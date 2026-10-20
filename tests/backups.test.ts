import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/persistence/store.js';
import { BackupService } from '../src/server/backups.js';
import { BackupStore, datasetEpoch } from '../src/persistence/backup-store.js';
import { backupLimits, type BackupReview } from '../src/shared/backups.js';
import { defaultPrompt } from '../src/shared/library.js';

let directory: string;
const stores: Store[] = [], services: BackupService[] = [];
const owner = 'synthetic-session';
function store(name: string, migrationsDirectory?: string) { const result = new Store(join(directory,`${name}.sqlite`),migrationsDirectory); stores.push(result); return result; }
function service(db: Store,name: string, migrationsDirectory?: string) { const result = new BackupService(db,join(directory,`${name}.sqlite`),migrationsDirectory); services.push(result); return result; }
function receipt(review: BackupReview,overwrite = true) { return { requestId: randomUUID(),digest: review.digest,token: review.token,overwrite }; }
async function bytes(backups: BackupService) { const file = await backups.export(); try { return readFileSync(file.path); } finally { file.cleanup(); } }
function character(db: Store,name: string,id?: string) { return db.saveLibrary(db.libraryRevision(),'characters',{ name, description: 'A patient guide',personality: '',scenario: '',first_mes: 'Welcome, traveler.',mes_example: '' },id); }
function chat(db: Store,characterId: string,title: string) { return db.createChat({ title,characterId,personaId: null,connectionId: null,promptId: 'default',contextPresetId: null,targetInputTokens: 32000,lorebookId: null }); }
beforeEach(() => { directory = mkdtempSync(join(tmpdir(),'ore-backup-test-')); });
afterEach(() => { for (const value of services.splice(0)) value.close(); for (const value of stores.splice(0)) if (value.sqlite.open) value.close(); rmSync(directory,{ recursive: true,force: true }); });

