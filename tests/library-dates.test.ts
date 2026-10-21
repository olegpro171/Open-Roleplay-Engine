import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, cpSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Store } from '../src/persistence/store.js';
import { removeSortingSchema } from './support/legacy-sorting.js';
import { defaultPrompt } from '../src/shared/library.js';
import { defaultContextPreset } from '../src/shared/context.js';
import { newLorebook } from '../src/shared/lorebook.js';

const initial = '2026-01-01T00:00:00.000Z';
const later = '2026-01-02T00:00:00.000Z';
const latest = '2026-01-03T00:00:00.000Z';
const card = { name: 'Guide', description: '', personality: '', scenario: '', first_mes: '', mes_example: '' };
const model = { name: 'Mock', endpoint: 'http://localhost:9999/v1', model: 'synthetic', contextWindow: 32000, maxOutputTokens: 1000, customParameters: {} };
afterEach(() => vi.useRealTimers());

it('records creation and edits for every reusable library, preserving added dates and no-op character saves', () => {
  vi.useFakeTimers(); vi.setSystemTime(initial);
  const store = new Store(':memory:');
  try {
    const fixtures = [
      { kind: 'characters', data: card }, { kind: 'personas', data: { name: 'Player', description: '' } },
      { kind: 'prompts', data: defaultPrompt }, { kind: 'contexts', data: defaultContextPreset },
      { kind: 'connections', data: model }, { kind: 'lorebooks', data: newLorebook() },
    ] as const;
    for (const fixture of fixtures) {
      vi.setSystemTime(initial);
      const id = store.saveLibrary(store.libraryRevision(), fixture.kind, fixture.data);
      expect(store.libraries().dates[id]).toEqual({ createdAt: initial, updatedAt: null });
      vi.setSystemTime(later);
      store.saveLibrary(store.libraryRevision(), fixture.kind, { ...fixture.data, name: 'Changed' }, id);
      expect(store.libraries().dates[id]).toEqual({ createdAt: initial, updatedAt: later });
      vi.setSystemTime(latest);
      expect(() => store.saveLibrary(-1, fixture.kind, fixture.data, id)).toThrow();
      expect(store.libraries().dates[id]?.updatedAt).toBe(later);
    }
    const id = store.saveLibrary(store.libraryRevision(), 'characters', card);
    vi.setSystemTime('2026-01-04T00:00:00.000Z');
    store.saveLibrary(store.libraryRevision(), 'characters', card, id);
    expect(store.libraries().dates[id]).toEqual({ createdAt: latest, updatedAt: null });
    store.saveLibrary(store.libraryRevision(), 'characters', { ...card, titleComment: 'Local label' }, id);
    expect(store.libraries().dates[id]?.updatedAt).toBe('2026-01-04T00:00:00.000Z');
  } finally { store.close(); }
});

it('tracks committed messages without moving chats for edits, retries, checkpoints or failed responses', () => {
  vi.useFakeTimers(); vi.setSystemTime(initial);
  const store = new Store(':memory:');
  try {
    const connectionId = store.saveLibrary(store.libraryRevision(), 'connections', model);
    const id = store.createChat({ title: 'Story', targetInputTokens: 32000, promptId: 'default', connectionId, characterId: null, personaId: null });
    const chat = () => store.libraries().chats.find(chat => chat.id === id);
    expect(chat()).toMatchObject({ createdAt: initial, lastMessageAt: null });
    vi.setSystemTime(later);
    const request = store.begin(store.snapshot(id).revision, randomUUID(), 'Hello', id);
    expect(chat()?.lastMessageAt).toBe(later);
    vi.setSystemTime(latest);
    store.checkpoint(request.id, 'Partial');
    store.finish(request.id, 'failed', 'Partial', 'Synthetic failure');
    expect(chat()?.lastMessageAt).toBe(later);
    const retryId = randomUUID();
    const retry = store.begin(store.snapshot(id).revision, retryId, undefined, id);
    expect(chat()?.lastMessageAt).toBe(later);
    store.finish(retry.id, 'succeeded', 'Welcome');
    expect(chat()?.lastMessageAt).toBe(latest);
    vi.setSystemTime('2026-01-04T00:00:00.000Z');
    const turn = store.snapshot(id).turns[0];
    store.editPart(store.snapshot(id).revision, turn.id, 'assistant', 'Edited response', id);
    expect(chat()?.lastMessageAt).toBe(latest);
    expect(store.begin(0, retryId, undefined, id)).toEqual({ id: retry.id, fresh: false });
    expect(chat()?.lastMessageAt).toBe(latest);
    store.deleteTurn(store.snapshot(id).revision, turn.id, id);
    expect(chat()?.lastMessageAt).toBeNull();
    store.replaceHistory(store.snapshot(id).revision, id, [{ user: 'Imported', assistant: 'Saved', complete: true }]);
    expect(chat()?.lastMessageAt).toBe('2026-01-04T00:00:00.000Z');
    const unchanged = store.libraryUpdate(store.libraryRevision());
    expect(unchanged.chats.find(chat => chat.id === id)?.lastMessageAt).toBe('2026-01-04T00:00:00.000Z');
  } finally { store.close(); }
});

