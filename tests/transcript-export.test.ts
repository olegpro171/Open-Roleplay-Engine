import { seedTranscript } from './support/transcript-fixture.js';
import { expect, test, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultContextPreset } from '../src/shared/context.js';
import { defaultPrompt } from '../src/shared/library.js';
import { newLorebook } from '../src/shared/lorebook.js';
import { importChat } from '../src/core/chat-import.js';
import { createApp } from '../src/server/app.js';
import { preparedDownloadSchema } from '../src/shared/downloads.js';

test('exports a consistent saved transcript for the requested story only', async () => {
  const { app, store } = await createApp({ database: ':memory:' });
  try {
    const host = { host: 'localhost', origin: 'http://localhost' };
    const setup = await app.inject({ method: 'POST', url: '/api/setup', headers: host, payload: { password: 'synthetic-export-password' } });
    expect(setup.statusCode).toBe(200);
    const headers = { ...host, cookie: String(setup.headers['set-cookie']).split(';')[0] };
    const { id, revision } = store.chatHeader();
    const story = [
      { user: '', assistant: 'Opening 👋', complete: true },
      { user: 'Earlier\r\nmessage', assistant: 'Selected **reply** ![alt](https://example.test/image.png)', complete: true },
      ...Array.from({ length: 16 }, (_, i) => ({ user: `Turn ${i}`, assistant: `Reply ${i}`, complete: true })),
      { user: 'Pending final question', assistant: '', complete: false },
    ];
    const savedRevision = seedTranscript(store, revision, id, story);
    const other = store.createChat({ title: 'Other', promptId: 'default', connectionId: null, characterId: null, personaId: null, targetInputTokens: 32000 });
    seedTranscript(store, 0, other, [{ user: 'Other story only', assistant: '', complete: false }]);
    const savedTurn = store.readTurns(id)[1];
    if (!savedTurn) throw new Error('Missing synthetic turn');
    store.sqlite.prepare('INSERT INTO response_variants (id,turn_id,text,source_revision,created_at) VALUES (?,?,?,?,?)')
      .run('unselected', savedTurn.id, 'Unselected alternative', 1, new Date().toISOString());

    const prepare = (rev: number) => app.inject({ method: 'POST', url: `/api/chats/${id}/export`, headers, payload: { revision: rev } });
    expect((await prepare(revision)).statusCode).toBe(409);
    const prepared = await prepare(savedRevision);
    expect(prepared.statusCode).toBe(200);
    const file = preparedDownloadSchema.parse(prepared.json());
    expect(file.filename).toBe('Main.jsonl');

    const download = () => app.inject({ method: 'GET', url: file.url, headers });
    expect((await app.inject({ method: 'GET', url: file.url, headers: host })).statusCode).toBe(401);
    store.editPart(savedRevision, savedTurn.id, 'user', 'Later edit', id);
    const exported = await download();
    expect(exported.statusCode).toBe(200);
    expect(exported.headers['content-disposition']).toBe(`attachment; filename="${file.filename}"`);
    expect(exported.body).not.toMatch(/Other story only|Unselected alternative|Later edit/);
    async function* chunks() { yield exported.body; }
    expect((await importChat(chunks())).turns).toEqual(story);
    await vi.waitFor(async () => expect((await download()).statusCode).toBe(404));
  } finally {
    await app.close();
  }
});

test.each([
  ['Падение с 30-го этажа 123', 'Падение с 30-го этажа 123.jsonl'],
  ["夜 (100%) d'Artagnan 🌙", "夜 (100%) d'Artagnan 🌙.jsonl"],
  ['Gate/West\r\nNight', 'Gate-West-Night.jsonl'],
  ['NUL.notes', '_NUL.notes.jsonl'],
  ['界'.repeat(100), '界'.repeat(83) + '.jsonl'],
])('downloads the branch %j with a portable UTF-8 filename', async (name, filename) => {
  const { app, store } = await createApp({ database: ':memory:' });
  try {
    const { headers } = await ownerSession(app);
    store.renameBranch('main', store.chatHeader().revision, name);
    const prepared = await app.inject({ method: 'POST', url: '/api/chats/main/export', headers, payload: { revision: store.chatHeader().revision } });
    expect(prepared.statusCode, prepared.body).toBe(200);
    const ticket = preparedDownloadSchema.parse(prepared.json());
    expect(ticket.filename).toBe(filename);
    const download = await app.inject({ url: ticket.url, headers });
    expect(download.statusCode, download.body).toBe(200);
    const disposition = download.headers['content-disposition'];
    if (/[^ -~]/.test(filename)) {
      const encoded = /^attachment; filename="download\.jsonl"; filename\*=UTF-8''([a-zA-Z0-9.%_~-]+)$/.exec(String(disposition))?.[1];
      expect(decodeURIComponent(encoded ?? '')).toBe(filename);
    } else {
      expect(disposition).toBe(`attachment; filename="${filename}"`);
    }
  } finally { await app.close(); }
});

