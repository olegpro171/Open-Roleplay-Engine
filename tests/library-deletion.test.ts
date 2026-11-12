import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, test } from 'vitest';
import { sourceOf } from '../src/core/context.js';
import { stateToken } from '../src/persistence/backup-store.js';
import type { Store } from '../src/persistence/store.js';
import { createApp } from '../src/server/app.js';
import { defaultAuthorNote } from '../src/shared/author-note.js';
import type { Connection, RequestPreview } from '../src/shared/contracts.js';
import { defaultContextPreset, type ContextJob, type SummaryNode } from '../src/shared/context.js';
import { defaultPrompt, type LibraryKind } from '../src/shared/library.js';
import { libraryDeletionReviewSchema, type LibraryDeletionCommand, type LibraryDeletionReview } from '../src/shared/library-deletion.js';
import { newLorebook } from '../src/shared/lorebook.js';
import { startMockProvider } from './support/mock-provider.js';
import { cropFromControls } from '../src/shared/pictures.js';
import { quadrantPicture } from './support/pictures.js';
import { seedTranscript } from './support/transcript-fixture.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });
const base = { title: 'Keeper’s story', targetInputTokens: 1125, connectionId: null, promptId: 'default', characterId: null, personaId: null };
const card = { name: 'Keeper', description: 'A synthetic character', personality: '', scenario: '', first_mes: 'Original greeting', mes_example: '' };
const turn = { user: 'Open the door.', assistant: 'The tower comes into view.', complete: true };
const key = 'synthetic-deletion-credential';

async function fixture() {
  const folder = mkdtempSync(join(tmpdir(), 'ore-library-deletion-'));
  cleanups.push(async () => { rmSync(folder, { recursive: true, force: true }); });
  const mock = await startMockProvider();
  cleanups.push(async () => {
    try { expect(mock.requests).toEqual([]); expect(mock.modelRequests).toEqual([]); }
    finally { await mock.close(); }
  });
  const database = join(folder, 'story.sqlite');
  let instance = await createApp({ database });
  let closed = false;
  cleanups.push(async () => { if (!closed) await instance.app.close(); });
  const host = { host: 'localhost', origin: 'http://localhost' };
  const setup = await instance.app.inject({ method: 'POST', url: '/api/setup', headers: host, payload: { password: 'synthetic-deletion-password' } });
  expect(setup.statusCode).toBe(200);
  const cookie = String(setup.headers['set-cookie']).split(';')[0];
  const connection: Connection = { name: 'Original Connection', endpoint: mock.url, model: 'mock', contextWindow: 4096, maxOutputTokens: 256, customParameters: {} };
  const request = (method: 'GET' | 'POST' | 'DELETE' | 'PUT', path: string, payload?: object, headers = {}) =>
    instance.app.inject({ method, url: '/api' + path, headers: { ...host, cookie, ...headers }, payload });
  const inspect = (kind: LibraryKind, id: string, replacementId?: string, deleteLorebookId?: string) =>
    request('GET', `/library/${id}/deletion?${new URLSearchParams({
      kind, ...(replacementId && { replacementId }), ...(deleteLorebookId && { deleteLorebookId }),
    })}`);
  const review = async (kind: LibraryKind, id: string, replacementId?: string, deleteLorebookId?: string) => {
    const response = await inspect(kind, id, replacementId, deleteLorebookId);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).not.toContain(key);
    expect(response.body).not.toContain(mock.url);
    return libraryDeletionReviewSchema.parse(response.json());
  };
  const commit = (id: string, command: LibraryDeletionCommand) => request('POST', `/library/${id}/deletion`, command);
  return {
    get store() { return instance.store; }, get coordinator() { return instance.coordinator; },
    connection, request, review, commit, inspect,
    async reopen() {
      await instance.app.close();
      closed = true;
      instance = await createApp({ database });
      closed = false;
    },
  };
}

function command(kind: LibraryKind, { action }: LibraryDeletionReview): LibraryDeletionCommand {
  return { kind, requestId: randomUUID(), token: action.token, choice: action.choice };
}

