import { message } from '../shared/localization.js';
import { fork, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { cropSchema, pictureBase64Schema, pictureLimits, type PictureAnalysis, type PictureCrop } from '../shared/pictures.js';

const processedSchema = z.object({ ok: z.literal(true), width: z.number().int().positive().max(pictureLimits.edge), height: z.number().int().positive().max(pictureLimits.edge), orientation: z.number().int().min(1).max(8), mime: z.enum(['image/png', 'image/jpeg', 'image/webp']), firstFrame: z.boolean(), crop: cropSchema, preview: z.instanceof(Buffer).refine(bytes => bytes.length <= pictureLimits.previewBytes), thumbnail: z.instanceof(Buffer).refine(bytes => bytes.length <= pictureLimits.thumbBytes) });
export type { PreparedPicture } from '../persistence/picture-data.js';
import type { PreparedPicture } from '../persistence/picture-data.js';
export function pictureBytes(base64: string) {
  const bytes = Buffer.from(pictureBase64Schema.parse(base64), 'base64');
  if (bytes.length > pictureLimits.bytes) throw new AppError(400, 'picture_too_large', message("pictures.pictures_are_limited_to_10_mb"));
  return bytes;
}
export function pictureDigest(bytes: Buffer) { return createHash('sha256').update(bytes).digest('hex'); }
export function pictureAnalysis(picture: PreparedPicture): PictureAnalysis {
  return { width: picture.width, height: picture.height, crop: picture.crop, firstFrame: picture.firstFrame, preview: `data:image/png;base64,${picture.preview.toString('base64')}`, thumbnail: `data:image/png;base64,${picture.thumbnail.toString('base64')}` };
}
type Work = { bytes: Buffer; crop?: PictureCrop; signal?: AbortSignal; deadline: number; resolve: (picture: PreparedPicture) => void; reject: (error: unknown) => void; abort: () => void; timer?: ReturnType<typeof setTimeout> };
/** Each task has its own native process. SIGKILL stops libvips on timeout/cancel. */
export class PictureProcessor {
  private queue: Work[] = [];
  private active = new Map<ChildProcess, () => void>();
  private closed = false;
  constructor(private readonly durationMs: number = pictureLimits.durationMs) {}
  process(bytes: Buffer, crop?: PictureCrop, signal?: AbortSignal): Promise<PreparedPicture> {
    if (bytes.length > pictureLimits.bytes) return Promise.reject(new AppError(400, 'picture_too_large', message("pictures.pictures_are_limited_to_10_mb")));
    return new Promise((resolve, reject) => {
      if (this.closed || signal?.aborted) { reject(new AppError(409, 'picture_cancelled', message("errors.picture_processing_was_cancelled"))); return; }
      if (this.queue.length >= pictureLimits.queued) { reject(new AppError(503, 'pictures_busy', message("errors.picture_processing_is_busy_try_again_shortly"))); return; }
      const work: Work = { bytes, crop, signal, deadline: Date.now() + Math.min(pictureLimits.durationMs, Math.max(1, this.durationMs)), resolve, reject, abort: () => {} };
      work.abort = () => {
        const index = this.queue.indexOf(work);
        if (index < 0) return;
        this.queue.splice(index, 1); clearTimeout(work.timer); signal?.removeEventListener('abort', work.abort);
        reject(new AppError(409, 'picture_cancelled', message("errors.picture_processing_was_cancelled")));
      };
      signal?.addEventListener('abort', work.abort, { once: true });
      work.timer = setTimeout(() => {
        const index = this.queue.indexOf(work);
        if (index < 0) return;
        this.queue.splice(index, 1); signal?.removeEventListener('abort', work.abort); reject(new AppError(422, 'picture_timeout', message("errors.picture_processing_timed_out_choose_a_smaller_picture")));
      }, Math.max(1, work.deadline - Date.now()));
      this.queue.push(work); this.drain();
    });
  }
  private drain() {
    while (!this.closed && this.queue.length && this.active.size < pictureLimits.concurrent) {
      const work = this.queue.shift(); if (!work) return;
      clearTimeout(work.timer); work.signal?.removeEventListener('abort', work.abort);
      const compiled = fileURLToPath(new URL('./picture-worker.js', import.meta.url));
      const workerPath = existsSync(compiled) ? compiled : fileURLToPath(new URL('./picture-worker.ts', import.meta.url));
      const child = fork(workerPath, [], { execPath: process.execPath, execArgv: workerPath.endsWith('.ts') ? ['--import', 'tsx', '--max-old-space-size=256'] : ['--max-old-space-size=256'], serialization: 'advanced', stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { ...process.env, VIPS_CONCURRENCY: '1', MALLOC_ARENA_MAX: '2' } });
      let finished = false;
      const finish = (error?: unknown, value?: unknown) => {
        if (finished) return;
        finished = true; clearTimeout(timer); work.signal?.removeEventListener('abort', abort);
        child.kill('SIGKILL');
        if (error) work.reject(error);
        else {
          const result = processedSchema.safeParse(value);
          if (result.success) work.resolve({ ...result.data, original: work.bytes, digest: pictureDigest(work.bytes), renditionVersion: 1 });
          else {
            const failure = z.object({ ok: z.literal(false), message: z.string().max(500) }).safeParse(value);
            work.reject(new AppError(422, 'invalid_picture', failure.success ? failure.data.message : message("errors.picture_processing_failed_choose_another_picture")));
          }
        }
      };
      const abort = () => finish(new AppError(409, 'picture_cancelled', message("errors.picture_processing_was_cancelled")));
      this.active.set(child, abort);
      const timer = setTimeout(() => finish(new AppError(422, 'picture_timeout', message("errors.picture_processing_timed_out_choose_a_smaller_picture"))), Math.max(1, work.deadline - Date.now()));
      work.signal?.addEventListener('abort', abort, { once: true });
      child.once('message', value => finish(undefined, value));
      child.once('error', () => finish(new AppError(422, 'picture_failed', message("errors.picture_processing_could_not_start_retry_or_choose"))));
      child.once('exit', () => { finish(new AppError(422, 'picture_failed', message("errors.picture_processing_stopped_retry_or_choose_a_smaller"))); this.active.delete(child); this.drain(); });
      child.send({ bytes: work.bytes, crop: work.crop });
      if (work.signal?.aborted) abort();
    }
  }
  async close() {
    this.closed = true;
    for (const work of [...this.queue]) work.abort();
    await Promise.all([...this.active].map(([child, abort]) => new Promise<void>(resolve => { child.once('exit', () => resolve()); abort(); })));
  }
}
