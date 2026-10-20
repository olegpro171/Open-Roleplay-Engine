import { setTimeout as delay } from 'node:timers/promises';
import { AppError } from '../core/errors.js';
import { contextPlan, summaryRequest } from '../core/context-plan.js';
import { nextRepair } from '../core/context.js';
import { generateSummary } from './summarizer.js';
import type { Store } from '../persistence/store.js';
import type { Provider } from '../provider/openai.js';
import type { ContextJob, RepairAction, SummaryRetry, SummaryNode } from '../shared/context.js';
import { hasPromptMarker } from '../shared/library.js';
import type { LoreRegexPool } from './lore-regex.js';
import { resolveRequestLore } from './lore-resolution.js';
import type { LoreResolution } from '../shared/lorebook.js';

export class ContextCoordinator {
  private active = new Map<string, { controller: AbortController; task: Promise<void>; generationId: string | null }>();
  private stopping = false;
  private preflights = new Set<AbortController>();
  constructor(private store: Store, private provider: Provider, private changed: () => void, private loreRegex: LoreRegexPool) {}
  hasActiveWork() { return this.active.size > 0 || this.preflights.size > 0; }
  async startResolved(chatId: string, revision: number, requestId: string, mode: Exclude<ContextJob['mode'], 'refresh'>, retry?: SummaryRetry) {
    if (this.stopping) throw new AppError(503, 'server_stopping', 'The server is stopping. Retry after it restarts.');
    const existing = this.store.contexts.commandJob(chatId, requestId, mode, retry);
    if (existing) return { jobId: existing.id };
    this.store.checkRevision(revision, chatId);
    const lore = await this.resolveLore(chatId);
    return this.start(chatId, revision, requestId, mode, lore, retry);
  }
  start(chatId: string, revision: number, requestId: string, mode: Exclude<ContextJob['mode'], 'refresh'>, lore?: LoreResolution | null, retry?: SummaryRetry) {
    if (this.stopping) throw new AppError(503, 'server_stopping', 'The server is stopping. Retry after it restarts.');
    const { job, fresh } = this.store.contexts.begin(chatId, revision, requestId, mode, null, lore, retry);
    if (fresh) this.dispatch(job.id);
    return { jobId: job.id };
  }
  repairAction(id: string, revision: number, requestId: string, action: RepairAction, text?: string) {
    const result = this.store.contexts.repairAction(id, revision, requestId, action, text);
    if (result.fresh && action === 'close') this.active.get(id)?.controller.abort();
    if (result.fresh && result.job.status === 'running') void this.dispatch(id);
    this.changed();
    return { jobId: id };
  }
  private async resolveLore(chatId: string) {
    const controller = new AbortController();
    this.preflights.add(controller);
    try {
      const lore = await resolveRequestLore(this.store.snapshot(chatId), this.loreRegex, controller.signal);
      if (this.stopping || controller.signal.aborted) throw new AppError(503, 'server_stopping', 'The server is stopping. Retry after it restarts.');
      return lore;
    } finally { this.preflights.delete(controller); }
  }
  async repairActionResolved(id: string, revision: number, requestId: string, action: RepairAction, text?: string) {
    if (action !== 'regenerate' || this.store.contexts.job(id).repairCommands?.[requestId]) return this.repairAction(id, revision, requestId, action, text);
    if (this.stopping) throw new AppError(503, 'server_stopping', 'The server is stopping. Retry after it restarts.');
    const job = this.store.contexts.job(id);
    this.store.checkRevision(revision, job.chatId);
    const lore = await this.resolveLore(job.chatId);
    const result = this.store.contexts.repairAction(id, revision, requestId, action, text, lore);
    if (result.fresh && result.job.status === 'running') void this.dispatch(id);
    this.changed();
    return { jobId: id };
  }
  private dispatch(id: string, parentSignal?: AbortSignal): Promise<void> {
    const controller = new AbortController();
    const signal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal;
    const task = this.run(id, signal).finally(() => { if (this.active.get(id)?.controller === controller) this.active.delete(id); });
    this.active.set(id, { controller, task, generationId: this.store.contexts.job(id).generationId }); this.changed();
    return task;
  }
  async prepareForGeneration(chatId: string, generationId: string, signal: AbortSignal) {
    const snapshot = { ...this.store.generationSnapshot(generationId), loreResolution: this.store.loreOperation(generationId) };
    if (!hasPromptMarker(snapshot.sources.prompt, 'summary') || !snapshot.context.preset) return;
    const plan = contextPlan(snapshot);
    if (plan.blocked) throw new AppError(422, 'context_blocked', plan.blocked);
    if (plan.ready) return;
    const { job, fresh } = this.store.contexts.begin(chatId, snapshot.revision, generationId, 'prepare', generationId);
    if (fresh) await this.dispatch(job.id, signal);
    const completed = this.store.contexts.job(job.id);
    if (completed.status !== 'succeeded') throw new AppError(422, 'context_failed', completed.error ?? 'Context preparation did not finish. Resume from Memory before retrying the response.');
  }
  private async run(id: string, signal: AbortSignal) {
    try {
      while (!signal.aborted && !this.stopping) {
        const job = this.store.contexts.job(id), snapshot = this.store.contexts.operationSnapshot(id);
        const plan = contextPlan(snapshot);
        const replacements = new Map();
        const operation = job.mode === 'repair' ? nextRepair(snapshot.turns, snapshot.context, replacements) : plan.next;
        if (job.mode !== 'repair' && plan.blocked) throw new AppError(422, 'context_blocked', plan.blocked);
        if (!operation) { this.store.contexts.finish(id, 'succeeded'); this.changed(); return; }
        if (job.mode === 'repair' && this.store.contexts.revalidateRepair(id)) { this.changed(); await new Promise<void>(resolve => setImmediate(resolve)); continue; }
        if (job.mode !== 'repair' && this.store.contexts.reuseNext(id)) {
          this.changed();
          if (job.mode === 'step') { this.store.contexts.finish(id, 'succeeded'); this.changed(); return; }
          continue;
        }
        if (operation.turnIds.length && !job.config.connectionId) throw new AppError(422, 'summary_connection_required', 'Select a summarization Connection in the context preset to generate missing summaries.');
        const connection = operation.turnIds.length ? this.store.connection(job.config.connectionId!) : null;
        const prepared = connection ? summaryRequest(snapshot, operation, connection, replacements, operation.repair ? this.store.contexts.sourceRequest(job.chatId, operation.repair) : null) : { request: null, prior: [] };
        let retries = 0;
        let saved: SummaryNode | undefined;
        while (true) {
          const step = this.store.contexts.beginStep(id, operation, prepared.request, plan.inputTokens);
          this.changed();
          let text: string;
          try {
            text = prepared.request ? await generateSummary(this.provider, prepared.request, this.store.connectionApiKey(job.config.connectionId!), signal) : '';
          } catch (error) {
            // Retry only provider/output failures. Planning and commit failures need user action.
            if (signal.aborted || this.stopping || !(error instanceof AppError) || error.status !== 502) throw error;
            this.store.contexts.failAttempt(step, error.message);
            this.changed();
            if (!job.retry || job.retry.maxRetries !== 0 && retries >= job.retry.maxRetries) throw error;
            retries++;
            await delay(1000, undefined, { signal });
            continue;
          }
          if (signal.aborted || this.stopping) break;
          saved = this.store.contexts.completeStep(step, text, prepared.prior);
          break;
        }
        if (!saved) break;
        this.changed();
        if (job.mode === 'repair') {
          if (saved.approved) { await new Promise<void>(resolve => setImmediate(resolve)); continue; }
          this.store.contexts.finish(id, 'awaiting_review'); this.changed(); return;
        }
        if (job.mode === 'step') { this.store.contexts.finish(id, 'succeeded'); this.changed(); return; }
      }
      if (!this.stopping) this.store.contexts.finish(id, 'cancelled', 'Preparation stopped. Previously saved replacements remain selected. Resume explicitly.');
    } catch (error) {
      if (!this.stopping) this.store.contexts.finish(id, signal.aborted ? 'cancelled' : 'failed', error instanceof AppError ? error.message : 'Memory preparation failed. Check the Connection and retry; selected sources remain available.');
    } finally { this.changed(); }
  }
  cancel(id: string) {
    const operation = this.active.get(id), job = this.store.contexts.job(id);
    if (!operation || job.status !== 'running') throw new AppError(409, 'inactive_context_job', 'This memory operation is no longer running.');
    if (job.generationId) throw new AppError(409, 'response_owns_preparation', 'Cancel the running response to stop its memory preparation.');
    operation.controller.abort();
    this.store.contexts.finish(id, 'cancelled', 'Preparation stopped. Previously saved replacements remain selected. Resume explicitly.');
    this.changed();
  }
  cancelForGeneration(generationId: string) {
    for (const [id, operation] of this.active) {
      if (operation.generationId !== generationId) continue;
      const job = this.store.contexts.job(id);
      if (job.generationId !== generationId || job.status !== 'running') continue;
      operation.controller.abort();
      this.store.contexts.finish(id, 'cancelled', 'The owning response was cancelled. Committed memory remains selected.');
    }
  }
  async shutdown() {
    this.stopping = true;
    for (const controller of this.preflights) controller.abort();
    for (const operation of this.active.values()) operation.controller.abort();
    await Promise.allSettled([...this.active.values()].map(operation => operation.task));
  }
}