function sibling(store: Store, groupId: string, name = 'Sibling branch', turns = [turn]) {
  return store.importBranch(groupId, { name, requestId: randomUUID(), turns }).id;
}

function persistentState(store: Store) {
  return [stateToken(store.sqlite), store.libraryRevision(), store.sqlite.prepare('SELECT * FROM lore_commands ORDER BY request_id').all()];
}

test('keeps a Character’s Lorebook by default and protects independent chat and Character links', async () => {
  const f = await fixture();
  const { store } = f;
  const book = store.saveLibrary(store.libraryRevision(), 'lorebooks', { ...newLorebook(), name: 'Tower lore' });
  const character = store.saveLibrary(store.libraryRevision(), 'characters', { ...card, lorebookId: book });
  const choice = await f.review('characters', character, undefined, book);
  expect(choice.linkedLorebook).toEqual({ id: book, name: 'Tower lore', inUse: false });
  const other = store.saveLibrary(store.libraryRevision(), 'characters', { ...card, name: 'Other Keeper', lorebookId: book });
  const otherCharacterReview = await f.review('characters', character, undefined, book);
  expect(otherCharacterReview.linkedLorebook?.inUse).toBe(true);
  const blocked = await f.commit(character, command('characters', otherCharacterReview));
  expect(blocked.json().localized.key).toBe('library_delete.lorebook_unavailable');
  store.deleteLibrary(store.libraryRevision(), 'characters', other);
  const chat = store.createChat({ ...base, characterId: character });
  const before = persistentState(store);
  expect((await f.commit(character, command('characters', choice))).json().code).toBe('library_deletion_stale');
  const shared = await f.review('characters', character, undefined, book);
  expect(shared.linkedLorebook?.inUse).toBe(true);
  expect((await f.commit(character, command('characters', shared))).json().code).toBe('library_deletion_blocked');
  expect(persistentState(store)).toEqual(before);
  const keep = await f.review('characters', character);
  expect((await f.commit(character, command('characters', keep))).statusCode).toBe(200);
  expect(store.libraries().lorebooks.map(book => book.id)).toContain(book);
  expect(store.chatHeader(chat).settings).toMatchObject({ characterId: null, lorebookId: book });
});

test('deletes a Character and its opted-in Lorebook together, with rollback and receipt replay', async () => {
  const f = await fixture();
  const { store } = f;
  const book = store.saveLibrary(store.libraryRevision(), 'lorebooks', newLorebook());
  const unrelated = store.saveLibrary(store.libraryRevision(), 'lorebooks', { ...newLorebook(), name: 'Unrelated' });
  const character = store.saveLibrary(store.libraryRevision(), 'characters', { ...card, lorebookId: book });
  const replacement = store.saveLibrary(store.libraryRevision(), 'characters', { ...card, name: 'Other Keeper' });
  const chat = store.createChat({ ...base, characterId: character, lorebookId: null });
  const before = persistentState(store);
  const wrong = await f.review('characters', character, replacement, unrelated);
  expect((await f.commit(character, command('characters', wrong))).json().code).toBe('library_deletion_blocked');
  const keep = await f.review('characters', character, replacement);
  expect((await f.commit(character, { ...command('characters', keep), choice: { mode: 'replace', replacementId: replacement, deleteLorebookId: book } })).json().code).toBe('library_deletion_stale');
  expect(persistentState(store)).toEqual(before);
  const pending = command('characters', await f.review('characters', character, replacement, book));
  store.sqlite.exec(`CREATE TRIGGER reject_book_delete BEFORE DELETE ON library
    WHEN OLD.id = '${book}' AND NOT EXISTS (SELECT 1 FROM library WHERE id = '${character}')
    BEGIN SELECT RAISE(ABORT, 'synthetic lorebook deletion failure'); END`);
  expect((await f.commit(character, pending)).json().code).toBe('library_deletion_rolled_back');
  expect(persistentState(store)).toEqual(before);
  store.sqlite.exec('DROP TRIGGER reject_book_delete');
  expect((await f.commit(character, pending)).statusCode).toBe(200);
  expect((await f.commit(character, pending)).statusCode).toBe(200);
  expect((await f.commit(character, { ...pending, choice: keep.action.choice })).json().code).toBe('request_id_conflict');
  expect(store.libraries().characters.map(card => card.id)).toEqual([replacement]);
  expect(store.libraries().lorebooks.map(book => book.id)).toEqual([unrelated]);
  expect(store.chatHeader(chat).settings).toMatchObject({ characterId: replacement, lorebookId: null });
});

