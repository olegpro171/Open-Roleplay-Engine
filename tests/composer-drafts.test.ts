import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import { Store } from '../src/persistence/store.js';
import { composerDraftSchema, type ComposerDraftSave } from '../src/shared/composer-draft.js';
import type { Connection } from '../src/shared/contracts.js';
import { createStoryApp, openStoryStore } from './support/story-fixture.js';
import { seedTranscript } from './support/transcript-fixture.js';
import { removeComposerDraftSchema } from './support/schema-19.js';

const connection: Connection = {
  name: 'Synthetic draft model', endpoint: 'http://localhost:1/v1', model: 'mock',
  contextWindow: 16_000, maxOutputTokens: 256, customParameters: {},
};
const editFrom = (editorId = randomUUID(), sequence = 1) => ({ editorId, sequence });

test('sharing uses the last accepted autosave, preserves exact text, and stays independent of branch state', async () => {
  let calls = 0;
  const { app, store } = await createStoryApp({ database: ':memory:', provider: { async stream() { calls++; } } });
  try {
    const host = { host: 'localhost', origin: 'http://localhost' };
    const setup = await app.inject({ method: 'POST', url: '/api/setup', headers: host, payload: { password: 'synthetic-draft-password' } });
    const login = await app.inject({ method: 'POST', url: '/api/login', headers: host, payload: { password: 'synthetic-draft-password' } });
    const session = (response: typeof setup) => ({ ...host, cookie: String(response.headers['set-cookie']).split(';')[0] });
    const headers = session(setup);
    const other = session(login);
    const url = '/api/chats/main/draft';
    const get = () => app.inject({ url, headers: other });
    const put = (payload: ComposerDraftSave, requestHeaders: Record<string, string> = headers) => app.inject({ method: 'PUT', url, headers: requestHeaders, payload });
    const before = store.snapshot();
    const first = { baseRevision: 0, edit: editFrom(), text: '\n  Mira watches. 🗝\n' };
    const second = { baseRevision: 0, edit: editFrom(), text: 'Leon closes the gate.\n  ' };
    expect((await app.inject({ url, headers: host })).statusCode).toBe(401);
    expect((await put(first, host)).statusCode).toBe(401);
    expect((await put(first, { ...headers, 'x-ore-epoch': randomUUID() })).statusCode).toBe(409);
    expect((await put({ ...first, text: 'x'.repeat(100_001) })).statusCode).toBe(400);
    expect((await put(first)).statusCode).toBe(200);
    expect(composerDraftSchema.parse((await get()).json())).toMatchObject({ text: first.text, revision: 1 });
    expect((await put(second, other)).statusCode).toBe(200);
    const winner = composerDraftSchema.parse((await get()).json());
    expect(winner).toMatchObject({ text: second.text, revision: 2 });
    expect((await put(second, other)).json()).toEqual(winner);
    const copy = { revision: before.revision, requestId: randomUUID(), name: 'Elsewhere' };
    const source = store.forkSource('main', copy);
    const sibling = store.commitBranch('main', copy, source, source.snapshot.context);
    expect(store.drafts.read(sibling).text).toBe('');
    const branchRevision = store.snapshot(sibling).revision;
    store.drafts.save(sibling, { baseRevision: 0, edit: editFrom(), text: 'Different branch.' });
    store.deleteBranch(sibling, branchRevision);
    expect(store.sqlite.prepare('SELECT chat_id FROM composer_drafts').all()).toEqual([{ chat_id: 'main' }]);
    expect(store.snapshot()).toEqual(before);
    expect(calls).toBe(0);
  } finally { await app.close(); }
});

