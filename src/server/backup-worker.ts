import Database from 'better-sqlite3';
import { closeSync, openSync, rmSync } from 'node:fs';
import { z } from 'zod';
import { BackupValidationError } from '../core/errors.js';
import { compareSnapshot, insertRow, sanitizePortable } from '../persistence/backup-store.js';
import { backupTextFieldLimit, checkUploadedFieldSizes, invalidBackup, portableRowCount, rows, validateContent } from '../persistence/backup-validation.js';
import { upgradeSingleBranches } from '../persistence/branch-upgrade.js';
import { backupLimits, backupTables, type ReportBackupProgress } from '../shared/backups.js';
import { backupTaskSchema, metadataSql } from './backup-work.js';

type Task = z.infer<typeof backupTaskSchema>;
function prepareExport(task: Extract<Task, { kind: 'export' }>, report: ReportBackupProgress) {
  const db = new Database(task.snapshot, { fileMustExist: true });
  try {
    db.pragma('temp_store = FILE');
    db.pragma('secure_delete = ON');
    sanitizePortable(db, report);
    validateContent(db, report);
    db.exec(metadataSql);
    db.prepare('INSERT INTO backup_metadata VALUES (1,?)').run(JSON.stringify(task.metadata));
    // Copy only live pages into the finished file. The input can contain deleted runtime secrets.
    report('compact');
    closeSync(openSync(task.compact, 'wx', 0o600));
    db.prepare('VACUUM INTO ?').run(task.compact);
  } finally { db.close(); }
}

function inspect(task: Extract<Task, { kind: 'inspect' }>, report: ReportBackupProgress) {
  const content = new Database(task.content, { fileMustExist: true });
  let phase = 'Opening uploaded SQLite database';
  try {
    const source = new Database(task.source, { readonly: true, fileMustExist: true });
    try {
      source.pragma('trusted_schema = OFF');
      content.pragma('foreign_keys = ON');
      content.pragma('temp_store = FILE');
      const singleBranches = task.version < 16;
      const largeCards = task.version >= 18;
      const tables = backupTables.filter(table => !singleBranches || table !== 'chat_groups');
      const total = portableRowCount(source, tables);
      if (total > backupLimits.rows) throw invalidBackup('Portable content exceeds the 100,000-row limit.');
      report('reconstruct', 0, total);
      content.transaction(() => {
        content.pragma('defer_foreign_keys = ON');
        content.exec('DELETE FROM chat_groups; DELETE FROM library;');
        let count = 0;
        for (const table of tables) {
          phase = `Reading table ${table}`;
          checkUploadedFieldSizes(source, table, largeCards);
          let ordinal = 0;
          for (const row of rows(source, table)) {
            phase = `Reconstructing table ${table}, record ${++ordinal}`;
            if (++count > backupLimits.rows) throw invalidBackup('Portable content exceeds the 100,000-row limit.');
            if (Object.entries(row).some(([field, value]) => typeof value === 'string' && Buffer.byteLength(value) > backupTextFieldLimit(table, field, row, largeCards))) {
              throw invalidBackup(`Table ${table}, record ${ordinal}: a text field exceeds its size limit.`);
            }
            insertRow(content, table, row);
            report('reconstruct', count, total);
          }
        }
        if (singleBranches) upgradeSingleBranches(content);
        phase = 'Committing reconstructed backup tables';
      })();
    } finally { source.close(); }
    rmSync(task.source);
    phase = 'Validating reconstructed backup content';
    validateContent(content, report);
    phase = 'Removing runtime authority from staged content';
    sanitizePortable(content, report);
    phase = 'Validating sanitized backup content';
    validateContent(content, report, 'cleaned');
    phase = 'Checking the combined backup';
    report('compare');
    const preview = new Database(task.snapshot, { fileMustExist: true });
    try {
      preview.pragma('foreign_keys = ON');
      preview.pragma('temp_store = FILE');
      return compareSnapshot(preview, content, undefined, report);
    } finally { preview.close(); }
  } catch (error) {
    if (isDiskFull(error)) throw error;
    // Never forward SQLite paths, uploaded values or raw Zod messages.
    let reason = 'Unexpected staging or content-validation failure.';
    if (error instanceof BackupValidationError) reason = error.details;
    else if (error instanceof z.ZodError) reason = `Record validation failed (${[...new Set(error.issues.map(issue => issue.code))].join(', ')}).`;
    else if (error instanceof SyntaxError) reason = 'Malformed JSON.';
    else if (error instanceof Error && 'code' in error && typeof error.code === 'string' && /^SQLITE_[A-Z_]+$/.test(error.code)) reason = `SQLite rejected the backup (${error.code}).`;
    throw invalidBackup(`${phase}: ${reason}`);
  } finally { content.close(); }
}
function isDiskFull(error: unknown) {
  return error instanceof Error && 'code' in error && ['ENOSPC','SQLITE_FULL'].includes(String(error.code));
}

process.once('disconnect', () => process.exit(process.exitCode ?? 0));
process.once('message', raw => {
  let lastPhase = '', lastSent = 0;
  const report: ReportBackupProgress = (phase, done, total) => {
    const now = performance.now();
    if (phase === lastPhase && done !== total && now - lastSent < 100) return;
    lastPhase = phase; lastSent = now;
    process.send?.({ kind: 'progress', progress: { phase, done, total } });
  };
  try {
    const task = backupTaskSchema.parse(raw);
    if (task.kind === 'export') {
      prepareExport(task, report);
      process.send?.({ kind: 'finished' });
    } else {
      const plan = inspect(task, report);
      process.send?.({ kind: 'finished', plan });
    }
  } catch (error) {
    if (isDiskFull(error)) process.send?.({ kind: 'diskFull' });
    else if (error instanceof BackupValidationError) process.send?.({ kind: 'invalid', details: error.details });
    else process.exitCode = 1;
  } finally { process.disconnect?.(); }
});
