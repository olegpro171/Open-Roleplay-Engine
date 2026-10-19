import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/persistence/store.js';
import { assembleRequest } from '../src/core/prompt.js';
import { exportPersona, importPersonas } from '../src/core/cards.js';
import { libraryPersonaSchema, personaLabel, type Persona } from '../src/shared/library.js';

const folders: string[] = [];
afterEach(() => { for (const path of folders.splice(0)) rmSync(path, { recursive: true, force: true }); });
function filename() {
  const path = mkdtempSync(join(tmpdir(), 'ore-persona-title-'));
  folders.push(path);
  return join(path, 'test.sqlite');
}

const persona: Persona = { name: 'Alex', description: 'A traveller named {{user}}.' };
const connection = { name: 'Mock', endpoint: 'http://localhost:1234/v1', model: 'mock', contextWindow: 100_000, maxOutputTokens: 100, customParameters: {} };

it('keeps a local title out of selected prompt sources, requests and exports across restart', () => {
  const path = filename();
  let store = new Store(path);
  try {
    const id = store.saveLibrary(store.libraryRevision(), 'personas', persona);
    const connectionId = store.saveLibrary(store.libraryRevision(), 'connections', connection);
    const chatId = store.createChat({ title: 'Story', promptId: 'default', characterId: null, personaId: id, connectionId, targetInputTokens: 32000 });
    const before = store.snapshot(chatId);
    const request = assembleRequest(connection, before.settings, before.turns, before.sources, before.context);
    const oldRecord = store.sqlite.prepare('SELECT data, revision FROM library WHERE id = ?').get(id);
    store.close(); store = new Store(path);
    expect(store.sqlite.prepare('SELECT data, revision FROM library WHERE id = ?').get(id)).toEqual(oldRecord);

    const revision = store.libraryRevision();
    store.saveLibrary(revision, 'personas', { ...persona, titleComment: '  University version  ' }, id);
    expect(store.libraryRevision()).toBe(revision + 1);
    expect(store.libraries().personas.find(value => value.id === id)).toMatchObject({ ...persona, titleComment: 'University version', revision: 0 });
    expect(store.snapshot(chatId)).toEqual(before);
    const selected = store.snapshot(chatId);
    expect(selected.sources.persona).not.toHaveProperty('titleComment');
    expect(assembleRequest(connection, selected.settings, selected.turns, selected.sources, selected.context)).toEqual(request);
    const saved = store.libraries().personas.find(value => value.id === id);
    if (!saved) throw new Error('Missing saved persona');
    expect(JSON.stringify(exportPersona(saved))).not.toContain('University version');
    expect(importPersonas(exportPersona(saved))).toEqual([persona]);

    const unchanged = store.libraryRevision();
    store.saveLibrary(unchanged, 'personas', persona, id);
    expect(store.libraryRevision()).toBe(unchanged);
    expect(store.libraries().personas.find(value => value.id === id)?.titleComment).toBe('University version');
    store.close(); store = new Store(path);
    expect(store.libraries().personas.find(value => value.id === id)?.titleComment).toBe('University version');
    store.saveLibrary(store.libraryRevision(), 'personas', { ...persona, titleComment: '' }, id);
    expect(store.libraries().personas.find(value => value.id === id)?.titleComment).toBeUndefined();
    expect(store.snapshot(chatId)).toEqual(before);
  } finally { store.close(); }
});

it('keeps ordinary persona edits revisioned and rejects stale metadata writes', () => {
  const store = new Store(filename());
  try {
    const id = store.saveLibrary(store.libraryRevision(), 'personas', { ...persona, titleComment: 'First' });
    const chatId = store.createChat({ title: 'Story', promptId: 'default', characterId: null, personaId: id, connectionId: null, targetInputTokens: 32000 });
    const before = store.snapshot(chatId);
    const revision = store.libraryRevision();
    expect(() => store.saveLibrary(revision - 1, 'personas', { ...persona, titleComment: 'Stale' }, id)).toThrow('changed on another device');
    expect(store.libraries().personas.find(value => value.id === id)?.titleComment).toBe('First');
    store.saveLibrary(revision, 'personas', { ...persona, description: 'Changed', titleComment: 'Second' }, id);
    expect(store.snapshot(chatId).revision).toBe(before.revision + 1);
    expect(store.snapshot(chatId).sources.persona).toMatchObject({ name: 'Alex', description: 'Changed', revision: 1 });
    expect(store.snapshot(chatId).sources.persona).not.toHaveProperty('titleComment');
  } finally { store.close(); }
});

it('validates bounded single-line titles and formats labels', () => {
  expect(personaLabel(libraryPersonaSchema.parse({ ...persona, titleComment: '  Средневековая версия  ' }))).toBe('Alex · Средневековая версия');
  expect(libraryPersonaSchema.parse({ ...persona, titleComment: '界'.repeat(200) }).titleComment).toHaveLength(200);
  for (const titleComment of ['x'.repeat(201), 'two\nlines', 42, null]) expect(libraryPersonaSchema.safeParse({ ...persona, titleComment }).success).toBe(false);
});
