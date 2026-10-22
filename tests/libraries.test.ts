import { legacyRows, removeVariantSchema } from './support/legacy-variants.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createReadStream, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Store } from '../src/persistence/store.js';
import { sourceOf, staleSummaries } from '../src/core/context.js';
import { assembleRequest, replaceNameMacros } from '../src/core/prompt.js';
import { importChat } from '../src/core/chat-import.js';
import { importCharacter, exportCharacter, importPersonas, exportPersona } from '../src/core/cards.js';
import { readCardFile } from '../src/server/card-import.js';
import { characterSchema, defaultPrompt, promptSchema, type Character } from '../src/shared/library.js';
import { createApp } from '../src/server/app.js';
import { randomUUID } from 'node:crypto';
import { startMockProvider } from './support/mock-provider.js';
import { deflateSync } from 'node:zlib';
import legacyContextPrompts from './fixtures/legacy-context-prompts.json';
import { contextPresetSchema, defaultContextPreset, type SummaryNode } from '../src/shared/context.js';
import { legacyLorePrompt, legacyRoleplayPrompt } from '../src/persistence/legacy-prompt.js';
import { upgradePrompt } from '../src/core/prompt-upgrade.js';

const folders: string[] = [];
afterEach(() => { for (const path of folders.splice(0)) rmSync(path, { recursive: true, force: true }); });
function folder() { const path = mkdtempSync(join(tmpdir(), 'roleplay-library-')); folders.push(path); return path; }
async function* chunks(text: string) { for (let i = 0; i < text.length; i += 37) yield text.slice(i, i + 37); }
const card: Character = { name: 'Keeper', description: '{{char}} greets {{user}}.', personality: 'Patient', scenario: 'A tower', first_mes: 'Welcome, {{user}}.', mes_example: '' };
const connection = { name: 'Synthetic', endpoint: 'http://localhost:1234/v1', model: 'synthetic', contextWindow: 100_000, maxOutputTokens: 100, customParameters: {} };

it('duplicates Connection settings and credentials on the server without exposing the key', async () => {
  const { app, store } = await createApp({ database: join(folder(), 'duplicate-connection.sqlite') });
  let cookie = '';
  const cmd = (url: string, data: unknown) => app.inject({ method: 'POST', url: '/api' + url,
    headers: { host: 'localhost', origin: 'http://localhost', cookie, 'content-type': 'application/json' }, payload: JSON.stringify(data) });
  try {
    const setup = await cmd('/setup', { password: 'synthetic-library-password' });
    cookie = String(setup.headers['set-cookie']).split(';')[0];
    const original = store.saveLibrary(store.libraryRevision(), 'connections', { ...connection, requestUsage: false }, undefined, 'synthetic-copy-secret');
    const revision = store.libraryRevision();
    const copied = await cmd(`/library/connections/${original}/duplicate`, { revision });
    expect(copied.statusCode).toBe(200);
    const id: string = copied.json().id;
    expect(id).not.toBe(original);
    expect(store.connection(id)).toEqual({ ...connection, requestUsage: false, name: 'Synthetic copy' });
    expect(store.connectionApiKey(id)).toBe('synthetic-copy-secret');
    expect(store.libraryRevision()).toBe(revision + 1);
    const publicLibrary = await app.inject({ method: 'GET', url: '/api/library', headers: { host: 'localhost', cookie } });
    expect(publicLibrary.json().connections.find((item: { id: string }) => item.id === id).hasApiKey).toBe(true);
    expect(publicLibrary.body + copied.body).not.toContain('synthetic-copy-secret');
    expect((await cmd(`/library/connections/${original}/duplicate`, { revision })).statusCode).toBe(409);
    expect(store.libraryRevision()).toBe(revision + 1);
    expect((await cmd(`/library/connections/${randomUUID()}/duplicate`, { revision: store.libraryRevision() })).statusCode).toBe(404);
    const beforeFailure = store.libraries();
    store.sqlite.exec("CREATE TRIGGER reject_copied_key BEFORE INSERT ON credentials WHEN NEW.api_key = 'synthetic-copy-secret' BEGIN SELECT RAISE(ABORT, 'synthetic credential write failure'); END");
    expect((await cmd(`/library/connections/${original}/duplicate`, { revision: store.libraryRevision() })).statusCode).toBe(500);
    expect(store.libraries()).toEqual(beforeFailure);
    store.sqlite.exec('DROP TRIGGER reject_copied_key');
    const withoutKey = store.saveLibrary(store.libraryRevision(), 'connections', connection);
    const emptyCopy = await cmd(`/library/connections/${withoutKey}/duplicate`, { revision: store.libraryRevision() });
    expect(emptyCopy.statusCode).toBe(200);
    expect(store.connectionApiKey(emptyCopy.json().id)).toBe('');
    store.saveLibrary(store.libraryRevision(), 'connections', { ...connection, name: 'Changed original' }, original, 'changed-secret');
    expect(store.connectionApiKey(id)).toBe('synthetic-copy-secret');
    expect(store.connection(id).name).toBe('Synthetic copy');
  } finally { await app.close(); }
});

