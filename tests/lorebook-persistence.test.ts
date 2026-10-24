import { legacyRows, removeVariantSchema } from './support/legacy-variants.js';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/persistence/store.js';
import { exportCharacter, importCharacter } from '../src/core/cards.js';
import { exportLorebook } from '../src/core/lorebook-formats.js';
import { assembleRequest } from '../src/core/prompt.js';
import { defaultPrompt, selectionsSchema, type Character } from '../src/shared/library.js';
import { defaultContextPreset, type ContextJob, type ContextStep, type SummaryNode } from '../src/shared/context.js';
import fixtures from './fixtures/lorebooks.json';
import { legacyLorePrompt, legacyRoleplayPrompt } from '../src/persistence/legacy-prompt.js';
import { upgradePrompt } from '../src/core/prompt-upgrade.js';
import { summaryRefusalFilterVersion } from '../src/core/summary-validation.js';

const folders: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});
function path() {
  const folder = mkdtempSync(join(tmpdir(), 'ore-lore-persistence-'));
  folders.push(folder);
  return join(folder, 'test.sqlite');
}
function open(filename = path()) {
  const store = new Store(filename);
  stores.push(store);
  return store;
}
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Expected a saved fixture record.');
  return value;
}
function book(store: Store, id: string) { return required(store.libraries().lorebooks.find(item => item.id === id)); }
function character(store: Store, id: string) { return required(store.libraries().characters.find(item => item.id === id)); }
function withoutIdentity<T extends { id: string; revision: number }>(value: T) {
  const { id: _id, revision: _revision, ...data } = value;
  return data;
}
function createChat(store: Store, input: Partial<ReturnType<typeof selectionsSchema.parse>> = {}) {
  return store.createChat(selectionsSchema.parse({ title: 'Synthetic chat', targetInputTokens: 32_000, connectionId: null, promptId: 'default', characterId: null, personaId: null, ...input }));
}
function selection(store: Store, chatId: string, input: Partial<ReturnType<typeof selectionsSchema.parse>> = {}) {
  const { settings } = store.snapshot(chatId);
  return selectionsSchema.parse({ title: settings.title, targetInputTokens: settings.targetInputTokens, connectionId: settings.connectionId ?? null,
    promptId: settings.promptId ?? 'default', characterId: settings.characterId ?? null, personaId: settings.personaId ?? null,
    contextPresetId: settings.contextPresetId ?? null, ...input,
  });
}
const cardFields: Character = { name: 'Synthetic keeper', description: 'A keeper in a tower.', personality: '', scenario: '', first_mes: '', mes_example: '' };
const v2Card = { spec: 'chara_card_v2', spec_version: '2.0', data: { ...cardFields, character_book: fixtures.v2, extensions: { foreign: 'preserved' } } };
const v3Card = { spec: 'chara_card_v3', spec_version: '3.0', data: { ...cardFields, character_book: fixtures.v3.data, extensions: {} } };
const connection = { name: 'Synthetic', endpoint: 'http://localhost:1234/v1', model: 'synthetic', contextWindow: 100_000, maxOutputTokens: 100, customParameters: {} };

function commandRows(store: Store) { return store.sqlite.prepare('SELECT * FROM lore_commands ORDER BY rowid').all(); }
function savedRows(database: Database.Database, legacy = false): Record<string, unknown[]> {
  const records: Record<string, unknown[]> = {};
  for (const table of ['chats', 'library', 'library_state', 'turns', 'generations', 'connections', 'credentials', 'owners', 'sessions', 'summaries', 'context_states', 'context_jobs', 'context_steps']) {
    records[table] = legacy ? legacyRows(database, table) : database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
  }
  return records;
}

