import { semanticFingerprint } from '../src/core/lorebook.js';
import { z } from 'zod';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { Store } from '../src/persistence/store.js';
import { BackupService } from '../src/server/backups.js';
import { unprotectBytes } from '../src/server/protected-files.js';
import { BackupStore } from '../src/persistence/backup-store.js';
import { GenerationCoordinator } from '../src/server/coordinator.js';
import { defaultContextPreset, type ContextJob, type SummaryNode } from '../src/shared/context.js';
import { newLorebook, newLoreEntry } from '../src/shared/lorebook.js';
import { selectionsSchema } from '../src/shared/library.js';
import type { Provider } from '../src/provider/openai.js';
import { PictureProcessor } from '../src/server/pictures.js';
import { quadrantPicture } from './support/pictures.js';
import { createApp } from '../src/server/app.js';
import { backupLimits, type BackupReview } from '../src/shared/backups.js';
import { compactPrompt } from './support/compact-prompt.js';

let directory: string;
const stores: Store[] = [], services: BackupService[] = [], coordinators: GenerationCoordinator[] = [], processors: PictureProcessor[] = [];
beforeEach(() => { directory = mkdtempSync(join(tmpdir(),'ore-backup-recovery-')); });
afterEach(async () => { vi.useRealTimers(); await Promise.all(coordinators.splice(0).map(value => value.shutdown())); await Promise.all(processors.splice(0).map(value => value.close())); services.splice(0).forEach(value => value.close()); stores.splice(0).forEach(value => { if (value.sqlite.open) value.close(); }); rmSync(directory,{ recursive: true,force: true }); });
function open(name: string) { const value = new Store(join(directory,`${name}.sqlite`)); stores.push(value); return value; }
function backup(db: Store,name: string) { const value = new BackupService(db,join(directory,`${name}.sqlite`)); services.push(value); return value; }
// Schema-corruption and crash fixtures need the inner SQLite snapshot.
async function exported(value: BackupService) { const file = await value.export(); try { return await unprotectBytes(readFileSync(file.path), 'backup', '', backupLimits.bytes); } finally { file.cleanup(); } }
const command = (review: BackupReview) => ({ requestId: randomUUID(),digest: review.digest,token: review.token,overwrite: true });
function requireValue<T>(value: T | null | undefined): T { if (value == null) throw new Error('Missing synthetic fixture.'); return value; }
const model = { name: 'Synthetic',endpoint: 'http://localhost:1234/v1',model: 'synthetic',contextWindow: 100000,maxOutputTokens: 1000,customParameters: {} };