test('Send commits the draft clear with the pending turn, fences delayed saves, and leaves later drafts on replay', () => {
  const store = openStoryStore(':memory:');
  try {
    const firstEditor = randomUUID();
    store.saveSettings(store.snapshot().revision, connection, store.snapshot().settings);
    const saved = store.drafts.save('main', { baseRevision: 0, edit: editFrom(firstEditor), text: 'I kept the' }).draft;
    const reference = { baseRevision: 0, edit: editFrom(firstEditor, 2) };
    const text = '\nI kept the key.\n';
    const revision = store.snapshot().revision;
    const command = randomUUID();
    store.sqlite.exec("CREATE TRIGGER reject_draft_clear BEFORE UPDATE ON composer_drafts BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END");
    expect(() => store.begin(revision, command, text, 'main', reference)).toThrow('synthetic write failure');
    expect(store.snapshot().turns).toEqual([]);
    expect(store.snapshot().revision).toBe(revision);
    expect(store.drafts.read('main')).toEqual(saved);
    store.sqlite.exec('DROP TRIGGER reject_draft_clear');
    const accepted = store.begin(revision, command, text, 'main', reference);
    expect(store.snapshot().turns.map(turn => turn.user.text)).toEqual(['I kept the key.']);
    const cleared = store.drafts.read('main');
    expect(cleared.text).toBe('');
    expect(store.drafts.save('main', { ...reference, text }).draft).toEqual(cleared);
    expect(store.drafts.save('main', { baseRevision: saved.revision, edit: editFrom(), text: 'Unaware of the send.' }).draft).toEqual(cleared);
    const newer = store.drafts.save('main', { baseRevision: cleared.revision, edit: editFrom(), text: 'For the next turn.' }).draft;
    expect(store.begin(revision, command, text, 'main', reference)).toEqual({ id: accepted.id, fresh: false });
    expect(store.drafts.read('main')).toEqual(newer);
    expect(store.snapshot().turns).toHaveLength(1);
    expect(store.snapshot().generations).toHaveLength(1);
  } finally { store.close(); }
});

test('a shared draft replaced on another device survives sending the earlier version', () => {
  const store = openStoryStore(':memory:');
  try {
    store.saveSettings(store.snapshot().revision, connection, store.snapshot().settings);
    const first = store.drafts.save('main', { baseRevision: 0, edit: editFrom(), text: 'Mira looks around.' }).draft;
    if (!first.edit) throw new Error('Missing saved draft edit');
    const latest = store.drafts.save('main', { baseRevision: first.revision, edit: editFrom(), text: 'A newer draft from the phone.' }).draft;
    store.begin(store.snapshot().revision, randomUUID(), first.text, 'main', { baseRevision: first.revision, edit: first.edit });
    expect(store.snapshot().turns[0]?.user.text).toBe(first.text);
    expect(store.drafts.read('main')).toMatchObject({ text: latest.text, edit: latest.edit });
  } finally { store.close(); }
});

test('migration 20 leaves a populated schema 19 story intact and draft text survives reopening', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ore-composer-drafts-'));
  const filename = join(directory, 'legacy.sqlite');
  let store: Store | undefined;
  try {
    store = openStoryStore(filename);
    seedTranscript(store, store.snapshot().revision, 'main', [{ user: 'I arrived.', assistant: 'Come in.', complete: true }]);
    const original = store.snapshot();
    store.close();
    store = undefined;
    const older = new Database(filename);
    try { removeComposerDraftSchema(older); older.pragma('user_version = 19'); }
    finally { older.close(); }
    store = new Store(filename);
    expect(store.snapshot()).toEqual(original);
    expect(store.drafts.read('main')).toMatchObject({ text: '', revision: 0 });
    const saved = store.drafts.save('main', { baseRevision: 0, edit: editFrom(), text: '  It can wait.\n' }).draft;
    store.close();
    store = undefined;
    store = new Store(filename);
    expect(store.snapshot()).toEqual(original);
    expect(store.drafts.read('main')).toEqual(saved);
  } finally { store?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('replacing a draft checks the displayed draft and scene together and reconciles an exact repeat', () => {
  const store = openStoryStore(':memory:');
  try {
    const revision = store.snapshot().revision;
    const first = store.drafts.save('main', { baseRevision: 0, edit: editFrom(), text: 'My move.' }).draft;
    const replace = { baseRevision: first.revision, replaceAtBranchRevision: revision, text: 'A suggestion', edit: editFrom() };
    const other = store.drafts.save('main', { baseRevision: first.revision, edit: editFrom(), text: 'A newer move.' }).draft;
    expect(() => store.drafts.save('main', replace)).toThrow(/draft or scene/);
    expect(store.drafts.read('main')).toEqual(other);
    store.bumpRevision('main');
    expect(() => store.drafts.save('main', { ...replace, baseRevision: other.revision })).toThrow(/draft or scene/);
    const current = { ...replace, baseRevision: other.revision, replaceAtBranchRevision: revision + 1 };
    const accepted = store.drafts.save('main', current);
    expect(accepted.draft.text).toBe(replace.text);
    expect(store.drafts.save('main', current)).toEqual({ draft: accepted.draft, changed: false });
  } finally { store.close(); }
});
