import { createHash, randomUUID } from 'node:crypto';
import type { Store } from './store.js';
import { AppError } from '../core/errors.js';
import { contextPlan } from '../core/context-plan.js';
import { refreshContext } from '../core/context-refresh.js';
import { savedReplacement } from '../core/context-reuse.js';
import { nextRepair, nodeFor, repairQueue, replaceSelection, selectedContext, sourceOf } from '../core/context.js';
import { repairInputs } from '../core/context-repair.js';
import { assembleRequest } from '../core/prompt.js';
import { validateSummary } from '../core/summary-validation.js';
import { emptyContextState, refKey, type ContextJob, type ContextJobDetails, type ContextOperation, type ContextSnapshot, type ContextState, type ContextStep, type SummaryNode, type SummaryRef, type RepairAction, type RepairChange } from '../shared/context.js';
import type { ChatSnapshot, RequestPreview } from '../shared/contracts.js';
import { hasPromptMarker } from '../shared/library.js';
import type { LoreResolution } from '../shared/lorebook.js';

type JsonRow = { data: string };
export class ContextStore {
  constructor(private store: Store) {}
  private get sqlite() { return this.store.sqlite; }
  running(chatId?: string): boolean {
    return Boolean(chatId ? this.sqlite.prepare("SELECT id FROM context_jobs WHERE chat_id = ? AND json_extract(data, '$.status') = 'running'").get(chatId) : this.sqlite.prepare("SELECT id FROM context_jobs WHERE json_extract(data, '$.status') = 'running'").get());
  }
  snapshot(chatId: string, presetId: string | null): ContextSnapshot {
    const row = this.sqlite.prepare('SELECT data, revision FROM context_states WHERE chat_id = ?').get(chatId) as (JsonRow & { revision: number }) | undefined;
    const summaries = (this.sqlite.prepare('SELECT data FROM summaries WHERE chat_id = ? ORDER BY rowid').all(chatId) as JsonRow[]).map(row => JSON.parse(row.data) as SummaryNode);
    const jobs = (this.sqlite.prepare('SELECT data FROM context_jobs WHERE chat_id = ? ORDER BY rowid DESC LIMIT 20').all(chatId) as JsonRow[]).map(row => JSON.parse(row.data) as ContextJob);
    return { ...emptyContextState(), ...(row ? JSON.parse(row.data) as ContextState : {}), revision: row?.revision ?? 0, summaries, preset: this.store.contextPreset(presetId), jobs };
  }
  job(id: string): ContextJob {
    const row = this.sqlite.prepare('SELECT data FROM context_jobs WHERE id = ?').get(id) as JsonRow | undefined;
    if (!row) throw new AppError(404, 'context_job_not_found', 'Memory preparation not found.');
    return JSON.parse(row.data) as ContextJob;
  }
  commandJob(chatId: string, requestId: string, mode: ContextJob['mode']): ContextJob | null {
    const row = this.sqlite.prepare('SELECT data, chat_id, command FROM context_jobs WHERE request_id = ?').get(requestId) as (JsonRow & { chat_id: string; command: string }) | undefined;
    if (!row) return null;
    if (row.chat_id !== chatId || row.command !== JSON.stringify({ mode, generationId: null })) throw new AppError(409, 'request_id_conflict', 'This request identity was used for another memory command.');
    return JSON.parse(row.data) as ContextJob;
  }
  steps(id: string): ContextStep[] {
    this.job(id);
    return (this.sqlite.prepare('SELECT data FROM context_steps WHERE job_id = ? ORDER BY rowid').all(id) as JsonRow[]).map(row => JSON.parse(row.data) as ContextStep);
  }
  details(id: string): ContextJobDetails {
    const job = this.job(id), steps = this.steps(id);
    if (job.mode !== 'repair') return { job, steps };
    const snapshot = this.store.snapshot(job.chatId);
    const step = [...steps].reverse().find(step => step.status === 'candidate') ?? steps.at(-1);
    const previous = step?.operation.repair ? this.sourceRequest(job.chatId, step.operation.repair) : null;
    const payload = (request: RequestPreview | null | undefined): { sources?: unknown; previous_sources?: unknown; changes?: RepairChange[] } => {
      try { return JSON.parse(request?.body.messages.at(-1)?.content ?? '{}'); } catch { return {}; }
    };
    const current = payload(step?.request), old = payload(previous);
    const format = (value: unknown): string | null => {
      if (!Array.isArray(value)) return null;
      return value.map((source: { turn?: number; level?: number; user?: string; assistant?: string; text?: string }) =>
        source.level !== undefined ? `Level ${source.level} summary\n${source.text ?? ''}` : `Turn ${source.turn}\nUser: ${source.user ?? ''}\nAssistant: ${source.assistant ?? ''}`).join('\n\n');
    };
    const prior = (request: RequestPreview | null | undefined) => request?.body.messages.slice(1, -1).map(message => message.content).join('\n\n') ?? '';
    if (Array.isArray(current.changes)) {
      const text = (prior: boolean, side: 'before' | 'after') => current.changes!.filter(change => (change.kind === 'prior') === prior).map(change => `${change.label}\n${change[side] ?? (side === 'before' ? change.beforeRevision === null ? '[Not previously incorporated]' : '[Previous input unavailable]' : '[Input removed]')}`).join('\n\n');
      return { job, steps, repair: { remaining: repairQueue(snapshot.turns, snapshot.context).length,
        previousSources: text(false, 'before'), currentSources: text(false, 'after'), previousPrior: text(true, 'before'), currentPrior: text(true, 'after') } };
    }
    return { job, steps, repair: { remaining: repairQueue(snapshot.turns, snapshot.context).length,
      previousSources: format(current.previous_sources ?? old.sources), currentSources: format(current.sources) ?? '',
      previousPrior: prior(previous), currentPrior: prior(step?.request) } };
  }
  private discardCandidates(id: string) {
    const job = this.job(id);
    for (const step of this.steps(id)) {
      if (step.status !== 'candidate') continue;
      if (step.result) this.sqlite.prepare("DELETE FROM summaries WHERE chat_id = ? AND id = ? AND revision = ? AND json_extract(data, '$.approved') = 0").run(job.chatId, step.result.id, step.result.revision);
      this.saveStep({ ...step, status: 'discarded', result: null });
    }
  }
  sourceRequest(chatId: string, ref: SummaryRef): RequestPreview | null {
    const row = this.sqlite.prepare("SELECT context_steps.data FROM context_steps JOIN context_jobs ON context_jobs.id = context_steps.job_id WHERE context_jobs.chat_id = ? AND json_extract(context_steps.data, '$.result.id') = ? AND json_extract(context_steps.data, '$.result.revision') = ? AND json_type(context_steps.data, '$.request') = 'object' ORDER BY context_steps.rowid DESC LIMIT 1").get(chatId, ref.id, ref.revision) as JsonRow | undefined;
    if (row) return (JSON.parse(row.data) as ContextStep).request;
    const node = nodeFor(this.store.snapshot(chatId).context, ref);
    return node?.basedOn ? this.sourceRequest(chatId, node.basedOn) : null;
  }
  private saveJob(job: ContextJob) { this.sqlite.prepare('UPDATE context_jobs SET data = ? WHERE id = ?').run(JSON.stringify(job), job.id); }
  private saveStep(step: ContextStep) { this.sqlite.prepare('UPDATE context_steps SET data = ? WHERE id = ?').run(JSON.stringify(step), step.id); }
  private saveState(chatId: string, state: ContextState) {
    this.sqlite.prepare('INSERT INTO context_states (chat_id, revision, data) VALUES (?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET revision=excluded.revision, data=excluded.data').run(chatId, state.revision, JSON.stringify({ selected: state.selected, archivedTurnIds: state.archivedTurnIds }));
  }
  private saveNode(chatId: string, node: SummaryNode) { this.sqlite.prepare('INSERT INTO summaries (id, revision, chat_id, data) VALUES (?, ?, ?, ?)').run(node.id, node.revision, chatId, JSON.stringify(node)); }
  private repairedState(snapshot: ChatSnapshot, node: SummaryNode): ContextState {
    return { ...snapshot.context, revision: snapshot.context.revision + 1,
      archivedTurnIds: snapshot.context.archivedTurnIds.filter(id => snapshot.turns.some(turn => turn.id === id)),
      selected: snapshot.context.selected.flatMap(ref => ref.id === node.id ? node.turns.length ? [{ id: node.id, revision: node.revision }] : [] : [ref]),
    };
  }
  private bump(job: ContextJob): ContextJob {
    const revision = this.store.bumpRevision(job.chatId);
    if (job.generationId) this.sqlite.prepare("UPDATE generations SET source_revision = ? WHERE id = ? AND chat_id = ? AND status = 'running'").run(revision, job.generationId, job.chatId);
    return { ...job, sourceRevision: revision, updatedAt: new Date().toISOString() };
  }
  private current(job: ContextJob) {
    if (job.status !== 'running' && job.status !== 'awaiting_review') throw new AppError(409, 'inactive_context_job', 'This memory operation is no longer active.');
    this.store.checkRevision(job.sourceRevision, job.chatId);
    const snapshot = this.store.snapshot(job.chatId);
    if (!snapshot.context.preset || refKey(snapshot.context.preset) !== refKey(job.config)) throw new AppError(409, 'stale_context_result', 'The context preset changed. Generate a new candidate from the current settings.');
    if (job.generationId && this.store.generation(job.generationId)?.status !== 'running') throw new AppError(409, 'inactive_generation', 'The response owning this preparation is no longer running.');
    return { ...snapshot, loreResolution: this.store.loreOperation(job.id) ?? (job.generationId ? this.store.loreOperation(job.generationId) : null) };
  }
  operationSnapshot(id: string) { return this.current(this.job(id)); }
  refresh(chatId: string, revision: number, requestId: string, loreResolution?: LoreResolution | null): { jobId: string; report: NonNullable<ContextJob['refresh']> } {
    return this.sqlite.transaction(() => {
      const command = JSON.stringify({ mode: 'refresh', generationId: null });
      const existing = this.sqlite.prepare('SELECT data, chat_id, command FROM context_jobs WHERE request_id = ?').get(requestId) as (JsonRow & { chat_id: string; command: string }) | undefined;
      if (existing) {
        if (existing.chat_id !== chatId || existing.command !== command) throw new AppError(409, 'request_id_conflict', 'This request identity was used for another memory command.');
        const job = JSON.parse(existing.data) as ContextJob;
        return { jobId: job.id, report: job.refresh! };
      }
      this.store.checkRevision(revision, chatId); this.store.ensureIdle(chatId);
      if (this.sqlite.prepare("SELECT id FROM context_jobs WHERE chat_id = ? AND json_extract(data, '$.status') = 'awaiting_review'").get(chatId)) throw new AppError(409, 'repair_awaits_review', 'Approve or discard the repair candidate before refreshing memory.');
      const snapshot = { ...this.store.snapshot(chatId), loreResolution };
      const { state, report } = refreshContext(snapshot);
      const now = new Date().toISOString();
      const job: ContextJob = this.bump({ id: randomUUID(), chatId, status: 'succeeded', mode: 'refresh', generationId: null,
        config: snapshot.context.preset!, sourceRevision: revision, historyTurnIds: snapshot.turns.map(turn => turn.id), stepCount: 0,
        error: null, createdAt: now, updatedAt: now, refresh: report });
      this.store.saveLoreOperation(chatId, job.id, loreResolution ?? null);
      if (report.changed) this.saveState(chatId, state);
      this.sqlite.prepare('INSERT INTO context_jobs (id, chat_id, request_id, command, data) VALUES (?, ?, ?, ?, ?)').run(job.id, chatId, requestId, command, JSON.stringify(job));
      return { jobId: job.id, report };
    })();
  }
  begin(chatId: string, revision: number, requestId: string, mode: Exclude<ContextJob['mode'], 'refresh'>, generationId: string | null = null, loreResolution?: LoreResolution | null): { job: ContextJob; fresh: boolean } {
    return this.sqlite.transaction(() => {
      const command = JSON.stringify({ mode, generationId });
      const existing = this.sqlite.prepare('SELECT data, chat_id, command FROM context_jobs WHERE request_id = ?').get(requestId) as (JsonRow & { chat_id: string; command: string }) | undefined;
      if (existing) {
        if (existing.chat_id !== chatId || existing.command !== command) throw new AppError(409, 'request_id_conflict', 'This request identity was used for another memory command.');
        return { job: JSON.parse(existing.data) as ContextJob, fresh: false };
      }
      this.store.checkRevision(revision, chatId);
      if (generationId) {
        const generation = this.store.generation(generationId);
        if (!generation || generation.chatId !== chatId || generation.status !== 'running' || this.running(chatId)) throw new AppError(409, 'context_running', 'Another operation is already running for this chat.');
      } else this.store.ensureIdle(chatId);
      const snapshot = { ...this.store.snapshot(chatId), loreResolution: loreResolution ?? (generationId ? this.store.loreOperation(generationId) : null) }, preset = snapshot.context.preset;
      if (!hasPromptMarker(snapshot.sources.prompt, 'summary')) throw new AppError(422, 'summaries_disabled', 'Summaries are disabled. Enable a Summary marker in the prompt before preparing memory.');
      if (this.sqlite.prepare("SELECT id FROM context_jobs WHERE chat_id = ? AND json_extract(data, '$.status') = 'awaiting_review'").get(chatId)) throw new AppError(409, 'repair_awaits_review', 'Approve or discard the existing repair candidate before preparing more memory.');
      if (!preset) throw new AppError(422, 'context_required', 'Select a context preset first.');
      // Only an explicit Prepare click may restore detail. Automatic preparation
      // and single steps continue from the committed selection.
      const reselection = mode === 'prepare' && !generationId ? refreshContext(snapshot, { allowOverflowFallback: true }) : null;
      const now = new Date().toISOString();
      const before = new Set(snapshot.context.selected.map(refKey));
      const job: ContextJob = this.bump({ id: randomUUID(), chatId, status: 'running', mode, generationId, config: preset, sourceRevision: revision, historyTurnIds: snapshot.turns.map(turn => turn.id), stepCount: 0, error: null, createdAt: now, updatedAt: now,
        ...(reselection ? { refresh: reselection.report } : {}), reusedCount: reselection?.state.selected.filter(ref => !before.has(refKey(ref))).length ?? 0, generatedCount: 0 });
      this.store.saveLoreOperation(chatId, job.id, snapshot.loreResolution ?? null);
      if (reselection?.report.changed) this.saveState(chatId, reselection.state);
      this.sqlite.prepare('INSERT INTO context_jobs (id, chat_id, request_id, command, data) VALUES (?, ?, ?, ?, ?)').run(job.id, chatId, requestId, command, JSON.stringify(job));
      return { job, fresh: true };
    })();
  }
  reuseNext(jobId: string): boolean {
    return this.sqlite.transaction(() => {
      const job = this.job(jobId), snapshot = this.current(job), plan = contextPlan(snapshot);
      if (job.mode === 'repair' || plan.blocked || !plan.next) return false;
      const replacement = savedReplacement(snapshot, plan.next);
      if (!replacement) return false;
      const { node, state, inputAfter } = replacement;
      const step: ContextStep = { id: randomUUID(), jobId, operation: plan.next, request: null, status: 'saved', result: { id: node.id, revision: node.revision }, error: null,
        before: { selected: snapshot.context.selected, archivedTurnIds: snapshot.context.archivedTurnIds }, after: { selected: state.selected, archivedTurnIds: state.archivedTurnIds },
        inputBefore: plan.inputTokens, inputAfter, createdAt: new Date().toISOString(), reused: true };
      this.saveState(job.chatId, state);
      this.sqlite.prepare('INSERT INTO context_steps (id, job_id, data) VALUES (?, ?, ?)').run(step.id, jobId, JSON.stringify(step));
      this.saveJob(this.bump({ ...job, stepCount: job.stepCount + 1, reusedCount: (job.reusedCount ?? 0) + 1 }));
      return true;
    })();
  }
  revalidateRepair(jobId: string): boolean {
    return this.sqlite.transaction(() => {
      const job = this.job(jobId), snapshot = this.current(job);
      if (job.mode !== 'repair') return false;
      const operation = nextRepair(snapshot.turns, snapshot.context, new Map());
      if (!operation?.repair) return false;
      const inputs = repairInputs(snapshot, operation, this.sourceRequest(job.chatId, operation.repair));
      if (!inputs.reusable) return false;
      const node: SummaryNode = { ...inputs.old,
        revision: Math.max(...snapshot.context.summaries.filter(node => node.id === inputs.old.id).map(node => node.revision)) + 1,
        turns: snapshot.turns.filter(turn => operation.turnIds.includes(turn.id)).map(sourceOf), children: operation.children, prior: inputs.prior, corrections: inputs.corrections,
        approved: true, createdAt: new Date().toISOString(), basedOn: operation.repair,
      };
      const state = this.repairedState(snapshot, node);
      const step: ContextStep = { id: randomUUID(), jobId, operation, request: null, status: 'saved', result: { id: node.id, revision: node.revision }, error: null,
        before: { selected: snapshot.context.selected, archivedTurnIds: snapshot.context.archivedTurnIds }, after: { selected: state.selected, archivedTurnIds: state.archivedTurnIds },
        inputBefore: contextPlan(snapshot).inputTokens, inputAfter: null, createdAt: node.createdAt, repairOutcome: 'inputs_unchanged' };
      this.discardCandidates(jobId);
      this.saveNode(job.chatId, node); this.saveState(job.chatId, state);
      this.sqlite.prepare('INSERT INTO context_steps (id, job_id, data) VALUES (?, ?, ?)').run(step.id, jobId, JSON.stringify(step));
      this.saveJob(this.bump({ ...job, stepCount: job.stepCount + 1, revalidatedCount: (job.revalidatedCount ?? 0) + 1 }));
      return true;
    })();
  }
  beginStep(jobId: string, operation: ContextOperation, request: RequestPreview | null, inputBefore: number): ContextStep {
    return this.sqlite.transaction(() => {
      const job = this.job(jobId), snapshot = this.current(job);
      const expected = job.mode === 'repair' ? nextRepair(snapshot.turns, snapshot.context, new Map()) : contextPlan(snapshot).next;
      if (JSON.stringify(expected) !== JSON.stringify(operation) || job.mode !== 'repair' && contextPlan(snapshot).blocked) throw new AppError(409, 'stale_context_result', 'This memory operation is no longer eligible.');
      const step: ContextStep = { id: randomUUID(), jobId, operation, request, status: 'running', result: null, error: null,
        before: { selected: snapshot.context.selected, archivedTurnIds: snapshot.context.archivedTurnIds }, after: null, inputBefore, inputAfter: null, createdAt: new Date().toISOString() };
      this.sqlite.prepare('INSERT INTO context_steps (id, job_id, data) VALUES (?, ?, ?)').run(step.id, jobId, JSON.stringify(step));
      this.saveJob({ ...job, stepCount: job.stepCount + 1 });
      return step;
    })();
  }
  completeStep(step: ContextStep, text: string, prior: SummaryRef[]): SummaryNode {
    return this.sqlite.transaction(() => {
      const job = this.job(step.jobId), snapshot = this.current(job);
      const savedStep = this.steps(job.id).find(item => item.id === step.id);
      if (!savedStep || savedStep.status !== 'running') throw new AppError(409, 'duplicate_context_result', 'This summary step has already been resolved.');
      if (JSON.stringify(step.before) !== JSON.stringify({ selected: snapshot.context.selected, archivedTurnIds: snapshot.context.archivedTurnIds })) throw new AppError(409, 'stale_selection', 'The selected memory changed before the summary was saved.');
      const repair = step.operation.repair;
      if (repair && JSON.stringify(nextRepair(snapshot.turns, snapshot.context, new Map())) !== JSON.stringify(step.operation)) throw new AppError(409, 'stale_context_result', 'The required correction or repair changed.');
      const inputs = repair ? repairInputs(snapshot, step.operation, this.sourceRequest(job.chatId, repair)) : null;
      if (!repair && JSON.stringify(contextPlan(snapshot).next) !== JSON.stringify(step.operation)) throw new AppError(409, 'stale_context_result', 'This batch is no longer the next eligible replacement.');
      if (step.operation.turnIds.length && !validateSummary(text, 'stop').accepted) throw new AppError(502, 'invalid_summary', 'The candidate summary failed validation.');
      const sourceIds = new Set(step.operation.turnIds);
      const sourceTurns = snapshot.turns.filter(turn => sourceIds.has(turn.id));
      if (sourceTurns.length !== sourceIds.size || sourceTurns.some(turn => !turn.complete)) throw new AppError(409, 'stale_sources', 'The summary sources changed.');
      if (savedStep.request && JSON.stringify(savedStep.request.coverage) !== JSON.stringify(sourceTurns.map(sourceOf))) throw new AppError(409, 'stale_sources', 'The source revisions changed while the model was summarizing.');
      const identity = repair?.id ?? randomUUID();
      const unchanged = Boolean(inputs?.known && inputs.structureUnchanged && text === inputs.old.text && step.operation.turnIds.length);
      const node: SummaryNode = { id: identity, revision: repair ? Math.max(...snapshot.context.summaries.filter(node => node.id === identity).map(node => node.revision)) + 1 : 0,
        level: step.operation.level, text, turns: sourceTurns.map(sourceOf), children: step.operation.children, prior,
        ...(inputs ? { corrections: inputs.corrections } : {}),
        approved: !repair || unchanged, createdAt: new Date().toISOString(), manual: inputs?.old.manual ?? false, ...(repair ? { basedOn: repair } : {}) };
      let after: ContextState | null = null, inputAfter: number | null = null;
      if (!repair) {
        after = replaceSelection(snapshot.context, step.operation, node);
        selectedContext(snapshot.turns, after);
        inputAfter = assembleRequest(snapshot.connection!, snapshot.settings, snapshot.turns, snapshot.sources, after, { validateLimits: false, lore: snapshot.loreResolution }).budget.inputTokens;
        if (inputAfter >= step.inputBefore) throw new AppError(422, 'summary_no_savings', 'The summary did not reduce the assembled input. Sources remain selected; revise the summary prompt or output target and retry.');
      }
      else if (unchanged) after = this.repairedState(snapshot, node);
      // Keep an existing candidate usable until regeneration succeeds.
      if (repair) this.discardCandidates(job.id);
      this.saveNode(job.chatId, node);
      if (after) this.saveState(job.chatId, after);
      this.saveStep({ ...savedStep, status: repair && !unchanged ? 'candidate' : 'saved', result: { id: node.id, revision: node.revision }, after: after ? { selected: after.selected, archivedTurnIds: after.archivedTurnIds } : null, inputAfter, ...(unchanged ? { repairOutcome: 'model_unchanged' } : {}) });
      this.saveJob(this.bump({ ...job, generatedCount: (job.generatedCount ?? 0) + Number(Boolean(savedStep.request)), unchangedCount: (job.unchangedCount ?? 0) + Number(unchanged) }));
      return node;
    })();
  }
  finish(id: string, status: Exclude<ContextJob['status'], 'running'>, error: string | null = null) {
    this.sqlite.transaction(() => {
      const row = this.sqlite.prepare('SELECT data FROM context_jobs WHERE id = ?').get(id) as JsonRow | undefined;
      if (!row) return;
      const job = JSON.parse(row.data) as ContextJob;
      if (job.status !== 'running') return;
      for (const step of this.steps(id)) if (step.status === 'running') this.saveStep({ ...step, status: status === 'interrupted' ? 'interrupted' : 'failed', error });
      let completed = job;
      if (status === 'succeeded' && job.mode === 'prepare' && !job.generationId && job.stepCount) {
        // Newly available groups can make a finer saved-only plan possible.
        // Finish the explicit action in that plan, rather than changing it again
        // on a second identical click. Automatic continuation never does this.
        const { state, report } = refreshContext(this.current(job));
        if (report.changed) {
          this.saveState(job.chatId, state);
          const before = new Set(report.before.selected.map(refKey));
          completed = { ...job, finalRefresh: report, reusedCount: (job.reusedCount ?? 0) + state.selected.filter(ref => !before.has(refKey(ref))).length };
        }
      }
      const plan = status === 'succeeded' && job.mode !== 'repair' ? contextPlan(this.current(job)) : null;
      if (job.mode === 'repair' && status === 'cancelled') this.discardCandidates(id);
      const keepCandidate = job.mode === 'repair' && (status === 'failed' || status === 'interrupted') && this.steps(id).some(step => step.status === 'candidate');
      this.saveJob(this.bump({ ...completed, status: keepCandidate ? 'awaiting_review' : status, error, ...(plan ? { outcome: { inputTokens: plan.inputTokens, verbatimTurns: plan.verbatimTurnIds.length } } : {}) }));
    })();
  }
  review(id: string, revision: number, accept: boolean, editedText?: string) {
    this.sqlite.transaction(() => {
      const job = this.job(id);
      this.store.checkRevision(revision, job.chatId); this.store.ensureIdle(job.chatId);
      if (job.status !== 'awaiting_review') throw new AppError(409, 'no_repair_candidate', 'This repair no longer awaits review.');
      if (accept) {
        const snapshot = this.current(job), step = [...this.steps(id)].reverse().find(step => step.status === 'candidate');
        if (!step?.result || !step.operation.repair) throw new AppError(409, 'missing_candidate', 'The repair candidate is missing.');
        const candidate = nodeFor(snapshot.context, step.result);
        if (!candidate) throw new AppError(409, 'missing_candidate', 'The repair candidate is missing.');
        if (editedText !== undefined && candidate.turns.length && !editedText.trim()) throw new AppError(400, 'blank_summary', 'A summary covering saved turns cannot be empty.');
        const normalized = editedText?.trim();
        const edited = normalized !== undefined && normalized !== candidate.text
          ? { ...candidate, text: normalized, manual: true, revision: Math.max(...snapshot.context.summaries.filter(node => node.id === candidate.id).map(node => node.revision)) + 1 }
          : candidate;
        const changed = edited.revision !== candidate.revision;
        const approved = { ...edited, approved: true };
        const state: ContextState = { ...snapshot.context, revision: snapshot.context.revision + 1,
          summaries: changed ? [...snapshot.context.summaries, approved] : snapshot.context.summaries.map(node => refKey(node) === refKey(approved) ? approved : node),
          archivedTurnIds: snapshot.context.archivedTurnIds.filter(id => snapshot.turns.some(turn => turn.id === id)),
          selected: snapshot.context.selected.flatMap(ref => ref.id === approved.id ? approved.turns.length ? [{ id: approved.id, revision: approved.revision }] : [] : [ref]),
        };
        if (changed) {
          this.saveNode(job.chatId, approved);
          this.sqlite.prepare('DELETE FROM summaries WHERE chat_id = ? AND id = ? AND revision = ?').run(job.chatId, candidate.id, candidate.revision);
        }
        else this.sqlite.prepare('UPDATE summaries SET data = ? WHERE id = ? AND revision = ?').run(JSON.stringify(approved), approved.id, approved.revision);
        this.saveState(job.chatId, state);
        this.saveStep({ ...step, status: 'saved', result: { id: approved.id, revision: approved.revision }, after: { selected: state.selected, archivedTurnIds: state.archivedTurnIds } });
      }
      this.discardCandidates(id);
      this.saveJob(this.bump({ ...job, reviewedCount: (job.reviewedCount ?? 0) + Number(accept), status: accept ? 'succeeded' : 'cancelled', error: accept ? null : 'Repair candidate discarded. Original memory remains selected.' }));
    })();
  }
  repairAction(id: string, revision: number, requestId: string, action: RepairAction, text?: string, loreResolution?: LoreResolution | null): { fresh: boolean; job: ContextJob } {
    return this.sqlite.transaction(() => {
      const job = this.job(id);
      if (job.mode !== 'repair') throw new AppError(409, 'not_repair_job', 'This operation is not a summary repair.');
      const command = createHash('sha256').update(JSON.stringify({ action, text })).digest('hex');
      const recorded = job.repairCommands?.[requestId];
      if (recorded) {
        if (recorded !== command) throw new AppError(409, 'request_id_conflict', 'This request identity was used for another repair command.');
        return { fresh: false, job };
      }
      if (action === 'close') {
        // Dismissal only touches unapproved work, so it also works after a source edit
        // or a generation finishing between the click and this command.
        if (job.status === 'running') this.finish(id, 'cancelled', 'Repair closed. Approved replacements remain saved.');
        this.discardCandidates(id);
        const current = this.job(id);
        this.saveJob({ ...current, status: current.status === 'succeeded' ? 'succeeded' : 'cancelled', error: null, updatedAt: new Date().toISOString() });
      } else {
        this.store.checkRevision(revision, job.chatId); this.store.ensureIdle(job.chatId);
        if (this.sqlite.prepare("SELECT id FROM context_jobs WHERE chat_id = ? AND id != ? AND json_extract(data, '$.status') = 'awaiting_review'").get(job.chatId, id)) throw new AppError(409, 'repair_awaits_review', 'Another repair is awaiting review. Close it before restarting this repair.');
        if (!['awaiting_review', 'failed', 'interrupted'].includes(job.status)) throw new AppError(409, 'inactive_context_job', 'This repair is no longer awaiting an action.');
        const snapshot = this.store.snapshot(job.chatId);
        if (!hasPromptMarker(snapshot.sources.prompt, 'summary')) throw new AppError(422, 'summaries_disabled', 'Summaries are disabled. Enable a Summary marker before repairing memory.');
        if (!snapshot.context.preset) throw new AppError(422, 'context_required', 'Select a context preset first.');
        if (action === 'regenerate') {
          if (snapshot.sources.lorebook && loreResolution === undefined) throw new AppError(422, 'lore_unresolved', 'Resolve the current lorebook before retrying repair.');
          this.store.replaceLoreOperation(job.chatId, id, loreResolution ?? null);
        }
        if (action === 'approve') this.review(id, revision, true, text);
        else if (job.sourceRevision !== revision) this.discardCandidates(id);
        const current = this.job(id), updated = this.store.snapshot(job.chatId);
        const remaining = repairQueue(updated.turns, updated.context).length;
        this.saveJob(this.bump({ ...current, config: updated.context.preset!, status: remaining ? 'running' : 'succeeded', error: null }));
      }
      const current = this.job(id);
      this.saveJob({ ...current, repairCommands: { ...current.repairCommands, [requestId]: command } });
      return { fresh: true, job: this.job(id) };
    })();
  }
  clearMemory(chatId: string, revision: number) {
    this.sqlite.transaction(() => {
      this.store.checkRevision(revision, chatId); this.store.ensureIdle(chatId);
      this.clear(chatId);
      this.store.bumpRevision(chatId);
    })();
  }
  editSummary(chatId: string, revision: number, ref: SummaryRef, text: string): SummaryRef {
    return this.sqlite.transaction(() => {
      this.store.checkRevision(revision, chatId); this.store.ensureIdle(chatId);
      const state = this.store.snapshot(chatId).context, old = nodeFor(state, ref);
      if (!old?.approved || state.summaries.some(node => node.id === ref.id && node.approved && node.revision > ref.revision)) throw new AppError(409, 'stale_summary', 'This is not the current approved summary revision. Reopen its current version before editing.');
      if (!text.trim() || !old.turns.length) throw new AppError(400, 'blank_summary', 'A saved summary must have nonempty text and source coverage.');
      const normalized = text.trim();
      if (normalized === old.text) return { id: old.id, revision: old.revision };
      const node: SummaryNode = { ...old, revision: Math.max(...state.summaries.filter(node => node.id === ref.id).map(node => node.revision)) + 1, text: normalized, manual: true, createdAt: new Date().toISOString(), basedOn: ref };
      this.saveNode(chatId, node);
      const replacement = { id: node.id, revision: node.revision };
      this.saveState(chatId, { ...state, revision: state.revision + 1, selected: state.selected.map(selected => refKey(selected) === refKey(ref) ? replacement : selected) });
      this.store.bumpRevision(chatId);
      return replacement;
    })();
  }
  clear(chatId: string) {
    this.sqlite.prepare('DELETE FROM lore_operations WHERE chat_id = ? AND operation_id IN (SELECT id FROM context_jobs WHERE chat_id = ?)').run(chatId, chatId);
    this.sqlite.prepare('DELETE FROM context_jobs WHERE chat_id = ?').run(chatId);
    this.sqlite.prepare('DELETE FROM summaries WHERE chat_id = ?').run(chatId);
    this.sqlite.prepare('DELETE FROM context_states WHERE chat_id = ?').run(chatId);
  }
  recover() {
    const jobs = (this.sqlite.prepare("SELECT data FROM context_jobs WHERE json_extract(data, '$.status') = 'running'").all() as JsonRow[]).map(row => JSON.parse(row.data) as ContextJob);
    for (const job of jobs) this.finish(job.id, 'interrupted', 'The server stopped during preparation. Saved replacements remain selected. Resume explicitly to start a new request.');
  }
}