it('round trips variants, corrected selected memory, picture links, exact requests and approved preparation progress through wipe/import/restart',async () => {
  let db = open('roundtrip'), backups = backup(db,'roundtrip');
  db.saveLibrary(db.libraryRevision(), 'prompts', compactPrompt, 'default');
  const connectionId = db.saveLibrary(db.libraryRevision(),'connections',model,undefined,'synthetic-story-key');
  const contextId = db.saveLibrary(db.libraryRevision(),'contexts',{ ...defaultContextPreset,connectionId,minTail: 2,batchSize: 2,promotionGroup: 2,retainedPerLevel: 1 });
  const processor = new PictureProcessor(); processors.push(processor); const image = await processor.process(await quadrantPicture());
  const card = { name: 'Mara',description: 'Keeper of the brass key.',personality: '',scenario: '',first_mes: 'Welcome.',alternate_greetings: ['Another welcome.'],mes_example: '' };
  const cid = db.saveCharacter({ kind: 'characters',revision: db.libraryRevision(),requestId: randomUUID(),data: card,tagIds: [],expectedPicture: null,picture: { mode: 'replace',base64: image.original.toString('base64'),crop: image.crop } },undefined,image).id;
  const tag = db.tags.create(db.libraryRevision(),'Keys'); db.tags.setAssignments(db.libraryRevision(),cid,[tag]);
  const book = newLorebook(); book.name = 'Tower lore'; const bookId = db.saveLibrary(db.libraryRevision(),'lorebooks',book);
  db.saveLibrary(db.libraryRevision(),'characters',{ ...card,lorebookId: bookId },cid);
  const chatId = db.createChat({ title: 'Remember the key',targetInputTokens: 1200,connectionId,promptId: 'default',characterId: cid,personaId: null,contextPresetId: contextId,lorebookId: bookId });
  db.replaceHistory(db.snapshot(chatId).revision,chatId,Array.from({ length: 16 },(_,i) => ({ user: `Turn ${i}: Mara offers the brass key. ${'A quiet tower. '.repeat(20)}`,assistant: `Leon takes the key. ${'He promises to return. '.repeat(20)}`,complete: true })));
  const calls: unknown[] = [];
  const provider: Provider = { async stream(request,_key,_signal,onText) { calls.push(request); const payload = request.body.messages.at(-1)?.content ?? ''; onText(payload.includes('"sources"') ? 'Mara gave Leon the brass key.' : 'Leon returns the brass key.'); return { finishReason: 'stop' }; } };
  let coordinator = new GenerationCoordinator(db,provider); coordinators.push(coordinator);
  const job = await coordinator.context.startResolved(chatId,db.snapshot(chatId).revision,randomUUID(),'prepare');
  await expect.poll(() => db.contexts.job(job.jobId).status).toBe('succeeded');
  const selected = requireValue(db.snapshot(chatId).context.selected.at(-1));
  db.contexts.editSummary(chatId,db.snapshot(chatId).revision,selected,'Author correction: Mara gave Leon the brass key; a silver duplicate remains hidden.');
  const prepared = await coordinator.context.startResolved(chatId,db.snapshot(chatId).revision,randomUUID(),'prepare'); await expect.poll(() => db.contexts.job(prepared.jobId).status).toBe('succeeded');
  coordinator.start(db.snapshot(chatId).revision,randomUUID(),'I return the key.',chatId);
  await expect.poll(() => db.snapshot(chatId).generations[0]?.status).toBe('succeeded');
  coordinator.regenerate(db.snapshot(chatId).revision,randomUUID(),requireValue(db.snapshot(chatId).turns.at(-1)).id,chatId);
  await expect.poll(() => db.snapshot(chatId).generations[0]?.status).toBe('succeeded');
  const before = db.snapshot(chatId), generation = requireValue(before.generations[0]), request = db.generation(generation.id)?.request, picture = requireValue(db.pictures.get(cid));
  const bytes = await exported(backups), totalCalls = calls.length;
  const persistence = new BackupStore(db); persistence.commit({ requestId: randomUUID(),digest: '0'.repeat(64),token: persistence.token,overwrite: true });
  const review = backups.upload(bytes,'owner'); expect(review.blockers).toEqual([]); backups.commit(review.stageId,'owner',command(review));
  await coordinator.shutdown(); coordinators.splice(coordinators.indexOf(coordinator),1); backups.close(); db.close();
  db = open('roundtrip'); backups = backup(db,'roundtrip'); coordinator = new GenerationCoordinator(db,provider); coordinators.push(coordinator);
  expect(calls).toHaveLength(totalCalls);
  const after = db.snapshot(chatId);
  expect(after.turns).toEqual(before.turns); expect(after.context.selected).toEqual(before.context.selected); expect(after.context.summaries).toEqual(before.context.summaries);
  expect(after.context.archivedTurnIds).toEqual(before.context.archivedTurnIds);
  expect(after.context.summaries.some(value => value.manual && value.text.includes('silver duplicate'))).toBe(true);
  expect(after.context.jobs).toEqual(before.context.jobs);
  expect(db.generation(generation.id)?.request).toEqual(request);
  expect(db.pictures.resource(cid,picture.key,'original').bytes).toEqual(image.original); expect(db.tags.assigned(cid)).toEqual([tag]);
  expect(db.snapshot(chatId).settings.lorebookId).toBe(bookId);
  coordinator.start(db.snapshot(chatId).revision,randomUUID(),'We continue after restoring the story.',chatId);
  await expect.poll(() => db.snapshot(chatId).generations[0]?.status).toBe('succeeded');
  expect(db.snapshot(chatId).turns).toHaveLength(before.turns.length+1);
  expect(db.snapshot(chatId).turns.at(-1)?.assistant.text).toBe('Leon returns the brass key.');
  expect(db.generation(generation.id)?.request).toEqual(request);

});

