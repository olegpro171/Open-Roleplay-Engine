import { legacyRows, removeVariantSchema } from './support/legacy-variants.js';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/persistence/store.js';
import { legacyLorePrompt } from '../src/persistence/legacy-prompt.js';
import { upgradePrompt } from '../src/core/prompt-upgrade.js';
import { assembleRequest } from '../src/core/prompt.js';
import { resolveLore } from '../src/core/lorebook.js';
import { defaultPrompt } from '../src/shared/library.js';
import { newLorebook, newLoreEntry } from '../src/shared/lorebook.js';

const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });
const preservedTables = ['turns', 'generations', 'connections', 'credentials', 'context_states', 'summaries', 'context_jobs', 'context_steps', 'lore_epochs', 'lore_states', 'lore_operations', 'lore_commands'];
function rows(db: Database.Database) { return Object.fromEntries(preservedTables.map(table => [table, legacyRows(db, table)])); }
async function seed() {
  const folder = mkdtempSync(join(tmpdir(), 'ore-prompt-migration-'));
  folders.push(folder);
  const path = join(folder, 'chat.sqlite'), store = new Store(path);
  const connection = { name: 'Synthetic', endpoint: 'http://localhost/v1', model: 'synthetic', contextWindow: 10000, maxOutputTokens: 100, customParameters: {} };
  const connectionId = store.saveLibrary(store.libraries().revision, 'connections', connection, undefined, 'synthetic-secret');
  const characterId = store.saveLibrary(store.libraries().revision, 'characters', { name: 'Mira', description: 'Keeper', personality: 'Patient', scenario: 'Tower', mes_example: '', first_mes: '' });
  const lorebookId = store.saveLibrary(store.libraries().revision, 'lorebooks', { ...newLorebook(), entries: [{ ...newLoreEntry('entry'), content: 'Lore', constant: true }] });
  const custom = { ...legacyLorePrompt, name: 'Custom order and roles', blocks: [...legacyLorePrompt.blocks].reverse().map(block => ({ ...block, role: 'assistant', ...(block.id === 'lore-after' ? { enabled: false } : {}) })) };
  const promptId = store.saveLibrary(store.libraries().revision, 'prompts', upgradePrompt(custom));
  const chatId = store.createChat({ title: 'Preserved story', targetInputTokens: 5000, connectionId, promptId, characterId, personaId: null, lorebookId });
  const operation = store.begin(store.snapshot(chatId).revision, randomUUID(), 'Original input', chatId);
  const snapshot = store.snapshot(chatId);
  if (!snapshot.sources.lorebook) throw new Error('Missing fixture book.');
  const lore = await resolveLore({ book: snapshot.sources.lorebook, turns: snapshot.turns, sources: snapshot.sources, state: snapshot.loreState ?? { epoch: 0, entries: {} } }, async () => ({ matched: false }));
  const assembled = assembleRequest(connection, snapshot.settings, snapshot.turns, snapshot.sources, undefined, { lore });
  const historicalLore = { ...lore, outcomes: lore.outcomes.map(outcome => outcome.destination ? { ...outcome, destination: { ...outcome.destination, controlId: 'lore-after' } } : outcome) };
  const request = { ...assembled, lore: historicalLore };
  store.saveLoreOperation(chatId, operation.id, historicalLore);
  store.saveRequest(operation.id, request);
  store.finish(operation.id, 'succeeded', 'Saved response', null);
  expect(Object.values(store.loreState(chatId, lorebookId).entries).map(entry => entry.matches)).toEqual([1]);
  const untouched = store.saveLibrary(store.libraries().revision, 'prompts', { name: 'Text only', blocks: [defaultPrompt.blocks[0]] });
  store.sqlite.prepare('UPDATE library SET data = ? WHERE id = ?').run(JSON.stringify(custom), promptId);
  const before = store.snapshot(chatId), library = store.libraries(), preserved = rows(store.sqlite);
  store.sqlite.exec('DROP TABLE character_pictures; DROP TABLE picture_assets; DROP TRIGGER tagged_character_kind; DROP TABLE character_tags; DROP TABLE tags');
  store.sqlite.pragma('user_version = 7');
  removeVariantSchema(store.sqlite);
  store.close();
  return { path, chatId, promptId, custom, before, library, preserved, untouched };
}