describe('portable backup persistence',() => {
  it.each([
    { sourceEnding: 'LF', targetEnding: 'CRLF', version: 13 },
    { sourceEnding: 'CRLF', targetEnding: 'LF', version: 13 },
    { sourceEnding: 'LF', targetEnding: 'CRLF', version: 12 },
    { sourceEnding: 'CRLF', targetEnding: 'LF', version: 12 },
  ])('imports populated schema-$version backups from $sourceEnding migrations into $targetEnding migrations',async ({ sourceEnding,targetEnding,version }) => {
    const shippedMigrations = fileURLToPath(new URL('../migrations/',import.meta.url));
    function migrations(name: string, ending: string) {
      const path = join(directory,name);
      mkdirSync(path);
      for (const file of readdirSync(shippedMigrations).filter(file => file.endsWith('.sql'))) {
        const sql = readFileSync(join(shippedMigrations,file),'utf8').replace(/\r\n/g,'\n');
        writeFileSync(join(path,file),ending === 'CRLF' ? sql.replace(/\n/g,'\r\n') : sql);
      }
      return path;
    }
    const sourceMigrations = migrations('source-migrations',sourceEnding);
    const targetMigrations = migrations('target-migrations',targetEnding);
    const source = store('source',sourceMigrations), sourceBackups = service(source,'source',sourceMigrations);
    const cid = character(source,'Cross-platform guide'), chatId = chat(source,cid,'Cross-platform story');
    source.replaceHistory(source.snapshot(chatId).revision,chatId,[
      { user: 'First line\r\nSecond line',assistant: 'First paragraph\n\nSecond paragraph',complete: true },
      { user: 'Pending input\r\ncontinued',assistant: '',complete: false },
    ]);
    const expectedTurns = source.snapshot(chatId).turns;
    const path = join(directory,'input.sqlite');
    writeFileSync(path,await bytes(sourceBackups));
    if (version === 12) {
      const legacy = new Database(path);
      try { legacy.exec('DROP TABLE backup_metadata; DROP TABLE dataset_state; DROP TABLE data_commands; PRAGMA user_version = 12'); }
      finally { legacy.close(); }
    }
    const input = readFileSync(path);
    const destination = store('destination',targetMigrations), target = service(destination,'destination',targetMigrations);
    const retained = character(destination,'Local guide');
    const pictureSchema = "SELECT sql FROM sqlite_master WHERE name = 'character_pictures'";
    expect(source.sqlite.prepare(pictureSchema).get()).not.toEqual(destination.sqlite.prepare(pictureSchema).get());
    const before = target.persistence.token;
    const review = target.upload(input,owner);
    expect(review.blockers).toEqual([]);
    expect(review.metadata?.schema ?? null).toBe(version === 13 ? 13 : null);
    expect(target.page(review.stageId,owner,'turns',0,chatId).total).toBe(2);
    expect(target.persistence.token).toBe(before);
    target.commit(review.stageId,owner,receipt(review));
    expect(destination.snapshot(chatId).turns).toEqual(expectedTurns);
    expect(destination.libraries().characters.map(item => item.id)).toEqual(expect.arrayContaining([cid,retained]));
    expect(readFileSync(path)).toEqual(input);
  });
  it('downloads a consistent portable SQLite snapshot and inspects/imports it without leaking credentials or owner authentication',async () => {
    const source = store('source'), backups = service(source,'source');
    const cid = character(source,'Mara'), chatId = chat(source,cid,'A saved story');
    const connection = source.saveLibrary(source.libraryRevision(),'connections',{ name: 'Private model',endpoint: 'http://127.0.0.1:9999/v1',model: 'synthetic',contextWindow: 32000,maxOutputTokens: 1000,customParameters: {} },undefined,'SYNTHETIC_SECRET_ABC');
    source.sqlite.prepare("INSERT INTO owners VALUES ('owner','synthetic-salt','synthetic-owner-hash')").run();
    source.sqlite.prepare("INSERT INTO sessions VALUES ('synthetic-session-hash',9999999999999)").run();
    const snapshot = await bytes(backups), path = join(directory,'portable.sqlite'); writeFileSync(path,snapshot);
    const portable = new Database(path,{ readonly: true });
    expect(portable.prepare('SELECT * FROM runtime_owner').all()).toEqual([]);
    expect(portable.prepare('SELECT * FROM owners').all()).toEqual([]);
    expect(portable.prepare('SELECT * FROM sessions').all()).toEqual([]);
    expect(portable.prepare('SELECT api_key FROM credentials WHERE id = ?').get(connection)).toEqual({ api_key: 'SYNTHETIC_SECRET_ABC' }); portable.close();
    expect(snapshot.includes(Buffer.from('synthetic-owner-hash'))).toBe(false);
    const destination = store('destination'), target = service(destination,'destination');
    const retained = character(destination,'Current only');
    const review = target.upload(snapshot,owner);
    expect(review.blockers).toEqual([]); expect(review.overlaps).toBeGreaterThan(0);
    const credentials = target.page(review.stageId,owner,'credentials',0);
    const leaf = target.leaf(review.stageId,owner,'credentials',credentials.items[0].key,0);
    expect(JSON.stringify(leaf)).not.toContain('SYNTHETIC_SECRET_ABC'); expect(leaf.fields).toContainEqual({ name: 'Saved API key',value: 'Present' });
    expect(() => target.commit(review.stageId,owner,receipt(review,false))).toThrow('overwrite approval');
    const command = receipt(review); const outcome = target.commit(review.stageId,owner,command);
    expect(destination.snapshot(chatId).turns[0].assistant.text).toBe('Welcome, traveler.');
    expect(destination.libraries().characters.some(item => item.id === retained)).toBe(true);
    expect(destination.connectionApiKey(connection)).toBe('SYNTHETIC_SECRET_ABC');
    expect(target.commit(review.stageId,owner,command)).toEqual(outcome);
    target.close(); destination.close();
    const restarted = store('destination'), restartedBackups = service(restarted,'destination');
    expect(restartedBackups.commit(review.stageId,owner,command)).toEqual(outcome);
    expect(restarted.snapshot(chatId).turns[0].variants).toHaveLength(1);
  });
  it('replaces an older chat aggregate instead of keeping newer children, while retaining equal-name different identities',async () => {
    const db = store('aggregate'), backups = service(db,'aggregate');
    const cid = character(db,'Same name'), chatId = chat(db,cid,'Old story');
    const saved = await bytes(backups);
    const extra = character(db,'Same name');
    db.replaceHistory(db.snapshot(chatId).revision,chatId,[{ user: 'Newer input',assistant: 'Newer response',complete: true },{ user: 'Another input',assistant: 'Another response',complete: true }]);
    const newTurns = db.snapshot(chatId).turns.map(turn => turn.id);
    const review = backups.upload(saved,owner);
    expect(review.blockers).toEqual([]); expect(review.units.find(unit => unit.id === chatId)?.children).toBeGreaterThan(0);
    backups.commit(review.stageId,owner,receipt(review));
    expect(db.snapshot(chatId).turns.map(turn => turn.assistant.text)).toEqual(['Welcome, traveler.']);
    for (const id of newTurns) expect(db.sqlite.prepare('SELECT id FROM turns WHERE id = ?').get(id)).toBeUndefined();
    expect(db.libraries().characters.some(item => item.id === extra)).toBe(true);
  });
  it('wipe keeps the owner and current session, deletes content atomically and permits reimport of identical IDs',async () => {
    const db = store('wipe'), backups = service(db,'wipe');
    const cid = character(db,'Restorable'), chatId = chat(db,cid,'Restorable story'); const saved = await bytes(backups);
    db.sqlite.exec("INSERT INTO owners VALUES ('owner','salt','hash'); INSERT INTO sessions VALUES ('current',9999999999999); INSERT INTO sessions VALUES ('other',9999999999999)");
    const persistence = new BackupStore(db), initialEpoch = persistence.epoch;
    const command = { requestId: randomUUID(),digest: '0'.repeat(64),token: persistence.token,overwrite: true };
    const outcome = persistence.commit(command,undefined,'current');
    expect(persistence.epoch).not.toBe(initialEpoch); expect(persistence.commit(command,undefined,'current')).toEqual(outcome);
    expect(db.libraries().chats).toEqual([]); expect(db.libraries().characters).toEqual([]);
    expect(db.sqlite.prepare('SELECT hash FROM sessions').all()).toEqual([{ hash: 'current' }]); expect(db.sqlite.prepare('SELECT id FROM owners').get()).toEqual({ id: 'owner' });
    const review = backups.upload(saved,owner); expect(review.blockers).toEqual([]); backups.commit(review.stageId,owner,receipt(review));
    expect(db.snapshot(chatId).turns[0].assistant.text).toBe('Welcome, traveler.');
    expect(persistence.epoch).not.toBe(outcome.epoch);
    expect(() => persistence.commit({ ...command,digest: '1'.repeat(64) })).toThrow('different data');
  });
  it('cancel and stale review preserve all saved content, including a changed chat with unchanged library revision',async () => {
    const db = store('stale'), backups = service(db,'stale'); const cid = character(db,'Guide'), chatId = chat(db,cid,'Story');
    const saved = await bytes(backups), cancelled = backups.upload(saved,owner);
    backups.cancel(cancelled.stageId,owner); expect(() => backups.commit(cancelled.stageId,owner,receipt(cancelled))).toThrow('expired');
    const review = backups.upload(saved,owner), before = db.libraryRevision(), state = db.snapshot(chatId);
    db.editPart(state.revision,state.turns[0].id,'assistant','Local correction',chatId);
    expect(db.libraryRevision()).toBe(before);
    expect(() => backups.commit(review.stageId,owner,receipt(review))).toThrow('changed since review');
    expect(db.snapshot(chatId).turns[0].assistant.text).toBe('Local correction');
    const renewed = backups.review(review.stageId,owner); expect(renewed.token).not.toBe(review.token);
    backups.commit(review.stageId,owner,receipt(renewed)); expect(db.snapshot(chatId).turns[0].assistant.text).toBe('Welcome, traveler.');
  });
  it('blocks conflicting tag identities and cross-kind records without changing destination state',async () => {
    const a = store('tag-a'), b = store('tag-b'), sa = service(a,'tag-a'), sb = service(b,'tag-b');
    a.tags.create(a.libraryRevision(),'Travel'); b.tags.create(b.libraryRevision(),'TRAVEL');
    const before = new BackupStore(b).token, review = sb.upload(await bytes(sa),owner);
    expect(review.blockers.join(' ')).toContain('Rename');
    expect(() => sb.commit(review.stageId,owner,receipt(review))).toThrow(); expect(new BackupStore(b).token).toBe(before);
    sb.cancel(review.stageId,owner);
    const c = character(a,'Kind conflict');
    b.sqlite.prepare('INSERT INTO library VALUES (?,\'prompts\',0,?)').run(c,JSON.stringify(defaultPrompt));
    const collision = sb.upload(await bytes(sa),owner); expect(collision.blockers.length).toBeGreaterThan(0);
  });
  it('rejects malicious schemas, future/corrupt files and dangling or inconsistent records, preserving the input bytes',async () => {
    const db = store('untrusted'), backups = service(db,'untrusted'), snapshot = await bytes(backups), before = new BackupStore(db).token;
    expect(() => backups.upload(Buffer.from('not a database'),owner)).toThrow();
    for (const sql of ['PRAGMA user_version = 999','CREATE TRIGGER injected AFTER INSERT ON chats BEGIN DELETE FROM owners; END',"INSERT INTO library VALUES ('bad','unknown',0,'{}')", "INSERT INTO chats VALUES ('bad',0,'{}')"]) {
      const path = join(directory,randomUUID()+'.sqlite'); writeFileSync(path,snapshot); const altered = new Database(path); altered.exec(sql); altered.close();
      const original = readFileSync(path); expect(() => backups.upload(original,owner)).toThrow(); expect(readFileSync(path)).toEqual(original);
    }
    expect(new BackupStore(db).token).toBe(before);
  });
  it('bounds record branches and leaf text and binds staging to its session',async () => {
    const db = store('bounded'), backups = service(db,'bounded');
    for (let i=0;i<55;i++) character(db,`Character ${i}`);
    const review = backups.upload(await bytes(backups),owner);
    const page = backups.page(review.stageId,owner,'library',0); expect(page.items).toHaveLength(backupLimits.page); expect(page.total).toBe(57);
    expect(backups.page(review.stageId,owner,'library',40).items).toHaveLength(17);
    expect(() => backups.page(review.stageId,'another-session','library',0)).toThrow('expired');
    expect(review.units).toHaveLength(backupLimits.page);
  });
  it('supports migration from a populated schema-12 input without modifying its source',async () => {
    const db = store('old'), backups = service(db,'old'); const cid = character(db,'Old guide'), chatId = chat(db,cid,'Old story');
    const path = join(directory,'old-input.sqlite'); writeFileSync(path,await bytes(backups)); const old = new Database(path);
    old.exec('DROP TABLE backup_metadata; DROP TABLE dataset_state; DROP TABLE data_commands; PRAGMA user_version = 12'); old.close(); const source = readFileSync(path);
    const review = backups.upload(source,owner); expect(review.metadata).toBeNull(); expect(review.blockers).toEqual([]);
    backups.commit(review.stageId,owner,receipt(review)); expect(db.snapshot(chatId).turns[0].assistant.text).toBe('Welcome, traveler.'); expect(readFileSync(path)).toEqual(source);
  });
});

