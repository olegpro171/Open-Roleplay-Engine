import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/persistence/store.js';
import { assembleRequest } from '../src/core/prompt.js';
import { exportCharacter, importCharacter } from '../src/core/cards.js';
import { characterLabel, libraryCharacterSchema, type Character, type CharacterSaveCommand } from '../src/shared/library.js';
import { newLorebook } from '../src/shared/lorebook.js';
import { createApp } from '../src/server/app.js';
import { startMockProvider } from './support/mock-provider.js';

const folders: string[] = [];
afterEach(() => { for (const path of folders.splice(0)) rmSync(path, { recursive: true, force: true }); });
function filename() {
  const path = mkdtempSync(join(tmpdir(), 'ore-character-title-'));
  folders.push(path);
  return join(path, 'test.sqlite');
}
const fields: Character = { name: 'Alice', description: '{{char}} meets {{user}}.', personality: 'Patient', scenario: '', first_mes: 'I am {{char}}.', mes_example: '' };
const connection = { name: 'Mock', endpoint: 'http://localhost:1234/v1', model: 'mock', contextWindow: 100_000, maxOutputTokens: 100, customParameters: {} };
function command(store: Store, titleComment: string): CharacterSaveCommand {
  return { kind: 'characters', revision: store.libraryRevision(), requestId: randomUUID(), data: { ...fields, titleComment } };
}

it('adds local metadata to existing populated records without changing prompts, history, source revisions or lore state', () => {
  const path = filename();
  let store = new Store(path);
  try {
    const book = store.saveLibrary(store.libraryRevision(), 'lorebooks', newLorebook());
    const id = store.saveLibrary(store.libraryRevision(), 'characters', { ...fields, lorebookId: book });
    const connectionId = store.saveLibrary(store.libraryRevision(), 'connections', connection);
    const chatId = store.createChat({ title: 'Story', promptId: 'default', characterId: id, personaId: null, connectionId, targetInputTokens: 32000, lorebookId: null });
    const generation = store.begin(store.snapshot(chatId).revision, randomUUID(), 'Hello.', chatId);
    const pending = store.snapshot(chatId);
    store.saveRequest(generation.id, assembleRequest(connection, pending.settings, pending.turns, pending.sources, pending.context));
    store.finish(generation.id, 'succeeded', 'Hello back.', null);
    store.sqlite.prepare('INSERT INTO lore_epochs VALUES (?, ?)').run(chatId, 7);
    const before = store.snapshot(chatId), oldLibrary = store.libraries();
    const oldRecord = store.sqlite.prepare('SELECT * FROM library WHERE id = ?').get(id);
    store.close(); store = new Store(path);
    expect(store.sqlite.prepare('SELECT * FROM library WHERE id = ?').get(id)).toEqual(oldRecord);
    expect(store.snapshot(chatId)).toEqual(before);

    const save = command(store, '  University version  ');
    store.saveCharacter(save, id);
    const saved = store.libraries().characters.find(card => card.id === id);
    expect(saved).toMatchObject({ name: 'Alice', titleComment: 'University version', revision: oldLibrary.characters[0]?.revision });
    expect(store.libraryRevision()).toBe(oldLibrary.revision + 1);
    expect(store.libraryUpdate(oldLibrary.revision)).not.toHaveProperty('unchanged');
    expect(store.snapshot(chatId)).toEqual(before);
    const after = store.snapshot(chatId);
    expect(assembleRequest(connection, after.settings, after.turns, after.sources, after.context)).toEqual(assembleRequest(connection, before.settings, before.turns, before.sources, before.context));
    expect(after.sources.character).not.toHaveProperty('titleComment');
    expect(store.libraries().lorebookUses.find(use => use.bookId === book)?.characters).toEqual([{ id, name: 'Alice', titleComment: 'University version' }]);

    const revision = store.libraryRevision();
    store.saveCharacter(command(store, 'University version'), id);
    expect(store.libraryRevision()).toBe(revision);
    // Internal card-only updates and older clients cannot erase local organization.
    store.saveLibrary(revision, 'characters', { ...fields, description: 'Updated description' }, id);
    expect(store.libraries().characters.find(card => card.id === id)?.titleComment).toBe('University version');
    expect(store.snapshot(chatId).revision).toBe(before.revision + 1);
    store.close(); store = new Store(path);
    expect(store.libraries().characters.find(card => card.id === id)?.titleComment).toBe('University version');
    expect(store.saveCharacter(save, id)).toEqual({ id });
    expect(store.libraries().characters.find(card => card.id === id)?.description).toBe('Updated description');
  } finally { store.close(); }
});