test('Connection review deduplicates shared chats, resolves legacy main, preserves provenance and clears the correct selections', async () => {
  const f = await fixture();
  const { store } = f;
  store.saveSettings(store.chatHeader().revision, f.connection, { ...store.chatHeader().settings, connectionId: 'main' }, key);
  store.sqlite.exec("UPDATE chat_groups SET settings = json_remove(settings, '$.connectionId') WHERE id = 'main'");
  const fallback = store.saveLibrary(store.libraryRevision(), 'connections', { ...f.connection, name: 'First fallback' });
  const unrelated = store.saveLibrary(store.libraryRevision(), 'connections', { ...f.connection, name: 'Another Connection' });
  const preset = store.saveLibrary(store.libraryRevision(), 'contexts', { ...defaultContextPreset, name: 'Memory via main', connectionId: 'main' });
  const direct = store.createChat({ ...base, connectionId: 'main', contextPresetId: preset });
  const second = sibling(store, direct);
  const indirect = store.createChat({ ...base, connectionId: unrelated, contextPresetId: preset });
  const untouched = store.createChat({ ...base, connectionId: null });
  store.saveAuthorNote(second, { revision: store.chatHeader(second).revision, settings: { ...defaultAuthorNote, prompt: 'Branch-specific note' } });
  const created = store.begin(store.chatHeader(direct).revision, randomUUID(), 'Synthetic request', direct);
  const historical: RequestPreview = {
    endpoint: f.connection.endpoint + '/chat/completions',
    body: { model: 'mock', messages: [{ role: 'user', content: 'Original model input' }], max_tokens: 256, stream: true },
    coverage: [], budget: { inputTokens: 20, targetInputTokens: 1125, reservedOutputTokens: 256, contextWindow: 4096, method: 'synthetic', verified: false },
  };
  store.saveRequest(created.id, historical);
  expect(store.finish(created.id, 'succeeded', 'Historical reply')).toBe(true);
  const savedTurn = store.readTurns(direct)[0];
  store.setTurnPin(direct, savedTurn.id, store.chatHeader(direct).revision, true);
  const historicalGeneration = store.generation(created.id);
  const before = ['main', direct, second, indirect, untouched].map(id => store.chatHeader(id));
  const histories = before.map(({ id }) => store.readTurns(id));
  const defaults = await f.request('PUT', '/application/chat-defaults', { revision: 0, libraryRevision: store.libraryRevision(), kind: 'connections', id: 'main' });
  expect(defaults.statusCode, defaults.body).toBe(200);
  const oldClient = await f.request('DELETE', '/library/main', { revision: store.libraryRevision(), kind: 'connections' });
  expect(oldClient.json().code).toBe('item_in_use');
  const stable = persistentState(store);
  const reviewed = await f.review('connections', 'main');
  expect(persistentState(store)).toEqual(stable);
  expect(reviewed.dependencies.chats).toHaveLength(3);
  expect(reviewed.dependencies.chats).toEqual(expect.arrayContaining([
    { id: 'main', name: before[0].settings.title, direct: true, memoryPreset: null },
    { id: direct, name: base.title, direct: true, memoryPreset: { id: preset, name: 'Memory via main' } },
    { id: indirect, name: base.title, direct: false, memoryPreset: { id: preset, name: 'Memory via main' } },
  ]));
  expect(reviewed.dependencies.contexts).toEqual([{ id: preset, name: 'Memory via main' }]);
  expect(reviewed.bookmark).toEqual({ fallback: { id: fallback, name: 'First fallback' } });
  expect(reviewed.replacements.map(item => item.id)).toEqual([fallback, unrelated]);
  const changes: unknown[] = [];
  f.coordinator.events.on('changed', change => changes.push(change));
  const result = await f.commit('main', command('connections', reviewed));
  expect(result.statusCode, result.body).toBe(200);
  for (const [index, branch] of before.entries()) {
    const after = store.chatHeader(branch.id);
    const cleared = index < 3;
    expect(after.settings).toEqual({ ...branch.settings, connectionId: cleared ? null : branch.settings.connectionId });
    expect(after.revision).toBe(branch.revision + Number(index !== 4));
    expect(store.readTurns(branch.id)).toEqual(histories[index]);
    if (index !== 4) expect(changes).toContainEqual({ kind: 'chat', chatId: branch.id, detail: 'state' });
  }
  expect(changes).toContainEqual({ kind: 'library' });
  expect(store.generation(created.id)).toEqual(historicalGeneration);
  expect(store.contextPreset(preset)).toMatchObject({ connectionId: null, revision: 1 });
  expect(store.sqlite.prepare('SELECT id FROM credentials WHERE id = ?').get('main')).toBeUndefined();
  expect((await f.request('GET', '/application/chat-defaults')).json().settings.connections).toBe('main');
  const createdAfter = await f.request('POST', '/chats', { title: 'New defaults', targetInputTokens: 2500, characterId: null, personaId: null });
  expect(store.chatHeader(createdAfter.json().id).settings.connectionId).toBe(fallback);
  const staleEditor = await f.request('PUT', `/chats/${direct}/selections`, {
    revision: before[1].revision, settings: { ...base, connectionId: 'main', contextPresetId: preset },
  });
  expect(staleEditor.statusCode).toBe(409);
});

