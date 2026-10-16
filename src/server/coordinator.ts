import { EventEmitter } from 'node:events';
import { AppError } from '../core/errors.js';
import { assembleRequest } from '../core/prompt.js';
import type { Store } from '../persistence/store.js';
import type { Provider } from '../provider/openai.js';

export class GenerationCoordinator {
  readonly events = new EventEmitter();
  private active = new Map<string, { controller: AbortController; task: Promise<void>; text: string }>();
  private stopping = false;
  constructor(private store: Store, private provider: Provider) {
    store.recoverInterrupted();
    this.events.setMaxListeners(100);
  }
  changed() { this.events.emit('changed'); }

  start(revision: number, requestId: string, text?: string) {
    const result = this.store.begin(revision, requestId, text);
    if (result.fresh) {
      const operation = { controller: new AbortController(), task: Promise.resolve(), text: '' };
      this.active.set(result.id, operation);
      operation.task = this.run(result.id, operation).finally(() => this.active.delete(result.id));
      this.changed();
    }
    return { generationId: result.id };
  }
  private async run(id: string, operation: { controller: AbortController; text: string }) {
    try {
      const snapshot = this.store.snapshot();
      const request = assembleRequest(snapshot.connection!, snapshot.settings, snapshot.turns);
      this.store.saveRequest(id, request);
      this.changed();
      let lastCheckpoint = 0;
      await this.provider.stream(request, this.store.apiKey(), operation.controller.signal, (delta) => {
        if (operation.controller.signal.aborted) return;
        operation.text += delta;
        if (Date.now() - lastCheckpoint >= 250) {
          this.store.checkpoint(id, operation.text);
          lastCheckpoint = Date.now();
          this.changed();
        }
      });
      if (!this.stopping && !operation.controller.signal.aborted) {
        this.store.finish(id, 'succeeded', operation.text);
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
    this.store.finish(id, 'cancelled', operation.text, 'Response cancelled. Retry explicitly to send a new model request.');
    operation.controller.abort();
    this.changed();
  }
  async shutdown() {
    this.stopping = true;
    for (const [id, operation] of this.active) {
      this.store.checkpoint(id, operation.text);
      operation.controller.abort();
    }
    await Promise.allSettled([...this.active.values()].map((operation) => operation.task));
    this.events.emit('shutdown');
  }
}
