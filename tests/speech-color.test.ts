import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/persistence/store.js';
import { assembleRequest } from '../src/core/prompt.js';
import { exportCharacter, exportPersona } from '../src/core/cards.js';
import { libraryCharacterSchema, libraryPersonaSchema } from '../src/shared/library.js';

const folders: string[] = [];
afterEach(() => { for (const path of folders.splice(0)) rmSync(path, { recursive: true, force: true }); });
const character = { name: 'Mara', description: 'A keeper.', personality: '', scenario: '', first_mes: '"Welcome."', mes_example: '' };
const persona = { name: 'Alex', description: 'A traveller.' };
const connection = { name: 'Mock', endpoint: 'http://localhost:1234/v1', model: 'mock', contextWindow: 100_000, maxOutputTokens: 100, customParameters: {} };

it('adds speech colors to populated records without altering prompts, history or source revisions, and preserves them on restart and older-client writes', () => {
  const folder = mkdtempSync(join(tmpdir(), 'ore-speech-color-'));
  folders.push(folder);
  const path = join(folder, 'test.sqlite');
  let store = new Store(path);
  try {
    const characterId = store.saveLibrary(store.libraryRevision(), 'characters', character);
    const personaId = store.saveLibrary(store.libraryRevision(), 'personas', persona);
    const connectionId = store.saveLibrary(store.libraryRevision(), 'connections', connection);
    const chatId = store.createChat({ title: 'Story', promptId: 'default', characterId, personaId, connectionId, targetInputTokens: 32000 });
    const before = store.snapshot(chatId);
    const request = assembleRequest(connection, before.settings, before.turns, before.sources, before.context);
    store.close(); store = new Store(path);
    expect(store.libraries().characters.find(card => card.id === characterId)).not.toHaveProperty('speechColor');
    expect(store.libraries().personas.find(item => item.id === personaId)).not.toHaveProperty('speechColor');

    const revision = store.libraryRevision();
    store.saveLibrary(revision, 'characters', { ...character, speechColor: '#EeAa88' }, characterId);
    store.saveLibrary(store.libraryRevision(), 'personas', { ...persona, speechColor: '#88cc99' }, personaId);
    expect(store.libraryRevision()).toBe(revision + 2);
    expect(store.libraries().characters.find(card => card.id === characterId)).toMatchObject({ speechColor: '#eeaa88', revision: 0 });
    expect(store.libraries().personas.find(item => item.id === personaId)).toMatchObject({ speechColor: '#88cc99', revision: 0 });
    expect(store.snapshot(chatId)).toEqual(before);
    const after = store.snapshot(chatId);
    expect(assembleRequest(connection, after.settings, after.turns, after.sources, after.context)).toEqual(request);

    const stale = store.libraryRevision() - 1;
    expect(() => store.saveLibrary(stale, 'characters', { ...character, speechColor: '#ffffff' }, characterId)).toThrow('changed on another device');
    expect(() => store.saveLibrary(stale, 'personas', { ...persona, speechColor: '#ffffff' }, personaId)).toThrow('changed on another device');
    store.saveLibrary(store.libraryRevision(), 'characters', character, characterId);
    store.saveLibrary(store.libraryRevision(), 'personas', persona, personaId);
    expect(store.libraryRevision()).toBe(revision + 2);
    const copy = store.duplicateCharacter(store.libraryRevision(), characterId);
    expect(store.libraries().characters.find(card => card.id === copy)?.speechColor).toBe('#eeaa88');
    store.close(); store = new Store(path);
    const savedCharacter = store.libraries().characters.find(card => card.id === characterId);
    const savedPersona = store.libraries().personas.find(item => item.id === personaId);
    if (!savedCharacter || !savedPersona) throw new Error('Missing saved records');
    expect(savedCharacter.speechColor).toBe('#eeaa88');
    expect(savedPersona.speechColor).toBe('#88cc99');
    const { id: _id, revision: _revision, ...exportedCard } = savedCharacter;
    expect(exportCharacter(exportedCard)).not.toHaveProperty('speechColor');
    expect(exportCharacter(exportedCard).data).not.toHaveProperty('speechColor');
    expect(JSON.stringify(exportPersona(savedPersona))).not.toContain('speechColor');
    expect(store.snapshot(chatId)).toEqual(before);

    store.saveLibrary(store.libraryRevision(), 'characters', { ...character, speechColor: null }, characterId);
    store.saveLibrary(store.libraryRevision(), 'personas', { ...persona, speechColor: null }, personaId);
    expect(store.snapshot(chatId)).toEqual(before);
    store.close(); store = new Store(path);
    expect(store.libraries().characters.find(card => card.id === characterId)).not.toHaveProperty('speechColor');
    expect(store.libraries().personas.find(item => item.id === personaId)).not.toHaveProperty('speechColor');
    expect(store.libraries().characters.find(card => card.id === copy)?.speechColor).toBe('#eeaa88');
  } finally { store.close(); }
});

it('accepts only opaque six-digit hex colors while keeping the property optional for existing records', () => {
  for (const [schema, data] of [[libraryCharacterSchema, character], [libraryPersonaSchema, persona]] as const) {
    expect(schema.parse(data)).not.toHaveProperty('speechColor');
    expect(schema.parse({ ...data, speechColor: null }).speechColor).toBeNull();
    expect(schema.parse({ ...data, speechColor: '#ABCDEF' }).speechColor).toBe('#abcdef');
    for (const speechColor of ['', '#abc', '#abcd1234', 'red', '#zzzzzz', 'var(--color)', 123]) {
      expect(schema.safeParse({ ...data, speechColor }).success).toBe(false);
    }
  }
});
