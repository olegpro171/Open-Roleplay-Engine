import { removeSortingSchema } from './support/legacy-sorting.js';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, cpSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { Store } from '../src/persistence/store.js';
import { GenerationCoordinator } from '../src/server/coordinator.js';
import type { Provider } from '../src/provider/openai.js';
import { assembleRequest } from '../src/core/prompt.js';

const connection = { name: 'Synthetic', endpoint: 'http://localhost/v1', model: 'mock', contextWindow: 32000, maxOutputTokens: 1000, customParameters: {} };

it.each([false, true])('upgrades a populated schema 11 without rewriting existing data (rollback: %s)', failMigration => {
  const directory = mkdtempSync(join(tmpdir(), 'ore-reasoning-migration-'));
  const filename = join(directory, 'chat.sqlite');
  let store = new Store(filename);
  try {
    store.saveSettings(store.snapshot().revision, connection, store.snapshot().settings, 'synthetic-secret');
    const completed = store.begin(store.snapshot().revision, randomUUID(), 'First turn.');
    const current = store.snapshot();
    store.saveRequest(completed.id, assembleRequest(connection, current.settings, current.turns, current.sources));
    store.finish(completed.id, 'succeeded', 'A saved response.', null, { inputTokens: 10, outputTokens: 4, totalTokens: 14 });
    const pending = store.begin(store.snapshot().revision, randomUUID(), 'Pending input.');
    store.finish(pending.id, 'cancelled', 'Partial response.', 'Cancelled by user.');
    const before = store.snapshot();
    store.sqlite.exec('ALTER TABLE generations DROP COLUMN reasoning_text');
    removeSortingSchema(store.sqlite);
    store.sqlite.pragma('user_version = 11');
    const tables = ['chats', 'turns', 'response_variants', 'generations', 'library', 'credentials'];
    const rows = Object.fromEntries(tables.map(table => [table, store.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
    store.close();
    if (failMigration) {
      const migrations = join(directory, 'migrations');
      cpSync(resolve('migrations'), migrations, { recursive: true });
      appendFileSync(join(migrations, '0012_reasoning.sql'), '\nSELECT * FROM synthetic_missing_table;');
      expect(() => new Store(filename, migrations)).toThrow('synthetic_missing_table');
      const old = new Database(filename);
      try {
        expect(old.pragma('user_version', { simple: true })).toBe(11);
        expect(Object.fromEntries(tables.map(table => [table, old.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))).toEqual(rows);
      } finally { old.close(); }
    }
    store = new Store(filename);
    expect(store.sqlite.pragma('user_version', { simple: true })).toBe(15);
    expect(store.snapshot()).toEqual(before);
    expect(store.generation(completed.id)?.reasoningText).toBe('');
    expect(store.generation(pending.id)?.reasoningText).toBe('');
    expect(store.apiKey()).toBe('synthetic-secret');
    expect(store.sqlite.pragma('foreign_key_check')).toEqual([]);
    store.close(); store = new Store(filename);
    expect(store.snapshot()).toEqual(before);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
}, 30000);

it('rejects late reasoning after cancellation and keeps it isolated to its saved attempt', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ore-reasoning-cancel-'));
  const store = new Store(join(directory, 'chat.sqlite'));
  let release = () => {};
  let reasoning: ((text: string) => void) | undefined;
  const provider: Provider = { async stream(_request, _key, _signal, onText, onReasoning) {
    reasoning = onReasoning;
    onReasoning?.('Original thought.');
    await new Promise<void>(resolve => { release = resolve; });
    onReasoning?.('Late thought.'); onText('Late reply.');
    return { finishReason: 'stop' };
  } };
  store.saveSettings(store.snapshot().revision, connection, store.snapshot().settings);
  const coordinator = new GenerationCoordinator(store, provider);
  try {
    const { generationId } = coordinator.start(store.snapshot().revision, randomUUID(), 'I enter.');
    await expect.poll(() => coordinator.reasoningText(generationId)).toBe('Original thought.');
    coordinator.cancel(generationId);
    reasoning?.('Another late thought.'); release();
    await expect.poll(() => coordinator.reasoningText(generationId)).toBe('');
    expect(store.generation(generationId)).toMatchObject({ status: 'cancelled', partialText: '', reasoningText: 'Original thought.' });
    expect(store.snapshot().turns[0].complete).toBe(false);
  } finally {
    release(); await coordinator.shutdown(); store.close(); rmSync(directory, { recursive: true, force: true });
  }
});
