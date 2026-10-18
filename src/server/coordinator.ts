import { EventEmitter } from 'node:events';
import { AppError } from '../core/errors.js';
import { assembleRequest } from '../core/prompt.js';
import type { Store } from '../persistence/store.js';
import type { Provider } from '../provider/openai.js';
import { ContextCoordinator } from './context-coordinator.js';
import { LoreRegexPool } from './lore-regex.js';
import { resolveRequestLore } from './lore-resolution.js';

export class GenerationCoordinator {
  readonly events = new EventEmitter();
  private active = new Map<string, { controller: AbortController; task: Promise<void>; text: string }>();
  private stopping = false;
  readonly context: ContextCoordinator;
  readonly loreRegex = new LoreRegexPool();
  constructor(private store: Store, private provider: Provider) {
    store.recoverInterrupted();
    this.context = new ContextCoordinator(store, provider, () => this.changed(), this.loreRegex);
    this.events.setMaxListeners(100);
  }
  changed() { this.events.emit('changed'); }

  start(revision: number, requestId: string, text?: string, chatId = 'main') {
    if (this.stopping) throw new AppError(503, 'server_stopping', 'The server is stopping. Retry after it restarts.');
    const result = this.store.begin(revision, requestId, text, chatId);
    if (result.fresh) {
      const operation = { controller: new AbortController(), task: Promise.resolve(), text: '' };
      this.active.set(result.id, operation);
      operation.task = this.run(result.id, operation, chatId).finally(() => this.active.delete(result.id));
      this.changed();
    }
    return { generationId: result.id };
  }
  private async run(id: string, operation: { controller: AbortController; text: string }, chatId: string) {
    try {
      const initial = this.store.snapshot(chatId);
      const loreResolution = await resolveRequestLore(initial, this.loreRegex, operation.controller.signal);
      if (this.stopping || operation.controller.signal.aborted) return;
      this.store.saveLoreOperation(chatId, id, loreResolution);
      await this.context.prepareForGeneration(chatId, id, operation.controller.signal);
      if (this.stopping || operation.controller.signal.aborted) return;
      const snapshot = this.store.snapshot(chatId);
      const request = assembleRequest(snapshot.connection!, snapshot.settings, snapshot.turns, snapshot.sources, snapshot.context, { lore: loreResolution });
      this.store.saveRequest(id, request);
      this.changed();
      let lastCheckpoint = 0;
      const completion = await this.provider.stream(request, this.store.apiKey(chatId), operation.controller.signal, (delta) => {
        if (operation.controller.signal.aborted) return;
        operation.text += delta;
        if (Date.now() - lastCheckpoint >= 250) {
          this.store.checkpoint(id, operation.text);
          lastCheckpoint = Date.now();
          this.changed();
        }
      });
      if (!this.stopping && !operation.controller.signal.aborted) {
        this.store.finish(id, 'succeeded', operation.text, null, completion?.usage ?? null);
        this.changed();
      }
    } catch (error) {
      if (this.stopping) return;
      // Never persist upstream response bodies or raw transport errors: they may contain secrets.
      const message = error instanceof AppError ? error.message : 'The model request failed or timed out. Check the Connection and retry.';
      this.store.finish(id, 'failed', operation.text, message);
      this.changed();
    }
  }
  cancel(id: string) {
    const operation = this.active.get(id);
    if (!operation || this.store.generation(id)?.status !== 'running') throw new AppError(409, 'inactive_generation', 'This response is no longer active.');
    this.store.finish(id, 'cancelled', operation.text, 'Response cancelled. Generate response before next turn.');
    operation.controller.abort();
    this.context.cancelForGeneration(id);
    this.changed();
  }
  async shutdown() {
    this.stopping = true;
    for (const [id, operation] of this.active) {
      this.store.checkpoint(id, operation.text);
      operation.controller.abort();
    }
    await this.context.shutdown();
    await this.loreRegex.close();
    await Promise.allSettled([...this.active.values()].map((operation) => operation.task));
    this.events.emit('shutdown');
  }
}
