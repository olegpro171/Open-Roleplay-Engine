import { randomUUID } from 'node:crypto';
import { message, type LocalizedMessage } from '../shared/localization.js';
import { defaultChatBehavior, type ChatBehavior } from '../shared/chat-behavior.js';
import type { EngineSnapshot } from '../shared/contracts.js';
import { assembleRequest } from '../core/prompt.js';
import { fitsInputTarget } from '../core/input-target.js';
import { setImmediate as yieldForCommands, setTimeout as delay } from 'node:timers/promises';
import { AppError } from '../core/errors.js';
import { contextPlan, summaryRequest } from '../core/context-plan.js';
import { PreparationReplay, type ReplayFrame } from '../core/context-replay.js';
import { belowMinimumTail, minimumTailDiagnostic, nextRepair } from '../core/context.js';
import { generateSummary, RefusedSummaryError } from './summarizer.js';
import type { Store } from '../persistence/store.js';
import type { Provider } from '../provider/openai.js';
import { preparationRunLimit, type ContextJob, type PreparationDeletionPreview, type RepairAction, type SummaryRetry, type SummaryNode, type SummaryPhase, type ContextJobProgress } from '../shared/context.js';
import { hasPromptMarker } from '../shared/library.js';
import type { LoreRegexPool } from './lore-regex.js';
import { resolveRequestLore } from './lore-resolution.js';
import type { LoreResolution } from '../shared/lorebook.js';

function preparationLimitReached() {
  return new AppError(422, 'preparation_run_limit', message('memory.preparation_run_limit', { limit: preparationRunLimit }));
}

