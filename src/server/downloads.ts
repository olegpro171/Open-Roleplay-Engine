import { randomBytes } from 'node:crypto';
import { statSync } from 'node:fs';
import { AppError } from '../core/errors.js';
import { downloadLifetimeMs, downloadLimit } from '../shared/downloads.js';
import { message } from '../shared/localization.js';

type Source = { bytes: Buffer } | { path: string; cleanup: () => void };
type Download = { owner: string; filename: string; source: Source; length: number; expires: number; readers: number };

// Only completed ciphertext is retained, never passwords or plaintext snapshots.
export class Downloads {
  private readonly entries = new Map<string, Download>();
  private readonly timer: ReturnType<typeof setInterval>;
  private closed = false;

  constructor() {
    this.timer = setInterval(() => this.prune(), 30_000);
    this.timer.unref();
  }

  private remove(token: string, entry: Download) {
    if ('path' in entry.source) entry.source.cleanup();
    this.entries.delete(token);
  }
  private prune() {
    for (const [token, entry] of this.entries) {
      if (entry.expires <= Date.now() && entry.readers === 0) this.remove(token, entry);
    }
  }

  add(owner: string, filename: string, source: Source) {
    try {
      this.prune();
      if (this.closed) throw new AppError(503, 'server_stopping', message('errors.the_server_is_stopping_try_again_after_restart'));
      if (this.entries.size >= downloadLimit) throw new AppError(429, 'downloads_busy', message('errors.downloads_busy'));
      const token = randomBytes(32).toString('hex');
      const length = 'bytes' in source ? source.bytes.length : statSync(source.path).size;
      this.entries.set(token, { owner, filename, source, length, expires: Date.now() + downloadLifetimeMs, readers: 0 });
      return { url: `/api/downloads/${token}`, filename };
    } catch (error) {
      if ('path' in source) source.cleanup();
      throw error;
    }
  }

  open(token: string, owner: string) {
    this.prune();
    const entry = this.entries.get(token);
    if (this.closed || !entry || entry.owner !== owner || entry.expires <= Date.now()) {
      throw new AppError(404, 'download_expired', message('errors.download_expired'));
    }
    entry.readers++;
    let released = false;
    return { source: entry.source, length: entry.length, filename: entry.filename, release: (completed = false) => {
      if (released) return;
      released = true;
      entry.readers--;
      if (completed) entry.expires = 0;
      this.prune();
    } };
  }

  close() {
    this.closed = true;
    clearInterval(this.timer);
    for (const entry of this.entries.values()) entry.expires = 0;
    this.prune();
  }
}
