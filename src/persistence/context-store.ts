import { message, outcomeMessage, type LocalizedMessage } from '../shared/localization.js';
import { createHash, randomUUID } from 'node:crypto';
import type { Store } from './store.js';
import { AppError } from '../core/errors.js';
import { contextPlan } from '../core/context-plan.js';
import { summariesDeletion, summaryDeletion, summarySuffixDeletion } from '../core/context-delete.js';
import { supersededMemoryAlternatives, type MemoryLayoutCleanup } from '../core/memory-layout.js';
import { checkSummaryRefusal, summaryRefusalCheck, unresolvedRefusal, assertRefusalSelection } from '../core/summary-refusals.js';
import { summaryRefusalFilterVersion } from '../core/summary-validation.js';
import { assertCorrectionSelection, correctionDiagnostic, correctionProtection, latestApproved } from '../core/context-corrections.js';
import { savedReplacement } from '../core/context-reuse.js';
import type { ReplayFrame } from '../core/context-replay.js';
import { belowMinimumTail, hasChronologicalLevels, nextRepair, nodeFor, repairQueue, replaceSelection, selectedContext, sourceOf } from '../core/context.js';
import { repairInputs } from '../core/context-repair.js';
import { assembleRequest } from '../core/prompt.js';
import { validateSummary } from '../core/summary-validation.js';
import { emptyContextState, refKey, type SummaryRetry, type ContextJob, type ContextJobDetails, type ContextOperation, type ContextPlan, type ContextSnapshot, type ContextState, type ContextStep, type PreparationDeletionPreview, type SummaryNode, type SummaryRef, type RepairAction, type RepairChange } from '../shared/context.js';
import type { EngineSnapshot, RequestPreview } from '../shared/contracts.js';
import { hasPromptMarker } from '../shared/library.js';
import type { LoreResolution } from '../shared/lorebook.js';