it('exposes current character assignments in full and incremental chat lists', () => {
  const store = new Store(join(folder(), 'chat-characters.sqlite'));
  try {
    const characterId = store.saveLibrary(store.libraryRevision(), 'characters', card);
    const settings = { title: 'Portrait story', targetInputTokens: 32_000, connectionId: null, promptId: 'default', characterId, personaId: null };
    const id = store.createChat(settings);
    const otherId = store.createChat({ ...settings, title: 'Unassigned story', characterId: null });
    expect(store.libraries().chats.find(chat => chat.id === id)?.characterId).toBe(characterId);
    expect(store.libraries().chats.find(chat => chat.id === otherId)?.characterId).toBeNull();
    const revision = store.libraryRevision();
    store.updateChat(store.snapshot(id).revision, id, { ...settings, characterId: null });
    const update = store.libraryUpdate(revision);
    expect(update).toMatchObject({ unchanged: true, revision });
    expect(update.chats.find(chat => chat.id === id)?.characterId).toBeNull();
    store.updateChat(store.snapshot(id).revision, id, settings);
    expect(store.libraryUpdate(revision).chats.find(chat => chat.id === id)?.characterId).toBe(characterId);
  } finally { store.close(); }
});

it('supplies the repair prompt for older saved and imported presets without rewriting stored versions', () => {
  const store = new Store(join(folder(), 'old-context.sqlite'));
  try {
    const id = store.saveLibrary(store.libraries().revision, 'contexts', { ...defaultContextPreset, name: 'Older context' });
    store.sqlite.prepare("UPDATE library SET data = json_remove(data, '$.repairPrompt') WHERE id = ?").run(id);
    const row = store.sqlite.prepare('SELECT data, revision FROM library WHERE id = ?').get(id);
    const revision = store.libraries().revision;
    expect(store.contextPreset(id)?.repairPrompt).toBe(defaultContextPreset.repairPrompt);
    expect(store.libraries().contexts.find(preset => preset.id === id)?.repairPrompt).toBe(defaultContextPreset.repairPrompt);
    expect(store.sqlite.prepare('SELECT data, revision FROM library WHERE id = ?').get(id)).toEqual(row);
    expect(store.libraries().revision).toBe(revision);
    const { repairPrompt: _, ...oldImport } = defaultContextPreset;
    expect(contextPresetSchema.parse(oldImport).repairPrompt).toBe(defaultContextPreset.repairPrompt);
    expect(() => contextPresetSchema.parse({ ...defaultContextPreset, repairPrompt: '   ' })).toThrow();
  } finally { store.close(); }
});