describe('durable lorebook imports', () => {
  it('keeps separately imported books independent until an explicit selection', () => {
    const store = open();
    const characterId = store.saveLibrary(store.libraries().revision, 'characters', cardFields);
    const chatId = createChat(store, { characterId });
    const before = store.snapshot(chatId), originalCharacter = character(store, characterId);
    const imported = store.importBook(store.libraries().revision, randomUUID(), fixtures.v2);
    expect(book(store, imported.id).name).toBe(fixtures.v2.name);
    expect(store.snapshot(chatId)).toEqual(before);
    expect(character(store, characterId)).toEqual(originalCharacter);
    expect(store.libraries().lorebookUses.find(use => use.bookId === imported.id)).toEqual({ bookId: imported.id, characters: [], chats: [] });
  });

  it('makes repeated lost-acknowledgement commands idempotent across restart while allowing deliberate duplicates', () => {
    const filename = path();
    let store = open(filename);
    const revision = store.libraries().revision;
    const requestId = randomUUID();
    const first = store.importBook(revision, requestId, fixtures.worldInfo);
    const saved = book(store, first.id);
    const library = store.libraries();
    const savedEntryIds = new Set(saved.entries.map(entry => entry.id));
    expect(first.diagnostics.some(diagnostic => diagnostic.entryId)).toBe(true);
    expect(first.diagnostics.every(diagnostic => !diagnostic.entryId || savedEntryIds.has(diagnostic.entryId))).toBe(true);
    expect(store.importBook(revision, requestId, fixtures.worldInfo)).toEqual(first);
    expect(store.libraries()).toEqual(library);
    store.close();
    store = open(filename);
    expect(store.importBook(revision, requestId, fixtures.worldInfo)).toEqual(first);
    expect(store.libraries()).toEqual(library);
    const duplicate = store.importBook(store.libraries().revision, randomUUID(), fixtures.worldInfo);
    expect(duplicate.id).not.toBe(first.id);
    const copied = book(store, duplicate.id);
    expect(copied.name).toBe(saved.name);
    expect(copied.entries.map(entry => entry.id).some(id => savedEntryIds.has(id))).toBe(false);
    expect(copied.entries.map(entry => entry.externalId)).toEqual(saved.entries.map(entry => entry.externalId));
    expect(commandRows(store)).toHaveLength(2);
  });

  it('rejects stale revisions, conflicting command identities and malformed nested input without mutation', () => {
    const store = open();
    const revision = store.libraries().revision;
    const requestId = randomUUID();
    store.importBook(revision, requestId, fixtures.v2);
    const before = store.libraries(), commands = commandRows(store);
    expect(() => store.importBook(revision, randomUUID(), fixtures.v2)).toThrow('changed on another device');
    expect(() => store.importBook(before.revision, requestId, fixtures.worldInfo)).toThrow('different command');
    expect(() => store.importBook(before.revision, randomUUID(), fixtures.malformedV3)).toThrow();
    expect(() => store.importCard(before.revision, randomUUID(), { ...v3Card, data: { ...v3Card.data, character_book: fixtures.malformedV3.data } })).toThrow();
    expect(() => store.importCard(before.revision, requestId, v2Card)).toThrow('different command');
    expect(store.libraries()).toEqual(before);
    expect(commandRows(store)).toEqual(commands);
  });

  it.each([v2Card, v3Card])('creates a character, independent book and link atomically for $spec', source => {
    const store = open();
    const revision = store.libraries().revision, requestId = randomUUID();
    const result = store.importCard(revision, requestId, source);
    const card = character(store, required(result.ids[0]));
    const imported = book(store, required(result.books[0]).id);
    expect(card.lorebookId).toBe(imported.id);
    expect(result.books).toEqual([{ id: imported.id, name: imported.name, entries: imported.entries.length }]);
    expect(exportCharacter(withoutIdentity(card), withoutIdentity(imported))).toMatchObject({ data: { character_book: source.data.character_book } });
    const savedIds = new Set(imported.entries.map(entry => entry.id));
    expect(result.diagnostics.every(diagnostic => !diagnostic.entryId || savedIds.has(diagnostic.entryId))).toBe(true);
    const before = store.libraries();
    expect(store.importCard(revision, requestId, source)).toEqual(result);
    expect(store.libraries()).toEqual(before);
    expect(commandRows(store)).toHaveLength(1);
    const duplicate = store.importCard(before.revision, randomUUID(), source);
    expect(duplicate.ids[0]).not.toBe(card.id);
    expect(duplicate.books[0]?.id).not.toBe(imported.id);
  });

  it('distinguishes absent and explicitly empty embedded books without creating placeholders', () => {
    const store = open();
    const none = store.importCard(store.libraries().revision, randomUUID(), cardFields);
    expect(none.books).toEqual([]);
    expect(character(store, required(none.ids[0])).lorebookId).toBeNull();
    expect(store.libraries().lorebooks).toHaveLength(0);
    const empty = store.importCard(store.libraries().revision, randomUUID(), { ...v3Card, data: { ...v3Card.data, character_book: fixtures.emptyV3.data } });
    expect(empty.books).toHaveLength(1);
    expect(book(store, required(empty.books[0]).id).entries).toEqual([]);
  });

  it.each(['legacy', 'chara_card_v2', 'chara_card_v3'])('treats a null embedded book as absent in %s cards', spec => {
    const store = open();
    const fields = { ...cardFields, character_book: null, alternate_greetings: ['Another greeting.'] };
    const source = spec === 'legacy' ? fields : { spec, data: fields };
    const before = store.libraries();
    expect(store.previewCard(source)).toMatchObject({ name: fields.name, book: null, diagnostics: [] });
    expect(store.libraries()).toEqual(before);
    const requestId = randomUUID();
    const result = store.importCard(before.revision, requestId, source);
    const saved = character(store, required(result.ids[0]));
    expect(result.books).toEqual([]);
    expect(saved).toMatchObject({ lorebookId: null, alternate_greetings: fields.alternate_greetings, source });
    expect(store.libraries().lorebooks).toEqual([]);
    const committed = store.libraries();
    expect(store.importCard(before.revision, requestId, source)).toEqual(result);
    expect(() => store.extractBook(committed.revision, randomUUID(), saved.id)).toThrow('no preserved embedded lorebook');
    expect(store.libraries()).toEqual(committed);
    expect(commandRows(store)).toHaveLength(1);
    expect(exportCharacter(withoutIdentity(saved), null).data).not.toHaveProperty('character_book');
  });

  it.each([false, '', [], {}])('rejects malformed non-null embedded books without partial records: %j', character_book => {
    const store = open();
    const before = store.libraries();
    const source = { ...v2Card, data: { ...v2Card.data, character_book } };
    expect(() => store.previewCard(source)).toThrow();
    expect(() => store.importCard(before.revision, randomUUID(), source)).toThrow();
    expect(store.libraries()).toEqual(before);
    expect(commandRows(store)).toEqual([]);
  });

  it('rolls back the book, character, link, revision and durable command when a later character write fails', () => {
    const store = open();
    const before = store.libraries(), commands = commandRows(store), requestId = randomUUID();
    store.sqlite.exec("CREATE TRIGGER reject_lore_character BEFORE INSERT ON library WHEN NEW.kind = 'characters' BEGIN SELECT RAISE(ABORT, 'synthetic character write failure'); END");
    expect(() => store.importCard(before.revision, requestId, v2Card)).toThrow('synthetic character write failure');
    expect(store.libraries()).toEqual(before);
    expect(commandRows(store)).toEqual(commands);
    store.sqlite.exec('DROP TRIGGER reject_lore_character');
    const retried = store.importCard(before.revision, requestId, v2Card);
    expect(retried.books).toHaveLength(1);
    expect(store.libraries().characters).toHaveLength(1);
    expect(commandRows(store)).toHaveLength(1);
  });

  it('rolls back a standalone save when recording its durable command fails', () => {
    const store = open();
    const before = store.libraries(), requestId = randomUUID();
    store.sqlite.exec("CREATE TRIGGER reject_lore_command BEFORE INSERT ON lore_commands BEGIN SELECT RAISE(ABORT, 'synthetic command write failure'); END");
    expect(() => store.importBook(before.revision, requestId, fixtures.v2)).toThrow('synthetic command write failure');
    expect(store.libraries()).toEqual(before);
    expect(commandRows(store)).toEqual([]);
    store.sqlite.exec('DROP TRIGGER reject_lore_command');
    expect(store.importBook(before.revision, requestId, fixtures.v2).id).toBeTruthy();
    expect(commandRows(store)).toHaveLength(1);
  });
});