it('clears absent incoming credentials/art and preserves immutable bytes referenced by a retained character during an asset-ID collision',async () => {
  const source = open('assets-source'), input = backup(source,'assets-source');
  const connectionId = source.saveLibrary(source.libraryRevision(),'connections',model);
  const cid = source.saveLibrary(source.libraryRevision(),'characters',{ name: 'Incoming',description: '',personality: '',scenario: '',first_mes: '',mes_example: '' });
  const baseline = await exported(input);
  const destination = open('assets-destination'), target = backup(destination,'assets-destination');
  let review = target.upload(baseline,'owner'); target.commit(review.stageId,'owner',command(review));
  destination.saveLibrary(destination.libraryRevision(),'connections',model,connectionId,'newer-local-secret');
  const processor = new PictureProcessor(); processors.push(processor); const image = await processor.process(await quadrantPicture());
  const { id: _id,revision: _revision,...saved } = requireValue(destination.libraries().characters.find(value => value.id === cid));
  destination.saveCharacter({ kind: 'characters',revision: destination.libraryRevision(),requestId: randomUUID(),data: saved,tagIds: [],expectedPicture: null,picture: { mode: 'replace',base64: image.original.toString('base64'),crop: image.crop } },cid,image);
  const retained = destination.duplicateCharacter(destination.libraryRevision(),cid), retainedPicture = requireValue(destination.pictures.get(retained));
  review = target.upload(baseline,'owner'); target.commit(review.stageId,'owner',command(review));
  expect(destination.connectionApiKey(connectionId)).toBe(''); expect(destination.pictures.get(cid)).toBeNull();
  expect(destination.pictures.resource(retained,retainedPicture.key,'original').bytes).toEqual(image.original);
  // Force a valid storage collision in the synthetic source; only the imported association gets remapped.
  source.saveCharacter({ kind: 'characters',revision: source.libraryRevision(),requestId: randomUUID(),data: saved,tagIds: [],expectedPicture: null,picture: { mode: 'replace',base64: image.original.toString('base64'),crop: image.crop } },cid,image);
  const assetRow = z.object({ asset_id: z.string() });
  const collision = assetRow.parse(destination.sqlite.prepare('SELECT asset_id FROM character_pictures WHERE character_id = ?').get(retained));
  const asset = assetRow.parse(source.sqlite.prepare('SELECT asset_id FROM character_pictures WHERE character_id = ?').get(cid));
  const original = Buffer.concat([image.original,Buffer.from('synthetic trailing image bytes')]);
  source.sqlite.pragma('foreign_keys = OFF');
  source.sqlite.prepare('UPDATE picture_assets SET id = ?, original = ?, digest = ? WHERE id = ?').run(collision.asset_id,original,createHash('sha256').update(original).digest('hex'),asset.asset_id);
  source.sqlite.prepare('UPDATE character_pictures SET asset_id = ? WHERE character_id = ?').run(collision.asset_id,cid); source.sqlite.pragma('foreign_keys = ON');
  review = target.upload(await exported(input),'owner'); expect(review.blockers).toEqual([]); target.commit(review.stageId,'owner',command(review));
  expect(destination.pictures.resource(retained,retainedPicture.key,'original').bytes).toEqual(image.original);
  expect(destination.pictures.resource(cid,requireValue(destination.pictures.get(cid)).key,'original').bytes).toEqual(original);
});

it('updates retained shared-record consumers and clears old lore activation without rewriting historical requests or narrative summaries',async () => {
  const db = open('shared'), backups = backup(db,'shared');
  const book = newLorebook(); book.name = 'Original lore'; const bid = db.saveLibrary(db.libraryRevision(),'lorebooks',book);
  const cid = db.saveLibrary(db.libraryRevision(),'characters',{ name: 'Before',description: 'Before description',personality: '',scenario: '',first_mes: 'Greeting',mes_example: '',lorebookId: bid });
  const old = await exported(backups);
  const chatId = db.createChat({ title: 'Retained story',targetInputTokens: 32000,connectionId: null,promptId: 'default',characterId: cid,personaId: null,contextPresetId: null,lorebookId: bid });
  db.sqlite.prepare('INSERT INTO lore_states VALUES (?,?,0,?)').run(chatId,bid,JSON.stringify({ entry: { fingerprint: 'old',matches: 9 } }));
  db.saveLibrary(db.libraryRevision(),'characters',{ name: 'After',description: 'After description',personality: '',scenario: '',first_mes: 'New greeting',mes_example: '',lorebookId: bid },cid);
  const before = db.snapshot(chatId), review = backups.upload(old,'owner'); expect(review.totalEffects).toBe(1); expect(review.effects[0].id).toBe(chatId);
  backups.commit(review.stageId,'owner',command(review));
  const after = db.snapshot(chatId); expect(after.turns).toEqual(before.turns); expect(after.context).toEqual(before.context); expect(after.revision).toBeGreaterThan(before.revision); expect(after.sources.character?.name).toBe('Before'); expect(db.loreState(chatId,bid).entries).toEqual({});
});

