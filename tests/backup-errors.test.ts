import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Store } from '../src/persistence/store.js';
import { BackupService } from '../src/server/backups.js';
import { BackupStore } from '../src/persistence/backup-store.js';
import { backupLimits } from '../src/shared/backups.js';

vi.mock('node:fs',async original => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual,statfsSync: vi.fn(actual.statfsSync),writeFileSync: vi.fn(actual.writeFileSync) };
});
afterEach(() => vi.clearAllMocks());
it('rejects oversized inputs and disk-space/write failures, cleans staging, and retains usable current data',async () => {
  const directory = fs.mkdtempSync(join(tmpdir(),'ore-backup-errors-')), filename = join(directory,'live.sqlite');
  const store = new Store(filename), service = new BackupService(store,filename);
  try {
    const file = await service.export(), bytes = fs.readFileSync(file.path); file.cleanup(); const token = new BackupStore(store).token;
    const oversized = Buffer.alloc(backupLimits.bytes+1); expect(() => service.upload(oversized,'owner')).toThrow();
    const space = fs.statfsSync(directory); vi.mocked(fs.statfsSync).mockReturnValueOnce({ ...space,bavail: 0 });
    expect(() => service.upload(bytes,'owner')).toThrow('not enough free disk space');
    vi.mocked(fs.writeFileSync).mockImplementationOnce(() => { throw Object.assign(new Error('Synthetic disk full'),{ code: 'ENOSPC' }); });
    expect(() => service.upload(bytes,'owner')).toThrow(); expect(fs.readdirSync(join(directory,'.ore-backups-live.sqlite'))).toEqual([]);
    expect(new BackupStore(store).token).toBe(token);
    const review = service.upload(bytes,'owner'); expect(review.blockers).toEqual([]); service.cancel(review.stageId,'owner');
  } finally { service.close(); store.close(); fs.rmSync(directory,{ recursive: true,force: true }); }
});

it('rejects unexpected executable schema names, binary text, wrong selected variants and cyclic summary dependencies',async () => {
  const directory = fs.mkdtempSync(join(tmpdir(),'ore-backup-untrusted-')), filename = join(directory,'live.sqlite');
  const store = new Store(filename), service = new BackupService(store,filename);
  try {
    store.replaceHistory(store.snapshot().revision,'main',[{ user: 'Input',assistant: 'Saved response',complete: true }]);
    const file = await service.export(), bytes = fs.readFileSync(file.path); file.cleanup(); const token = new BackupStore(store).token;
    for (const sql of [
      'CREATE TRIGGER sqliteXhidden AFTER INSERT ON chats BEGIN DELETE FROM chats; END',
      "UPDATE turns SET user_text = X'616263'",
      "UPDATE turns SET selected_variant_id = 'missing-variant'",
      `INSERT INTO summaries VALUES ('cycle',0,'main','{"id":"cycle","revision":0,"level":1,"text":"Memory","turns":[],"children":[],"prior":[{"id":"cycle","revision":0}],"approved":true,"manual":false,"createdAt":""}')`,
    ]) {
      const path = join(directory,'malformed.sqlite'); fs.writeFileSync(path,bytes); const db = new Database(path); db.exec(sql); db.close();
      expect(() => service.upload(fs.readFileSync(path),'owner')).toThrow(); expect(new BackupStore(store).token).toBe(token);
    }
  } finally { service.close(); store.close(); fs.rmSync(directory,{ recursive: true,force: true }); }
});
