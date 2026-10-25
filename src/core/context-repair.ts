import { message } from '../shared/localization.js';
import type { EngineSnapshot, RequestPreview } from '../shared/contracts.js';
import { refKey, type ContextOperation, type RepairChange, type SummaryRef } from '../shared/context.js';
import { AppError } from './errors.js';
import { nodeFor, sourceOf, staleSummaries } from './context.js';
import { assertCleanSummaryInput, unresolvedRefusal } from './summary-refusals.js';

/** Compare effective incorporated inputs, rather than treating all provenance edits as content changes. */
export function repairInputs(snapshot: EngineSnapshot, operation: ContextOperation, previousRequest: RequestPreview | null) {
  const old = operation.repair && nodeFor(snapshot.context, operation.repair);
  if (!old) throw new AppError(422, 'missing_summary', message("errors.the_summary_being_repaired_is_missing"));
  const changes: RepairChange[] = [];
  const rebuilding = unresolvedRefusal(old);
  const latest = new Map<string, SummaryRef>();
  for (const node of snapshot.context.summaries) if (node.approved && node.revision > (latest.get(node.id)?.revision ?? -1)) latest.set(node.id, { id: node.id, revision: node.revision });
  const current = (ref: SummaryRef) => latest.get(ref.id) ?? ref;
  const prior = old.prior.map(current).filter(ref => Boolean(nodeFor(snapshot.context, ref)?.turns.length));
  const corrections = [...new Map([...(old.corrections ?? []).map(current), ...(operation.reconcile ?? []).map(current)].map(ref => [ref.id, ref])).values()];
  const stale = staleSummaries(snapshot.turns, snapshot.context);
  const same = (a: string[], b: string[]) => JSON.stringify(a) === JSON.stringify(b);
  let structureUnchanged = same(old.turns.map(source => source.turnId), operation.turnIds)
    && operation.turnIds.every(id => snapshot.turns.find(turn => turn.id === id)?.complete);
  let known = true;
  const add = (change: RepairChange) => { if (change.before !== change.after || change.coverageChanged) changes.push(change); };
  const currentSources = snapshot.turns.filter(turn => operation.turnIds.includes(turn.id)).map(turn => ({ turnId: turn.id, user: turn.user.text, assistant: turn.assistant.text }));
  if (old.level === 1) {
    let previousSources = previousRequest?.summarySources;
    if (!previousSources) {
      try {
        const payload = JSON.parse(previousRequest?.body.messages.at(-1)?.content ?? '{}');
        if (Array.isArray(payload.sources) && payload.sources.length === previousRequest?.coverage.length && payload.sources.every((source: { user?: unknown; assistant?: unknown }) => typeof source.user === 'string' && typeof source.assistant === 'string')) {
          previousSources = payload.sources.map((source: { user: string; assistant: string }, i: number) => ({ turnId: previousRequest!.coverage[i].turnId, user: source.user, assistant: source.assistant }));
        }
      } catch { /* Missing older baselines require model review rather than automatic reuse. */ }
    }
    for (const source of old.turns) {
      const before = previousSources?.find(turn => turn.turnId === source.turnId);
      const after = snapshot.turns.find(turn => turn.id === source.turnId);
      if (!before) known = false;
      for (const kind of ['user', 'assistant'] as const) add({ kind, id: source.turnId,
        label: `Turn ${after ? snapshot.turns.indexOf(after) + 1 : 'deleted'} · ${kind}`,
        before: before?.[kind] ?? null, after: after?.[kind].text ?? null,
        beforeRevision: kind === 'user' ? source.userRevision : source.assistantRevision,
        afterRevision: after ? kind === 'user' ? after.user.revision : sourceOf(after).assistantRevision : null });
    }
  }
  for (const kind of ['child', 'prior', 'correction'] as const) {
    const beforeRefs = kind === 'child' ? old.children : kind === 'prior' ? old.prior : old.corrections ?? [];
    const afterRefs = kind === 'child' ? operation.children : kind === 'prior' ? prior : corrections;
    if (!same(beforeRefs.map(ref => ref.id), afterRefs.map(ref => ref.id))) structureUnchanged = false;
    for (const id of new Set([...beforeRefs.map(ref => ref.id), ...afterRefs.map(ref => ref.id)])) {
      const beforeRef = beforeRefs.find(ref => ref.id === id), afterRef = afterRefs.find(ref => ref.id === id);
      const before = beforeRef && nodeFor(snapshot.context, beforeRef), after = afterRef && nodeFor(snapshot.context, afterRef);
      if (beforeRef && !before || afterRef && !after) throw new AppError(422, 'invalid_context', message("errors.a_summary_input_revision_is_missing"));
      if (afterRef && stale.has(refKey(afterRef))) throw new AppError(409, 'stale_dependency', message("errors.repair_the_changed_input_summary_before_repairing_its"));
      if (after) assertCleanSummaryInput(after);
      const omitted = before && unresolvedRefusal(before);
      if (omitted) known = false;
      const coverageChanged = !same(before?.turns.map(source => source.turnId) ?? [], after?.turns.map(source => source.turnId) ?? []);
      if (coverageChanged) structureUnchanged = false;
      add({ kind, id, label: `${kind === 'prior' ? 'Earlier memory' : kind === 'correction' ? 'Manual correction requiring reconciliation' : 'Source summary'} · level ${(after ?? before)!.level} · ${id}${coverageChanged ? ' · coverage changed' : ''}`,
        before: omitted ? null : before?.text ?? null, after: after?.text ?? null, beforeRevision: beforeRef?.revision ?? null, afterRevision: afterRef?.revision ?? null, ...(coverageChanged ? { coverageChanged: true } : {}), ...(omitted ? { beforeOmitted: 'unusable_summary' as const } : {}) });
    }
  }
  return { old, changes, prior, corrections, currentSources, known, structureUnchanged, rebuilding, reusable: !rebuilding && known && structureUnchanged && changes.length === 0 };
}