it('interrupts running work, discards unapproved repair candidates, and makes no automatic provider call after import',async () => {
  const db = open('interrupt'), backups = backup(db,'interrupt');
  const connectionId = db.saveLibrary(db.libraryRevision(),'connections',model), contextId = db.saveLibrary(db.libraryRevision(),'contexts',{ ...defaultContextPreset,connectionId,minTail: 0,batchSize: 1 });
  const chatId = db.createChat({ title: 'Interrupted',targetInputTokens: 1000,connectionId,promptId: 'default',characterId: null,personaId: null,contextPresetId: contextId });
  db.replaceHistory(db.snapshot(chatId).revision,chatId,[{ user: 'The key changes hands.',assistant: 'Mara takes it.',complete: true }]);
  const snap = db.snapshot(chatId), nodeId = randomUUID(), jobId = randomUUID(), stepId = randomUUID();
  const node: SummaryNode = { id: nodeId,revision: 0,level: 1,text: 'UNAPPROVED_REPAIR_TEXT',turns: [],children: [],prior: [],approved: false,manual: false,createdAt: new Date().toISOString() };
  db.sqlite.prepare('INSERT INTO summaries VALUES (?,?,?,?)').run(nodeId,0,chatId,JSON.stringify(node));
  const job: ContextJob = { id: jobId,chatId,status: 'awaiting_review',mode: 'repair',generationId: null,config: requireValue(snap.context.preset),sourceRevision: snap.revision,historyTurnIds: snap.turns.map(turn => turn.id),stepCount: 1,error: null,createdAt: '',updatedAt: '' };
  db.sqlite.prepare('INSERT INTO context_jobs VALUES (?,?,?,?,?)').run(jobId,chatId,randomUUID(),'{}',JSON.stringify(job));
  db.sqlite.prepare('INSERT INTO context_steps VALUES (?,?,?)').run(stepId,jobId,JSON.stringify({ id: stepId,jobId,operation: { level: 1,turnIds: [],children: [] },request: null,status: 'candidate',result: { id: nodeId,revision: 0 },before: { selected: [],archivedTurnIds: [] },after: null,inputBefore: 1,inputAfter: null,error: null,createdAt: '' }));
  const generation = db.begin(db.snapshot(chatId).revision,randomUUID(),'Pending input',chatId); db.checkpoint(generation.id,'Partial reply','Partial reasoning');
  const portable = await exported(backups); expect(portable.includes(Buffer.from('UNAPPROVED_REPAIR_TEXT'))).toBe(false);
  db.finish(generation.id,'cancelled','Partial reply',null,null,'Partial reasoning');
  const review = backups.upload(portable,'owner'); expect(review.blockers).toEqual([]); backups.commit(review.stageId,'owner',command(review));
  const provider: Provider = { stream: vi.fn() }; const coordinator = new GenerationCoordinator(db,provider); coordinators.push(coordinator);
  expect(provider.stream).not.toHaveBeenCalled(); expect(db.generation(generation.id)).toMatchObject({ status: 'interrupted',partialText: 'Partial reply',reasoningText: 'Partial reasoning' });
  expect(db.snapshot(chatId).turns.at(-1)?.complete).toBe(false); expect(db.contexts.job(jobId).status).toBe('interrupted'); expect(db.contexts.steps(jobId)[0].status).toBe('discarded'); expect(db.snapshot(chatId).context.summaries).toEqual([]);
});