test('exported final user-only completion is interpreted as pending on import', async () => {
  const { app, store } = await createApp({ database: ':memory:' });
  try {
    const { headers } = await ownerSession(app);
    const story = [
      { user: 'The gate?', assistant: 'Open.', complete: true },
      { user: 'I walk in.\nТихо.', assistant: '', complete: true },
    ];
    const revision = seedTranscript(store, 0, 'main', story);
    const prepared = await app.inject({ method: 'POST', url: '/api/chats/main/export', headers, payload: { revision } });
    const file = preparedDownloadSchema.parse(prepared.json());
    const exported = await app.inject({ method: 'GET', url: file.url, headers });
    const parsed = await importChat(lines([exported.body]));
    expect(parsed.turns).toEqual([story[0], { ...story[1], complete: false }]);
  } finally { await app.close(); }
});

type App = Awaited<ReturnType<typeof createApp>>['app'];
async function ownerSession(app: App) {
  const host = { host: 'localhost', origin: 'http://localhost' };
  const setup = await app.inject({ method: 'POST', url: '/api/setup', headers: host, payload: { password: 'synthetic-import-password' } });
  expect(setup.statusCode).toBe(200);
  return { host, headers: { ...host, cookie: String(setup.headers['set-cookie']).split(';')[0] } };
}

async function* lines(items: Iterable<string>) {
  for (const item of items) yield item;
}

const importUrl = '/api/chats/import';
const branchUrl = '/api/chat-groups/main/branches/import';
const transcript = [
  { user: '', assistant: 'Opening 🌙\r\nДругая строка.', complete: true },
  { user: 'Waiting', assistant: '', complete: false },
];