describe('cards, macros and prompt arrangement', () => {
  it('round trips basic fields and preserves inactive V2 metadata without using it in prompts', () => {
    const source = { spec: 'chara_card_v2', spec_version: '2.0', data: { ...card, character_book: { entries: [{ content: 'INACTIVE LORE' }] }, extensions: { custom: 'kept' }, creator_notes: 'NOT PROMPT', system_prompt: 'NOT AUTOMATIC' } };
    const imported = importCharacter(source);
    const result = exportCharacter({ ...imported, description: 'Edited' });
    expect(result.data).toMatchObject({ description: 'Edited', character_book: source.data.character_book, extensions: { custom: 'kept' } });
    expect(importPersonas(exportPersona({ name: 'Traveller', description: 'A visitor' }))).toEqual([{ name: 'Traveller', description: 'A visitor' }]);
    expect(importCharacter({ name: 'Legacy' }).first_mes).toBe('');
    expect(() => importCharacter({ ...source, spec: 'unknown' })).toThrow('Only legacy');
  });
  it('decodes a PNG card chunk and rejects malformed imports', () => {
    const payload = Buffer.from('chara\0' + Buffer.from(JSON.stringify({ ...card })).toString('base64'));
    const chunk = Buffer.alloc(payload.length + 12); chunk.writeUInt32BE(payload.length); chunk.write('tEXt', 4); payload.copy(chunk, 8);
    const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk]);
    expect(importCharacter(readCardFile(png.toString('base64'))).name).toBe('Keeper');
    expect(() => readCardFile(png.subarray(0, 14).toString('base64'))).toThrow();
    expect(() => readCardFile(Buffer.from('invalid JSON').toString('base64'))).toThrow('valid card JSON');
  });
  it('imports V3 basic fields, prefers ccv3 PNG metadata, and retains V3 extras through editing and export', () => {
    const source = { spec: 'chara_card_v3', spec_version: '3.0', data: { ...card, name: 'V3 Keeper', nickname: 'Kept nickname', group_only_greetings: ['Kept greeting'], assets: [{ type: 'icon', uri: 'ccdefault:', name: 'main', ext: 'png' }], extensions: { custom: true } } };
    const chunk = (keyword: string, value: unknown, type: string) => {
      const text = Buffer.from(Buffer.from(JSON.stringify(value)).toString('base64'));
      const payload = Buffer.concat([Buffer.from(keyword + '\0'), type === 'zTXt' ? Buffer.concat([Buffer.from([0]), deflateSync(text)]) : type === 'iTXt' ? Buffer.concat([Buffer.from([1, 0, 0, 0]), deflateSync(text)]) : text]);
      const result = Buffer.alloc(payload.length + 12); result.writeUInt32BE(payload.length); result.write(type, 4); payload.copy(result, 8); return result;
    };
    for (const type of ['tEXt', 'zTXt', 'iTXt']) {
      for (const reversed of [false, true]) {
        const chunks = [chunk('chara', card, 'tEXt'), chunk('ccv3', source, type)];
        const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ...(reversed ? chunks.reverse() : chunks)]);
        const imported = importCharacter(readCardFile(png.toString('base64')));
        expect(imported.name).toBe('V3 Keeper');
        const exported = exportCharacter({ ...imported, description: 'Edited V3 description' });
        expect(exported).toMatchObject({ spec: 'chara_card_v3', spec_version: '3.0', data: { ...source.data, description: 'Edited V3 description' } });
        expect(importCharacter(exported).description).toBe('Edited V3 description');
      }
    }
    expect(importCharacter(readCardFile(Buffer.from(JSON.stringify(source)).toString('base64'))).name).toBe('V3 Keeper');
  });
  it('resolves name tags once, arranges roles, preserves transcript text, and measures the resolved request', () => {
    expect(replaceNameMacros('{{User}} {{ CHAR }} {{unknown}}', '$&{{char}}', 'Keeper')).toBe('$&{{char}} Keeper {{unknown}}');
    const store = new Store(':memory:');
    try {
      const personaId = store.saveLibrary(store.libraries().revision, 'personas', { name: 'Traveller', description: '{{user}} visits {{char}}.' });
      const characterId = store.saveLibrary(store.libraries().revision, 'characters', card);
      const connectionId = store.saveLibrary(store.libraries().revision, 'connections', connection, undefined, 'synthetic-library-api-key-7319');
      const prompt = { name: 'Ordered', blocks: [
        { id: 'persona', name: 'Persona', enabled: true, kind: 'marker' as const, role: 'user' as const, marker: 'persona' as const },
        { id: 'char', name: 'Character', enabled: true, kind: 'marker' as const, role: 'system' as const, marker: 'character' as const },
        defaultPrompt.blocks.find(block => block.id === 'messages')!,
        { id: 'after', name: 'After', enabled: true, kind: 'text' as const, role: 'system' as const, text: '{{char}} replies to {{user}}.' },
      ] };
      const promptId = store.saveLibrary(store.libraries().revision, 'prompts', prompt);
      const id = store.createChat({ title: 'Tower', targetInputTokens: 32_000, connectionId, promptId, characterId, personaId });
      const snapshot = store.snapshot(id);
      expect(snapshot.turns[0]).toMatchObject({ complete: true, user: { text: '' }, assistant: { text: 'Welcome, Traveller.' } });
      const request = assembleRequest(snapshot.connection!, snapshot.settings, [...snapshot.turns, { ...snapshot.turns[0], complete: false, user: { ...snapshot.turns[0].user, text: 'Literal {{char}}' } }], snapshot.sources);
      expect(request.body.messages[0]).toEqual({ role: 'user', content: 'Traveller visits Keeper.' });
      expect(request.body.messages[1].content).toBe('Keeper');
      expect(request.body.messages[2]).toEqual({ role: 'system', content: 'Keeper greets Traveller.' });
      expect(request.body.messages.slice(-2)).toEqual([{ role: 'user', content: 'Literal {{char}}' }, { role: 'system', content: 'Keeper replies to Traveller.' }]);
      expect(JSON.stringify(store.libraries())).not.toContain('synthetic-library-api-key-7319');
      store.saveLibrary(store.libraries().revision, 'characters', { ...card, first_mes: 'Different greeting' }, characterId);
      expect(store.snapshot(id).turns[0].assistant.text).toBe('Welcome, Traveller.');
      expect(promptSchema.parse({ name: 'Missing history', blocks: [defaultPrompt.blocks[0]] }).blocks).toHaveLength(1);
      expect(promptSchema.parse({ name: 'Empty', blocks: [] }).blocks).toEqual([]);
      expect(() => promptSchema.parse({ ...defaultPrompt, blocks: [...defaultPrompt.blocks, { ...defaultPrompt.blocks.find(block => block.id === 'messages')!, id: 'duplicate' }] })).toThrow('Messages marker');
    } finally { store.close(); }
  });
});