it('rolls back an import or wipe when its durable receipt cannot be written',async () => {
  const db = open('rollback'), backups = backup(db,'rollback'); const bytes = await exported(backups), review = backups.upload(bytes,'owner');
  const persistence = new BackupStore(db), before = persistence.token;
  db.sqlite.exec("CREATE TRIGGER fail_data_receipt BEFORE INSERT ON data_commands BEGIN SELECT RAISE(ABORT,'synthetic write failure'); END");
  expect(() => backups.commit(review.stageId,'owner',command(review))).toThrow('synthetic write failure'); expect(persistence.token).toBe(before);
  expect(() => persistence.commit({ requestId: randomUUID(),digest: '0'.repeat(64),token: persistence.token,overwrite: true })).toThrow('synthetic write failure'); expect(persistence.token).toBe(before);
  db.sqlite.exec('DROP TRIGGER fail_data_receipt'); expect(backups.commit(review.stageId,'owner',command(review)).ok).toBe(true);
});

it('expires/cancels staging and removes orphaned stage artifacts on restart',async () => {
  const db = open('expiry'), backups = backup(db,'expiry'), portable = await exported(backups), review = backups.upload(portable,'owner');
  vi.useFakeTimers(); vi.setSystemTime(Date.now()+31*60_000); expect(() => backups.review(review.stageId,'owner')).toThrow('expired'); vi.useRealTimers();
  expect(readdirSync(join(directory,'.ore-backups-expiry.sqlite'))).toEqual([]);
  const stage = backups.upload(portable,'owner'); expect(stage.stageId).toBeTruthy(); backups.close();
  const restarted = backup(db,'expiry'); expect(() => restarted.review(stage.stageId,'owner')).toThrow('expired'); expect(readdirSync(join(directory,'.ore-backups-expiry.sqlite'))).toEqual([]);
});

it('blocks a wipe while an asynchronous library save is in flight, then rejects the old epoch after commit',async () => {
  const application = await createApp({ database: join(directory,'gate.sqlite') });
  const headers = { host: 'localhost',origin: 'http://localhost','content-type': 'application/json' };
  let release = () => {}, started = () => {};
  const entered = new Promise<void>(resolve => { started = resolve; });
  application.app.addHook('preHandler',async request => { if (request.url === '/api/library') { started(); await new Promise<void>(resolve => { release = resolve; }); } });
  try {
    const setup = await application.app.inject({ method: 'POST',url: '/api/setup',headers,payload: { password: 'synthetic-owner-password' } });
    const cookie = String(setup.headers['set-cookie']).split(';')[0], authenticated = { ...headers,cookie };
    const preview = await application.app.inject({ method: 'GET',url: '/api/data/wipe-preview',headers: authenticated });
    const pending = application.app.inject({ method: 'POST',url: '/api/library',headers: authenticated,payload: { kind: 'personas',revision: application.store.libraryRevision(),data: { name: 'Delayed',description: '' } } });
    const saving = pending.then(value => value); await entered;
    const blocked = await application.app.inject({ method: 'POST',url: '/api/data/wipe',headers: authenticated,payload: { ...preview.json<{ token: string; digest: string }>(),requestId: randomUUID(),overwrite: true } });
    expect(blocked.statusCode).toBe(409); expect(blocked.json().code).toBe('data_management_busy'); release(); expect((await saving).statusCode).toBe(200);
    const refreshed = await application.app.inject({ method: 'GET',url: '/api/data/wipe-preview',headers: authenticated });
    const wiped = await application.app.inject({ method: 'POST',url: '/api/data/wipe',headers: authenticated,payload: { ...refreshed.json<{ token: string; digest: string }>(),requestId: randomUUID(),overwrite: true } }); expect(wiped.statusCode).toBe(200);
    const late = await application.app.inject({ method: 'POST',url: '/api/chats',headers: authenticated,payload: selectionsSchema.parse({ title: 'Stale',targetInputTokens: 1000,connectionId: null,promptId: 'default',characterId: null,personaId: null }) }); expect(late.statusCode).toBe(409);
  } finally { await application.app.close(); }
});