describe('lorebook selection and ownership', () => {
  it('invalidates cached lorebook uses when Setup renames a chat or changes its book', () => {
    const store = open();
    const bookId = store.importBook(store.libraries().revision, randomUUID(), fixtures.v2).id;
    const chatId = createChat(store, { lorebookId: bookId });
    const before = store.libraries();
    const revision = store.snapshot(chatId).revision;
    store.updateChat(revision, chatId, selection(store, chatId, { title: 'Renamed in Setup' }));
    const renamed = store.libraryUpdate(before.revision);
    expect(renamed).not.toHaveProperty('unchanged');
    if ('unchanged' in renamed) throw new Error('Renamed chat references must refresh the library.');
    expect(renamed.lorebookUses.find(use => use.bookId === bookId)?.chats).toEqual([{ id: chatId, title: 'Renamed in Setup' }]);

    expect(() => store.updateChat(revision, chatId, selection(store, chatId, { lorebookId: null }))).toThrow();
    expect(store.libraryUpdate(renamed.revision)).toHaveProperty('unchanged', true);
    expect(store.snapshot(chatId).settings.lorebookId).toBe(bookId);

    store.updateChat(store.snapshot(chatId).revision, chatId, selection(store, chatId, { lorebookId: null }));
    const unlinked = store.libraryUpdate(renamed.revision);
    expect(unlinked).not.toHaveProperty('unchanged');
    if ('unchanged' in unlinked) throw new Error('Changed chat references must refresh the library.');
    expect(unlinked.lorebookUses.find(use => use.bookId === bookId)?.chats).toEqual([]);
  });

  it('resolves omitted create selection from the character while explicit None remains None', () => {
    const store = open();
    const imported = store.importCard(store.libraries().revision, randomUUID(), v2Card);
    const characterId = required(imported.ids[0]), bookId = required(imported.books[0]).id;
    const defaulted = createChat(store, { characterId }), none = createChat(store, { characterId, lorebookId: null });
    expect(store.snapshot(defaulted).settings.lorebookId).toBe(bookId);
    expect(store.snapshot(defaulted).sources.lorebook?.id).toBe(bookId);
    expect(store.snapshot(none).settings.lorebookId).toBeNull();
    expect(store.snapshot(none).sources.lorebook).toBeNull();
    expect(store.snapshot().settings.lorebookId).toBeNull();
    const raw = store.sqlite.prepare("SELECT json_extract(settings, '$.lorebookId') AS selected, json_type(settings, '$.lorebookId') AS type FROM chats WHERE id = ?").get(none);
    expect(raw).toEqual({ selected: null, type: 'null' });
  });

  it('preserves saved selection on omitted updates and character changes, including legacy settings saves', () => {
    const store = open();
    const imported = store.importCard(store.libraries().revision, randomUUID(), v2Card);
    const characterId = required(imported.ids[0]), bookId = required(imported.books[0]).id;
    const otherCard = store.saveLibrary(store.libraries().revision, 'characters', { ...cardFields, name: 'Other character', lorebookId: null });
    const chatId = createChat(store, { characterId });
    store.updateChat(store.snapshot(chatId).revision, chatId, selection(store, chatId, { characterId: otherCard }));
    expect(store.snapshot(chatId).settings.lorebookId).toBe(bookId);
    const snapshot = store.snapshot(chatId);
    const { lorebookId: _lorebookId, ...oldSettings } = snapshot.settings;
    store.saveSettings(snapshot.revision, connection, oldSettings, 'synthetic-secret-preserve', chatId);
    expect(store.snapshot(chatId).settings.lorebookId).toBe(bookId);
    expect(store.apiKey(chatId)).toBe('synthetic-secret-preserve');
    store.updateChat(store.snapshot(chatId).revision, chatId, selection(store, chatId, { lorebookId: null }));
    expect(store.snapshot(chatId).settings.lorebookId).toBeNull();
    store.updateChat(store.snapshot(chatId).revision, chatId, selection(store, chatId, { characterId }));
    expect(store.snapshot(chatId).settings.lorebookId).toBeNull();
  });

  it('shares a duplicated character link and makes explicit book copies independent', () => {
    const store = open();
    const imported = store.importCard(store.libraries().revision, randomUUID(), v2Card);
    const original = character(store, required(imported.ids[0])), linked = book(store, required(imported.books[0]).id);
    const duplicateCard = store.saveLibrary(store.libraries().revision, 'characters', { ...withoutIdentity(original), name: 'Copied character' });
    expect(character(store, duplicateCard).lorebookId).toBe(linked.id);
    expect(store.libraries().lorebooks).toHaveLength(1);
    const duplicateBook = store.saveLibrary(store.libraries().revision, 'lorebooks', { ...withoutIdentity(linked), name: 'Copied book' });
    const copied = book(store, duplicateBook);
    expect(copied.id).not.toBe(linked.id);
    expect(copied.entries.map(entry => entry.id).some(id => linked.entries.some(entry => entry.id === id))).toBe(false);
    expect(exportLorebook(withoutIdentity(copied))).toMatchObject({ name: 'Copied book', entries: fixtures.v2.entries });
    const current = book(store, linked.id);
    store.saveLibrary(store.libraries().revision, 'lorebooks', { ...withoutIdentity(current), entries: current.entries.map(entry => ({ ...entry, content: 'Changed shared lore' })) }, linked.id);
    expect(book(store, copied.id).entries[0]?.content).toBe(fixtures.v2.entries[0].content);
  });

  it('keeps unlinked raw metadata internally but never resurrects it in resolved character exports', () => {
    const store = open();
    const imported = store.importCard(store.libraries().revision, randomUUID(), v2Card);
    const original = character(store, required(imported.ids[0]));
    store.saveLibrary(store.libraries().revision, 'characters', { ...withoutIdentity(original), lorebookId: null }, original.id);
    const unlinked = character(store, original.id);
    expect(unlinked.source).toEqual(original.source);
    expect(unlinked.lorebookId).toBeNull();
    expect(JSON.stringify(exportCharacter(withoutIdentity(unlinked), null))).not.toContain('character_book');
    const { lorebookId: _lorebookId, ...legacyUpdate } = withoutIdentity(unlinked);
    store.saveLibrary(store.libraries().revision, 'characters', { ...legacyUpdate, description: 'Edited character' }, original.id);
    const edited = character(store, original.id);
    expect(edited.lorebookId).toBeNull();
    expect(JSON.stringify(exportCharacter(withoutIdentity(edited), null))).not.toContain('character_book');
    expect(store.libraries().lorebooks).toHaveLength(1);
  });

  it('exports the linked character default independently of a chat book override', () => {
    const store = open();
    const imported = store.importCard(store.libraries().revision, randomUUID(), v2Card);
    const cardId = required(imported.ids[0]), defaultId = required(imported.books[0]).id;
    const override = store.importBook(store.libraries().revision, randomUUID(), fixtures.worldInfo);
    const chatId = createChat(store, { characterId: cardId, lorebookId: override.id });
    expect(store.snapshot(chatId).sources.lorebook?.id).toBe(override.id);
    const card = character(store, cardId);
    expect(card.lorebookId).toBe(defaultId);
    expect(exportCharacter(withoutIdentity(card), withoutIdentity(book(store, defaultId)))).toMatchObject({ data: { character_book: fixtures.v2 } });
    expect(store.libraries().lorebookUses.find(use => use.bookId === defaultId)?.characters).toEqual([{ id: card.id, name: card.name }]);
    expect(store.libraries().lorebookUses.find(use => use.bookId === override.id)?.chats).toEqual([{ id: chatId, title: 'Synthetic chat' }]);
  });

  it('rejects invalid selections and deletion in use without changing saved state', () => {
    const store = open();
    const imported = store.importCard(store.libraries().revision, randomUUID(), v2Card);
    const characterId = required(imported.ids[0]), bookId = required(imported.books[0]).id;
    const chatId = createChat(store, { characterId });
    const before = store.libraries(), chat = store.snapshot(chatId);
    expect(() => store.deleteLibrary(before.revision, 'lorebooks', bookId)).toThrow('used by');
    expect(() => store.updateChat(chat.revision, chatId, selection(store, chatId, { lorebookId: 'missing-book' }))).toThrow('no longer exists');
    expect(() => store.saveLibrary(before.revision, 'characters', { ...cardFields, lorebookId: 'missing-book' })).toThrow('no longer exists');
    expect(() => createChat(store, { lorebookId: characterId })).toThrow('no longer exists');
    expect(store.libraries()).toEqual(before);
    expect(store.snapshot(chatId)).toEqual(chat);
    const card = character(store, characterId);
    store.saveLibrary(store.libraries().revision, 'characters', { ...withoutIdentity(card), lorebookId: null }, characterId);
    expect(() => store.deleteLibrary(store.libraries().revision, 'lorebooks', bookId)).toThrow('used by');
    store.updateChat(store.snapshot(chatId).revision, chatId, selection(store, chatId, { lorebookId: null }));
    store.deleteLibrary(store.libraries().revision, 'lorebooks', bookId);
    expect(store.libraries().lorebooks).toHaveLength(0);
  });

  it('propagates shared-book edits only to chats selecting that book and preserves stale-write checks', () => {
    const store = open();
    const imported = store.importBook(store.libraries().revision, randomUUID(), fixtures.v2);
    const one = createChat(store, { lorebookId: imported.id }), two = createChat(store, { lorebookId: imported.id });
    const independent = createChat(store, { lorebookId: null });
    const beforeOne = store.snapshot(one), beforeTwo = store.snapshot(two), untouched = store.snapshot(independent);
    const before = book(store, imported.id), revision = store.libraries().revision;
    store.saveLibrary(revision, 'lorebooks', { ...withoutIdentity(before), name: 'Renamed shared book' }, imported.id);
    expect(book(store, imported.id).revision).toBe(before.revision + 1);
    expect(store.snapshot(one).revision).toBe(beforeOne.revision + 1);
    expect(store.snapshot(two).revision).toBe(beforeTwo.revision + 1);
    expect(store.snapshot(independent)).toEqual(untouched);
    expect(() => store.saveLibrary(revision, 'lorebooks', withoutIdentity(before), imported.id)).toThrow('changed on another device');
    expect(() => store.updateChat(beforeOne.revision, one, selection(store, one))).toThrow('changed on another device');
  });
});