test('atomic standalone import uses normal defaults, skips greeting validation and replays across restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ore-transcript-import-'));
  const database = join(directory, 'story.sqlite');
  const stream = vi.fn(async () => { throw new Error('Unexpected provider call'); });
  let instance = await createApp({ database, provider: { stream } });
  try {
    const { host, headers } = await ownerSession(instance.app);
    const post = (url: string, payload: object) => instance.app.inject({ method: 'POST', url, headers, payload });
    const { store } = instance;
    const lorebookId = store.saveLibrary(store.libraryRevision(), 'lorebooks', newLorebook());
    const characterId = store.saveLibrary(store.libraryRevision(), 'characters', {
      name: 'Keeper', description: '', personality: '', scenario: '', mes_example: '', first_mes: 'Primary',
      alternate_greetings: ['Alternate'], lorebookId,
    });
    const personaId = store.saveLibrary(store.libraryRevision(), 'personas', { name: 'Visitor', description: '' });
    const promptId = store.saveLibrary(store.libraryRevision(), 'prompts', { ...defaultPrompt, name: 'Bookmarked prompt' });
    const contextPresetId = store.saveLibrary(store.libraryRevision(), 'contexts', { ...defaultContextPreset, name: 'Bookmarked context' });
    const connection = { name: 'Synthetic', endpoint: 'http://localhost:1/v1', model: 'mock', contextWindow: 100_000, maxOutputTokens: 1000, customParameters: {} };
    store.saveLibrary(store.libraryRevision(), 'connections', connection);
    const connectionId = store.saveLibrary(store.libraryRevision(), 'connections', { ...connection, name: 'Bookmarked connection' });
    for (const [kind, id] of [['prompts', promptId], ['contexts', contextPresetId], ['connections', connectionId]]) {
      const defaults = await instance.app.inject({ url: '/api/application/chat-defaults', headers });
      const response = await instance.app.inject({ method: 'PUT', url: '/api/application/chat-defaults', headers,
        payload: { revision: defaults.json().revision, libraryRevision: store.libraryRevision(), kind, id } });
      expect(response.statusCode, response.body).toBe(200);
    }
    const ordinary = await post('/api/chats', { title: 'Ordinary', characterId, personaId, targetInputTokens: 32_000 });
    expect(ordinary.statusCode, ordinary.body).toBe(200);
    const ordinaryId = ordinary.json<{ id: string }>().id;
    expect(store.snapshot(ordinaryId).turns[0].variants?.map(variant => variant.text)).toEqual(['Primary', 'Alternate']);
    // Simulate an older card whose preserved source carries malformed alternate greetings.
    store.sqlite.prepare(`UPDATE library SET data = json_set(json_remove(data, '$.alternate_greetings'),
      '$.source', json('{"alternate_greetings":false}')) WHERE id = ?`).run(characterId);
    const input = { title: 'Imported story', characterId, personaId, requestId: randomUUID(), turns: transcript };
    expect((await instance.app.inject({ method: 'POST', url: importUrl, headers: host, payload: input })).statusCode).toBe(401);
    const before = store.libraries();
    store.sqlite.exec(`CREATE TRIGGER fail_transcript_receipt BEFORE INSERT ON branch_commands
      BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END`);
    expect((await post(importUrl, input)).statusCode).toBe(500);
    expect(store.libraries()).toEqual(before);
    expect(store.sqlite.prepare('SELECT count(*) FROM branch_commands').pluck().get()).toBe(0);
    expect(store.sqlite.prepare('SELECT count(*) FROM turns').pluck().get()).toBe(1);
    expect(store.sqlite.prepare('SELECT count(*) FROM response_variants').pluck().get()).toBe(2);
    store.sqlite.exec('DROP TRIGGER fail_transcript_receipt');
    const results = await Promise.all([post(importUrl, input), post(importUrl, input)]);
    for (const response of results) expect(response.statusCode, response.body).toBe(200);
    const { id } = results[0].json<{ id: string }>();
    expect(results[1].json()).toEqual({ id });
    expect(store.libraries().revision).toBe(before.revision + 1);
    expect(store.libraries().chats).toHaveLength(before.chats.length + 1);
    const saved = store.snapshot(id);
    expect(saved).toMatchObject({ id, groupId: id, branchName: null,
      settings: { title: input.title, characterId, personaId, lorebookId, promptId, contextPresetId, connectionId, targetInputTokens: 32_000 },
      generations: [],
    });
    expect(saved.turns.map(turn => ({ user: turn.user.text, assistant: turn.assistant.text, complete: turn.complete }))).toEqual(transcript);
    expect(saved.turns[0].assistant.variantId).toBe(saved.turns[0].variants?.[0]?.id);
    expect(saved.turns[1].variants).toEqual([]);
    const receipt = store.sqlite.prepare('SELECT command FROM branch_commands WHERE id = ?').pluck().get(input.requestId);
    expect(receipt).toMatch(/^transcript:[a-f0-9]{64}$/);
    expect((await post(importUrl, { ...input, turns: [transcript[0]] })).json().code).toBe('request_id_conflict');
    expect((await post(branchUrl, { name: input.title, requestId: input.requestId, turns: input.turns })).json().code).toBe('request_id_conflict');
    await instance.app.close();
    instance = await createApp({ database, provider: { stream } });
    expect((await post(importUrl, input)).json()).toEqual({ id });
    expect(instance.store.snapshot(id)).toEqual(saved);
    instance.store.deleteChat(saved.revision, id);
    expect((await post(importUrl, input)).statusCode).toBe(404);
    expect(instance.store.libraries().chats).toHaveLength(before.chats.length);
    expect(stream).not.toHaveBeenCalled();
  } finally {
    await instance.app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('validates the destination, normalized turn shape and dataset epoch before writing', async () => {
  const { app, store } = await createApp({ database: ':memory:' });
  try {
    const { headers } = await ownerSession(app);
    const payload = { name: 'Incoming', requestId: randomUUID(), turns: transcript };
    const post = (url: string, body: object, extra = {}) => app.inject({ method: 'POST', url, headers: { ...headers, ...extra }, payload: body });
    const invalid = await post(branchUrl, { ...payload, turns: [...transcript, transcript[0]] });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().issues[0].localized.key).toBe('validation.only_the_final_turn_may_await_an_assistant');
    expect((await post('/api/chat-groups/absent/branches/import', payload)).statusCode).toBe(404);
    const imported = await post(branchUrl, payload);
    expect(imported.statusCode, imported.body).toBe(200);
    const { id } = imported.json<{ id: string }>();
    // A branch ID alone is not a parent group, even when it exists.
    expect((await post(`/api/chat-groups/${id}/branches/import`, { ...payload, requestId: randomUUID() })).statusCode).toBe(404);
    const preview = await app.inject({ url: '/api/data/wipe-preview', headers });
    const wiped = await post('/api/data/wipe', { ...preview.json(), requestId: randomUUID(), overwrite: true });
    expect(wiped.statusCode, wiped.body).toBe(200);
    expect((await post(branchUrl, payload)).json().code).toBe('dataset_changed');
    expect((await post(importUrl, { title: 'Stale', requestId: randomUUID(), turns: transcript })).json().code).toBe('dataset_changed');
    expect((await post(branchUrl, payload, { 'x-ore-epoch': wiped.json().epoch })).statusCode).toBe(404);
    expect(store.libraries().chats).toEqual([]);
    expect(store.sqlite.prepare('SELECT * FROM branch_commands').all()).toEqual([]);
  } finally { await app.close(); }
});