export class ContextCoordinator {
  private active = new Map<string, { controller: AbortController; task: Promise<void>; generationId: string | null }>();
  private phases = new Map<string, SummaryPhase>();
  private retrying = new Set<string>();
  private deletionReviews = new Map<string, { token: string; preview: Omit<PreparationDeletionPreview, 'token'>; replay?: ReplayFrame; resume: () => void }>();
  private stopping = false;
  private preflights = new Set<AbortController>();
  constructor(private store: Store, private provider: Provider, private changed: (chatId: string) => void, private loreRegex: LoreRegexPool) {}
  liveProgress(id: string): Pick<ContextJobProgress, 'phase' | 'retrying' | 'deletionReviewToken'> {
    const review = this.deletionReviews.get(id);
    if (review) return { deletionReviewToken: review.token };
    return this.retrying.has(id) ? { retrying: true } : { phase: this.phases.get(id) };
  }
  deletionPreview(id: string): PreparationDeletionPreview {
    const review = this.deletionReviews.get(id);
    if (!review || this.store.contexts.job(id).status !== 'running') throw new AppError(409, 'memory_impact_changed', message('memory.cleanup_changed'));
    return { token: review.token, ...review.preview };
  }
  confirmDeletion(id: string, token: string) {
    const review = this.deletionReviews.get(id);
    if (this.stopping || !review || review.token !== token) throw new AppError(409, 'memory_impact_changed', message('memory.cleanup_changed'));
    this.store.contexts.confirmPreparationDeletion(id, review.preview, review.replay);
    this.deletionReviews.delete(id);
    review.resume();
  }
  private async waitForDeletionReview(job: ContextJob, preview: Omit<PreparationDeletionPreview, 'token'>, signal: AbortSignal, replay?: ReplayFrame) {
    if (signal.aborted || this.stopping) return;
    const token = randomUUID();
    let abort: (() => void) | undefined;
    try {
      await new Promise<void>(resolve => {
        abort = resolve;
        signal.addEventListener('abort', abort, { once: true });
        this.deletionReviews.set(job.id, { token, preview, replay, resume: resolve });
        this.changed(job.chatId);
      });
    } finally {
      if (abort) signal.removeEventListener('abort', abort);
      this.deletionReviews.delete(job.id);
    }
  }
  progress(id: string): ContextJobProgress {
    const { status, working } = this.store.contexts.job(id);
    return { status, ...(status === 'running' ? this.liveProgress(id) : {}), ...(working ? { working } : {}) };
  }
  hasActiveWork() { return this.active.size > 0 || this.preflights.size > 0; }
  async startResolved(chatId: string, revision: number, requestId: string, mode: Exclude<ContextJob['mode'], 'refresh'>, retry?: SummaryRetry) {
    if (this.stopping) throw new AppError(503, 'server_stopping', message("errors.the_server_is_stopping_retry_after_it_restarts"));
    const existing = this.store.contexts.commandJob(chatId, requestId, mode, retry);
    if (existing) return { jobId: existing.id };
    this.store.checkRevision(revision, chatId);
    const lore = await this.resolveLore(chatId);
    return this.start(chatId, revision, requestId, mode, lore, retry);
  }
  start(chatId: string, revision: number, requestId: string, mode: Exclude<ContextJob['mode'], 'refresh'>, lore?: LoreResolution | null, retry?: SummaryRetry) {
    if (this.stopping) throw new AppError(503, 'server_stopping', message("errors.the_server_is_stopping_retry_after_it_restarts"));
    const { job, fresh } = this.store.contexts.begin(chatId, revision, requestId, mode, null, lore, retry);
    if (fresh) this.dispatch(job.id);
    return { jobId: job.id };
  }
  repairAction(id: string, revision: number, requestId: string, action: RepairAction, text?: string) {
    const result = this.store.contexts.repairAction(id, revision, requestId, action, text);
    if (result.fresh && action === 'close') this.active.get(id)?.controller.abort();
    if (result.fresh && result.job.status === 'running') void this.dispatch(id);
    this.changed(result.job.chatId);
    return { jobId: id };
  }
  private async resolveLore(chatId: string) {
    const controller = new AbortController();
    this.preflights.add(controller);
    try {
      const lore = await resolveRequestLore(this.store.engineSnapshot(chatId), this.loreRegex, controller.signal);
      if (this.stopping || controller.signal.aborted) throw new AppError(503, 'server_stopping', message("errors.the_server_is_stopping_retry_after_it_restarts"));
      return lore;
    } finally { this.preflights.delete(controller); }
  }
  async repairActionResolved(id: string, revision: number, requestId: string, action: RepairAction, text?: string) {
    if (action !== 'regenerate' || this.store.contexts.job(id).repairCommands?.[requestId]) return this.repairAction(id, revision, requestId, action, text);
    if (this.stopping) throw new AppError(503, 'server_stopping', message("errors.the_server_is_stopping_retry_after_it_restarts"));
    const job = this.store.contexts.job(id);
    this.store.checkRevision(revision, job.chatId);
    const lore = await this.resolveLore(job.chatId);
    const result = this.store.contexts.repairAction(id, revision, requestId, action, text, lore);
    if (result.fresh && result.job.status === 'running') void this.dispatch(id);
    this.changed(result.job.chatId);
    return { jobId: id };
  }
  private dispatch(id: string, parentSignal?: AbortSignal): Promise<void> {
    const { chatId, generationId } = this.store.contexts.job(id);
    const controller = new AbortController();
    const signal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal;
    const task = Promise.resolve().then(() => this.run(id, chatId, signal))
      .finally(() => { if (this.active.get(id)?.controller === controller) this.active.delete(id); });
    this.active.set(id, { controller, task, generationId });
    this.changed(chatId);
    return task;
  }
  async prepareForGeneration(chatId: string, generationId: string, signal: AbortSignal, behavior: ChatBehavior) {
    if (signal.aborted || this.stopping) return;
    const snapshot = { ...this.store.generationSnapshot(generationId), loreResolution: this.store.loreOperation(generationId) };
    if (!snapshot.connection || !hasPromptMarker(snapshot.sources.prompt, 'summary') || !snapshot.context.preset) return;
    // Physical overflow is validated by final request assembly. It never adds
    // a preparation trigger when the working target permits this input.
    try {
      const request = assembleRequest(snapshot.connection, snapshot.settings, snapshot.turns, snapshot.sources, snapshot.context, { validateLimits: false, lore: snapshot.loreResolution });
      if (fitsInputTarget(request.budget.inputTokens, snapshot.settings.targetInputTokens, behavior)) {
        if (hasPromptMarker(snapshot.sources.prompt, 'messages') && belowMinimumTail(snapshot.turns, snapshot.context, snapshot.context.preset.minTail)) {
          throw new AppError(422, 'context_blocked', minimumTailDiagnostic);
        }
        return;
      }
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'correction_reconciliation_required') throw error;
      // The replay can include a fresh retained correction, or surface its
      // existing repair/deletion path if no valid representation is possible.
    }
    const retry = behavior.autoRetryMemory ? { maxRetries: behavior.memoryMaxRetries } : undefined;
    const { job, fresh } = this.store.contexts.begin(chatId, snapshot.revision, generationId, 'prepare', generationId, undefined, retry);
    if (fresh) await this.dispatch(job.id, signal);
    const completed = this.store.contexts.job(job.id);
    if (completed.status !== 'succeeded') throw new AppError(422, 'context_failed', completed.errorMessage ?? completed.error ?? message('memory.preparation_did_not_finish'));
  }
  async prepareAfterGeneration(chatId: string, generationId: string, behavior: ChatBehavior) {
    const snapshot = this.store.engineSnapshot(chatId);
    if (this.stopping || !snapshot.connection || !snapshot.context.preset || !hasPromptMarker(snapshot.sources.prompt, 'summary')) return;
    let lore: LoreResolution | null = null;
    let failure: string | LocalizedMessage | undefined;
    try {
      if (snapshot.sources.lorebook) lore = await this.resolveLore(chatId);
      const request = assembleRequest(snapshot.connection, snapshot.settings, snapshot.turns, snapshot.sources, snapshot.context, { validateLimits: false, allowStale: true, lore });
      if (request.budget.inputTokens <= snapshot.settings.targetInputTokens) return;
    } catch (error) {
      failure = error instanceof AppError ? error.localized ?? error.message : message('diagnostics.memory_preparation_failed_check_the_connection_and_retry');
    }
    if (this.stopping) return;
    // Lore resolution can yield. A newer command owns the chat if it changed
    // in that interval; its own Send/completion checks will govern preparation.
    if (!this.postResponseStillCurrent(snapshot, generationId)) return;
    const retry = behavior.autoRetryMemory ? { maxRetries: behavior.memoryMaxRetries } : undefined;
    const { job, fresh } = this.store.contexts.begin(chatId, snapshot.revision, `after:${generationId}`, 'prepare', null, lore, retry, true);
    if (!fresh) return;
    if (failure) {
      this.store.contexts.finish(job.id, 'failed', failure);
      this.changed(chatId);
      return;
    }
    void this.dispatch(job.id);
  }
  private postResponseStillCurrent(snapshot: EngineSnapshot, generationId: string): boolean {
    if (this.store.generation(generationId)?.status !== 'succeeded') return false;
    try {
      this.store.checkRevision(snapshot.revision, snapshot.id);
      this.store.ensureIdle(snapshot.id);
      return true;
    } catch (error) {
      if (error instanceof AppError && ['revision_conflict', 'generation_running', 'context_running'].includes(error.code)) return false;
      throw error;
    }
  }
  private async run(id: string, chatId: string, signal: AbortSignal) {
    let replay: PreparationReplay | undefined;
    let reusedCount = 0;
    let consideredReuseCount = 0;
    try {
      while (!signal.aborted && !this.stopping) {
        let job = this.store.contexts.job(id);
        if (job.status !== 'running') return;
        let committed = this.store.contexts.operationSnapshot(id);
        if (job.mode === 'prepare' && !replay) {
          const savedLayout = job.generationId && this.store.generation(job.generationId)?.kind === 'regeneration'
            ? this.store.contexts.savedState(job.chatId) : committed.context;
          replay = new PreparationReplay(committed, savedLayout);
          this.store.contexts.trackPlan(id, replay.next().plan);
          this.changed(chatId);
        }
        let unreported = 0;
        while (replay?.advanceSaved()) {
          reusedCount++;
          if (++unreported % 32 === 0) {
            await yieldForCommands();
            if (signal.aborted || this.stopping) break;
          }
        }
        if (signal.aborted || this.stopping) break;
        let frame = replay?.next();
        // Publish consecutive saved steps together before waiting on a provider or a review.
        // A fitting replay is published by finish, including runs with no selection change.
        if (replay && frame && !frame.plan.ready && reusedCount !== consideredReuseCount) {
          consideredReuseCount = reusedCount;
          const revisions = this.store.contexts.activateReusedProgress(id, frame, reusedCount);
          if (revisions) {
            replay.updateRevisions(revisions);
            frame = replay.next();
            job = this.store.contexts.job(id);
            committed = this.store.contexts.operationSnapshot(id);
            this.changed(chatId);
          }
        }
        const snapshot = frame?.snapshot ?? committed;
        const plan = frame?.plan ?? contextPlan(snapshot);
        const replacements = new Map();
        const repairing = job.mode === 'repair';
        const operation = repairing ? nextRepair(snapshot.turns, snapshot.context, replacements) : plan.next;
        if (!repairing) {
          this.store.contexts.trackPlan(id, plan, replay ? reusedCount : undefined);
          if (operation && !frame?.saved && job.stepCount >= preparationRunLimit) throw preparationLimitReached();
          const deletion = this.store.contexts.previewPreparationDeletion(job, committed, plan, frame);
          if (deletion) {
            await this.waitForDeletionReview(job, deletion, signal, frame);
            replay = undefined;
            reusedCount = 0;
            consideredReuseCount = 0;
            continue;
          }
          if (plan.blocked) throw new AppError(422, 'context_blocked', plan.blockedMessage ?? plan.blocked);
        }
        // Measure first. A fitting request after the last allowed step succeeds.
        if (!operation) {
          this.store.contexts.finish(id, 'succeeded', null, frame ? { frame, reusedCount } : undefined);
          this.changed(chatId);
          return;
        }
        if (replay && frame?.saved) {
          replay.advance(frame, frame.saved);
          reusedCount++;
          await yieldForCommands();
          continue;
        }
        if (repairing && this.store.contexts.revalidateRepair(id)) { this.changed(chatId); await yieldForCommands(); continue; }
        if (job.mode === 'step' && plan.reusable && this.store.contexts.reuseNext(id)) {
          this.changed(chatId);
          this.store.contexts.finish(id, 'succeeded');
          this.changed(chatId);
          return;
        }
        const connectionId = job.config.connectionId ?? (snapshot.settings.connectionId === undefined ? 'main' : snapshot.settings.connectionId);
        if (operation.turnIds.length && !connectionId) throw new AppError(422, 'summary_connection_required', message("errors.select_a_roleplay_connection_to_measure_the_complete"));
        const connection = operation.turnIds.length && connectionId ? this.store.connection(connectionId) : null;
        const prepared = connection ? summaryRequest(snapshot, operation, connection, replacements, operation.repair ? this.store.contexts.sourceRequest(job.chatId, operation.repair) : null) : { request: null, prior: [] };
        const maxRetries = !repairing && job.retry ? job.retry.maxRetries || defaultChatBehavior.memoryMaxRetries : 0;
        let retries = 0;
        let saved: SummaryNode | undefined;
        while (!signal.aborted && !this.stopping) {
          const step = this.store.contexts.beginStep(id, operation, prepared.request, plan.inputTokens, frame);
          if (prepared.request) this.phases.set(id, 'connecting');
          this.changed(chatId);
          if (signal.aborted || this.stopping) break;
          let text: string;
          try {
            text = prepared.request && connectionId ? await generateSummary(this.provider, prepared.request, this.store.connectionApiKey(connectionId), signal, phase => {
              if (this.phases.get(id) === phase) return;
              this.phases.set(id, phase);
              this.changed(chatId);
            }) : '';
          } catch (error) {
            // Retry only provider/output failures. Planning and commit failures need user action.
            if (signal.aborted || this.stopping || !(error instanceof AppError) || error.status !== 502) throw error;
            this.store.contexts.failAttempt(step, error.localized ?? error.message, repairing && error instanceof RefusedSummaryError ? error.rejectedText : undefined);
            if (retries >= maxRetries) throw error;
            if (job.stepCount + retries + 1 >= preparationRunLimit) throw preparationLimitReached();
            retries++;
            this.phases.delete(id);
            this.retrying.add(id);
            this.changed(chatId);
            try { await delay(1000, undefined, { signal }); }
            finally { this.retrying.delete(id); }
            continue;
          }
          if (signal.aborted || this.stopping) break;
          const result = this.store.contexts.completeStep(step, text, prepared.prior, frame);
          saved = result.node;
          if (replay && frame) {
            replay.advance(frame, saved);
            replay.updateRevisions(result);
          }
          this.phases.delete(id);
          break;
        }
        if (!saved) break;
        this.changed(chatId);
        if (repairing) {
          if (saved.approved) { await yieldForCommands(); continue; }
          this.store.contexts.finish(id, 'awaiting_review'); this.changed(chatId); return;
        }
        if (job.mode === 'step') { this.store.contexts.finish(id, 'succeeded'); this.changed(chatId); return; }
        await yieldForCommands();
      }
      if (!this.stopping) this.store.contexts.finish(id, 'cancelled', message("interface.preparation_stopped_previously_saved_replacements_remain_selected_resume"));
    } catch (error) {
      if (!this.stopping) this.store.contexts.finish(id, signal.aborted ? 'cancelled' : 'failed', error instanceof AppError ? error.localized ?? error.message : message("diagnostics.memory_preparation_failed_check_the_connection_and_retry"));
    } finally { this.phases.delete(id); this.changed(chatId); }
  }
  cancel(id: string) {
    const operation = this.active.get(id), job = this.store.contexts.job(id);
    if (!operation || job.status !== 'running') throw new AppError(409, 'inactive_context_job', message("errors.this_memory_operation_is_no_longer_running"));
    if (job.generationId) throw new AppError(409, 'response_owns_preparation', message("errors.cancel_the_running_response_to_stop_its_memory"));
    this.store.contexts.finish(id, 'cancelled', message("interface.preparation_stopped_previously_saved_replacements_remain_selected_resume"));
    operation.controller.abort();
    this.changed(job.chatId);
  }
  cancelForGeneration(generationId: string) {
    for (const [id, operation] of this.active) {
      if (operation.generationId !== generationId) continue;
      const job = this.store.contexts.job(id);
      if (job.generationId !== generationId || job.status !== 'running') continue;
      operation.controller.abort();
      this.store.contexts.finish(id, 'cancelled', message("interface.the_owning_response_was_cancelled_committed_memory_remains"));
    }
  }
  async shutdown() {
    this.stopping = true;
    for (const controller of this.preflights) controller.abort();
    for (const operation of this.active.values()) operation.controller.abort();
    await Promise.allSettled([...this.active.values()].map(operation => operation.task));
  }
}