describe('explicit legacy embedded extraction', () => {
  it('extracts once, retries safely, and returns the existing shared link on repeated explicit extraction', () => {
    const store = open();
    const cardId = store.saveLibrary(store.libraries().revision, 'characters', importCharacter(v2Card));
    const chatId = createChat(store, { characterId: cardId });
    expect(store.snapshot(chatId).settings.lorebookId).toBeNull();
    const revision = store.libraries().revision, requestId = randomUUID();
    const result = store.extractBook(revision, requestId, cardId);
    expect(character(store, cardId).lorebookId).toBe(result.bookId);
    expect(store.snapshot(chatId).settings.lorebookId).toBeNull();
    expect(store.extractBook(revision, requestId, cardId)).toEqual(result);
    const before = store.libraries();
    expect(store.extractBook(before.revision, randomUUID(), cardId).bookId).toBe(result.bookId);
    expect(store.libraries()).toEqual(before);
    expect(store.libraries().lorebooks).toHaveLength(1);
    expect(() => store.extractBook(revision, randomUUID(), cardId)).toThrow('changed on another device');
    expect(store.libraries()).toEqual(before);
  });

  it('rolls back extraction and permits the same command to retry after a forced link failure', () => {
    const store = open();
    const cardId = store.saveLibrary(store.libraries().revision, 'characters', importCharacter(v3Card));
    const before = store.libraries(), requestId = randomUUID();
    store.sqlite.exec("CREATE TRIGGER reject_extracted_link BEFORE UPDATE ON library WHEN NEW.kind = 'characters' BEGIN SELECT RAISE(ABORT, 'synthetic link write failure'); END");
    expect(() => store.extractBook(before.revision, requestId, cardId)).toThrow('synthetic link write failure');
    expect(store.libraries()).toEqual(before);
    expect(commandRows(store)).toEqual([]);
    store.sqlite.exec('DROP TRIGGER reject_extracted_link');
    const result = store.extractBook(before.revision, requestId, cardId);
    expect(book(store, result.bookId).entries).toHaveLength(2);
    expect(character(store, cardId).lorebookId).toBe(result.bookId);
  });
});

