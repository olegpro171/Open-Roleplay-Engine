import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import { refKey, type ContextRefresh, type ContextState, type SummaryRef } from '../shared/context.js';
import type { EngineSnapshot, RequestPreview } from '../shared/contracts.js';
import { insertRow } from './backup-store.js';
import { jobSchema, parseRecord, requestSchema, rowSchema, selection, stepSchema, str } from './backup-validation.js';

function identities() {
  const ids = new Map<string, string>();
  return (id: string) => {
    const previous = ids.get(id);
    if (previous) return previous;
    const next = randomUUID();
    ids.set(id, next);
    return next;
  };
}

/** Called inside the branch creation transaction. Copy local links without rewriting provider bodies. */
export function copyBranchContent(db: Database.Database, source: EngineSnapshot, destination: string, state: ContextState, earlier: boolean) {
  const turnId = identities();
  const variantId = identities();
  const generationId = identities();
  const summaryId = identities();
  const summaryRef = (ref: SummaryRef) => ({ id: summaryId(ref.id), revision: ref.revision });
  const copySelection = (value: Pick<ContextState, 'selected' | 'archivedTurnIds'>) => ({
    selected: value.selected.map(summaryRef),
    archivedTurnIds: value.archivedTurnIds.map(turnId),
  });
  const refresh = (value: ContextRefresh) => ({ ...value, before: copySelection(value.before), after: copySelection(value.after) });
  const allowedTurns = new Set(source.turns.map(turn => turn.id));
  const allowedSummaries = new Set(state.summaries.map(refKey));
  const requestWithLocalSources = (request: RequestPreview) => ({
    ...request,
    coverage: request.coverage.map(source => ({ ...source, turnId: turnId(source.turnId) })),
    summarySources: request.summarySources?.map(source => ({ ...source, turnId: turnId(source.turnId) })),
  });
  const retainedOperations = new Map<string, string>();
  const getTurn = db.prepare('SELECT * FROM turns WHERE id = ?');
  const getVariants = db.prepare('SELECT * FROM response_variants WHERE turn_id = ? ORDER BY rowid');
  const getGeneration = db.prepare('SELECT * FROM generations WHERE id = ?');
  const generations = z.array(z.object({ id: z.string(), turn_id: z.string() })).parse(
    db.prepare('SELECT id, turn_id FROM generations WHERE chat_id = ? ORDER BY rowid').all(source.id),
  );
  for (const turn of source.turns) {
    const row = rowSchema.parse(getTurn.get(turn.id));
    insertRow(db, 'turns', { ...row, id: turnId(turn.id), chat_id: destination,
      user_id: randomUUID(), assistant_id: randomUUID(), selected_variant_id: turn.assistant.variantId ? variantId(turn.assistant.variantId) : null });
  }
  for (const generation of generations) {
    if (!allowedTurns.has(generation.turn_id)) continue;
    const row = rowSchema.parse(getGeneration.get(generation.id));
    const id = generationId(generation.id);
    const contextSelection = typeof row.context_selection === 'string'
      ? selection.extend({ revision: z.number().int().nonnegative() }).parse(JSON.parse(row.context_selection)) : null;
    insertRow(db, 'generations', { ...row, id, chat_id: destination,
      request_id: randomUUID(), turn_id: turnId(generation.turn_id),
      context_selection: contextSelection && JSON.stringify({ revision: contextSelection.revision, ...copySelection(contextSelection) }) });
    retainedOperations.set(generation.id, id);
  }
  for (const turn of source.turns) {
    for (const raw of getVariants.all(turn.id)) {
      const row = rowSchema.parse(raw);
      const generation = typeof row.generation_id === 'string' ? retainedOperations.get(row.generation_id) ?? null : null;
      insertRow(db, 'response_variants', { ...row, id: variantId(str(row, 'id')), turn_id: turnId(turn.id), generation_id: generation });
    }
  }
  insertRow(db, 'context_states', { chat_id: destination, revision: state.revision, data: JSON.stringify(copySelection(state)) });
  const savedBaseline = db.prepare('SELECT fork_source_request FROM summaries WHERE id = ? AND revision = ?').pluck();
  const stepBaseline = db.prepare(`SELECT json_extract(step.data, '$.request') FROM context_steps step
    JOIN context_jobs job ON job.id = step.job_id
    WHERE job.chat_id = ? AND json_extract(step.data, '$.result.id') = ? AND json_extract(step.data, '$.result.revision') = ?
    AND json_type(step.data, '$.request') = 'object' ORDER BY step.rowid DESC LIMIT 1`).pluck();
  for (const node of state.summaries) {
    const copy = {
      ...node, id: summaryId(node.id),
      turns: node.turns.map(turn => ({ ...turn, turnId: turnId(turn.turnId) })),
      children: node.children.map(summaryRef), prior: node.prior.map(summaryRef),
      corrections: node.corrections?.map(summaryRef), basedOn: node.basedOn && summaryRef(node.basedOn),
    };
    const raw = savedBaseline.get(node.id, node.revision) ?? (earlier ? stepBaseline.get(source.id, node.id, node.revision) : undefined);
    const baseline = typeof raw === 'string' ? requestSchema.parse(JSON.parse(raw)) : null;
    const inherited = baseline && (!earlier || baseline.coverage.every(turn => allowedTurns.has(turn.turnId)));
    insertRow(db, 'summaries', { id: copy.id, revision: copy.revision, chat_id: destination, data: JSON.stringify(copy),
      fork_source_request: inherited ? JSON.stringify(requestWithLocalSources(baseline)) : null });
  }
  const jobIds = z.array(z.object({ id: z.string() })).parse(db.prepare('SELECT id FROM context_jobs WHERE chat_id = ? ORDER BY rowid').all(source.id));
  const getJob = db.prepare('SELECT * FROM context_jobs WHERE id = ?');
  const getStepIds = db.prepare('SELECT id FROM context_steps WHERE job_id = ? ORDER BY rowid');
  const getStep = db.prepare('SELECT * FROM context_steps WHERE id = ?');
  for (const { id: oldId } of jobIds) {
    const row = rowSchema.parse(getJob.get(oldId));
    const job = parseRecord(jobSchema, row, 'context_jobs');
    if (earlier && !job.historyTurnIds.every(id => allowedTurns.has(id))) continue;
    const id = randomUUID();
    const generation = job.generationId && (retainedOperations.get(job.generationId) ?? generationId(job.generationId));
    const copy = { ...job, id, chatId: destination, generationId: generation, historyTurnIds: job.historyTurnIds.map(turnId),
      repairCommands: undefined, refresh: job.refresh && refresh(job.refresh), finalRefresh: job.finalRefresh && refresh(job.finalRefresh) };
    insertRow(db, 'context_jobs', { ...row, id, chat_id: destination, request_id: randomUUID(), data: JSON.stringify(copy) });
    retainedOperations.set(oldId, id);
    for (const item of getStepIds.all(oldId)) {
      const stepId = z.object({ id: z.string() }).parse(item).id;
      const row = rowSchema.parse(getStep.get(stepId));
      const step = parseRecord(stepSchema, row, 'context_steps');
      const operation = step.operation;
      const copy = {
        ...step, id: randomUUID(), jobId: id,
        operation: { ...operation, turnIds: operation.turnIds.map(turnId), children: operation.children.map(summaryRef),
          repair: operation.repair && summaryRef(operation.repair), reconcile: operation.reconcile?.map(summaryRef) },
        result: step.result && summaryRef(step.result),
        resultDeleted: step.result && !allowedSummaries.has(refKey(step.result)) ? true : step.resultDeleted,
        before: copySelection(step.before), after: step.after && copySelection(step.after),
        request: step.request && requestWithLocalSources(step.request),
      };
      insertRow(db, 'context_steps', { id: copy.id, job_id: id, data: JSON.stringify(copy) });
    }
  }
  if (!earlier) {
    db.prepare('INSERT INTO lore_epochs SELECT ?, epoch FROM lore_epochs WHERE chat_id = ?').run(destination, source.id);
    db.prepare('INSERT INTO lore_states SELECT ?, book_id, epoch, data FROM lore_states WHERE chat_id = ?').run(destination, source.id);
  }
  const copyLore = db.prepare('INSERT INTO lore_operations SELECT ?, ?, resolution FROM lore_operations WHERE chat_id = ? AND operation_id = ?');
  for (const [old, id] of retainedOperations) copyLore.run(id, destination, source.id, old);
}
