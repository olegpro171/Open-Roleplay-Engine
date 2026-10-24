import { message } from '../shared/localization.js';
import { EventEmitter } from 'node:events';
import { AppError } from '../core/errors.js';
import { assembleRequest } from '../core/prompt.js';
import type { Store } from '../persistence/store.js';
import type { Provider } from '../provider/openai.js';
import { ContextCoordinator } from './context-coordinator.js';
import { LoreRegexPool } from './lore-regex.js';
import { resolveRequestLore } from './lore-resolution.js';
import { defaultChatBehavior, type ChatBehavior } from '../shared/chat-behavior.js';

export class GenerationCoordinator {
  readonly events = new EventEmitter();
  private active = new Map<string, { controller: AbortController; task: Promise<void>; text: string; reasoning: string }>();
  private stopping = false;
  readonly context: ContextCoordinator;
  readonly loreRegex = new LoreRegexPool();
  constructor(private store: Store, private provider: Provider, private behavior: () => ChatBehavior = () => defaultChatBehavior) {
    store.recoverInterrupted();
    this.context = new ContextCoordinator(store, provider, () => this.changed(), this.loreRegex);
    this.events.setMaxListeners(100);
  }
  hasActiveWork() { return this.active.size > 0 || this.context.hasActiveWork(); }
  changed() { this.events.emit('changed'); }
  reasoningText(id: string) { return this.active.get(id)?.reasoning ?? ''; }
  partialText(id: string) { return this.active.get(id)?.text ?? ''; }

  start(revision: number, requestId: string, text?: string, chatId = 'main') {
    if (this.stopping) throw new AppError(503, 'server_stopping', message("errors.the_server_is_stopping_retry_after_it_restarts"));
    const result = this.store.begin(revision, requestId, text, chatId);
    return this.dispatch(result, chatId);
  }
  regenerate(revision: number, requestId: string, turnId: string, chatId: string) {
    if (this.stopping) throw new AppError(503, 'server_stopping', message("errors.the_server_is_stopping_retry_after_it_restarts"));
    return this.dispatch(this.store.beginRegeneration(revision, requestId, turnId, chatId), chatId);
  }
  private dispatch(result: { id: string; fresh: boolean }, chatId: string) {
    if (result.fresh) {
      const operation = { controller: new AbortController(), task: Promise.resolve(), text: '', reasoning: '' };
      this.active.set(result.id, operation);
      operation.task = this.run(result.id, operation, chatId).finally(() => this.active.delete(result.id));
      this.changed();
    }
    return { generationId: result.id };
  }
  private async run(id: string, operation: { controller: AbortController; text: string; reasoning: string }, chatId: string) {
    let updateTimer: ReturnType<typeof setTimeout> | undefined;
    const clearUpdateTimer = () => clearTimeout(updateTimer);
    operation.controller.signal.addEventListener('abort', clearUpdateTimer, { once: true });
    try {
      const behavior = this.behavior();
      const initial = this.store.generationSnapshot(id);
      const loreResolution = await resolveRequestLore(initial, this.loreRegex, operation.controller.signal);
      if (this.stopping || operation.controller.signal.aborted) return;
      this.store.saveLoreOperation(chatId, id, loreResolution);
      await this.context.prepareForGeneration(chatId, id, operation.controller.signal, behavior);
      if (this.stopping || operation.controller.signal.aborted) return;
      const snapshot = this.store.generationSnapshot(id);
      const request = assembleRequest(snapshot.connection!, snapshot.settings, snapshot.turns, snapshot.sources, snapshot.context, { lore: loreResolution, overshoot: behavior });
      this.store.saveRequest(id, request);
      this.changed();
      let lastCheckpoint = 0;
      const publish = () => {
        if (Date.now() - lastCheckpoint >= 250) {
          clearTimeout(updateTimer);
          updateTimer = undefined;
          this.store.checkpoint(id, operation.text, operation.reasoning);
          lastCheckpoint = Date.now();
          this.changed();
        } else if (!updateTimer) {
          updateTimer = setTimeout(() => {
            updateTimer = undefined;
            if (!operation.controller.signal.aborted && !this.stopping) this.changed();
          }, 250 - (Date.now() - lastCheckpoint));
        }
      };
      const completion = await this.provider.stream(request, this.store.apiKey(chatId), operation.controller.signal, delta => {
        if (operation.controller.signal.aborted) return;
        operation.text += delta;
        publish();
      }, delta => {
        if (operation.controller.signal.aborted) return;
        operation.reasoning += delta;
        publish();
      });
      if (!this.stopping && !operation.controller.signal.aborted) {
        this.store.finish(id, 'succeeded', operation.text, null, completion?.usage ?? null, operation.reasoning);
        this.changed();
        // This is a separate ordinary memory job. Its Stop/failure/restart
        // outcome cannot change the response that was already committed.
        await this.context.prepareAfterGeneration(chatId, id, behavior);
        this.changed();
      }
    } catch (error) {
      if (this.stopping) return;
      // Never persist upstream response bodies or raw transport errors: they may contain secrets.
      const diagnostic = error instanceof AppError ? error.localized ?? error.message : message("diagnostics.the_model_request_failed_or_timed_out_check");
      this.store.finish(id, 'failed', operation.text, diagnostic, null, operation.reasoning);
      this.changed();
    } finally {
      clearUpdateTimer();
      operation.controller.signal.removeEventListener('abort', clearUpdateTimer);
    }
  }
  cancel(id: string) {
    const operation = this.active.get(id);
    if (!operation || this.store.generation(id)?.status !== 'running') throw new AppError(409, 'inactive_generation', message("errors.this_response_is_no_longer_active"));
    this.store.finish(id, 'cancelled', operation.text, this.store.generation(id)?.kind === 'regeneration' ? message("diagnostics.regeneration_cancelled_the_selected_response_was_kept") : message("app.response_cancelled_generate_response_before_next_turn"), null, operation.reasoning);
    operation.controller.abort();
    this.context.cancelForGeneration(id);
    this.changed();
  }
  async shutdown() {
    this.stopping = true;
    for (const [id, operation] of this.active) {
      this.store.checkpoint(id, operation.text, operation.reasoning);
      operation.controller.abort();
    }
    await this.context.shutdown();
    await this.loreRegex.close();
    await Promise.allSettled([...this.active.values()].map((operation) => operation.task));
    this.events.emit('shutdown');
  }
}