function populatedVersion6(customized: boolean) {
  const filename = path();
  const store = open(filename);
  const connectionId = store.saveLibrary(store.libraries().revision, 'connections', connection, undefined, 'synthetic-migration-secret');
  const characterId = store.saveLibrary(store.libraries().revision, 'characters', importCharacter(v2Card));
  const contextId = store.saveLibrary(store.libraries().revision, 'contexts', { ...defaultContextPreset, name: 'Preserved custom context' });
  const oldFactory = { ...legacyLorePrompt, blocks: legacyLorePrompt.blocks.filter(block => !block.marker?.startsWith('lore_')) };
  const factory = customized ? { ...oldFactory, name: 'My edited default' } : oldFactory;
  store.saveLibrary(store.libraries().revision, 'prompts', upgradePrompt(factory), 'default');
  const customPromptId = store.saveLibrary(store.libraries().revision, 'prompts', { ...upgradePrompt(oldFactory), name: 'Custom old prompt' });
  store.sqlite.prepare('UPDATE library SET data = ? WHERE id = ?').run(JSON.stringify(factory), 'default');
  store.sqlite.prepare('UPDATE library SET data = ? WHERE id = ?').run(JSON.stringify({ ...oldFactory, name: 'Custom old prompt' }), customPromptId);
  const chatId = createChat(store, { connectionId, characterId, contextPresetId: contextId });
  const customChat = createChat(store, { connectionId, promptId: customPromptId });
  store.replaceHistory(store.snapshot(chatId).revision, chatId, [
    { user: 'Mira gives Leon a key.', assistant: 'Leon promises to keep it.', complete: true },
    { user: 'Mira waits by the tower.', assistant: 'Leon opens the door.', complete: true },
  ]);
  const command = store.begin(store.snapshot(chatId).revision, randomUUID(), 'Leon returns.', chatId);
  const snapshot = store.snapshot(chatId);
  const request = assembleRequest(connection, snapshot.settings, snapshot.turns, snapshot.sources, snapshot.context);
  store.saveRequest(command.id, request);
  store.finish(command.id, 'succeeded', 'Mira welcomes Leon.', null, { inputTokens: 11, outputTokens: 7, totalTokens: 18 });
  const state = store.snapshot(chatId), turn = required(state.turns[0]);
  const revisionBefore = state.revision, libraryRevisionBefore = store.libraries().revision;
  const defaultRevisionBefore = required(store.libraries().prompts.find(prompt => prompt.id === 'default')).revision;
  const summary: SummaryNode = { id: 'preserved-summary', revision: 3, level: 1, text: 'Manual correction: Mira owns the key.', manual: true,
    approved: true, createdAt: '2026-10-17T10:00:00.000Z', turns: [{ turnId: turn.id, userRevision: turn.user.revision, assistantRevision: turn.assistant.revision, complete: true }], children: [], prior: [],
  };
  const config = required(store.contextPreset(contextId) ?? undefined);
  const job: ContextJob = { id: 'preserved-job', chatId, status: 'succeeded', mode: 'prepare', generationId: null, sourceRevision: state.revision,
    config, stepCount: 1, error: null, createdAt: summary.createdAt, updatedAt: summary.createdAt, historyTurnIds: state.turns.map(turn => turn.id),
  };
  const step: ContextStep = { id: 'preserved-step', jobId: job.id, operation: { level: 1, turnIds: [turn.id], children: [] }, request,
    status: 'saved', result: summary, error: null, before: { archivedTurnIds: [], selected: [] }, after: { archivedTurnIds: [turn.id], selected: [summary] },
    inputBefore: 200, inputAfter: 100, createdAt: summary.createdAt,
  };
  store.sqlite.prepare('INSERT INTO summaries (id, revision, chat_id, data) VALUES (?, ?, ?, ?)').run(summary.id, summary.revision, chatId, JSON.stringify(summary));
  store.sqlite.prepare('INSERT INTO context_states (chat_id, revision, data) VALUES (?, ?, ?)').run(chatId, 5, JSON.stringify({ archivedTurnIds: [turn.id], selected: [{ id: summary.id, revision: summary.revision }] }));
  store.sqlite.prepare('INSERT INTO context_jobs (id, chat_id, request_id, command, data) VALUES (?, ?, ?, ?, ?)').run(job.id, chatId, 'preserved-memory-command', '{"mode":"prepare","generationId":null}', JSON.stringify(job));
  store.sqlite.prepare('INSERT INTO context_steps (id, job_id, data) VALUES (?, ?, ?)').run(step.id, job.id, JSON.stringify(step));
  store.sqlite.prepare('INSERT INTO owners (id, salt, hash) VALUES (?, ?, ?)').run('owner', 'synthetic-salt', 'synthetic-password-hash');
  store.sqlite.prepare('INSERT INTO sessions (hash, expires_at) VALUES (?, ?)').run('synthetic-session-hash', 2_000_000_000);
  store.close();
  const database = new Database(filename);
  try {
    database.pragma('foreign_keys = ON');
    database.exec('DROP TABLE character_pictures; DROP TABLE picture_assets; DROP TRIGGER tagged_character_kind; DROP TABLE character_tags; DROP TABLE tags; DROP TABLE lore_operations; DROP TABLE lore_commands; DROP TABLE lore_states; DROP TABLE lore_epochs');
    database.prepare("UPDATE chats SET settings = json_remove(settings, '$.lorebookId')").run();
    removeVariantSchema(database);
    database.pragma('user_version = 6');
    return { filename, chatId, customChat, characterId, customPromptId, records: savedRows(database, true), factory, summary, request, revisionBefore, libraryRevisionBefore, defaultRevisionBefore };
  } finally { database.close(); }
}