test('protects factory presets and deletes unused records and linked prompts through the reviewed API', async () => {
  const f = await fixture();
  const { store } = f;
  const before = persistentState(store);
  for (const [kind, id] of [['prompts', 'default'], ['contexts', 'default-context']] as const) {
    expect((await f.inspect(kind, id)).statusCode).toBe(409);
    expect((await f.commit(id, { kind, requestId: randomUUID(), token: 'a'.repeat(64), choice: { mode: 'clear' } })).statusCode).toBe(409);
  }
  expect((await f.request('GET', '/library/default/deletion?kind=prompts', undefined, { cookie: '' })).statusCode).toBe(401);
  expect(persistentState(store)).toEqual(before);
  const unused = store.saveLibrary(store.libraryRevision(), 'personas', { name: 'Unused', description: '' });
  const unusedReview = await f.review('personas', unused);
  expect(unusedReview.dependencies).toEqual({ chats: [], characters: [], contexts: [] });
  expect((await f.commit(unused, command('personas', unusedReview))).statusCode).toBe(200);
  const prompt = store.saveLibrary(store.libraryRevision(), 'prompts', { ...defaultPrompt, name: 'Personal prompt' });
  const chat = store.createChat({ ...base, promptId: prompt });
  const revision = store.chatHeader(chat).revision;
  const reviewed = await f.review('prompts', prompt);
  expect(reviewed.dependencies.chats.map(item => item.id)).toEqual([chat]);
  expect((await f.commit(prompt, command('prompts', reviewed))).statusCode).toBe(200);
  expect(store.chatHeader(chat)).toMatchObject({ revision: revision + 1, settings: { promptId: 'default', targetInputTokens: base.targetInputTokens } });
});