describe('alternate character greetings', () => {
  it.each(['legacy', 'chara_card_v2', 'chara_card_v3'])('imports and exports editable alternatives from %s cards', spec => {
    const fields = { ...card, alternate_greetings: ['Second {{user}}.', 'Third {{char}}.'] };
    const source = spec === 'legacy' ? fields : { spec, spec_version: spec === 'chara_card_v3' ? '3.0' : '2.0', data: fields };
    const imported = importCharacter(source);
    expect(imported).toMatchObject({ alternate_greetings: fields.alternate_greetings });
    const edited = characterSchema.parse({ ...imported, alternate_greetings: ['Edited greeting.'] });
    expect(exportCharacter(edited).data).toMatchObject({ alternate_greetings: ['Edited greeting.'] });
    expect(exportCharacter({ ...edited, alternate_greetings: [] }).data).toMatchObject({ alternate_greetings: [] });
    expect(() => importCharacter({ ...fields, alternate_greetings: ['Valid', 42] })).toThrow();
    expect(() => characterSchema.parse({ ...fields, alternate_greetings: 'Invalid' })).toThrow();
    expect(() => characterSchema.parse({ ...fields, alternate_greetings: ['x'.repeat(100_001)] })).toThrow();
    expect(() => characterSchema.parse({ ...fields, alternate_greetings: Array.from({ length: 1001 }, () => '') })).toThrow();
  });

  it('copies old preserved card alternatives once, keeps distinct provenance, and persists selections', () => {
    const path = join(folder(), 'greetings.sqlite');
    let store = new Store(path);
    try {
      const characterId = store.saveLibrary(store.libraryRevision(), 'characters', card);
      // Simulate a card imported before alternate greetings became editable.
      const old = { ...card, source: { spec: 'chara_card_v3', data: { ...card, alternate_greetings: ['\nSecond {{USER}} from {{char}}.\n', 'Third greeting.', 'Third greeting.'] } } };
      store.sqlite.prepare('UPDATE library SET data = ? WHERE id = ?').run(JSON.stringify(old), characterId);
      const personaId = store.saveLibrary(store.libraryRevision(), 'personas', { name: 'Traveller', description: '' });
      const create = () => store.createChat({ title: 'Greetings', targetInputTokens: 32_000, connectionId: null, promptId: 'default', characterId, personaId });
      const chatId = create();
      const opening = store.snapshot(chatId).turns[0];
      expect(opening.variants?.map(variant => variant.text)).toEqual(['Welcome, Traveller.', 'Second Traveller from Keeper.', 'Third greeting.', 'Third greeting.']);
      expect(opening).toMatchObject({ complete: true, user: { text: '' }, assistant: { text: 'Welcome, Traveller.' } });
      expect(opening.variants?.every(variant => variant.generationId === null)).toBe(true);
      const [first, second, third, duplicate] = opening.variants ?? [];
      if (!first || !second || !third || !duplicate) throw new Error('Missing greeting variants');
      expect(new Set([first.sourceRevision, second.sourceRevision, third.sourceRevision]).size).toBe(3);
      expect(duplicate.sourceRevision).toBe(third.sourceRevision);
      const memory: SummaryNode = { id: 'greeting-memory', revision: 0, level: 1, text: 'Traveller was welcomed.', turns: [sourceOf(opening)], children: [], prior: [], approved: true, manual: false, createdAt: '' };
      const context = { ...store.snapshot(chatId).context, summaries: [memory] };
      store.selectVariant(store.snapshot(chatId).revision, opening.id, second.id, chatId);
      expect(staleSummaries(store.snapshot(chatId).turns, context).size).toBe(1);
      store.selectVariant(store.snapshot(chatId).revision, opening.id, first.id, chatId);
      expect(staleSummaries(store.snapshot(chatId).turns, context).size).toBe(0);
      store.editPart(store.snapshot(chatId).revision, opening.id, 'assistant', 'Edited first.', chatId);
      expect(store.snapshot(chatId).turns[0].assistant.sourceRevision).toBeGreaterThan(Math.max(...(opening.variants ?? []).map(variant => variant.sourceRevision)));
      store.selectVariant(store.snapshot(chatId).revision, opening.id, second.id, chatId);
      expect(store.snapshot(chatId).turns[0].assistant.text).toBe('Second Traveller from Keeper.');
      const selected = store.snapshot(chatId);
      const request = assembleRequest(connection, selected.settings, selected.turns, selected.sources);
      expect(request.body.messages.filter(message => message.role === 'assistant')).toEqual([{ role: 'assistant', content: 'Second Traveller from Keeper.' }]);
      expect(request.coverage).toHaveLength(1);
      // Card edits affect future chats, including explicit removal, without changing saved variants.
      store.saveLibrary(store.libraryRevision(), 'characters', { ...old, alternate_greetings: ['New alternative.'] }, characterId);
      store.saveLibrary(store.libraryRevision(), 'characters', old, characterId);
      expect(store.snapshot(create()).turns[0].variants?.map(variant => variant.text)).toEqual(['Welcome, Traveller.', 'New alternative.']);
      store.saveLibrary(store.libraryRevision(), 'characters', { ...old, alternate_greetings: [] }, characterId);
      expect(store.snapshot(create()).turns[0].variants).toHaveLength(1);
      const before = store.snapshot(chatId);
      store.close(); store = new Store(path);
      expect(store.snapshot(chatId)).toEqual(before);
      expect(store.snapshot(chatId).generations).toEqual([]);
      expect(store.sqlite.pragma('foreign_key_check')).toEqual([]);
    } finally { store.close(); }
  });

  it('uses the first nonblank greeting when the primary is empty, and creates no turn when all are blank', () => {
    const store = new Store(':memory:');
    try {
      const create = (first_mes: string, alternate_greetings: string[]) => {
        const characterId = store.saveLibrary(store.libraryRevision(), 'characters', { ...card, first_mes, alternate_greetings });
        return store.snapshot(store.createChat({ title: 'Blank greetings', targetInputTokens: 32_000, connectionId: null, promptId: 'default', characterId, personaId: null }));
      };
      expect(create('', ['\n  \n', 'Hello {{user}}.', 'Another.']).turns[0]).toMatchObject({ assistant: { text: 'Hello You.' }, variants: [{ text: 'Hello You.' }, { text: 'Another.' }] });
      expect(create('\n ', [' ', '\n']).turns).toEqual([]);
    } finally { store.close(); }
  });

  it.each([{ alternatives: [] }, { alternatives: ['Existing alternative.'] }])('keeps source revisions when an editor exposes unchanged alternatives $alternatives', ({ alternatives }) => {
    const store = new Store(':memory:');
    try {
      const original = { ...card, source: { ...card, alternate_greetings: alternatives } };
      const characterId = store.saveLibrary(store.libraryRevision(), 'characters', original);
      const chatId = store.createChat({ title: 'Unchanged greetings', targetInputTokens: 32_000, connectionId: null, promptId: 'default', characterId, personaId: null });
      const before = store.snapshot(chatId), libraryBefore = store.libraries();
      store.saveLibrary(store.libraryRevision(), 'characters', { ...original, alternate_greetings: alternatives, titleComment: 'Local label' }, characterId);
      const after = store.snapshot(chatId);
      expect(after.revision).toBe(before.revision);
      expect(after.turns).toEqual(before.turns);
      expect(after.sources.character?.revision).toBe(before.sources.character?.revision);
      expect(store.libraries().characters.find(character => character.id === characterId)?.revision).toBe(libraryBefore.characters.find(character => character.id === characterId)?.revision);
      expect(store.libraryRevision()).toBe(libraryBefore.revision + 1);
      store.saveLibrary(store.libraryRevision(), 'characters', { ...original, alternate_greetings: ['Changed alternative.'] }, characterId);
      expect(store.snapshot(chatId).revision).toBeGreaterThan(before.revision);
      expect(store.snapshot(chatId).turns).toEqual(before.turns);
    } finally { store.close(); }
  });

  it('preserves malformed old metadata on unrelated saves/exports until explicit correction', () => {
    const store = new Store(':memory:');
    try {
      const characterId = store.saveLibrary(store.libraryRevision(), 'characters', card);
      const old = { ...card, source: { spec: 'chara_card_v2', data: { ...card, alternate_greetings: ['Valid text', 17], extensions: { retained: true } } } };
      store.sqlite.prepare('UPDATE library SET data = ? WHERE id = ?').run(JSON.stringify(old), characterId);
      store.saveLibrary(store.libraryRevision(), 'characters', { ...old, description: 'Unrelated edit.' }, characterId);
      const saved = store.libraries().characters.find(character => character.id === characterId);
      if (!saved) throw new Error('Missing legacy character');
      expect(saved.source).toEqual(old.source);
      const { id: _id, revision: _revision, ...fields } = saved;
      expect(exportCharacter(fields).data).toMatchObject({ alternate_greetings: ['Valid text', 17], extensions: { retained: true } });
      const create = () => store.createChat({ title: 'Invalid alternatives', targetInputTokens: 32_000, connectionId: null, promptId: 'default', characterId, personaId: null });
      expect(create).toThrow('Open the character editor');
      store.saveLibrary(store.libraryRevision(), 'characters', { ...fields, alternate_greetings: [] }, characterId);
      expect(store.snapshot(create()).turns[0].variants).toHaveLength(1);
      expect(exportCharacter({ ...fields, alternate_greetings: [] }).data).toMatchObject({ alternate_greetings: [] });
    } finally { store.close(); }
  });

  it('rolls back chat creation if any alternate variant cannot be saved', () => {
    const store = new Store(':memory:');
    try {
      const characterId = store.saveLibrary(store.libraryRevision(), 'characters', importCharacter({ ...card, alternate_greetings: ['Rejected alternative.'] }));
      const before = store.libraries();
      store.sqlite.exec("CREATE TRIGGER reject_greeting BEFORE INSERT ON response_variants WHEN NEW.text = 'Rejected alternative.' BEGIN SELECT RAISE(ABORT, 'synthetic greeting failure'); END");
      expect(() => store.createChat({ title: 'Rollback', targetInputTokens: 32_000, connectionId: null, promptId: 'default', characterId, personaId: null })).toThrow('synthetic greeting failure');
      expect(store.libraries()).toEqual(before);
      expect(store.sqlite.prepare('SELECT * FROM turns').all()).toEqual([]);
      expect(store.sqlite.prepare('SELECT * FROM response_variants').all()).toEqual([]);
    } finally { store.close(); }
  });
});

