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

it('explains schema, content and reconstruction failures without exposing uploaded values',async () => {
  const directory = fs.mkdtempSync(join(tmpdir(),'ore-backup-diagnostics-')), filename = join(directory,'live.sqlite');
  const store = new Store(filename), service = new BackupService(store,filename);
  try {
    store.replaceHistory(store.snapshot().revision,'main',[{ user: 'Private synthetic prose',assistant: 'Saved response',complete: true }]);
    const file = await service.export(), bytes = fs.readFileSync(file.path); file.cleanup();
    const token = service.persistence.token;
    const cases = [
      { sql: 'PRAGMA user_version = 999', reason: 'Unsupported database schema version 999' },
      { sql: "CREATE TABLE private_uploaded_secret (value TEXT)", reason: 'unexpected schema objects' },
      { sql: "PRAGMA writable_schema = ON; UPDATE sqlite_master SET sql = replace(replace(sql, char(10), char(13) || char(10)), '600000', '600001') WHERE name = 'character_pictures'", reason: 'Schema object character_pictures differs from the shipped definition' },
      { sql: "PRAGMA writable_schema = ON; UPDATE sqlite_master SET sql = replace(replace(sql, char(10), char(13) || char(10)), 'Pictures belong to characters', 'private_uploaded_secret') WHERE name = 'character_pictures_kind'", reason: 'Schema object character_pictures_kind differs from the shipped definition' },
      { sql: 'DROP INDEX character_pictures_asset', reason: 'Schema object character_pictures_asset is missing' },
      { sql: "PRAGMA writable_schema = ON; UPDATE sqlite_master SET sql = replace(sql, 'CHECK(id = 1)', 'CHECK(id > 0)') WHERE name = 'backup_metadata'", reason: 'Backup metadata table definition differs from the shipped definition' },
      { sql: "UPDATE turns SET user_text = X'616263'", reason: 'Table turns, column user_text: expected TEXT' },
      { sql: "UPDATE turns SET selected_variant_id = 'private_uploaded_secret'", reason: 'missing or inconsistent selected response variant' },
      { sql: "UPDATE turns SET chat_id = 'private_uploaded_secret'", reason: 'SQLITE_CONSTRAINT_FOREIGNKEY' },
      { sql: "UPDATE chats SET settings = '{private_uploaded_secret'", reason: 'Column settings contains malformed JSON' },
      { sql: `UPDATE chats SET settings = json_set(settings, '$.title', json('[]'))`, reason: 'Table chats, column settings: title: invalid_type' },
    ];
    for (const { sql,reason } of cases) {
      const path = join(directory,'input.sqlite'); fs.writeFileSync(path,bytes);
      const db = new Database(path);
      // Deliberately corrupt only this temporary fixture, including references and schema text.
      try { db.unsafeMode(true); db.pragma('foreign_keys = OFF'); db.exec(sql); } finally { db.close(); }
      const input = fs.readFileSync(path);
      let failure: unknown;
      try { service.upload(input,'owner'); } catch (error) { failure = error; }
      expect(failure).toMatchObject({ code: 'invalid_backup',message: 'This file is not a valid ORE backup.',details: expect.stringContaining(reason) });
      expect(JSON.stringify(failure)).not.toContain('private_uploaded_secret');
      expect(JSON.stringify(failure)).not.toContain('Private synthetic prose');
      // Compare every byte natively; per-byte matcher traversal of eleven SQLite
      // fixtures otherwise consumes almost the entire five-second test budget.
      expect(fs.readFileSync(path).equals(input)).toBe(true);
      expect(service.persistence.token).toBe(token);
      expect(fs.readdirSync(join(directory,'.ore-backups-live.sqlite'))).toEqual([]);
    }
    const review = service.upload(bytes,'owner'); expect(review.blockers).toEqual([]); service.cancel(review.stageId,'owner');
  } finally { service.close(); store.close(); fs.rmSync(directory,{ recursive: true,force: true }); }
});