it('upgrades populated schema13 without changing history, keeps unknown dates and rolls back a failed upgrade', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ore-sort-migration-'));
  const path = join(directory, 'story.sqlite');
  try {
    const seed = new Store(path);
    const cid = seed.saveLibrary(seed.libraryRevision(), 'characters', card);
    seed.replaceHistory(seed.snapshot().revision, 'main', [{ user: 'Original', assistant: 'Intact', complete: true }]);
    seed.saveSettings(seed.snapshot().revision, model, seed.snapshot().settings);
    const generated = seed.begin(seed.snapshot().revision, randomUUID(), 'A saved request');
    seed.finish(generated.id, 'succeeded', 'Saved response');
    const knownMessageDate = seed.generation(generated.id)?.updatedAt;
    const snapshot = seed.snapshot();
    seed.close();
    const old = new Database(path);
    removeSortingSchema(old); old.pragma('user_version=13'); old.close();
    const migrations = join(directory, 'migrations');
    cpSync('migrations', migrations, { recursive: true });
    writeFileSync(join(migrations, '0014_library_sorting.sql'), 'ALTER TABLE library ADD COLUMN created_at TEXT; INVALID SQL;');
    expect(() => new Store(path, migrations)).toThrow();
    const failed = new Database(path);
    expect(failed.pragma('user_version', { simple: true })).toBe(13);
    expect(failed.prepare('SELECT * FROM runtime_owner').all()).toEqual([]);
    expect(failed.prepare('PRAGMA table_info(library)').all()).not.toContainEqual(expect.objectContaining({ name: 'created_at' }));
    failed.close();
    const upgraded = new Store(path);
    expect(upgraded.snapshot()).toEqual(snapshot);
    expect(upgraded.libraries().chats.find(chat => chat.id === 'main')?.lastMessageAt).toBe(knownMessageDate);
    expect(upgraded.libraries().dates[cid]).toEqual({ createdAt: null, updatedAt: null });
    const dates = upgraded.libraries().dates;
    upgraded.close();
    const reopened = new Store(path);
    expect(reopened.snapshot()).toEqual(snapshot);
    expect(reopened.libraries().dates).toEqual(dates);
    reopened.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it('dates successful regeneration while keeping cancellations and version selection out of message recency', () => {
  vi.useFakeTimers(); vi.setSystemTime(initial);
  const store = new Store(':memory:');
  try {
    const connectionId = store.saveLibrary(store.libraryRevision(), 'connections', model);
    const characterId = store.saveLibrary(store.libraryRevision(), 'characters', { ...card, first_mes: 'An opening greeting' });
    const id = store.createChat({ title: 'Greetings', targetInputTokens: 32000, promptId: 'default', connectionId, characterId, personaId: null });
    const activity = () => store.libraries().chats.find(chat => chat.id === id)?.lastMessageAt;
    expect(activity()).toBe(initial);
    const first = store.snapshot(id).turns[0];
    vi.setSystemTime(later);
    const cancelled = store.beginRegeneration(store.snapshot(id).revision, randomUUID(), first.id, id);
    store.finish(cancelled.id, 'cancelled', 'Discarded partial');
    expect(store.finish(cancelled.id, 'succeeded', 'Late result')).toBe(false);
    expect(activity()).toBe(initial);
    const replacement = store.beginRegeneration(store.snapshot(id).revision, randomUUID(), first.id, id);
    store.finish(replacement.id, 'succeeded', 'A new greeting');
    expect(activity()).toBe(later);
    vi.setSystemTime(latest);
    const original = store.snapshot(id).turns[0].variants?.[0];
    if (!original) throw new Error('Missing original greeting variant');
    store.selectVariant(store.snapshot(id).revision, first.id, original.id, id);
    expect(activity()).toBe(later);
    const response = store.begin(store.snapshot(id).revision, randomUUID(), 'The next turn', id);
    store.finish(response.id, 'succeeded', 'A later response');
    expect(activity()).toBe(latest);
    const last = store.snapshot(id).turns.at(-1);
    if (!last) throw new Error('Missing second turn');
    store.deleteTurn(store.snapshot(id).revision, last.id, id);
    expect(activity()).toBe(later);
  } finally { store.close(); }
});

it('dates direct and reviewed tag assignment changes without marking no-op assignments as edits', () => {
  vi.useFakeTimers(); vi.setSystemTime(initial);
  const store = new Store(':memory:');
  try {
    const id = store.saveLibrary(store.libraryRevision(), 'characters', { ...card, source: { tags: ['Embedded'] } });
    const tagId = store.tags.create(store.libraryRevision(), 'Assigned');
    vi.setSystemTime(later);
    store.tags.setAssignments(store.libraryRevision(), id, [tagId]);
    expect(store.libraries().dates[id]?.updatedAt).toBe(later);
    vi.setSystemTime(latest);
    store.tags.setAssignments(store.libraryRevision(), id, [tagId]);
    expect(store.libraries().dates[id]?.updatedAt).toBe(later);
    store.tags.applyEmbedded(store.libraryRevision(), id, 'all');
    expect(store.libraries().dates[id]?.updatedAt).toBe(latest);
    expect(store.libraries().dates[id]?.createdAt).toBe(initial);
  } finally { store.close(); }
});