describe('prompt template upgrade', () => {
  it.each([false, true])('upgrades only an untouched old default (customized: %s), retaining saved records', customized => {
    const path = join(folder(), 'template.sqlite');
    let store = new Store(path);
    const legacy = { ...legacyLorePrompt, blocks: legacyLorePrompt.blocks.filter(block => block.id !== 'summary' && !block.marker?.startsWith('lore_')) };
    const data = customized ? { ...legacy, name: 'My default' } : legacy;
    store.sqlite.prepare('UPDATE library SET data = ? WHERE id = ?').run(JSON.stringify(data), 'default');
    const customId = store.saveLibrary(store.libraries().revision, 'prompts', { ...upgradePrompt(legacy), name: 'Custom legacy prompt' });
    store.sqlite.prepare('UPDATE library SET data = ? WHERE id = ?').run(JSON.stringify({ ...legacy, name: 'Custom legacy prompt' }), customId);
    const before = store.snapshot(), library = store.libraries();
    store.sqlite.exec('DROP TABLE character_pictures; DROP TABLE picture_assets; DROP TRIGGER tagged_character_kind; DROP TABLE character_tags; DROP TABLE tags');
    store.sqlite.pragma('user_version = 4');
    removeVariantSchema(store.sqlite);
    store.close(); store = new Store(path);
    try {
      const builtIn = store.libraries().prompts.find(prompt => prompt.id === 'default')!;
      expect(builtIn.blocks).toEqual(customized ? upgradePrompt(data).blocks : legacyRoleplayPrompt.blocks);
      expect(builtIn.name).toBe(data.name);
      expect(builtIn.revision).toBe(library.prompts.find(prompt => prompt.id === 'default')!.revision + 1 + 2 * Number(!customized));
      expect(store.snapshot().revision).toBe(before.revision + 1 + 2 * Number(!customized));
      expect(store.snapshot().turns).toEqual(before.turns);
      expect(store.snapshot().generations).toEqual(before.generations);
      expect(store.libraries().prompts.find(prompt => prompt.id === customId)!.blocks).toEqual(upgradePrompt(legacy).blocks);
      expect(store.sqlite.pragma('user_version', { simple: true })).toBe(15);
    } finally { store.close(); }
  });
});