type JsonRow = { data: string };
type ReplayRevisions = { sourceRevision: number; selectionRevision: number };
export class ContextStore {
  constructor(private store: Store) {}
  private get sqlite() { return this.store.sqlite; }
  running(chatId?: string): boolean {
    return Boolean(chatId ? this.sqlite.prepare("SELECT id FROM context_jobs WHERE chat_id = ? AND json_extract(data, '$.status') = 'running'").get(chatId) : this.sqlite.prepare("SELECT id FROM context_jobs WHERE json_extract(data, '$.status') = 'running'").get());
  }
  savedState(chatId: string): ContextState {
    const row = this.sqlite.prepare('SELECT data, revision FROM context_states WHERE chat_id = ?').get(chatId) as (JsonRow & { revision: number }) | undefined;
    const summaries = (this.sqlite.prepare('SELECT data FROM summaries WHERE chat_id = ? ORDER BY rowid').all(chatId) as JsonRow[]).map(row => JSON.parse(row.data) as SummaryNode);
    return { ...emptyContextState(), ...(row ? JSON.parse(row.data) as ContextState : {}), revision: row?.revision ?? 0, summaries };
  }
  selectionCheckpoint(chatId: string) {
    const row = this.sqlite.prepare("SELECT revision, json_array_length(data, '$.archivedTurnIds') AS archivedCount FROM context_states WHERE chat_id = ?")
      .get(chatId) as { revision: number; archivedCount: number | null } | undefined;
    return { revision: row?.revision ?? 0, archivedCount: row?.archivedCount ?? 0 };
  }
  snapshot(chatId: string, presetId: string | null): ContextSnapshot {
    const state = this.savedState(chatId);
    const update = this.sqlite.prepare("UPDATE summaries SET data = json_set(data, '$.refusalCheck', json(?)) WHERE chat_id = ? AND id = ? AND revision = ?");
    // A check changes only quality metadata, never text/source or chat revisions.
    // Persist it once per filter version; historical text remains available locally.
    for (const node of state.summaries) {
      if (node.refusalCheck?.version === summaryRefusalFilterVersion) continue;
      node.refusalCheck = checkSummaryRefusal(node.text);
      update.run(JSON.stringify(node.refusalCheck), chatId, node.id, node.revision);
    }
    const jobs = (this.sqlite.prepare('SELECT data FROM context_jobs WHERE chat_id = ? ORDER BY rowid DESC LIMIT 20').all(chatId) as JsonRow[]).map(row => JSON.parse(row.data) as ContextJob);
    return { ...state, preset: this.store.contextPreset(presetId), jobs };
  }
  job(id: string): ContextJob {
    const row = this.sqlite.prepare('SELECT data FROM context_jobs WHERE id = ?').get(id) as JsonRow | undefined;
    if (!row) throw new AppError(404, 'context_job_not_found', message("errors.memory_preparation_not_found"));
    return JSON.parse(row.data) as ContextJob;
  }
  commandJob(chatId: string, requestId: string, mode: ContextJob['mode'], retry?: SummaryRetry): ContextJob | null {
    const row = this.sqlite.prepare('SELECT data, chat_id, command FROM context_jobs WHERE request_id = ?').get(requestId) as (JsonRow & { chat_id: string; command: string }) | undefined;
    if (!row) return null;
    if (row.chat_id !== chatId || row.command !== JSON.stringify({ mode, generationId: null, ...(retry ? { retry } : {}) })) throw new AppError(409, 'request_id_conflict', message("errors.this_request_identity_was_used_for_another_memory"));
    return JSON.parse(row.data) as ContextJob;
  }
  steps(id: string): ContextStep[] {
    this.job(id);
    return (this.sqlite.prepare('SELECT data FROM context_steps WHERE job_id = ? ORDER BY rowid').all(id) as JsonRow[]).map(row => JSON.parse(row.data) as ContextStep);
  }
  details(id: string): ContextJobDetails {
    const job = this.job(id), steps = this.steps(id);
    if (job.mode !== 'repair') return { job, steps };
    const snapshot = this.store.engineSnapshot(job.chatId);
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
    const inherited = this.sqlite.prepare('SELECT fork_source_request AS data FROM summaries WHERE chat_id = ? AND id = ? AND revision = ? AND fork_source_request IS NOT NULL')
      .get(chatId, ref.id, ref.revision) as JsonRow | undefined;
    if (inherited) return JSON.parse(inherited.data) as RequestPreview;
    const node = nodeFor(this.store.engineSnapshot(chatId).context, ref);
    return node?.basedOn ? this.sourceRequest(chatId, node.basedOn) : null;
  }
  private saveJob(job: ContextJob) { this.sqlite.prepare('UPDATE context_jobs SET data = ? WHERE id = ?').run(JSON.stringify(job), job.id); }
  private saveStep(step: ContextStep) { this.sqlite.prepare('UPDATE context_steps SET data = ? WHERE id = ?').run(JSON.stringify(step), step.id); }
  private isRegenerating(job: ContextJob) {
    return job.generationId !== null && this.store.generation(job.generationId)?.kind === 'regeneration';
  }
  private saveState(chatId: string, state: ContextState, generationId?: string | null) {
    if (generationId && this.store.generation(generationId)?.kind === 'regeneration') {
      this.store.saveGenerationContext(generationId, state);
      return;
    }
    this.sqlite.prepare('INSERT INTO context_states (chat_id, revision, data) VALUES (?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET revision=excluded.revision, data=excluded.data').run(chatId, state.revision, JSON.stringify({ selected: state.selected, archivedTurnIds: state.archivedTurnIds }));
  }
  private saveNode(chatId: string, node: SummaryNode) {
    node.refusalCheck = checkSummaryRefusal(node.text);
    this.sqlite.prepare('INSERT INTO summaries (id, revision, chat_id, data) VALUES (?, ?, ?, ?)').run(node.id, node.revision, chatId, JSON.stringify(node));
  }
  private repairedState(snapshot: EngineSnapshot, node: SummaryNode): ContextState {
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
  private current(job: ContextJob, reviewing = false) {
    if (job.status !== 'running' && !(reviewing && job.status === 'awaiting_review')) throw new AppError(409, 'inactive_context_job', message("errors.this_memory_operation_is_no_longer_active"));
    this.store.checkRevision(job.sourceRevision, job.chatId);
    const snapshot = job.generationId ? this.store.generationSnapshot(job.generationId) : this.store.engineSnapshot(job.chatId);
    if (!snapshot.context.preset || refKey(snapshot.context.preset) !== refKey(job.config)) throw new AppError(409, 'stale_context_result', message("errors.the_context_preset_changed_generate_a_new_candidate"));
    if (job.generationId && this.store.generation(job.generationId)?.status !== 'running') throw new AppError(409, 'inactive_generation', message("errors.the_response_owning_this_preparation_is_no_longer"));
    return { ...snapshot, loreResolution: this.store.loreOperation(job.id) ?? (job.generationId ? this.store.loreOperation(job.generationId) : null) };
  }
  operationSnapshot(id: string) { return this.current(this.job(id)); }
  private checkReplay(job: ContextJob, snapshot: EngineSnapshot, frame?: ReplayFrame) {
    if (Boolean(frame) !== (job.mode === 'prepare')) {
      throw new AppError(409, 'stale_context_result', message("errors.this_memory_operation_is_no_longer_eligible"));
    }
    if (frame && (snapshot.id !== frame.snapshot.id || snapshot.revision !== frame.snapshot.revision
      || snapshot.context.revision !== frame.snapshot.context.revision)) {
      throw new AppError(409, 'stale_selection', message("errors.the_selected_memory_changed_before_the_summary_was"));
    }
  }
  private preparationDeletion(job: ContextJob, snapshot: EngineSnapshot, plan: ContextPlan, replay?: ReplayFrame) {
    if (job.mode !== 'prepare' && job.mode !== 'step') return null;
    const blockedByCorrection = plan.blockedMessage?.key === correctionDiagnostic.key && !plan.repairCount;
    if (!plan.next && !blockedByCorrection) return null;
    if (replay && !replay.maySupersede && !blockedByCorrection) return null;
    const regenerating = this.isRegenerating(job);
    const committed = regenerating ? this.savedState(job.chatId) : snapshot.context;
    const working = regenerating ? { ...snapshot.context, summaries: committed.summaries } : committed;
    const roots: SummaryRef[] = [];
    if (blockedByCorrection) {
      roots.push(...(replay?.correctionConflicts ?? correctionProtection(snapshot.turns, snapshot.context).unresolved));
      if (!replay) {
        // In single-step mode an edited dependent can mask the operation that
        // supersedes its source. Review them in the same cascade.
        const projected = summariesDeletion(working, roots);
        const after = { ...snapshot.context, ...projected.after };
        const nextPlan = contextPlan({ ...snapshot, context: after });
        if (nextPlan.next) roots.push(...supersededMemoryAlternatives(projected.after, after.selected, nextPlan.next, nextPlan.reusable));
      }
    } else if (plan.next) roots.push(...supersededMemoryAlternatives(committed, replay?.snapshot.context.selected ?? snapshot.context.selected, plan.next, plan.reusable));
    if (!roots.length) return null;
    const deletion = summariesDeletion(committed, roots);
    const preview = { revision: job.sourceRevision, deletedIds: [...deletion.deletedIds], restoredTurnIds: deletion.restoredTurnIds };
    return { deletion, preview, roots, regenerating, working };
  }
  previewPreparationDeletion(job: ContextJob, snapshot: EngineSnapshot, plan: ContextPlan, replay?: ReplayFrame): Omit<PreparationDeletionPreview, 'token'> | null {
    return this.preparationDeletion(job, snapshot, plan, replay)?.preview ?? null;
  }
  confirmPreparationDeletion(id: string, expected: Omit<PreparationDeletionPreview, 'token'>, replay?: ReplayFrame) {
    return this.sqlite.transaction(() => {
      const job = this.job(id);
      if (job.sourceRevision !== expected.revision) throw new AppError(409, 'memory_impact_changed', message('memory.cleanup_changed'));
      const snapshot = this.current(job);
      this.checkReplay(job, snapshot, replay);
      const review = this.preparationDeletion(job, snapshot, replay?.plan ?? contextPlan(snapshot), replay);
      if (!review || JSON.stringify(review.preview) !== JSON.stringify(expected)) {
        throw new AppError(409, 'memory_impact_changed', message('memory.cleanup_changed'));
      }
      this.applyLayoutCleanup(job.chatId, review.deletion);
      if (review.regenerating) {
        this.saveState(job.chatId, summariesDeletion(review.working, review.roots).after, job.generationId);
      }
      this.saveJob(this.bump(job));
    })();
  }
  private assertPreparationDeletionReviewed(job: ContextJob, snapshot: EngineSnapshot, plan: ContextPlan, replay?: ReplayFrame) {
    if (this.preparationDeletion(job, snapshot, plan, replay)) throw new AppError(409, 'memory_impact_required', message('memory.review_cleanup_first'));
  }
  private workingEstimate(plan: ContextPlan) {
    return { inputTokens: plan.inputTokens, targetInputTokens: plan.targetInputTokens, operation: plan.next ? { level: plan.next.level } : null };
  }
  trackPlan(id: string, plan: ContextPlan, reusedCount?: number) {
    // Transient phases live in the coordinator. Keep the last authoritative
    // estimate and planned operation available after reconnect or restart.
    this.sqlite.prepare("UPDATE context_jobs SET data = json_set(data, '$.working', json(?), '$.reusedCount', coalesce(?, json_extract(data, '$.reusedCount'))) WHERE id = ? AND json_extract(data, '$.status') = 'running'")
      .run(JSON.stringify(this.workingEstimate(plan)), reusedCount ?? null, id);
  }
  begin(chatId: string, revision: number, requestId: string, mode: Exclude<ContextJob['mode'], 'refresh'>, generationId: string | null = null, loreResolution?: LoreResolution | null, retry?: SummaryRetry, automatic = false): { job: ContextJob; fresh: boolean } {
    return this.sqlite.transaction(() => {
      const command = JSON.stringify({ mode, generationId, ...(retry ? { retry } : {}), ...(automatic ? { automatic: true } : {}) });
      const existing = this.sqlite.prepare('SELECT data, chat_id, command FROM context_jobs WHERE request_id = ?').get(requestId) as (JsonRow & { chat_id: string; command: string }) | undefined;
      if (existing) {
        if (existing.chat_id !== chatId || existing.command !== command) throw new AppError(409, 'request_id_conflict', message("errors.this_request_identity_was_used_for_another_memory"));
        return { job: JSON.parse(existing.data) as ContextJob, fresh: false };
      }
      this.store.checkRevision(revision, chatId);
      if (generationId) {
        const generation = this.store.generation(generationId);
        if (!generation || generation.chatId !== chatId || generation.status !== 'running' || this.running(chatId)) throw new AppError(409, 'context_running', message("errors.another_operation_is_already_running_for_this_chat"));
      } else this.store.ensureIdle(chatId);
      const snapshot = { ...(generationId ? this.store.generationSnapshot(generationId) : this.store.engineSnapshot(chatId)), loreResolution: loreResolution ?? (generationId ? this.store.loreOperation(generationId) : null) }, preset = snapshot.context.preset;
      if (!hasPromptMarker(snapshot.sources.prompt, 'summary')) throw new AppError(422, 'summaries_disabled', message("errors.summaries_are_disabled_enable_a_summary_marker_in"));
      if (this.sqlite.prepare("SELECT id FROM context_jobs WHERE chat_id = ? AND json_extract(data, '$.status') = 'awaiting_review'").get(chatId)) throw new AppError(409, 'repair_awaits_review', message("errors.approve_or_discard_the_existing_repair_candidate_before"));
      if (!preset) throw new AppError(422, 'context_required', message("errors.select_a_context_preset_first"));
      if (mode !== 'repair') assertRefusalSelection(snapshot.context);
      const now = new Date().toISOString();
      const job: ContextJob = this.bump({ ...(retry ? { retry } : {}), ...(automatic ? { automatic: true as const } : {}), id: randomUUID(), chatId, status: 'running', mode, generationId, config: preset, sourceRevision: revision, historyTurnIds: snapshot.turns.map(turn => turn.id), stepCount: 0, error: null, createdAt: now, updatedAt: now,
        reusedCount: 0, generatedCount: 0 });
      this.store.saveLoreOperation(chatId, job.id, snapshot.loreResolution ?? null);
      this.sqlite.prepare('INSERT INTO context_jobs (id, chat_id, request_id, command, data) VALUES (?, ?, ?, ?, ?)').run(job.id, chatId, requestId, command, JSON.stringify(job));
      return { job, fresh: true };
    })();
  }
  reuseNext(jobId: string): boolean {
    return this.sqlite.transaction(() => {
      const job = this.job(jobId), snapshot = this.current(job), plan = contextPlan(snapshot);
      if (job.mode !== 'step' || plan.blocked || !plan.next) return false;
      const replacement = savedReplacement(snapshot, plan.next);
      if (!replacement) return false;
      const { node, state, inputAfter } = replacement;
      this.assertPreparationDeletionReviewed(job, snapshot, plan);
      const step: ContextStep = { id: randomUUID(), jobId, operation: plan.next, request: null, status: 'saved', result: { id: node.id, revision: node.revision }, error: null,
        before: { selected: snapshot.context.selected, archivedTurnIds: snapshot.context.archivedTurnIds }, after: { selected: state.selected, archivedTurnIds: state.archivedTurnIds },
        inputBefore: plan.inputTokens, inputAfter, createdAt: new Date().toISOString(), reused: true };
      this.saveState(job.chatId, state, job.generationId);
      this.sqlite.prepare('INSERT INTO context_steps (id, job_id, data) VALUES (?, ?, ?)').run(step.id, jobId, JSON.stringify(step));
      this.saveJob(this.bump({ ...job, stepCount: job.stepCount + 1, reusedCount: (job.reusedCount ?? 0) + 1,
        working: { inputTokens: inputAfter, targetInputTokens: plan.targetInputTokens, operation: null } }));
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
  beginStep(jobId: string, operation: ContextOperation, request: RequestPreview | null, inputBefore: number, replay?: ReplayFrame): ContextStep {
    return this.sqlite.transaction(() => {
      const job = this.job(jobId), snapshot = this.current(job);
      this.checkReplay(job, snapshot, replay);
      const plan = job.mode === 'repair' ? null : replay?.plan ?? contextPlan(snapshot);
      const expected = plan ? plan.next : nextRepair(snapshot.turns, snapshot.context, new Map());
      if (JSON.stringify(expected) !== JSON.stringify(operation) || plan?.blocked) throw new AppError(409, 'stale_context_result', message("errors.this_memory_operation_is_no_longer_eligible"));
      if (plan) this.assertPreparationDeletionReviewed(job, snapshot, plan, replay);
      const working = replay?.snapshot.context ?? snapshot.context;
      const step: ContextStep = { id: randomUUID(), jobId, operation, request, status: 'running', result: null, error: null,
        before: { selected: working.selected, archivedTurnIds: working.archivedTurnIds }, after: null, inputBefore: plan?.inputTokens ?? inputBefore, inputAfter: null, createdAt: new Date().toISOString() };
      this.sqlite.prepare('INSERT INTO context_steps (id, job_id, data) VALUES (?, ?, ?)').run(step.id, jobId, JSON.stringify(step));
      this.saveJob({ ...job, stepCount: job.stepCount + 1 });
      return step;
    })();
  }
  private pendingStep(jobId: string, id: string): ContextStep {
    const row = this.sqlite.prepare('SELECT data FROM context_steps WHERE id = ? AND job_id = ?').get(id, jobId) as JsonRow | undefined;
    const step = row ? JSON.parse(row.data) as ContextStep : null;
    if (!step || step.status !== 'running') throw new AppError(409, 'duplicate_context_result', message("errors.this_summary_step_has_already_been_resolved"));
    return step;
  }
  failAttempt(step: ContextStep, error: string | LocalizedMessage, rejectedText?: string) {
    const outcome = outcomeMessage(error);
    this.sqlite.transaction(() => {
      const job = this.job(step.jobId);
      this.current(job);
      const saved = this.pendingStep(job.id, step.id);
      this.saveStep({ ...saved, status: 'failed', ...outcome, ...(job.mode === 'repair' && rejectedText !== undefined ? { rejectedText } : {}) });
    })();
  }
  completeStep(attempt: ContextStep, text: string, prior: SummaryRef[], replay?: ReplayFrame): { node: SummaryNode } & ReplayRevisions {
    return this.sqlite.transaction(() => {
      const job = this.job(attempt.jobId), snapshot = this.current(job);
      this.checkReplay(job, snapshot, replay);
      const step = this.pendingStep(job.id, attempt.id);
      const working = replay?.snapshot.context ?? snapshot.context;
      if (JSON.stringify(step.before) !== JSON.stringify({ selected: working.selected, archivedTurnIds: working.archivedTurnIds })) throw new AppError(409, 'stale_selection', message("errors.the_selected_memory_changed_before_the_summary_was"));
      const repair = step.operation.repair;
      if (repair && JSON.stringify(nextRepair(snapshot.turns, snapshot.context, new Map())) !== JSON.stringify(step.operation)) throw new AppError(409, 'stale_context_result', message("errors.the_required_correction_or_repair_changed"));
      const inputs = repair ? repairInputs(snapshot, step.operation, this.sourceRequest(job.chatId, repair)) : null;
      const plan = repair ? null : replay?.plan ?? contextPlan(snapshot);
      if (plan && JSON.stringify(plan.next) !== JSON.stringify(step.operation)) throw new AppError(409, 'stale_context_result', message("errors.this_batch_is_no_longer_the_next_eligible"));
      if (plan) this.assertPreparationDeletionReviewed(job, snapshot, plan, replay);
      if (step.operation.turnIds.length && !validateSummary(text, 'stop').accepted) throw new AppError(502, 'invalid_summary', message("errors.the_candidate_summary_failed_validation"));
      const sourceIds = new Set(step.operation.turnIds);
      const sourceTurns = snapshot.turns.filter(turn => sourceIds.has(turn.id));
      if (sourceTurns.length !== sourceIds.size || sourceTurns.some(turn => !turn.complete)) throw new AppError(409, 'stale_sources', message("errors.the_summary_sources_changed"));
      if (step.request && JSON.stringify(step.request.coverage) !== JSON.stringify(sourceTurns.map(sourceOf))) throw new AppError(409, 'stale_sources', message("errors.the_source_revisions_changed_while_the_model_was"));
      const identity = repair?.id ?? randomUUID();
      const unchanged = Boolean(inputs && !inputs.rebuilding && inputs.known && inputs.structureUnchanged && text === inputs.old.text && step.operation.turnIds.length);
      const node: SummaryNode = { id: identity, revision: repair ? Math.max(...snapshot.context.summaries.filter(node => node.id === identity).map(node => node.revision)) + 1 : 0,
        level: step.operation.level, text, turns: sourceTurns.map(sourceOf), children: step.operation.children, prior,
        ...(inputs ? { corrections: inputs.corrections } : {}),
        approved: !repair || unchanged, createdAt: new Date().toISOString(), manual: inputs?.old.manual ?? false, ...(repair ? { basedOn: repair } : {}) };
      let after: ContextState | null = null, inputAfter: number | null = null;
      if (plan) {
        after = replaceSelection({ ...working, summaries: snapshot.context.summaries }, step.operation, node);
        if (replay) {
          inputAfter = this.measureReplaySelection(snapshot, after);
        } else {
          selectedContext(snapshot.turns, after);
          const connection = snapshot.connection;
          if (!connection) throw new AppError(422, 'connection_required', message("errors.select_a_roleplay_connection_to_measure_the_complete"));
          inputAfter = assembleRequest(connection, snapshot.settings, snapshot.turns, snapshot.sources, after,
            { validateLimits: false, lore: snapshot.loreResolution, continuationTurnId: snapshot.continuationTurnId }).budget.inputTokens;
        }
        if (plan.inputTokens !== step.inputBefore) throw new AppError(409, 'stale_context_result', message("errors.this_batch_is_no_longer_the_next_eligible"));
        if (inputAfter >= plan.inputTokens) throw new AppError(422, 'summary_no_savings', message("errors.the_summary_did_not_reduce_the_assembled_input"));
      }
      else if (unchanged) after = this.repairedState(snapshot, node);
      // Keep an existing candidate usable until regeneration succeeds.
      if (repair) this.discardCandidates(job.id);
      this.saveNode(job.chatId, node);
      let selectionRevision = snapshot.context.revision;
      // A replay can save an earlier batch before reaching a later approved correction.
      if (after && (!replay || this.canActivateProgress(job, snapshot, after))) {
        this.saveState(job.chatId, after, job.generationId);
        selectionRevision = after.revision;
      }
      this.saveStep({ ...step, status: repair && !unchanged ? 'candidate' : 'saved', result: { id: node.id, revision: node.revision }, after: after ? { selected: after.selected, archivedTurnIds: after.archivedTurnIds } : null, inputAfter, ...(unchanged ? { repairOutcome: 'model_unchanged' } : {}) });
      const updatedJob = this.bump({ ...job, generatedCount: (job.generatedCount ?? 0) + Number(Boolean(step.request)),
        unchangedCount: (job.unchangedCount ?? 0) + Number(unchanged),
        ...(plan && inputAfter !== null ? { working: { inputTokens: inputAfter, targetInputTokens: plan.targetInputTokens, operation: null } } : {}) });
      this.saveJob(updatedJob);
      return { node, sourceRevision: updatedJob.sourceRevision, selectionRevision };
    })();
  }

  activateReusedProgress(id: string, frame: ReplayFrame, reusedCount: number): ReplayRevisions | null {
    return this.sqlite.transaction(() => {
      const job = this.job(id), snapshot = this.current(job);
      this.checkReplay(job, snapshot, frame);
      const state = this.changedReplaySelection(snapshot, frame);
      if (!state || !this.canActivateProgress(job, snapshot, state)) return null;
      this.checkReplayInput(snapshot, state, frame);
      this.saveState(job.chatId, state);
      const updatedJob = this.bump({ ...job, reusedCount, working: this.workingEstimate(frame.plan) });
      this.saveJob(updatedJob);
      return { sourceRevision: updatedJob.sourceRevision, selectionRevision: state.revision };
    })();
  }
  finish(id: string, status: Exclude<ContextJob['status'], 'running'>, error: string | LocalizedMessage | null = null, replay?: { frame: ReplayFrame; reusedCount: number }) {
    const outcome = outcomeMessage(error);
    this.sqlite.transaction(() => {
      const row = this.sqlite.prepare('SELECT data FROM context_jobs WHERE id = ?').get(id) as JsonRow | undefined;
      if (!row) return;
      const job = JSON.parse(row.data) as ContextJob;
      if (job.status !== 'running') return;
      for (const step of this.steps(id)) if (step.status === 'running') this.saveStep({ ...step, status: status === 'interrupted' ? 'interrupted' : 'failed', ...outcome });
      let plan: ContextPlan | null = null;
      if (status === 'succeeded' && job.mode !== 'repair') {
        const snapshot = this.current(job);
        this.checkReplay(job, snapshot, replay?.frame);
        plan = replay?.frame.plan ?? contextPlan(snapshot);
        if (replay) this.publishReplay(job, snapshot, replay.frame);
      }
      if (job.mode === 'repair' && status === 'cancelled') this.discardCandidates(id);
      const keepCandidate = job.mode === 'repair' && (status === 'failed' || status === 'interrupted') && this.steps(id).some(step => step.status === 'candidate');
      this.saveJob(this.bump({ ...job, status: keepCandidate ? 'awaiting_review' : status, ...outcome,
        ...(replay ? { reusedCount: replay.reusedCount } : {}),
        ...(plan ? { outcome: { inputTokens: plan.inputTokens, verbatimTurns: plan.verbatimTurnIds.length } } : {}) }));
    })();
  }
  private publishReplay(job: ContextJob, snapshot: EngineSnapshot, frame: ReplayFrame) {
    const changed = this.changedReplaySelection(snapshot, frame);
    const state = changed ?? snapshot.context;
    assertCorrectionSelection(snapshot.turns, state);
    if (!frame.plan.ready || frame.plan.inputTokens > frame.plan.effectiveLimit) {
      throw new AppError(409, 'stale_context_result', message("errors.this_memory_operation_is_no_longer_eligible"));
    }
    this.checkReplayInput(snapshot, state, frame);
    if (changed) this.saveState(job.chatId, changed, job.generationId);
  }

  private changedReplaySelection(snapshot: EngineSnapshot, frame: ReplayFrame): ContextState | null {
    const { selected, archivedTurnIds } = frame.snapshot.context;
    if (JSON.stringify(selected) === JSON.stringify(snapshot.context.selected)
      && JSON.stringify(archivedTurnIds) === JSON.stringify(snapshot.context.archivedTurnIds)) return null;
    return { ...snapshot.context, selected, archivedTurnIds, revision: snapshot.context.revision + 1 };
  }

  private canActivateProgress(job: ContextJob, snapshot: EngineSnapshot, state: ContextState): boolean {
    return !this.isRegenerating(job) && !correctionProtection(snapshot.turns, state).unresolved.length;
  }

  private measureReplaySelection(snapshot: EngineSnapshot, state: ContextState): number {
    const { summaries } = selectedContext(snapshot.turns, state);
    const preset = snapshot.context.preset;
    if (!snapshot.connection || !preset || !hasChronologicalLevels(summaries)
      || hasPromptMarker(snapshot.sources.prompt, 'messages') && belowMinimumTail(snapshot.turns, state, preset.minTail)) {
      throw new AppError(409, 'stale_context_result', message("errors.this_memory_operation_is_no_longer_eligible"));
    }
    // Coverage and freshness were checked above. Measure even when a later correction is still pending.
    return assembleRequest(snapshot.connection, snapshot.settings, snapshot.turns, snapshot.sources, state,
      { validateLimits: false, allowStale: true, lore: snapshot.loreResolution, continuationTurnId: snapshot.continuationTurnId }).budget.inputTokens;
  }

  private checkReplayInput(snapshot: EngineSnapshot, state: ContextState, frame: ReplayFrame) {
    if (this.measureReplaySelection(snapshot, state) !== frame.plan.inputTokens) {
      throw new AppError(409, 'stale_context_result', message("errors.this_memory_operation_is_no_longer_eligible"));
    }
  }
  review(id: string, revision: number, accept: boolean, editedText?: string) {
    this.sqlite.transaction(() => {
      const job = this.job(id);
      this.store.checkRevision(revision, job.chatId); this.store.ensureIdle(job.chatId);
      if (job.status !== 'awaiting_review') throw new AppError(409, 'no_repair_candidate', message("errors.this_repair_no_longer_awaits_review"));
      if (accept) {
        const snapshot = this.current(job, true), step = [...this.steps(id)].reverse().find(step => step.status === 'candidate');
        if (!step?.result || !step.operation.repair) throw new AppError(409, 'missing_candidate', message("errors.the_repair_candidate_is_missing"));
        const candidate = nodeFor(snapshot.context, step.result);
        if (!candidate) throw new AppError(409, 'missing_candidate', message("errors.the_repair_candidate_is_missing"));
        if (editedText !== undefined && candidate.turns.length && !editedText.trim()) throw new AppError(400, 'blank_summary', message("errors.a_summary_covering_saved_turns_cannot_be_empty"));
        const normalized = editedText?.trim();
        const edited = normalized !== undefined && normalized !== candidate.text
          ? { ...candidate, text: normalized, manual: true, revision: Math.max(...snapshot.context.summaries.filter(node => node.id === candidate.id).map(node => node.revision)) + 1 }
          : candidate;
        const changed = edited.revision !== candidate.revision;
        const approved = { ...edited, approved: true, refusalCheck: checkSummaryRefusal(edited.text) };
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
      this.saveJob(this.bump({ ...job, reviewedCount: (job.reviewedCount ?? 0) + Number(accept), status: accept ? 'succeeded' : 'cancelled', error: accept ? null : message('outcome.repairDiscarded').fallback, errorMessage: accept ? undefined : message('outcome.repairDiscarded') }));
    })();
  }
  repairAction(id: string, revision: number, requestId: string, action: RepairAction, text?: string, loreResolution?: LoreResolution | null): { fresh: boolean; job: ContextJob } {
    return this.sqlite.transaction(() => {
      const job = this.job(id);
      if (job.mode !== 'repair') throw new AppError(409, 'not_repair_job', message("errors.this_operation_is_not_a_summary_repair"));
      const command = createHash('sha256').update(JSON.stringify({ action, text })).digest('hex');
      const recorded = job.repairCommands?.[requestId];
      if (recorded) {
        if (recorded !== command) throw new AppError(409, 'request_id_conflict', message("errors.this_request_identity_was_used_for_another_repair"));
        return { fresh: false, job };
      }
      if (action === 'close') {
        // Dismissal only touches unapproved work, so it also works after a source edit
        // or a generation finishing between the click and this command.
        if (job.status === 'running') this.finish(id, 'cancelled', message("interface.repair_closed_approved_replacements_remain_saved"));
        this.discardCandidates(id);
        const current = this.job(id);
        this.saveJob({ ...current, status: current.status === 'succeeded' ? 'succeeded' : 'cancelled', error: null, errorMessage: undefined, updatedAt: new Date().toISOString() });
      } else {
        this.store.checkRevision(revision, job.chatId); this.store.ensureIdle(job.chatId);
        if (this.sqlite.prepare("SELECT id FROM context_jobs WHERE chat_id = ? AND id != ? AND json_extract(data, '$.status') = 'awaiting_review'").get(job.chatId, id)) throw new AppError(409, 'repair_awaits_review', message("errors.another_repair_is_awaiting_review_close_it_before"));
        if (!['awaiting_review', 'failed', 'interrupted'].includes(job.status)) throw new AppError(409, 'inactive_context_job', message("errors.this_repair_is_no_longer_awaiting_an_action"));
        const snapshot = this.store.engineSnapshot(job.chatId);
        if (!hasPromptMarker(snapshot.sources.prompt, 'summary')) throw new AppError(422, 'summaries_disabled', message("errors.summaries_are_disabled_enable_a_summary_marker_before"));
        if (!snapshot.context.preset) throw new AppError(422, 'context_required', message("errors.select_a_context_preset_first"));
        if (action === 'regenerate') {
          if (snapshot.sources.lorebook && loreResolution === undefined) throw new AppError(422, 'lore_unresolved', message("errors.resolve_the_current_lorebook_before_retrying_repair"));
          this.store.replaceLoreOperation(job.chatId, id, loreResolution ?? null);
        }
        if (action === 'approve') this.review(id, revision, true, text);
        else if (job.sourceRevision !== revision) this.discardCandidates(id);
        const current = this.job(id), updated = this.store.engineSnapshot(job.chatId);
        const remaining = repairQueue(updated.turns, updated.context).length;
        this.saveJob(this.bump({ ...current, config: updated.context.preset!, status: remaining ? 'running' : 'succeeded', error: null, errorMessage: undefined }));
      }
      const current = this.job(id);
      this.saveJob({ ...current, repairCommands: { ...current.repairCommands, [requestId]: command } });
      return { fresh: true, job: this.job(id) };
    })();
  }
  deleteSummary(chatId: string, revision: number, ref: SummaryRef) {
    return this.sqlite.transaction(() => {
      this.store.checkRevision(revision, chatId);
      this.store.ensureIdle(chatId);
      this.ensureLayoutReviewClosed(chatId);
      const deletion = summaryDeletion(this.store.engineSnapshot(chatId).context, ref);
      return this.commitDeletion(chatId, deletion);
    })();
  }
  hasOpenLayoutReview(chatId: string) {
    return Boolean(this.sqlite.prepare("SELECT id FROM context_jobs WHERE chat_id = ? AND json_extract(data, '$.status') = 'awaiting_review'").get(chatId));
  }
  ensureLayoutReviewClosed(chatId: string) {
    if (this.hasOpenLayoutReview(chatId)) {
      throw new AppError(409, 'context_review_pending', message('memory.close_the_repair_review_before_deleting_summaries'));
    }
  }
  private deleteSummaryRecords(chatId: string, deletedIds: Set<string>) {
    const ids = JSON.stringify([...deletedIds]);
    this.sqlite.prepare(`UPDATE context_steps SET data = json_set(data, '$.resultDeleted', json('true'))
      WHERE job_id IN (SELECT id FROM context_jobs WHERE chat_id = ?)
      AND json_extract(data, '$.result.id') IN (SELECT value FROM json_each(?))`)
      .run(chatId, ids);
    this.sqlite.prepare('DELETE FROM summaries WHERE chat_id = ? AND id IN (SELECT value FROM json_each(?))').run(chatId, ids);
  }
  applyLayoutCleanup(chatId: string, deletion: MemoryLayoutCleanup) {
    if (deletion.deletedIds.size) this.deleteSummaryRecords(chatId, deletion.deletedIds);
    this.saveState(chatId, deletion.after);
  }
  private commitDeletion(chatId: string, deletion: MemoryLayoutCleanup) {
    this.applyLayoutCleanup(chatId, deletion);
    this.store.bumpRevision(chatId);
    return { deletedIds: [...deletion.deletedIds], restoredTurnIds: deletion.restoredTurnIds };
  }
  resolveRefusals(chatId: string, revision: number, filterVersion: number, refs: SummaryRef[], action: 'keep' | 'regenerate' | 'delete') {
    return this.sqlite.transaction(() => {
      this.store.checkRevision(revision, chatId);
      this.store.ensureIdle(chatId);
      if (this.sqlite.prepare("SELECT id FROM context_jobs WHERE chat_id = ? AND json_extract(data, '$.status') = 'awaiting_review'").get(chatId)) {
        throw new AppError(409, 'context_review_pending', message('refusals.close_repair_first'));
      }
      const snapshot = this.store.engineSnapshot(chatId);
      const latest = new Map(latestApproved(snapshot.context).map(node => [node.id, node]));
      const nodes = refs.map(ref => {
        const node = latest.get(ref.id);
        if (filterVersion !== summaryRefusalFilterVersion || !node || node.revision !== ref.revision || !unresolvedRefusal(node)) {
          throw new AppError(409, 'stale_refusal_review', message('refusals.review_changed'));
        }
        return node;
      });
      if (action === 'delete') return this.commitDeletion(chatId, summarySuffixDeletion(snapshot.context, snapshot.turns.map(turn => turn.id), refs));
      for (const node of nodes) {
        if (action === 'keep') {
          const check = summaryRefusalCheck(node);
          node.refusalCheck = check.result === 'suspected' ? { ...check, decision: 'keep' } : check;
          delete node.regeneration;
        } else node.regeneration = 'refusal';
        this.sqlite.prepare('UPDATE summaries SET data = ? WHERE chat_id = ? AND id = ? AND revision = ?').run(JSON.stringify(node), chatId, node.id, node.revision);
      }
      this.store.bumpRevision(chatId);
      return { ok: true };
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
      const state = this.store.engineSnapshot(chatId).context, old = nodeFor(state, ref);
      if (!old?.approved || state.summaries.some(node => node.id === ref.id && node.approved && node.revision > ref.revision)) throw new AppError(409, 'stale_summary', message("errors.this_is_not_the_current_approved_summary_revision"));
      if (!text.trim() || !old.turns.length) throw new AppError(400, 'blank_summary', message("errors.a_saved_summary_must_have_nonempty_text_and"));
      const normalized = text.trim();
      if (normalized === old.text) return { id: old.id, revision: old.revision };
      const node: SummaryNode = { ...old, regeneration: undefined, revision: Math.max(...state.summaries.filter(node => node.id === ref.id).map(node => node.revision)) + 1, text: normalized, manual: true, createdAt: new Date().toISOString(), basedOn: ref };
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
    for (const job of jobs) this.finish(job.id, 'interrupted', message("interface.the_server_stopped_during_preparation_saved_replacements_remain"));
  }
}