it('keeps the last committed story when the server process dies inside the import transaction',async () => {
  const { spawn } = await import('node:child_process');
  const db = open('crash'), backups = backup(db,'crash');
  db.replaceHistory(db.snapshot().revision,'main',[{ user: 'Before backup',assistant: 'Older backup response',complete: true }]);
  const input = join(directory,'crash-input.sqlite'); writeFileSync(input,await exported(backups));
  db.replaceHistory(db.snapshot().revision,'main',[{ user: 'Current user text',assistant: 'Current saved response',complete: true }]);
  const before = db.snapshot(), token = new BackupStore(db).token;
  backups.close(); db.close();
  const child = spawn(process.execPath,['--import','tsx','tests/support/backup-crash-worker.ts',join(directory,'crash.sqlite'),input],{ cwd: process.cwd(),stdio: ['ignore','pipe','pipe'] });
  let output = '', errors = ''; child.stdout.on('data',chunk => { output += String(chunk); }); child.stderr.on('data',chunk => { errors += String(chunk); });
  const termination = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve,reject) => { child.once('error',reject); child.once('exit',(code,signal) => resolve({ code, signal })); });
  expect(output,errors).toContain('crash-before-data-receipt');
  // Windows reports TerminateProcess as a nonzero exit code, without a signal.
  if (process.platform === 'win32') expect(termination.code).not.toBe(0);
  else expect(termination.signal).toBe('SIGKILL');
  const restarted = open('crash'); expect(restarted.snapshot()).toEqual(before); expect(new BackupStore(restarted).token).toBe(token); expect(restarted.sqlite.prepare('SELECT * FROM data_commands').all()).toEqual([]);
  restarted.sqlite.exec('DROP TRIGGER synthetic_crash');
  const resumed = backup(restarted,'crash'), review = resumed.upload(readFileSync(input),'owner'); expect(review.blockers).toEqual([]); resumed.commit(review.stageId,'owner',command(review)); expect(restarted.snapshot().turns[0].assistant.text).toBe('Older backup response');
},15000);

it('blocks import/wipe until paid work and its cancelled asynchronous completion have settled',async () => {
  let release = () => {}, entered = () => {};
  const started = new Promise<void>(resolve => { entered = resolve; });
  const provider: Provider = { async stream(_request,_key,_signal,onText) { entered(); await new Promise<void>(resolve => { release = resolve; }); onText('Late response'); return { finishReason: 'stop' }; } };
  const application = await createApp({ database: join(directory,'active.sqlite'),provider });
  const base = { host: 'localhost',origin: 'http://localhost','content-type': 'application/json' };
  try {
    const setup = await application.app.inject({ method: 'POST',url: '/api/setup',headers: base,payload: { password: 'synthetic-owner-password' } });
    const headers = { ...base,cookie: String(setup.headers['set-cookie']).split(';')[0] };
    application.store.saveSettings(application.store.snapshot().revision,model,application.store.snapshot().settings,'synthetic-key');
    const response = await application.app.inject({ method: 'POST',url: '/api/turns',headers,payload: { revision: application.store.snapshot().revision,requestId: randomUUID(),text: 'Pending input' } }); expect(response.statusCode).toBe(202); await started;
    const attemptWipe = async () => {
      const preview = await application.app.inject({ method: 'GET',url: '/api/data/wipe-preview',headers });
      return application.app.inject({ method: 'POST',url: '/api/data/wipe',headers,payload: { ...preview.json<{ token: string; digest: string }>(),requestId: randomUUID(),overwrite: true } });
    };
    expect((await attemptWipe()).statusCode).toBe(409);
    const generation = response.json<{ generationId: string }>().generationId;
    const cancelled = await application.app.inject({ method: 'POST',url: `/api/generations/${generation}/cancel`,headers,payload: {} }); expect(cancelled.statusCode).toBe(200);
    expect((await attemptWipe()).statusCode).toBe(409);
    release(); await expect.poll(() => application.coordinator.hasActiveWork()).toBe(false);
    expect((await attemptWipe()).statusCode).toBe(200); expect(application.store.libraries().chats).toEqual([]);
  } finally { release(); await application.app.close(); }
});