describe('schema 7 lorebook migration', () => {
  it('creates fresh durable storage and explicit None without an activated placeholder book', () => {
    const store = open();
    expect(store.sqlite.pragma('user_version', { simple: true })).toBe(15);
    expect(store.libraries().lorebooks).toEqual([]);
    expect(store.snapshot().settings.lorebookId).toBeNull();
    expect(store.snapshot().loreState).toEqual({ epoch: 0, entries: {} });
    expect(store.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'lore_%' ORDER BY name").all()).toEqual([
      { name: 'lore_commands' }, { name: 'lore_epochs' }, { name: 'lore_operations' }, { name: 'lore_states' },
    ]);
    expect(required(store.libraries().prompts.find(prompt => prompt.id === 'default')).blocks).toEqual(defaultPrompt.blocks);
  });

  it.each([false, true])('preserves populated version-6 data and upgrades only the exact factory (customized: %s)', customized => {
    const seeded = populatedVersion6(customized);
    let store = open(seeded.filename);
    const actual = savedRows(store.sqlite, true);
    for (const table of ['turns', 'generations', 'connections', 'credentials', 'owners', 'sessions', 'summaries', 'context_states', 'context_jobs', 'context_steps']) expect(actual[table]).toEqual(seeded.records[table]);
    const saved = store.snapshot(seeded.chatId);
    expect(saved.revision).toBe(seeded.revisionBefore + Number(!customized) + 1);
    expect(store.libraries().revision).toBe(seeded.libraryRevisionBefore + Number(!customized) + 4);
    expect(saved.settings.lorebookId).toBeNull();
    expect(saved.sources.lorebook).toBeNull();
    expect(store.libraries().lorebooks).toEqual([]);
    expect(character(store, seeded.characterId).lorebookId).toBeUndefined();
    expect(saved.context.summaries).toContainEqual({ ...seeded.summary, refusalCheck: { version: summaryRefusalFilterVersion, result: 'passed' } });
    expect(saved.context.selected).toEqual([{ id: seeded.summary.id, revision: seeded.summary.revision }]);
    expect(saved.generations[0]?.request).toEqual(seeded.request);
    expect(saved.generations[0]?.request).not.toHaveProperty('lore');
    expect(store.apiKey(seeded.chatId)).toBe('synthetic-migration-secret');
    expect(JSON.stringify(store.libraries()) + JSON.stringify(saved)).not.toContain('synthetic-migration-secret');
    const factory = required(store.libraries().prompts.find(prompt => prompt.id === 'default'));
    expect(withoutIdentity(factory)).toEqual(customized ? upgradePrompt(seeded.factory) : legacyRoleplayPrompt);
    expect(factory.revision).toBe(seeded.defaultRevisionBefore + Number(!customized) + 1);
    const excludingPrompts = (rows: unknown[]) => rows.filter(row => typeof row !== 'object' || row === null || !('kind' in row) || row.kind !== 'prompts');
    expect(excludingPrompts(actual.library)).toEqual(excludingPrompts(seeded.records.library));
    const custom = required(store.libraries().prompts.find(prompt => prompt.id === seeded.customPromptId));
    expect(withoutIdentity(custom)).toEqual({ ...upgradePrompt(seeded.factory), name: 'Custom old prompt' });
    expect(custom.revision).toBe(1);
    expect(custom.blocks.some(block => block.kind === 'marker' && block.marker.startsWith('lore_'))).toBe(false);
    const previousChats = seeded.records.chats;
    expect(Array.isArray(previousChats)).toBe(true);
    // The custom prompt also gains an explicit field selection in version 8.
    const customRaw = store.sqlite.prepare('SELECT * FROM chats WHERE id = ?').get(seeded.customChat);
    const previousCustom = previousChats.find(row => typeof row === 'object' && row !== null && 'id' in row && row.id === seeded.customChat);
    if (typeof previousCustom !== 'object' || previousCustom === null || !('revision' in previousCustom) || typeof previousCustom.revision !== 'number') throw new Error('Missing fixture chat.');
    expect(customRaw).toEqual({ ...previousCustom, revision: previousCustom.revision + 1, created_at: null, updated_at: null });
    expect(store.sqlite.pragma('user_version', { simple: true })).toBe(15);
    const after = savedRows(store.sqlite), snapshotAfter = store.snapshot(seeded.chatId);
    store.close();
    store = open(seeded.filename);
    expect(savedRows(store.sqlite)).toEqual(after);
    expect(store.snapshot(seeded.chatId)).toEqual(snapshotAfter);
    expect(commandRows(store)).toEqual([]);
  });

  it('rolls back schema, prompt and revisions together and safely retries after an interrupted upgrade', () => {
    const seeded = populatedVersion6(false);
    const database = new Database(seeded.filename);
    database.exec("CREATE TRIGGER reject_lore_migration BEFORE UPDATE ON library_state BEGIN SELECT RAISE(ABORT, 'synthetic lore migration failure'); END");
    database.close();
    expect(() => new Store(seeded.filename)).toThrow('synthetic lore migration failure');
    const failed = new Database(seeded.filename);
    try {
      expect(failed.pragma('user_version', { simple: true })).toBe(6);
      expect(savedRows(failed, true)).toEqual(seeded.records);
      expect(failed.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'lore_%'").all()).toEqual([]);
      expect(failed.prepare('SELECT * FROM runtime_owner').all()).toEqual([]);
      failed.exec('DROP TRIGGER reject_lore_migration');
    } finally { failed.close(); }
    const recovered = open(seeded.filename);
    expect(recovered.sqlite.pragma('user_version', { simple: true })).toBe(15);
    expect(withoutIdentity(required(recovered.libraries().prompts.find(prompt => prompt.id === 'default')))).toEqual(legacyRoleplayPrompt);
    expect(savedRows(recovered.sqlite, true).generations).toEqual(seeded.records.generations);
    expect(savedRows(recovered.sqlite).summaries).toEqual(seeded.records.summaries);
  });
});