test('Lorebook replacement updates chat and Character defaults without altering existing chat overrides', async () => {
  const f = await fixture();
  const { store } = f;
  const book = store.saveLibrary(store.libraryRevision(), 'lorebooks', { ...newLorebook(), name: 'Shared Lorebook' });
  const alternate = store.saveLibrary(store.libraryRevision(), 'lorebooks', { ...newLorebook(), name: 'Different Lorebook' });
  const replacement = store.saveLibrary(store.libraryRevision(), 'lorebooks', { ...newLorebook(), name: 'Replacement Lorebook' });
  const character = store.saveLibrary(store.libraryRevision(), 'characters', { ...card, lorebookId: book, titleComment: 'Library comment' });
  const direct = store.createChat({ ...base, characterId: character });
  const override = store.createChat({ ...base, characterId: character, lorebookId: alternate });
  const overrideRevision = store.chatHeader(override).revision;
  const directRevision = store.chatHeader(direct).revision;
  const recorded = await f.review('lorebooks', book, replacement);
  expect(recorded.dependencies.characters).toEqual([{ id: character, name: 'Keeper · Library comment' }]);
  expect(recorded.dependencies.chats.map(item => item.id)).toEqual([direct]);
  expect((await f.commit(book, command('lorebooks', recorded))).statusCode).toBe(200);
  expect(store.chatHeader(direct)).toMatchObject({ revision: directRevision + 1, settings: { characterId: character, lorebookId: replacement } });
  expect(store.chatHeader(override)).toMatchObject({ revision: overrideRevision, settings: { characterId: character, lorebookId: alternate } });
  expect(store.readTurns(direct)[0].assistant.text).toBe(card.first_mes);
  expect(store.chatHeader(store.createChat({ ...base, characterId: character })).settings.lorebookId).toBe(replacement);
  expect((await f.request('GET', '/library?includeLorebookUses=false')).json()).not.toHaveProperty('lorebookUses');
  expect((await f.request('GET', '/library')).json()).toHaveProperty('lorebookUses');
  const clearing = await f.review('lorebooks', replacement);
  expect((await f.commit(replacement, command('lorebooks', clearing))).statusCode).toBe(200);
  expect(store.chatHeader(direct).settings.lorebookId).toBeNull();
  expect(store.libraries().characters.find(item => item.id === character)?.lorebookId).toBeNull();
  expect(store.chatHeader(override).settings.lorebookId).toBe(alternate);
});

test('Character and Persona changes reset lore in every affected branch and retain the selected book and transcript', async () => {
  const f = await fixture();
  const { store } = f;
  const book = store.saveLibrary(store.libraryRevision(), 'lorebooks', { ...newLorebook(), name: 'Independent Lorebook' });
  const image = await quadrantPicture();
  const created = await f.request('POST', '/library', {
    kind: 'characters', revision: store.libraryRevision(), requestId: randomUUID(), expectedPicture: null,
    data: card, picture: { mode: 'replace', base64: image.toString('base64'), crop: cropFromControls({ width: 400, height: 200 }) },
  });
  expect(created.statusCode, created.body).toBe(200);
  const character: string = created.json().id;
  const picture = store.pictures.get(character);
  if (!picture) throw new Error('Missing saved Character picture');
  const copied = await f.request('POST', `/library/characters/${character}/duplicate`, { revision: store.libraryRevision() });
  expect(copied.statusCode, copied.body).toBe(200);
  const replacement: string = copied.json().id;
  const replacementPicture = store.pictures.get(replacement);
  if (!replacementPicture) throw new Error('Missing copied Character picture');
  const persona = store.saveLibrary(store.libraryRevision(), 'personas', { name: 'Traveller', description: '' });
  const id = store.createChat({ ...base, characterId: character, personaId: persona, lorebookId: book });
  const other = sibling(store, id);
  const before = [id, other].map(branchId => ({ branchId, history: store.readTurns(branchId), lore: store.loreState(branchId, book) }));
  expect((await f.commit(character, command('characters', await f.review('characters', character, replacement)))).statusCode).toBe(200);
  expect(store.pictures.get(character)).toBeNull();
  expect(store.pictures.get(replacement)).toEqual(replacementPicture);
  expect(store.pictures.originalForCrop(replacement, replacementPicture.key)).toEqual(image);
  expect((await f.commit(persona, command('personas', await f.review('personas', persona)))).statusCode).toBe(200);
  for (const { branchId, history, lore } of before) {
    expect(store.chatHeader(branchId).settings).toMatchObject({ characterId: replacement, personaId: null, lorebookId: book });
    expect(store.readTurns(branchId)).toEqual(history);
    expect(store.loreState(branchId, book)).toEqual({ epoch: lore.epoch + 2, entries: {} });
  }
});