it('saves title/text/tags atomically, rejects stale and mismatched commands, copies metadata independently and clears it explicitly', () => {
  const store = new Store(filename());
  try {
    const original = command(store, 'University version');
    const { id } = store.saveCharacter(original);
    const tag = store.tags.create(store.libraryRevision(), 'Fantasy');
    store.tags.setAssignments(store.libraryRevision(), id, [tag]);
    expect(store.tags.embeddedReview(id)).toBeDefined();
    const before = store.libraries();
    const failed = { ...command(store, 'Must roll back'), data: { ...fields, name: 'Changed name', titleComment: 'Must roll back' }, tagIds: ['missing-tag'] };
    expect(() => store.saveCharacter(failed, id)).toThrow('no longer exists');
    expect(store.libraries()).toEqual(before);
    expect(store.replayCharacterSave(failed, id)).toEqual({ found: false });
    const metadataFailure = { ...command(store, 'Metadata must roll back'), tagIds: ['missing-tag'] };
    expect(() => store.saveCharacter(metadataFailure, id)).toThrow('no longer exists');
    expect(store.libraries()).toEqual(before);
    expect(store.replayCharacterSave(metadataFailure, id)).toEqual({ found: false });
    expect(() => store.saveCharacter({ ...command(store, 'Stale'), revision: before.revision - 1 }, id)).toThrow('changed on another device');
    expect(() => store.replayCharacterSave({ ...original, data: { ...original.data, titleComment: 'Different' } })).toThrow('different command');
    const copy = store.duplicateCharacter(store.libraryRevision(), id);
    expect(store.libraries().characters.find(card => card.id === copy)).toMatchObject({ name: 'Alice copy', titleComment: 'University version' });
    expect(store.tags.assigned(copy)).toEqual([tag]);
    store.saveCharacter(command(store, 'Medieval version'), copy);
    expect(store.libraries().characters.find(card => card.id === id)?.titleComment).toBe('University version');
    store.saveCharacter(command(store, '   '), id);
    expect(characterLabel(store.libraries().characters.find(card => card.id === id) ?? fields)).toBe('Alice');
    expect(store.libraries().characters.find(card => card.id === copy)?.titleComment).toBe('Medieval version');
  } finally { store.close(); }
});

it.each(['legacy', 'chara_card_v2', 'chara_card_v3'])('excludes the local title from %s exports and preserves creator notes and nickname', format => {
  const extras = { creator_notes: 'Author information', nickname: 'A separate nickname', extensions: { preserved: true } };
  const source = format === 'legacy' ? { ...fields, ...extras } : { spec: format, spec_version: format === 'chara_card_v3' ? '3.0' : '2.0', data: { ...fields, ...extras } };
  const card = { ...importCharacter(source), titleComment: 'LOCAL ONLY {{char}}' };
  const exported = exportCharacter(card);
  expect(exported).not.toHaveProperty('titleComment');
  expect(exported.data).not.toHaveProperty('titleComment');
  expect(JSON.stringify(exported)).not.toContain('LOCAL ONLY');
  expect(exported.data).toMatchObject({ name: 'Alice', ...extras });
  expect(importCharacter(exported)).not.toHaveProperty('titleComment');
});

it('validates bounded single-line metadata while allowing empty and multilingual labels', () => {
  expect(characterLabel(libraryCharacterSchema.parse({ ...fields, titleComment: '  Средневековая версия  ' }))).toBe('Alice · Средневековая версия');
  expect(libraryCharacterSchema.parse({ ...fields, titleComment: '界'.repeat(200) }).titleComment).toHaveLength(200);
  for (const titleComment of ['x'.repeat(201), 'two\nlines', 42, null]) expect(libraryCharacterSchema.safeParse({ ...fields, titleComment }).success).toBe(false);
});

it('keeps titles out of actual provider requests, greeting substitution and API exports, and blocks edits during generation', async () => {
  const mock = await startMockProvider();
  const { app, store } = await createApp({ database: filename() });
  let cookie = '';
  async function cmd(url: string, payload: unknown, method: 'POST' | 'PUT' = 'POST') {
    return app.inject({ method, url: `/api${url}`, headers: { host: 'localhost', origin: 'http://localhost', cookie, 'content-type': 'application/json' }, payload: JSON.stringify(payload) });
  }
  try {
    const setup = await cmd('/setup', { password: 'synthetic-title-password' });
    const header = setup.headers['set-cookie'];
    if (!header) throw new Error('Missing owner session');
    cookie = header.toString().split(';')[0] ?? '';
    const created = await cmd('/library', command(store, 'University version'));
    expect(created.statusCode).toBe(200);
    const id: string = created.json().id;
    expect((await cmd('/library', { ...command(store, 'x'.repeat(201)) })).statusCode).toBe(400);
    const connectionId = store.saveLibrary(store.libraryRevision(), 'connections', { ...connection, endpoint: mock.url }, undefined, 'synthetic-title-secret');
    const chatId = store.createChat({ title: 'Story', promptId: 'default', characterId: id, personaId: null, connectionId, targetInputTokens: 32000 });
    expect(store.snapshot(chatId).turns[0]?.assistant.text).toBe('I am Alice.');
    mock.setMode('hold');
    expect((await cmd(`/chats/${chatId}/turns`, { revision: store.snapshot(chatId).revision, requestId: randomUUID(), text: 'Hello.' })).statusCode).toBe(202);
    await expect.poll(() => mock.requests.length).toBe(1);
    expect(mock.requests[0]?.body.messages).toContainEqual({ role: 'system', content: 'Alice' });
    expect(mock.requests[0]?.body.messages).toContainEqual({ role: 'system', content: 'Alice meets You.' });
    expect(JSON.stringify(mock.requests[0]?.body)).not.toContain('University version');
    expect((await cmd(`/library/${id}`, command(store, 'Blocked title'), 'PUT')).statusCode).toBe(409);
    mock.finishAll();
    await expect.poll(() => store.snapshot(chatId).turns.at(-1)?.complete).toBe(true);
    const before = store.snapshot(chatId);
    expect((await cmd(`/library/${id}`, command(store, 'Medieval version'), 'PUT')).statusCode).toBe(200);
    expect(store.snapshot(chatId)).toEqual(before);
    const exported = await app.inject({ url: `/api/library/characters/${id}/export`, headers: { host: 'localhost', cookie } });
    expect(exported.statusCode).toBe(200);
    expect(exported.body).not.toContain('titleComment');
    expect(exported.body).not.toContain('Medieval version');
    expect(exported.body).not.toContain('synthetic-title-secret');
  } finally { mock.finishAll(); await app.close(); await mock.close(); }
});
