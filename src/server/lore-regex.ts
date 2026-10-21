import { message } from '../shared/localization.js';
import { Worker } from 'node:worker_threads';
import { AppError } from '../core/errors.js';
import type { RegexMatcher } from '../core/lorebook.js';
import { z } from 'zod';

const responseSchema = z.object({ matched: z.boolean(), invalid: z.string().optional() }).strict();
const workerCode = `
const { parentPort } = require('node:worker_threads');
parentPort.on('message', ({patterns,texts,caseSensitive}) => {
  try {
    const compiled = patterns.map(value => {
      const end = value.lastIndexOf('/');
      const delimited = value.startsWith('/') && end > 0;
      const source = delimited ? value.slice(1,end) : value;
      const flags = delimited ? value.slice(end+1) : caseSensitive ? 'u' : 'iu';
      if (!/^[dgimsuvy]*$/.test(flags)) throw new Error('Invalid regular expression flags.');
      return new RegExp(source,flags);
    });
    const matched = compiled.some(pattern => texts.some(text => { pattern.lastIndex=0; return pattern.test(text); }));
    parentPort.postMessage({matched});
  } catch { parentPort.postMessage({matched:false,invalid:'Invalid regular expression pattern or flags.'}); }
});`;

type Work = { patterns: string[]; texts: string[]; caseSensitive: boolean; deadline: number; signal?: AbortSignal; queuedAbort?: () => void; queuedTimer?: ReturnType<typeof setTimeout>; resolve: (result: z.infer<typeof responseSchema>) => void; reject: (error: unknown) => void };
/** Two isolated workers; catastrophic backtracking never runs on the server loop. */
export class LoreRegexPool {
  private workers = new Set<Worker>();
  private idle: Worker[] = [];
  private queue: Work[] = [];
  private activeStops = new Set<() => void>();
  private closed = false;
  matcher(signal?: AbortSignal): RegexMatcher {
    const deadline = Date.now() + 5000;
    return (patterns, texts, caseSensitive) => new Promise((resolve, reject) => {
      if (this.closed || signal?.aborted) { reject(new AppError(409, 'lore_cancelled', message("errors.lore_resolution_was_cancelled"))); return; }
      if (Date.now() > deadline) { reject(new AppError(422, 'lore_regex_timeout', message("errors.lore_matching_exceeded_its_total_time_limit_simplify"))); return; }
      if (this.queue.length >= 32) { reject(new AppError(503, 'lore_busy', message("errors.lore_matching_is_busy_try_again_when_the"))); return; }
      const work: Work = { patterns, texts, caseSensitive, deadline, signal, resolve, reject };
      work.queuedAbort = () => {
        const index = this.queue.indexOf(work);
        if (index >= 0) this.queue.splice(index, 1);
        clearTimeout(work.queuedTimer);
        reject(new AppError(409, 'lore_cancelled', message("errors.lore_resolution_was_cancelled")));
      };
      work.queuedTimer = setTimeout(() => {
        const index = this.queue.indexOf(work);
        if (index >= 0) this.queue.splice(index, 1);
        if (work.queuedAbort) signal?.removeEventListener('abort', work.queuedAbort);
        reject(new AppError(422, 'lore_regex_timeout', message("errors.lore_matching_exceeded_its_total_time_limit_reduce")));
      }, Math.max(1, deadline - Date.now()));
      signal?.addEventListener('abort', work.queuedAbort, { once: true });
      this.queue.push(work);
      this.drain();
    });
  }
  private drain() {
    if (this.closed) return;
    while (this.queue.length && (this.idle.length || this.workers.size < 2)) {
      const work = this.queue.shift();
      if (!work) break;
      clearTimeout(work.queuedTimer);
      if (work.queuedAbort) work.signal?.removeEventListener('abort', work.queuedAbort);
      if (work.signal?.aborted) { work.reject(new AppError(409, 'lore_cancelled', message("errors.lore_resolution_was_cancelled"))); continue; }
      if (Date.now() >= work.deadline) { work.reject(new AppError(422, 'lore_regex_timeout', message("errors.lore_matching_exceeded_its_total_time_limit_reduce"))); continue; }
      const worker = this.idle.pop() ?? new Worker(workerCode, { eval: true, resourceLimits: { maxOldGenerationSizeMb: 32, stackSizeMb: 2 } });
      const fresh = !this.workers.has(worker);
      this.workers.add(worker);
      worker.ref();
      let finished = false;
      let timer: ReturnType<typeof setTimeout>;
      const finish = (error?: unknown, result?: unknown) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        worker.removeListener('error', onError);
        worker.removeListener('exit', onExit);
        worker.removeListener('message', onMessage);
        worker.removeListener('online', send);
        this.activeStops.delete(abort);
        work.signal?.removeEventListener('abort', abort);
        if (error || this.closed) {
          this.workers.delete(worker);
          void worker.terminate();
          work.reject(error ?? new AppError(409, 'lore_cancelled', message("errors.lore_resolution_was_cancelled")));
        } else {
          const parsed = responseSchema.safeParse(result);
          if (parsed.success) work.resolve(parsed.data);
          else work.reject(new AppError(422, 'lore_regex_failed', message("errors.lore_pattern_matching_failed_review_the_selected_book")));
          worker.unref();
          this.idle.push(worker);
        }
        this.drain();
      };
      const abort = () => finish(new AppError(409, 'lore_cancelled', message("errors.lore_resolution_was_cancelled")));
      this.activeStops.add(abort);
      work.signal?.addEventListener('abort', abort, { once: true });
      const onError = () => finish(new AppError(422, 'lore_regex_failed', message("errors.lore_pattern_matching_exceeded_its_resources_simplify_the")));
      const onExit = () => finish(new AppError(422, 'lore_regex_failed', message("errors.lore_pattern_matching_stopped_unexpectedly_review_its_patterns")));
      const onMessage = (result: unknown) => finish(undefined, result);
      worker.once('error', onError);
      worker.once('exit', onExit);
      worker.once('message', onMessage);
      const send = () => {
        clearTimeout(timer);
        timer = setTimeout(() => finish(new AppError(422, 'lore_regex_timeout', message("errors.lore_pattern_matching_timed_out_simplify_the_selected"))), Math.max(1, Math.min(500, work.deadline - Date.now())));
        worker.postMessage({ patterns: work.patterns, texts: work.texts, caseSensitive: work.caseSensitive });
      };
      timer = setTimeout(() => finish(new AppError(422, 'lore_regex_failed', message("errors.lore_matching_could_not_start_its_isolated_worker"))), 2000);
      if (fresh) worker.once('online', send); else send();
    }
  }
  async close() {
    this.closed = true;
    const workers = [...this.workers];
    for (const stop of [...this.activeStops]) stop();
    for (const work of this.queue.splice(0)) {
      if (work.queuedAbort) work.signal?.removeEventListener('abort', work.queuedAbort);
      clearTimeout(work.queuedTimer);
      work.reject(new AppError(409, 'lore_cancelled', message("errors.lore_resolution_was_cancelled")));
    }
    await Promise.allSettled(workers.map(worker => worker.terminate()));
    this.workers.clear(); this.idle = [];
  }
}