function saveJob(store: Store, id: string, presetId: string, state: Pick<ContextJob, 'status' | 'mode'>) {
  const preset = store.contextPreset(presetId);
  if (!preset) throw new Error('Missing test context preset');
  const at = new Date().toISOString();
  const job: ContextJob = { id: randomUUID(), chatId: id, ...state, config: preset,
    generationId: null, sourceRevision: store.chatHeader(id).revision, stepCount: 0, error: null, createdAt: at, updatedAt: at,
    historyTurnIds: store.readTurns(id).map(turn => turn.id) };
  store.sqlite.prepare('INSERT INTO context_jobs VALUES (?, ?, ?, ?, ?)').run(job.id, id, randomUUID(), '{}', JSON.stringify(job));
  return job;
}

function savedMemory(store: Store, id: string, presetId: string, archived: boolean) {
  if (!store.readTurns(id).length) seedTranscript(store, store.chatHeader(id).revision, id, [turn, turn, turn]);
  const turns = store.readTurns(id);
  const summary: SummaryNode = { id: randomUUID(), revision: 0, level: 1, text: 'Original saved correction', turns: [sourceOf(turns[0])],
    children: [], prior: [], approved: true, manual: true, createdAt: new Date().toISOString() };
  store.sqlite.prepare('INSERT INTO summaries (id, revision, chat_id, data) VALUES (?, ?, ?, ?)').run(summary.id, 0, id, JSON.stringify(summary));
  if (archived) {
    store.sqlite.prepare('INSERT INTO context_states VALUES (?, ?, ?)').run(id, 1, JSON.stringify({
      selected: [{ id: summary.id, revision: 0 }], archivedTurnIds: [turns[0].id],
    }));
  }
  return saveJob(store, id, presetId, { status: 'succeeded', mode: 'prepare' });
}

test('Context deletion uses sibling coverage and existing layout impact, including an explicitly reviewed compatible Default context preset', async () => {
  const f = await fixture();
  const { store } = f;
  const original = store.saveLibrary(store.libraryRevision(), 'contexts', { ...defaultContextPreset, name: 'Current preset', batchSize: 1 });
  store.saveLibrary(store.libraryRevision(), 'contexts', { ...defaultContextPreset, batchSize: 1 }, 'default-context');
  const incompatible = store.saveLibrary(store.libraryRevision(), 'contexts', { ...defaultContextPreset, name: 'Different layout', batchSize: 2 });
  const main = store.createChat({ ...base, contextPresetId: original });
  const other = sibling(store, main, 'Archived branch', [turn, turn, turn]);
  const history = savedMemory(store, other, original, true);
  savedMemory(store, main, original, false);
  const memory = [store.contexts.savedState(main), store.contexts.savedState(other)];
  const stable = persistentState(store);
  const clear = await f.review('contexts', original);
  expect(clear.action.blockers).toEqual([{ reason: 'excluded', branches: [{ id: other, name: base.title, branchName: 'Archived branch' }] }]);
  expect((await f.commit(original, command('contexts', clear))).json().localized.key).toBe('library_delete.excluded');
  const impact = store.contextSelectionMemoryImpact(store.chatHeader(main).revision, main, incompatible);
  expect(impact?.branches.map(branch => branch.id)).toEqual([main]);
  const prune = await f.review('contexts', original, incompatible);
  expect(prune.action.blockers).toEqual([{ reason: 'layout', branches: [{ id: main, name: base.title, branchName: null }] }]);
  expect((await f.commit(original, command('contexts', prune))).json().localized.key).toBe('library_delete.layout');
  expect(persistentState(store)).toEqual(stable);
  const compatible = await f.review('contexts', original, 'default-context');
  expect(compatible.action.blockers).toEqual([]);
  expect((await f.commit(original, command('contexts', compatible))).statusCode).toBe(200);
  expect([main, other].map(id => store.chatHeader(id).settings.contextPresetId)).toEqual(['default-context', 'default-context']);
  expect([store.contexts.savedState(main), store.contexts.savedState(other)]).toEqual(memory);
  expect(store.contexts.job(history.id)).toEqual(history);

  const removable = store.saveLibrary(store.libraryRevision(), 'contexts', { ...defaultContextPreset, name: 'No excluded turns' });
  const clearableChat = store.createChat({ ...base, contextPresetId: removable });
  const inactive = savedMemory(store, clearableChat, removable, false);
  const clearableMemory = store.contexts.savedState(clearableChat);
  expect((await f.request('PUT', '/application/chat-defaults', { revision: 0, libraryRevision: store.libraryRevision(), kind: 'contexts', id: removable })).statusCode).toBe(200);
  const clearable = await f.review('contexts', removable);
  expect(clearable.bookmark).toEqual({ fallback: null });
  expect((await f.commit(removable, command('contexts', clearable))).statusCode).toBe(200);
  expect(store.chatHeader(clearableChat).settings.contextPresetId).toBeNull();
  expect(store.contexts.savedState(clearableChat)).toEqual(clearableMemory);
  expect(store.contexts.job(inactive.id)).toEqual(inactive);
});