it('retains an executing mutation permit after browser disconnection and releases it when the handler settles',async () => {
  const { request: httpRequest } = await import('node:http');
  const application = await createApp({ database: join(directory,'disconnect.sqlite') });
  let entered = () => {}, release = () => {};
  const started = new Promise<void>(resolve => { entered = resolve; });
  application.app.post('/api/synthetic-delayed-save',async () => {
    entered(); await new Promise<void>(resolve => { release = resolve; });
    application.store.saveLibrary(application.store.libraryRevision(),'personas',{ name: 'Saved after disconnect',description: '' });
    return { ok: true };
  });
  const address = await application.app.listen({ host: '127.0.0.1',port: 0 });
  const base = { host: 'localhost',origin: 'http://localhost','content-type': 'application/json' };
  try {
    const setup = await application.app.inject({ method: 'POST',url: '/api/setup',headers: base,payload: { password: 'synthetic-owner-password' } });
    const cookie = String(setup.headers['set-cookie']).split(';')[0];
    const pending = httpRequest(`${address}/api/synthetic-delayed-save`,{ method: 'POST',headers: { 'Content-Type': 'application/json',Origin: address,Cookie: cookie } });
    pending.on('error',() => {}); pending.end('{}'); await started; pending.destroy();
    const wipe = async () => {
      const preview = await application.app.inject({ method: 'GET',url: '/api/data/wipe-preview',headers: { ...base,cookie } });
      return application.app.inject({ method: 'POST',url: '/api/data/wipe',headers: { ...base,cookie },payload: { ...preview.json<{ token: string; digest: string }>(),requestId: randomUUID(),overwrite: true } });
    };
    expect((await wipe()).statusCode).toBe(409); release();
    await expect.poll(() => application.store.libraries().personas.some(value => value.name === 'Saved after disconnect')).toBe(true);
    expect((await wipe()).statusCode).toBe(200);
  } finally { release(); await application.app.close(); }
});

it('preserves retained-chat lore matches for cosmetic overwrites and drops only semantically changed entries',async () => {
  const db = open('lore-semantics'), backups = backup(db,'lore-semantics');
  const book = newLorebook(); book.name = 'Before cosmetic edit'; book.entries = [{ ...newLoreEntry('first'),content: 'Brass key',constant: true },{ ...newLoreEntry('second'),content: 'Silver key',constant: true }];
  const bid = db.saveLibrary(db.libraryRevision(),'lorebooks',book);
  const { id: _bookId,revision: _bookRevision,...original } = requireValue(db.libraries().lorebooks.find(value => value.id === bid));
  const portable = await exported(backups);
  const chatId = db.createChat({ title: 'Retained lore consumer',targetInputTokens: 32000,connectionId: null,promptId: 'default',characterId: null,personaId: null,contextPresetId: null,lorebookId: bid });
  const initialEntries = Object.fromEntries(original.entries.map(entry => [entry.id,{ fingerprint: semanticFingerprint(original,entry),matches: 4 }]));
  db.sqlite.prepare('INSERT INTO lore_states VALUES (?,?,0,?)').run(chatId,bid,JSON.stringify(initialEntries));
  db.saveLibrary(db.libraryRevision(),'lorebooks',{ ...original,name: 'Cosmetic label',entries: original.entries.map(entry => ({ ...entry,comment: 'Cosmetic comment' })) },bid);
  let review = backups.upload(portable,'owner'); expect(review.blockers).toEqual([]); backups.commit(review.stageId,'owner',command(review));
  expect(db.loreState(chatId,bid).entries).toEqual(initialEntries);
  db.saveLibrary(db.libraryRevision(),'lorebooks',{ ...original,entries: original.entries.map((entry,index) => index === 0 ? { ...entry,content: 'Different key' } : entry) },bid);
  const changed = requireValue(db.libraries().lorebooks.find(value => value.id === bid));
  const currentEntries = Object.fromEntries(changed.entries.map(entry => [entry.id,{ fingerprint: semanticFingerprint(changed,entry),matches: 8 }]));
  db.sqlite.prepare('UPDATE lore_states SET data = ? WHERE chat_id = ? AND book_id = ?').run(JSON.stringify(currentEntries),chatId,bid);
  review = backups.upload(portable,'owner'); backups.commit(review.stageId,'owner',command(review));
  expect(db.loreState(chatId,bid).entries).toEqual({ [original.entries[1].id]: currentEntries[original.entries[1].id] });
});