describe('continuity prompt upgrade', () => {
  it.each(['neither', 'extraction', 'promotion', 'both'] as const)('preserves customized fields (%s) and upgrades old factory fields once', customized => {
    const path = join(folder(), 'context-upgrade.sqlite');
    let store = new Store(path);
    const extractionPrompt = customized === 'extraction' || customized === 'both' ? 'My extraction rules.' : legacyContextPrompts.extractionPrompt;
    const promotionPrompt = customized === 'promotion' || customized === 'both' ? 'My promotion rules.' : legacyContextPrompts.promotionPrompt;
    const preset = { ...defaultContextPreset, name: 'My settings', minTail: 13, summaryTokens: 321, extractionPrompt, promotionPrompt, repairPrompt: 'My repair rules.' };
    const id = store.saveLibrary(store.libraries().revision, 'contexts', preset, 'default-context');
    const chatId = store.createChat({ title: 'Preserved', targetInputTokens: 32_000, connectionId: null, promptId: 'default', characterId: null, personaId: null, contextPresetId: id });
    store.replaceHistory(store.snapshot(chatId).revision, chatId, [{ user: 'Mira kept the key.', assistant: 'Leon promised to return.', complete: true }]);
    const before = store.snapshot(chatId), unrelated = store.snapshot(), library = store.libraries();
    const changed = customized !== 'both';
    store.sqlite.exec('DROP TABLE character_pictures; DROP TABLE picture_assets; DROP TRIGGER tagged_character_kind; DROP TABLE character_tags; DROP TABLE tags');
    store.sqlite.pragma('user_version = 5');
    removeVariantSchema(store.sqlite);
    store.close(); store = new Store(path);
    try {
      expect(store.contextPreset(id)).toEqual({ ...preset, id,
        revision: library.contexts.find(item => item.id === id)!.revision + Number(changed),
        extractionPrompt: extractionPrompt === legacyContextPrompts.extractionPrompt ? defaultContextPreset.extractionPrompt : extractionPrompt,
        promotionPrompt: promotionPrompt === legacyContextPrompts.promotionPrompt ? defaultContextPreset.promotionPrompt : promotionPrompt,
      });
      expect(store.snapshot(chatId)).toEqual({ ...before, revision: before.revision + Number(changed), context: { ...before.context, preset: store.contextPreset(id) } });
      expect(store.snapshot()).toEqual(unrelated);
      expect(store.libraries().revision).toBe(library.revision + Number(changed) + 3);
      expect(store.sqlite.pragma('user_version', { simple: true })).toBe(15);
      if (changed) expect(() => store.checkRevision(before.revision, chatId)).toThrow('changed on another device');
      const upgraded = store.snapshot(chatId), upgradedLibrary = store.libraries();
      store.close(); store = new Store(path);
      expect(store.snapshot(chatId)).toEqual(upgraded);
      expect(store.libraries()).toEqual(upgradedLibrary);
    } finally { store.close(); }
  });

  it('rolls back prompt and revision updates together if an upgrade write fails', () => {
    const path = join(folder(), 'context-rollback.sqlite');
    const store = new Store(path);
    store.saveLibrary(store.libraries().revision, 'contexts', { ...defaultContextPreset, ...legacyContextPrompts }, 'default-context');
    const before = legacyRows(store.sqlite, 'library');
    const libraryRevision = store.libraries().revision;
    store.sqlite.exec("CREATE TRIGGER reject_prompt_upgrade BEFORE UPDATE ON library_state BEGIN SELECT RAISE(ABORT, 'synthetic upgrade failure'); END");
    store.sqlite.exec('DROP TABLE character_pictures; DROP TABLE picture_assets; DROP TRIGGER tagged_character_kind; DROP TABLE character_tags; DROP TABLE tags');
    store.sqlite.pragma('user_version = 5');
    removeVariantSchema(store.sqlite);
    store.close();
    expect(() => new Store(path)).toThrow('synthetic upgrade failure');
    const db = new Database(path);
    try {
      expect(db.pragma('user_version', { simple: true })).toBe(5);
      expect(legacyRows(db, 'library')).toEqual(before);
      expect(db.prepare('SELECT revision FROM library_state WHERE id = 1').get()).toEqual({ revision: libraryRevision });
      expect(db.prepare('SELECT * FROM runtime_owner').all()).toEqual([]);
      db.exec('DROP TRIGGER reject_prompt_upgrade');
    } finally { db.close(); }
    const recovered = new Store(path);
    try { expect(recovered.contextPreset('default-context')?.extractionPrompt).toBe(defaultContextPreset.extractionPrompt); }
    finally { recovered.close(); }
  });
});