test('rejects stale membership at unchanged counts and checks a replacement’s exact identity, revision and kind', async () => {
  const f = await fixture();
  const { store } = f;
  const persona = store.saveLibrary(store.libraryRevision(), 'personas', { name: 'Traveller', description: '' });
  const replacement = store.saveLibrary(store.libraryRevision(), 'personas', { name: 'Traveller', description: 'Replacement' });
  const wrongKind = store.saveLibrary(store.libraryRevision(), 'characters', card);
  const first = store.createChat({ ...base, personaId: persona });
  const second = store.createChat(base);
  const old = await f.review('personas', persona, replacement);
  store.updateChat(store.chatHeader(first).revision, first, base);
  store.updateChat(store.chatHeader(second).revision, second, { ...base, personaId: persona });
  const stable = persistentState(store);
  const stale = await f.commit(persona, command('personas', old));
  expect(stale.statusCode).toBe(409);
  expect(stale.json().code).toBe('library_deletion_stale');
  const fresh = await f.review('personas', persona, replacement);
  expect(fresh.dependencies.chats.map(item => item.id)).toEqual([second]);
  expect(fresh.dependencies.chats).toHaveLength(old.dependencies.chats.length);
  for (const invalid of [wrongKind, persona, randomUUID()]) {
    const reviewed = await f.review('personas', persona, invalid);
    expect(reviewed.action.blockers).toEqual([{ reason: 'replacement', branches: [] }]);
    expect((await f.commit(persona, command('personas', reviewed))).json().localized.key).toBe('library_delete.replacement');
  }
  expect(persistentState(store)).toEqual(stable);
  store.saveLibrary(store.libraryRevision(), 'personas', { name: 'Traveller', description: 'Edited after review' }, replacement);
  const changed = persistentState(store);
  expect((await f.commit(persona, command('personas', fresh))).json().code).toBe('library_deletion_stale');
  expect(persistentState(store)).toEqual(changed);
  store.deleteLibrary(store.libraryRevision(), 'personas', replacement);
  const removed = persistentState(store);
  expect((await f.commit(persona, command('personas', fresh))).json().code).toBe('library_deletion_stale');
  expect(persistentState(store)).toEqual(removed);
});

