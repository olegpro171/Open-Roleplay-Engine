import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { AppError, BackupValidationError } from '../core/errors.js';
import { backupMetadataSchema, backupPlanSchema, backupProgressSchema, type ReportBackupProgress } from '../shared/backups.js';
import { message } from '../shared/localization.js';

export const metadataSql = 'CREATE TABLE backup_metadata (id INTEGER PRIMARY KEY CHECK(id = 1), data TEXT NOT NULL)';
export const backupTaskSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('export'), snapshot: z.string(), compact: z.string(), metadata: backupMetadataSchema }),
  z.object({ kind: z.literal('inspect'), source: z.string(), content: z.string(), snapshot: z.string(), version: z.number().int() }),
]);
type BackupTask = z.infer<typeof backupTaskSchema>;
const responseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('progress'), progress: backupProgressSchema }),
  z.object({ kind: z.literal('finished'), plan: backupPlanSchema.optional() }),
  z.object({ kind: z.literal('invalid'), details: z.string() }),
  z.object({ kind: z.literal('diskFull') }),
]);
export function runBackupWork(task: BackupTask, report: ReportBackupProgress | undefined, signal: AbortSignal) {
  signal.throwIfAborted();
  const source = import.meta.url.endsWith('.ts');
  const path = fileURLToPath(new URL(source ? './backup-worker.ts' : './backup-worker.js', import.meta.url));
  return new Promise<z.infer<typeof backupPlanSchema> | undefined>((resolve, reject) => {
    const child = fork(path, [], { execArgv: source ? ['--import', 'tsx'] : [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    let result: z.infer<typeof backupPlanSchema> | undefined;
    let finished = false;
    const failed = () => new AppError(500, 'backup_worker_failed', message('errors.backup_worker_failed'));
    let error: Error | undefined;
    const abort = () => { child.kill('SIGKILL'); };
    signal.addEventListener('abort', abort, { once: true });
    child.on('message', raw => {
      const parsed = responseSchema.safeParse(raw);
      if (!parsed.success) { error = failed(); abort(); return; }
      const value = parsed.data;
      switch (value.kind) {
        case 'progress': report?.(value.progress.phase, value.progress.done, value.progress.total); break;
        case 'finished': finished = task.kind === 'export' || value.plan !== undefined; result = value.plan; break;
        case 'invalid': error = new BackupValidationError(value.details); break;
        case 'diskFull': error = new AppError(507, 'backup_disk_space', message('errors.backup_staging_ran_out_of_disk_space_free')); break;
      }
    });
    child.on('error', () => { error = failed(); });
    // Wait for all file handles to close before the parent removes private staging.
    child.once('close', code => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted || error || !finished || code !== 0) reject(error ?? failed());
      else resolve(result);
    });
    child.send(task);
  });
}
