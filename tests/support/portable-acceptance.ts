// Explicit packaged-output acceptance harness. Uses synthetic data and a local mock.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { startMockProvider } from './mock-provider.js';
import { cardPng, quadrantPicture } from './pictures.js';
import { defaultContextPreset } from '../../src/shared/context.js';
import { newLorebook, newLoreEntry } from '../../src/shared/lorebook.js';
import type { LibrarySnapshot } from '../../src/shared/library.js';
import type { ChatSnapshot, RequestPreview } from '../../src/shared/contracts.js';
import type { BackupReview } from '../../src/shared/backups.js';

const home = resolve(process.argv[2] ?? '');
assert(home.includes('ORE'), 'Pass an isolated synthetic ORE installation, never user data.');
const mock = await startMockProvider();
const reservation = createServer();
await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
const address = reservation.address();
assert(address && typeof address !== 'string');
const port = address.port;
await new Promise<void>(resolve => reservation.close(() => resolve()));
const origin = `http://127.0.0.1:${port}`;
let cookie = '', epoch = 'initial', child: ChildProcess | undefined;
const environment = { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', ORE_OPEN_BROWSER: '0', ORE_SKIP_UPDATE: '1', ROLEPLAY_PORT: String(port), ROLEPLAY_HOST: '127.0.0.1', ROLEPLAY_DATABASE: join(home, 'data/roleplay.sqlite'), ROLEPLAY_TLS_CERT: '', ROLEPLAY_TLS_KEY: '' };
async function launch(extra: NodeJS.ProcessEnv = {}) {
  const processChild = spawn('/bin/bash', [join(home, 'start.command')], { cwd: '/', env: { ...environment, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  processChild.stdout.on('data', bytes => { output += String(bytes); });
  processChild.stderr.on('data', bytes => { output += String(bytes); });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { processChild.kill('SIGTERM'); reject(new Error(`Packaged start timeout: ${output}`)); }, 15000);
    const onData = () => { if (output.includes(`Local: ${origin}`)) { clearTimeout(timer); resolve(); } };
    processChild.stdout.on('data', onData);
    processChild.once('error', error => { clearTimeout(timer); reject(error); });
    processChild.once('exit', code => { clearTimeout(timer); reject(new Error(`Packaged start failed (${code}): ${output}`)); });
  });
  return processChild;
}
async function stop(signal: NodeJS.Signals = 'SIGTERM') {
  if (!child) return;
  const current = child;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Packaged server did not stop.')), 10000);
    current.once('exit', () => { clearTimeout(timer); resolve(); }); current.kill(signal);
  });
  child = undefined;
}
async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(origin + path, { method, headers: { cookie, Origin: origin, 'Content-Type': 'application/json', 'X-ORE-Epoch': epoch }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  epoch = response.headers.get('X-ORE-Epoch') ?? epoch;
  if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie')?.split(';')[0] ?? '';
  const value = await response.json();
  assert(response.ok, `${method} ${path}: ${JSON.stringify(value)}`);
  return value;
}
async function eventually<T>(read: () => Promise<T>, matches: (value: T) => boolean) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { const value = await read(); if (matches(value)) return value; await delay(30); }
  throw new Error('Packaged workflow did not reach its expected state.');
}
async function rejectedStart(message: RegExp, extra: NodeJS.ProcessEnv = {}) {
  const processChild = spawn('/bin/bash', [join(home, 'start.command')], { cwd: '/', env: { ...environment, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; processChild.stdout.on('data', bytes => { output += String(bytes); }); processChild.stderr.on('data', bytes => { output += String(bytes); });
  const status = await new Promise<number | null>((resolve, reject) => { const timer = setTimeout(() => { processChild.kill('SIGTERM'); reject(new Error('Duplicate start hung.')); }, 10000); processChild.once('exit', code => { clearTimeout(timer); resolve(code); }); });
  assert.notEqual(status, 0); assert.match(output, message);
}
try {
  child = await launch();
  const html = await fetch(origin).then(response => response.text()); assert.match(html, /<title>ORE<\/title>/);
  const session = await request<{ setupRequired: boolean }>('/api/session');
  await request(session.setupRequired ? '/api/setup' : '/api/login', 'POST', { password: 'synthetic-portable-password' });
  const about = await request<{ kind: string; node: string; commit: string }>('/api/about'); assert.equal(about.node, '24.19.0'); assert(about.commit.length === 40);
  const libraries = () => request<LibrarySnapshot>('/api/library');
  async function save(kind: string, data: unknown) { return request<{ id: string }>('/api/library', 'POST', { revision: (await libraries()).revision, kind, data, ...(kind === 'connections' ? { apiKey: 'synthetic-portable-secret' } : {}) }); }
  const connection = await save('connections', { name: 'Portable synthetic model', endpoint: mock.url, model: 'synthetic', contextWindow: 100000, maxOutputTokens: 1000, customParameters: {} });
  const image = cardPng(await quadrantPicture(), { name: 'Portable Mira', description: 'A synthetic keeper.', personality: '', scenario: '', first_mes: '', mes_example: '' });
  const imported = await request<{ ids: string[] }>('/api/library/import', 'POST', { revision: (await libraries()).revision, requestId: randomUUID(), kind: 'characters', base64: image.toString('base64'), pictureMode: 'retain' });
  const library = await libraries(); assert(library.characterPictures.some(picture => picture.characterId === imported.ids[0]));
  const lorebook = await save('lorebooks', { ...newLorebook(), entries: [{ ...newLoreEntry(randomUUID()), keys: ['/lantern/i'], useRegex: true, content: 'PACKAGED REGEX LORE', placement: 'history' }] });
  const context = await save('contexts', { ...defaultContextPreset, connectionId: connection.id, batchSize: 2, minTail: 2, promotionGroup: 2, retainedPerLevel: 1 });
  const chat = await request<{ id: string }>('/api/chats', 'POST', { title: 'Portable synthetic story', targetInputTokens: 700, connectionId: connection.id, promptId: 'default', characterId: imported.ids[0], personaId: null, lorebookId: lorebook.id, contextPresetId: context.id });
  const base = `/api/chats/${chat.id}`;
  const state = () => request<ChatSnapshot>(base);
  await request(`${base}/history`, 'PUT', { revision: (await state()).revision, turns: Array.from({ length: 12 }, (_, i) => ({ user: `Turn ${i}. Mira offers a key. ${'The room is quiet. '.repeat(10)}`, assistant: `The lantern casts long shadows. ${'Leon protects the key. '.repeat(7)}`, complete: true })) });
  await request(`${base}/context/prepare`, 'POST', { revision: (await state()).revision, requestId: randomUUID(), mode: 'prepare' });
  let saved = await eventually(state, snapshot => snapshot.context.jobs[0]?.status !== 'running');
  assert.equal(saved.context.jobs[0]?.status, 'succeeded'); assert(saved.context.selected.length > 0);
  const first = saved.turns[0]; assert(first);
  await request(`${base}/turns/${first.id}/user`, 'PATCH', { revision: saved.revision, text: first.user.text.replace('Mira', 'Nora') });
  await request(`${base}/context/prepare`, 'POST', { revision: (await state()).revision, requestId: randomUUID(), mode: 'repair' });
  saved = await eventually(state, snapshot => snapshot.context.jobs[0]?.status !== 'running');
  while (saved.context.jobs[0]?.status === 'awaiting_review') {
    await request(`/api/context/jobs/${saved.context.jobs[0].id}/repair`, 'POST', { revision: saved.revision, requestId: randomUUID(), action: 'approve' });
    saved = await eventually(state, snapshot => snapshot.context.jobs[0]?.status !== 'running');
  }
  assert.equal(saved.context.jobs[0]?.status, 'succeeded');
  await request(`${base}/turns`, 'POST', { revision: saved.revision, requestId: randomUUID(), text: 'I raise the lantern.' });
  saved = await eventually(state, snapshot => snapshot.generations[0]?.status !== 'running');
  assert.equal(saved.generations[0]?.status, 'succeeded');
  const generation = saved.generations[0]; assert(generation);
  const historical = await request<RequestPreview>(`${base}/generations/${generation.id}/request`);
  assert(historical.body.messages.some(message => message.content.includes('PACKAGED REGEX LORE')));
  assert(!JSON.stringify(saved).includes('synthetic-portable-secret'));
  const backupResponse = await fetch(origin + '/api/data/backup', { headers: { cookie } }); assert(backupResponse.ok);
  const bytes = Buffer.from(await backupResponse.arrayBuffer()); assert(bytes.length > 0);
  const staged = await fetch(origin + '/api/data/stages', { method: 'POST', headers: { cookie, Origin: origin, 'Content-Type': 'application/octet-stream' }, body: bytes }); assert(staged.ok);
  const review: BackupReview = await staged.json(); assert(review.overlaps > 0); assert.equal(review.blockers.length, 0);
  await request(`/api/data/stages/${review.stageId}/import`, 'POST', { digest: review.digest, token: review.token, requestId: randomUUID(), overwrite: true });
  assert.deepEqual((await state()).turns, saved.turns);
  await rejectedStart(/Another server is already using this database/);
  await rejectedStart(new RegExp(`Port ${port} is occupied`), { ROLEPLAY_DATABASE: join(home, 'data/collision.sqlite') });
  assert.deepEqual(await request(`${base}/generations/${generation.id}/request`), historical);
  await stop();
  child = await launch(); // No installation commands; default PATH has no Node/npm.
  assert.deepEqual((await state()).turns, saved.turns);
  assert.deepEqual(await request(`${base}/generations/${generation.id}/request`), historical);
  await stop('SIGKILL'); // IPC parent death shuts the server down; wait for ownership release.
  await eventually(async () => fetch(origin + '/api/session').then(() => false).catch(() => true), value => value);
  child = await launch();
  assert.deepEqual((await state()).turns, saved.turns);
  await stop();
  writeFileSync(join(home, 'logs/acceptance.json'), JSON.stringify({ about, platform: process.platform, arch: process.arch, checks: ['installed UI', 'owner', 'Connection', 'pictured PNG card and native child', 'lore regex worker', 'prepare', 'reviewed repair', 'generation', 'immutable request', 'backup/import', 'port collision', 'duplicate database owner', 'graceful restart', 'launcher interruption and restart', 'repeat start without Node/npm PATH'] }, null, 2));
  console.log(`Packaged acceptance passed. Evidence: ${join(home, 'logs/acceptance.json')}`);
} finally { await stop(); await mock.close(); }
