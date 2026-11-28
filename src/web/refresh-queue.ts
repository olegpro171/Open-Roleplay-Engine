import type { Change } from '../shared/changes';

export type RefreshScope = Partial<Record<'story' | 'library' | 'tools' | 'appearance' | 'chat-defaults' | 'chat-behavior', true>>;
export const workspaceRefresh: RefreshScope = { story: true, library: true, tools: true };
export const fullRefresh: RefreshScope = { ...workspaceRefresh, appearance: true, 'chat-defaults': true, 'chat-behavior': true };
export type ResumeRefresh = 'initial' | 'retry';
export type RefreshRequest = { scope: RefreshScope; resume?: ResumeRefresh };
type BatchWaiter = { resolve: () => void; reject: (error: unknown) => void };

export function mergeRefreshRequests(pending: RefreshRequest | null, incoming: RefreshRequest): RefreshRequest {
  return {
    scope: { ...pending?.scope, ...incoming.scope },
    resume: pending?.resume === 'retry' ? 'retry' : incoming.resume ?? pending?.resume,
  };
}

export function scopeForChange(change: Change, selectedChat: string | null, showingStory = true): RefreshScope | null {
  switch (change.kind) {
    case 'all': return fullRefresh;
    case 'library': return workspaceRefresh;
    case 'settings': return { [change.setting]: true };
    case 'draft': return null;
    case 'chat':
      if (change.detail === 'stream') return showingStory && change.chatId === selectedChat ? { story: true } : null;
      return change.chatId === selectedChat ? workspaceRefresh : { library: true };
  }
}

/** One read at a time; notifications arriving during it merge into one follow-up. */
export class RefreshQueue {
  private pending: RefreshRequest | null = null;
  private waiters: BatchWaiter[] = [];
  private activeRead: Promise<void> | null = null;
  private running: Promise<void> | null = null;
  constructor(private readonly read: (request: RefreshRequest) => Promise<void>) {}

  retryAfterResume(request: RefreshRequest): boolean {
    if (request.resume !== 'initial' && !this.pending?.resume) return false;
    // A resume already queued behind the timed-out read is the fresh attempt.
    void this.request(request.scope, 'retry');
    return true;
  }

  // A command waits for the batch that observes its acknowledgement. Later
  // notifications still drain but cannot extend that command's disabled state.
  async requestBatch(scope: RefreshScope, observed?: () => boolean): Promise<void> {
    if (observed) {
      if (observed()) return;
      // SSE may start the read before the command response arrives. Reuse it
      // only if it actually loaded the acknowledged state.
      if (this.activeRead) await this.activeRead;
      if (observed()) return;
    }
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
      void this.request(scope).catch(reject);
    });
  }

  request(scope: RefreshScope = fullRefresh, resume?: ResumeRefresh): Promise<void> {
    this.pending = mergeRefreshRequests(this.pending, { scope, resume });
    if (!this.running) {
      this.running = Promise.resolve().then(async () => {
        while (this.pending) {
          const next = this.pending;
          const waiters = this.waiters;
          this.pending = null;
          this.waiters = [];
          try {
            this.activeRead = this.read(next);
            await this.activeRead;
            for (const waiter of waiters) waiter.resolve();
          } catch (error) {
            for (const waiter of waiters) waiter.reject(error);
            throw error;
          } finally {
            this.activeRead = null;
          }
        }
      }).finally(() => {
        this.running = null;
        // A notification can arrive after the loop resolves but before this
        // promise settles. Include that last batch in the same awaited drain.
        if (this.pending) return this.request({});
      });
    }
    return this.running;
  }
}
