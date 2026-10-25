import type { Change } from '../shared/changes';

export type RefreshScope = Partial<Record<'story' | 'library' | 'tools' | 'appearance' | 'chat-defaults' | 'chat-behavior', true>>;
export const fullRefresh: RefreshScope = { story: true, library: true, tools: true, appearance: true, 'chat-defaults': true, 'chat-behavior': true };

export function scopeForChange(change: Change, selectedChat: string | null, showingStory = true): RefreshScope | null {
  switch (change.kind) {
    case 'all': return fullRefresh;
    case 'library': return { library: true, story: true, tools: true };
    case 'settings': return { [change.setting]: true };
    case 'chat':
      if (change.detail === 'stream') return showingStory && change.chatId === selectedChat ? { story: true } : null;
      return change.chatId === selectedChat ? { story: true, library: true, tools: true } : { library: true };
  }
}

/** One read at a time; notifications arriving during it merge into one follow-up. */
export class RefreshQueue {
  private pending: RefreshScope | null = null;
  private running: Promise<void> | null = null;
  constructor(private readonly read: (scope: RefreshScope) => Promise<void>) {}

  request(scope: RefreshScope = fullRefresh): Promise<void> {
    this.pending = { ...this.pending, ...scope };
    if (!this.running) {
      this.running = Promise.resolve().then(async () => {
        while (this.pending) {
          const next = this.pending;
          this.pending = null;
          await this.read(next);
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