test('matches the preview byte boundary for multibyte and escaped text and rejects oversized API bodies', async () => {
  const { app, store } = await createApp({ database: ':memory:' });
  try {
    const { headers } = await ownerSession(app);
    const empty = { user: '', assistant: '', complete: true };
    const fixedBytes = Buffer.byteLength(JSON.stringify(empty));
    const full = { ...empty, assistant: '界\u0000'.repeat(50_000) };
    const fullBytes = Buffer.byteLength(JSON.stringify(full)) + 1;
    const wholeTurns = Math.floor((24_998_000 - 2 - fixedBytes - 1) / fullBytes);
    const remainder = 24_998_000 - 2 - wholeTurns * fullBytes - fixedBytes;
    const lastText = '界\u0000'.repeat(Math.floor(remainder / 9)) + 'x'.repeat(remainder % 9);
    const expected = [...Array.from({ length: wholeTurns }, () => full), { ...empty, assistant: lastText }];
    const fromTurns = (turns: typeof expected) => lines(turns.map(turn => JSON.stringify({ is_user: false, mes: turn.assistant }) + '\n'));
    expect(Buffer.byteLength(JSON.stringify(expected))).toBe(24_998_000);
    const preview = await importChat(fromTurns(expected));
    expect(preview.messages).toBe(expected.length);
    const atLimit = await app.inject({ method: 'POST', url: branchUrl, headers, payload: { name: 'Within limit', requestId: randomUUID(), turns: preview.turns } });
    expect(atLimit.statusCode, atLimit.body).toBe(200);
    const imported = store.sqlite.prepare('SELECT assistant_text FROM turns WHERE chat_id = ? AND position = ?').pluck();
    expect(imported.get(atLimit.json().id, expected.length)).toBe(lastText);
    const oversized = [...expected.slice(0, -1), { ...empty, assistant: lastText + 'x' }];
    await expect(importChat(fromTurns(oversized))).rejects.toThrow('24,998,000-byte limit');
    const aboveLimit = await app.inject({ method: 'POST', url: importUrl, headers, payload: { title: 'Beyond limit', requestId: randomUUID(), turns: oversized } });
    expect(aboveLimit.statusCode).toBe(400);
    expect(aboveLimit.json().issues[0].localized.key).toBe('validation.transcript_upload_limit');
    const wire = JSON.stringify({ name: 'Beyond body limit', requestId: randomUUID(), turns: transcript });
    const tooLarge = await app.inject({ method: 'POST', url: branchUrl, headers: { ...headers, 'content-type': 'application/json' }, payload: wire.padEnd(25_000_001, ' ') });
    expect(tooLarge.statusCode).toBe(413);
    expect(tooLarge.json().localized.key).toBe('importErrors.upload_too_large');
    expect(store.libraries().chats).toHaveLength(2);
  } finally { await app.close(); }
}, 30_000);

test('does not commit a disconnected partial import upload', async () => {
  const { app, store } = await createApp({ database: ':memory:' });
  try {
    const payload = JSON.stringify({ title: 'Partial upload', requestId: randomUUID(), turns: transcript });
    let markEntered: () => void = () => {};
    let failEntered: (error: Error) => void = () => {};
    const entered = new Promise<void>((resolve, reject) => { markEntered = resolve; failEntered = reject; });
    let markAborted: () => void = () => {};
    const aborted = new Promise<void>(resolve => { markAborted = resolve; });
    app.addHook('preParsing', async (request, _reply, body) => {
      if (request.url === importUrl) markEntered();
      return body;
    });
    app.addHook('onRequestAbort', async request => { if (request.url === importUrl) markAborted(); });
    const { headers } = await ownerSession(app);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const upload = request(address + importUrl, {
      method: 'POST',
      headers: { origin: address, cookie: headers.cookie, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    });
    upload.on('error', error => { failEntered(error); });
    upload.write(payload.slice(0, 20));
    try { await entered; } finally { upload.destroy(); }
    await aborted;
    expect(store.libraries().chats).toHaveLength(1);
    expect(store.sqlite.prepare('SELECT * FROM branch_commands').all()).toEqual([]);
    const retry = await fetch(address + importUrl, { method: 'POST', headers: { origin: address, cookie: headers.cookie, 'content-type': 'application/json' }, body: payload });
    expect(retry.status).toBe(200);
    expect(store.libraries().chats).toHaveLength(2);
  } finally { await app.close(); }
});