describe('history replacement', () => {
  it('allows deletion of the original and final chat without recreating it on restart', () => {
    const path = join(folder(), 'deleted.sqlite'); let store = new Store(path);
    try {
      store.replaceHistory(0, 'main', [{ user: 'Synthetic', assistant: 'History', complete: true }]);
      expect(() => store.deleteChat(0, 'main')).toThrow('changed on another device');
      store.deleteChat(store.snapshot().revision, 'main');
      expect(store.libraries().chats).toEqual([]);
      store.close(); store = new Store(path);
      expect(store.libraries().chats).toEqual([]);
      const characterId = store.saveLibrary(store.libraries().revision, 'characters', { ...card, first_mes: '\n\nWelcome.\r\n \n' });
      const id = store.createChat({ title: 'Next story', targetInputTokens: 32_000, connectionId: null, promptId: 'default', characterId, personaId: null });
      expect(store.snapshot(id).turns[0].assistant.text).toBe('Welcome.');
      expect(store.sqlite.pragma('foreign_key_check')).toEqual([]);
    } finally { store.close(); }
  });
  it('preserves order, separate same-speaker messages, blank parts and a final pending user turn', async () => {
    const entries = [ { user_name: 'Visitor', character_name: 'Keeper', chat_metadata: { summary: 'DO NOT IMPORT' } },
      { is_user: false, mes: 'Greeting', extra: { hiddenFromAI: true, advancedMemorySnapshot: 'DO NOT IMPORT' }, swipes: ['Unused'] },
      { is_user: false, mes: 'Another assistant' }, { is_user: true, mes: 'User one' }, { is_user: true, mes: '' }, { is_user: false, mes: '' }, { is_user: true, mes: 'Pending' },
    ];
    const result = await importChat(chunks('\uFEFF' + entries.map(e => JSON.stringify(e)).join('\r\n')));
    expect(result.turns).toEqual([
      { user: '', assistant: 'Greeting', complete: true }, { user: '', assistant: 'Another assistant', complete: true },
      { user: 'User one', assistant: '', complete: true }, { user: '', assistant: '', complete: true }, { user: 'Pending', assistant: '', complete: false },
    ]);
    expect(JSON.stringify(result)).not.toContain('DO NOT IMPORT');
    await expect(importChat(chunks('{"is_user":false,"mes":"ok"}\ninvalid'))).rejects.toThrow('Line 2');
    await expect(importChat(chunks('{"is_user":false,"is_system":true,"mes":"system"}'))).rejects.toThrow('system messages');
  });
  it('replaces only the selected chat, rejects stale writes, and persists the replacement after restart', () => {
    const path = join(folder(), 'test.sqlite'); let store = new Store(path);
    try {
      const id = store.createChat({ title: 'Second', targetInputTokens: 32_000, connectionId: null, promptId: 'default', characterId: null, personaId: null });
      store.replaceHistory(0, 'main', [{ user: 'Original', assistant: 'Saved', complete: true }]);
      store.replaceHistory(0, id, [{ user: '', assistant: 'Imported greeting', complete: true }]);
      expect(store.snapshot('main').turns[0].user.text).toBe('Original');
      expect(() => store.replaceHistory(0, id, [{ user: 'Stale', assistant: '', complete: false }])).toThrow('changed on another device');
      const beforeFailure = store.snapshot(id);
      expect(() => store.replaceHistory(beforeFailure.revision, id, [{ user: 'Pending one', assistant: '', complete: false }, { user: 'Pending two', assistant: '', complete: false }])).toThrow();
      expect(store.snapshot(id)).toEqual(beforeFailure);
      const savedId = store.snapshot(id).turns[0].id;
      store.close(); store = new Store(path);
      expect(store.snapshot(id).turns[0].id).toBe(savedId);
      expect(store.snapshot('main').turns[0].user.text).toBe('Original');
    } finally { store.close(); }
  });
  it('migrates version 1 without losing identities, revision state, credentials or generation records', () => {
    const path = join(folder(), 'old.sqlite'); const db = new Database(path);
    db.exec(readFileSync('migrations/0001_initial.sql', 'utf8')); db.pragma('user_version = 1');
    db.prepare('INSERT INTO chats VALUES (?, ?, ?)').run('main', 4, JSON.stringify({ title: 'Old story', instructions: 'Old instructions', character: 'Old character', persona: 'Old persona', targetInputTokens: 32_000 }));
    db.prepare('INSERT INTO connections VALUES (?, ?)').run('main', JSON.stringify(connection));
    db.prepare('INSERT INTO credentials VALUES (?, ?)').run('main', 'old-secret');
    db.prepare('INSERT INTO turns VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('old-turn', 1, 1, 'old-user', 2, 'Saved input', 'old-assistant', 3, 'Saved response');
    db.prepare('INSERT INTO generations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('old-generation', 'old-request', '{}', 'old-turn', 'succeeded', 3, null, 'Saved response', null, '2026-10-16', '2026-10-16');
    db.close();
    const store = new Store(path);
    try {
      expect(store.snapshot()).toMatchObject({ revision: 4, turns: [{ id: 'old-turn', user: { id: 'old-user', revision: 2 }, assistant: { id: 'old-assistant', revision: 3 } }], generations: [{ id: 'old-generation', usage: null }] });
      expect(store.snapshot().sources.character?.description).toBe('Old character'); expect(store.apiKey()).toBe('old-secret');
      expect(store.sqlite.pragma('foreign_key_check')).toEqual([]);
      store.updateChat(4, 'main', { title: 'Old story', targetInputTokens: 32_000, connectionId: 'main', promptId: 'default', characterId: null, personaId: null });
      const cleared = store.snapshot();
      expect(assembleRequest(cleared.connection!, cleared.settings, cleared.turns, cleared.sources).body.messages).not.toContainEqual({ role: 'system', content: 'Old character' });
      expect(cleared.settings.character).toBe(''); expect(cleared.settings.persona).toBe('');
    } finally { store.close(); }
  });
});

it('keeps simultaneous chat generations and secrets isolated, blocks shared edits, and atomically clears old request records on replacement', async () => {
  const mock = await startMockProvider();
  const { app, store } = await createApp({ database: join(folder(), 'api.sqlite') });
  let cookie = '';
  async function cmd(url: string, data: unknown, method: 'POST' | 'PUT' | 'DELETE' = 'POST') { return app.inject({ method, url: '/api' + url, headers: { host: 'localhost', origin: 'http://localhost', 'content-type': 'application/json', cookie }, payload: JSON.stringify(data) }); }
  try {
    cookie = (await cmd('/setup', { password: 'synthetic-library-password' })).headers['set-cookie']!.toString().split(';')[0];
    const first = await cmd('/library', { kind: 'connections', revision: store.libraries().revision, data: { ...connection, endpoint: mock.url }, apiKey: 'isolated-one' }); expect(first.statusCode).toBe(200);
    const second = await cmd('/library', { kind: 'connections', revision: store.libraries().revision, data: { ...connection, endpoint: mock.url, model: 'second-model' }, apiKey: 'isolated-two' });
    const ids: string[] = [];
    for (const connectionId of [first.json().id, second.json().id]) ids.push((await cmd('/chats', { title: 'Isolated', targetInputTokens: 32_000, connectionId, promptId: 'default', characterId: null, personaId: null })).json().id);
    mock.setMode('hold');
    for (const id of ids) expect((await cmd(`/chats/${id}/turns`, { revision: 0, requestId: randomUUID(), text: id })).statusCode).toBe(202);
    await expect.poll(() => mock.requests.length).toBe(2);
    expect(new Set(mock.requests.map(r => r.authorization))).toEqual(new Set(['Bearer isolated-one', 'Bearer isolated-two']));
    expect((await cmd('/library', { kind: 'personas', revision: store.libraries().revision, data: { name: 'Blocked', description: '' } })).statusCode).toBe(409);
    expect((await cmd(`/chats/${ids[0]}/history`, { revision: store.snapshot(ids[0]).revision, turns: [{ user: '', assistant: 'Replacement', complete: true }] }, 'PUT')).statusCode).toBe(409);
    mock.finishAll(); await expect.poll(() => ids.every(id => store.snapshot(id).turns[0].complete)).toBe(true);
    expect((await cmd(`/chats/${ids[0]}/history`, { revision: store.snapshot(ids[0]).revision, turns: [{ user: '', assistant: 'Replacement', complete: true }] }, 'PUT')).statusCode).toBe(200);
    expect(store.snapshot(ids[0]).generations).toHaveLength(0); expect(store.snapshot(ids[1]).generations).toHaveLength(1);
    const before = store.snapshot(ids[0]);
    expect((await cmd(`/chats/${ids[0]}/history`, { revision: before.revision, turns: [{ user: 'Bad', assistant: '', complete: false }, { user: '', assistant: 'Bad', complete: true }] }, 'PUT')).statusCode).toBe(400);
    expect(store.snapshot(ids[0])).toEqual(before);
  } finally { await app.close(); await mock.close(); }
});