it('protects authenticated routes and rejects old-tab commands even when restored numeric revisions match',async () => {
  const app = await createApp({ database: join(directory,'http.sqlite') });
  let cookie = '';
  const command = async (url: string,payload: unknown,epoch = 'initial',method: 'POST'|'PUT' = 'POST') => app.app.inject({ method,url,headers: { host: 'localhost',origin: 'http://localhost','content-type': 'application/json',cookie,'x-ore-epoch': epoch },payload: JSON.stringify(payload) });
  try {
    expect((await app.app.inject({ method: 'GET',url: '/api/data/backup',headers: { host: 'localhost' } })).statusCode).toBe(401);
    const setup = await command('/api/setup',{ password: 'synthetic-owner-password' }); cookie = String(setup.headers['set-cookie']).split(';')[0];
    const revision = app.store.snapshot().revision;
    const downloaded = await app.app.inject({ method: 'GET',url: '/api/data/backup',headers: { host: 'localhost',cookie } });
    expect(downloaded.statusCode).toBe(200); expect(downloaded.headers['content-disposition']).toContain('ORE-backup');
    const rejected = await app.app.inject({ method: 'POST',url: '/api/data/stages',headers: { host: 'localhost',origin: 'http://localhost','content-type': 'application/octet-stream',cookie },payload: Buffer.alloc(100) });
    expect(rejected.statusCode).toBe(422);
    expect(rejected.json()).toEqual({ code: 'invalid_backup',message: 'This file is not a valid ORE backup.',details: 'File does not have the SQLite 3 header signature.' });
    expect(app.store.snapshot().revision).toBe(revision);
    const staged = await app.app.inject({ method: 'POST',url: '/api/data/stages',headers: { host: 'localhost',origin: 'http://localhost','content-type': 'application/octet-stream',cookie },payload: downloaded.rawPayload });
    expect(staged.statusCode,staged.body).toBe(200);
    const review = staged.json<BackupReview>(), input = receipt(review);
    const committed = await command(`/api/data/stages/${review.stageId}/import`,input); expect(committed.statusCode,committed.body).toBe(200);
    expect(app.store.snapshot().revision).toBe(revision);
    const { instructions: _instructions,character: _character,persona: _persona,...settings } = app.store.snapshot().settings;
    const stale = await command('/api/chats/main/selections',{ revision,settings },'initial','PUT'); expect(stale.statusCode).toBe(409); expect(stale.json().code).toBe('dataset_changed');
    const replay = await command(`/api/data/stages/${review.stageId}/import`,input); expect(replay.json()).toEqual(committed.json());
    const fresh = await command('/api/chats/main/selections',{ revision,settings },datasetEpoch(app.store.sqlite),'PUT'); expect(fresh.statusCode,fresh.body).toBe(200);
  } finally { await app.app.close(); }
});

it('keeps inspection bounded for a 4,000-turn synthetic transcript',async () => {
  const db = store('large'), backups = service(db,'large');
  db.replaceHistory(db.snapshot().revision,'main',Array.from({ length: 4000 },(_,i) => ({ user: `Turn ${i+1}: ${'Synthetic source prose. '.repeat(40)}`,assistant: 'Synthetic saved response. '.repeat(40),complete: true })));
  const review = backups.upload(await bytes(backups),owner); expect(review.blockers).toEqual([]);
  const first = backups.page(review.stageId,owner,'turns',0,'main'), last = backups.page(review.stageId,owner,'turns',3960,'main');
  expect(first.total).toBe(4000); expect(first.items).toHaveLength(40); expect(last.items).toHaveLength(40); expect(last.items.at(-1)?.label).toBe('Turn 4000'); expect(JSON.stringify(first).length).toBeLessThan(10000);
  expect(backups.leaf(review.stageId,owner,'turns',first.items[0].key,0).text?.length).toBeLessThanOrEqual(8192);
},15000);