describe('version 8 prompt migration', () => {
  it('removes retired controls and selects all fields once, preserving history, state and unrelated records', async () => {
    const f = await seed();
    let store = new Store(f.path);
    try {
      const preset = store.libraries().prompts.find(prompt => prompt.id === f.promptId);
      expect(preset).toEqual({ ...upgradePrompt(f.custom), id: f.promptId, revision: 1 });
      expect(store.snapshot(f.chatId)).toEqual({ ...f.before, revision: f.before.revision + 1, sources: { ...f.before.sources, prompt: preset } });
      expect(rows(store.sqlite)).toEqual(f.preserved);
      expect(store.libraries().prompts.find(prompt => prompt.id === f.untouched)).toEqual(f.library.prompts.find(prompt => prompt.id === f.untouched));
      expect(store.libraries().revision).toBe(f.library.revision + 3);
      expect(() => store.checkRevision(f.before.revision, f.chatId)).toThrow('changed on another device');
      expect(store.sqlite.pragma('user_version', { simple: true })).toBe(12);
      const after = store.snapshot(f.chatId), libraryAfter = store.libraries();
      store.close(); store = new Store(f.path);
      expect(store.snapshot(f.chatId)).toEqual(after);
      expect(store.libraries()).toEqual(libraryAfter);
    } finally { store.close(); }
  });

  it('rolls back presets and revisions on failure and permits a safe restart', async () => {
    const f = await seed(), db = new Database(f.path);
    const libraryBefore = db.prepare('SELECT * FROM library ORDER BY id').all(), chatsBefore = db.prepare('SELECT * FROM chats ORDER BY id').all();
    db.exec("CREATE TRIGGER reject_prompt_migration BEFORE UPDATE ON library_state BEGIN SELECT RAISE(ABORT, 'synthetic prompt failure'); END");
    db.close();
    expect(() => new Store(f.path)).toThrow('synthetic prompt failure');
    const failed = new Database(f.path);
    try {
      expect(failed.pragma('user_version', { simple: true })).toBe(7);
      expect(failed.prepare('SELECT * FROM library ORDER BY id').all()).toEqual(libraryBefore);
      expect(failed.prepare('SELECT * FROM chats ORDER BY id').all()).toEqual(chatsBefore);
      expect(failed.prepare('SELECT revision FROM library_state WHERE id = 1').get()).toEqual({ revision: f.library.revision });
      expect(rows(failed)).toEqual(f.preserved);
      expect(failed.prepare('SELECT * FROM runtime_owner').all()).toEqual([]);
      failed.exec('DROP TRIGGER reject_prompt_migration');
    } finally { failed.close(); }
    const recovered = new Store(f.path);
    try { expect(recovered.sqlite.pragma('user_version', { simple: true })).toBe(12); expect(rows(recovered.sqlite)).toEqual(f.preserved); }
    finally { recovered.close(); }
  });

  it('accepts old prompt exports but rejects unknown sources, invalid retired controls and invalid field choices', () => {
    expect(upgradePrompt(legacyLorePrompt)).toEqual(defaultPrompt);
    expect(() => upgradePrompt({ ...legacyLorePrompt, blocks: [...legacyLorePrompt.blocks, { ...legacyLorePrompt.blocks[1], marker: 'unknown' }] })).toThrow();
    expect(() => upgradePrompt({ ...legacyLorePrompt, blocks: [{ ...legacyLorePrompt.blocks[1], role: 'root' }] })).toThrow();
    expect(() => upgradePrompt({ ...legacyLorePrompt, blocks: [{ ...defaultPrompt.blocks[1], fields: ['first_mes'] }] })).toThrow();
  });
});