test('checks sibling work and open repair reviews at commit and names their branches', async () => {
  const f = await fixture();
  const { store } = f;
  const connection = store.saveLibrary(store.libraryRevision(), 'connections', f.connection);
  const persona = store.saveLibrary(store.libraryRevision(), 'personas', { name: 'Traveller', description: '' });
  const chat = store.createChat({ ...base, connectionId: connection, personaId: persona });
  const branch = sibling(store, chat);
  const beforeWork = await f.review('personas', persona);
  const running = store.begin(store.chatHeader(branch).revision, randomUUID(), 'Pending response', branch);
  const busyState = persistentState(store);
  expect((await f.commit(persona, command('personas', beforeWork))).statusCode).toBe(409);
  const busy = await f.review('personas', persona);
  expect(busy.blockers).toEqual([{ reason: 'busy', branches: [{ id: branch, name: base.title, branchName: 'Sibling branch' }] }]);
  expect((await f.commit(persona, command('personas', busy))).json().localized.key).toBe('library_delete.busy');
  expect(persistentState(store)).toEqual(busyState);
  store.finish(running.id, 'cancelled', '', null);
  const beforeRepair = await f.review('personas', persona);
  saveJob(store, branch, 'default-context', { mode: 'repair', status: 'awaiting_review' });
  const repairState = persistentState(store);
  const reviewed = await f.review('personas', persona);
  expect(reviewed.blockers).toEqual([{ reason: 'repair', branches: [{ id: branch, name: base.title, branchName: 'Sibling branch' }] }]);
  expect((await f.commit(persona, command('personas', beforeRepair))).statusCode).toBe(409);
  expect((await f.commit(persona, command('personas', reviewed))).json().localized.key).toBe('library_delete.repair');
  expect(persistentState(store)).toEqual(repairState);
});

test('rolls back after reference writes and atomically records a replayable outcome across reopening', async () => {
  const f = await fixture();
  const { store } = f;
  const persona = store.saveLibrary(store.libraryRevision(), 'personas', { name: 'Traveller', description: '' });
  const first = store.createChat({ ...base, personaId: persona });
  const second = sibling(store, first);
  const reviewed = await f.review('personas', persona);
  const pending = command('personas', reviewed);
  const before = persistentState(store);
  store.sqlite.exec(`CREATE TRIGGER reject_delete_receipt BEFORE INSERT ON lore_commands
    WHEN NOT EXISTS (SELECT 1 FROM library WHERE id = '${persona}')
      AND (SELECT json_type(settings, '$.personaId') FROM chat_groups WHERE id = '${first}') = 'null'
    BEGIN SELECT RAISE(ABORT, 'synthetic receipt write failure'); END`);
  const rejected = await f.commit(persona, pending);
  expect(rejected.statusCode).toBe(500);
  expect(rejected.json().code).toBe('library_deletion_rolled_back');
  expect(persistentState(store)).toEqual(before);
  store.sqlite.exec('DROP TRIGGER reject_delete_receipt');
  const done = await f.commit(persona, pending);
  expect(done.statusCode, done.body).toBe(200);
  const after = persistentState(store);
  const lock = new Database(store.sqlite.name);
  try {
    store.sqlite.pragma('busy_timeout = 0');
    lock.exec('BEGIN IMMEDIATE');
    const unchecked = await f.commit(persona, pending);
    expect(unchecked.statusCode).toBe(500);
    expect(unchecked.json().code).toBe('request_failed');
  } finally {
    lock.close();
    store.sqlite.pragma('busy_timeout = 5000');
  }
  expect((await f.commit(persona, pending)).json()).toEqual(done.json());
  expect((await f.commit(persona, { ...pending, choice: { mode: 'replace', replacementId: randomUUID() } })).json().code).toBe('request_id_conflict');
  expect(persistentState(store)).toEqual(after);
  await f.reopen();
  expect((await f.commit(persona, pending)).json()).toEqual(done.json());
  expect(f.store.chatHeader(second).settings.personaId).toBeNull();
  expect(persistentState(f.store)).toEqual(after);
  const preview = await f.request('GET', '/data/wipe-preview');
  const wiped = await f.request('POST', '/data/wipe', { ...preview.json(), overwrite: true, requestId: randomUUID() });
  expect(wiped.statusCode, wiped.body).toBe(200);
  const wipedState = persistentState(f.store);
  expect((await f.commit(persona, pending)).json().code).toBe('dataset_changed');
  expect(f.store.sqlite.prepare('SELECT request_id FROM lore_commands').all()).toEqual([]);
  expect(persistentState(f.store)).toEqual(wipedState);
});
