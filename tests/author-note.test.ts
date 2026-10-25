import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assembleRequest } from '../src/core/prompt.js';
import { contextPlan, summaryRequest } from '../src/core/context-plan.js';
import { sourceOf } from '../src/core/context.js';
import { promptDiagnostics } from '../src/core/prompt-diagnostics.js';
import { countInput } from '../src/core/tokens.js';
import { resolveLore } from '../src/core/lorebook.js';
import { Store } from '../src/persistence/store.js';
import { createApp } from '../src/server/app.js';
import { authorNoteSchema, defaultAuthorNote, type AuthorNote, type AuthorNoteStatus } from '../src/shared/author-note.js';
import { emptyContextState, defaultContextPreset } from '../src/shared/context.js';
import type { PromptBlock, PromptSources } from '../src/shared/library.js';
import type { RequestPreview, Turn } from '../src/shared/contracts.js';
import { newLorebook, newLoreEntry } from '../src/shared/lorebook.js';
import { SettingsAutosave } from '../src/web/settings-autosave.js';
import { authorNoteRequest } from '../src/web/useAuthorNote.js';

const connection = { name: 'Synthetic', endpoint: 'http://localhost/v1', model: 'synthetic', contextWindow: 10000, maxOutputTokens: 100, customParameters: {} };
const settings = { title: 'Story', instructions: '', character: '', persona: '', targetInputTokens: 5000 };
const messages: PromptBlock = { id: 'messages', name: 'Messages', enabled: true, kind: 'marker', marker: 'messages', role: 'system', allowDepthPrompt: false };
const closing: PromptBlock = { id: 'closing', name: 'Closing', enabled: true, kind: 'text', role: 'system', text: 'After history' };
const turn = (position: number, user: string, assistant: string, complete = true): Turn => ({
  id: `t${position}`, position, complete,
  user: { id: `u${position}`, revision: 0, text: user }, assistant: { id: `a${position}`, revision: 0, text: assistant },
});
const sources = (blocks: PromptBlock[] = [messages, closing]): PromptSources => ({ prompt: { id: 'preset', revision: 0, name: 'Preset', blocks }, character: null, persona: null });
const note = { prompt: 'Keep the key secret.', role: 'system' as const, depth: 2 };
const disposers: (() => void | Promise<void>)[] = [];
afterEach(async () => { vi.useRealTimers(); vi.unstubAllGlobals(); for (const dispose of disposers.splice(0).reverse()) await dispose(); });

describe('Author’s note request composition', () => {
  it.each([
    [0, ['U', 'A', 'Pending', note.prompt, 'After history']],
    [1, ['U', 'A', note.prompt, 'Pending', 'After history']],
    [2, ['U', note.prompt, 'A', 'Pending', 'After history']],
    [1000, [note.prompt, 'U', 'A', 'Pending', 'After history']],
  ])('counts outgoing messages at depth %i, including pending input', (depth, expected) => {
    const request = assembleRequest(connection, { ...settings, authorNote: { ...note, depth } }, [turn(1, 'U', 'A'), turn(2, 'Pending', '', false)], sources());
    expect(request.body.messages.map(part => part.content)).toEqual(expected);
    expect(request.layout?.find(part => part.label.startsWith('Author’s note'))?.kind).toBe('prompt');
    expect(request.coverage).toHaveLength(2);
  });

  it.each(['system', 'user', 'assistant'] as const)('supports %s role and resolves names once without interpreting original', role => {
    const input = { ...sources(), character: { id: 'c', revision: 0, name: '{{user}}', description: '', personality: '', scenario: '', first_mes: '', mes_example: '' }, persona: { id: 'p', revision: 0, name: 'Leon', description: '' } };
    const request = assembleRequest(connection, { ...settings, authorNote: { ...note, prompt: '{{char}} greets {{user}}. {{original}}', role } }, [], input);
    expect(request.body.messages[0]).toEqual({ role, content: '{{user}} greets Leon. {{original}}' });
  });

  it('places the note after lore and the character note at a shared clamped position', async () => {
    const book = { ...newLorebook(), id: 'book', revision: 0, entries: [{ ...newLoreEntry('entry'), constant: true, content: 'Lore', placement: 'history' as const, depth: 1000 }] };
    const input: PromptSources = { ...sources([{ ...messages, allowDepthPrompt: true }, closing]), lorebook: book,
      character: { id: 'c', revision: 0, name: 'Mira', description: '', personality: '', scenario: '', first_mes: '', mes_example: '', depth_prompt: { prompt: 'Card note', depth: 1000, role: 'system' } } };
    const turns = [turn(1, '', 'A'), turn(2, '  ', '', false)];
    const lore = await resolveLore({ book, sources: input, turns, state: { epoch: 0, entries: {} } }, async () => ({ matched: false }));
    const result = assembleRequest(connection, { ...settings, authorNote: { ...note, depth: 1000 } }, turns, input, undefined, { lore });
    expect(result.body.messages.map(part => part.content)).toEqual(['Lore', 'Card note', note.prompt, 'A', '  ', 'After history']);
    const withoutPermission = assembleRequest(connection, { ...settings, authorNote: note }, [], sources());
    expect(withoutPermission.body.messages[0].content).toBe(note.prompt);
  });

  it('omits blank notes, warns for absent/disabled Messages, and never falls back to another location', () => {
    for (const blocks of [[closing], [{ ...messages, enabled: false }, closing]]) {
      const request = assembleRequest(connection, { ...settings, authorNote: note }, [], sources(blocks));
      expect(request.body.messages).toEqual([{ role: 'system', content: 'After history' }]);
      expect(request.warningMessages?.at(-1)?.key).toBe('author_note.messages_missing');
      expect(promptDiagnostics(sources(blocks), note)).toMatchObject([{ code: 'author_note_messages_missing', target: 'prompts' }]);
    }
    expect(assembleRequest(connection, { ...settings, authorNote: { ...note, prompt: ' \n ' } }, [], sources()).body.messages).toEqual([{ role: 'system', content: 'After history' }]);
  });

  it('counts the note before selecting whole recent turns, including exact target and physical boundaries', () => {
    const input = sources();
    const turns = [turn(1, 'Old '.repeat(30), 'Old response '.repeat(30)), turn(2, 'Recent', 'Reply')];
    const exact = countInput([{ role: 'user', content: 'Recent' }, { role: 'system', content: note.prompt }, { role: 'assistant', content: 'Reply' }, { role: 'system', content: 'After history' }]).inputTokens;
    const request = assembleRequest(connection, { ...settings, targetInputTokens: exact, authorNote: { ...note, depth: 1 } }, turns, input);
    expect(request.history?.verbatimTurnIds).toEqual(['t2']);
    expect(request.budget.inputTokens).toBe(exact);
    expect(request.body.messages.map(part => part.content)).toEqual(['Recent', note.prompt, 'Reply', 'After history']);
    const required = [turn(3, 'Recent', '', false)];
    expect(() => assembleRequest(connection, { ...settings, targetInputTokens: 1, authorNote: note }, required, input)).toThrow('exceeds your target');
    expect(() => assembleRequest({ ...connection, contextWindow: 101 }, { ...settings, authorNote: note }, required, input)).toThrow('reserved output exceeds');
  });

  it('keeps managed coverage unchanged and excludes the note from summary-model requests', () => {
    const store = new Store(':memory:'); disposers.push(() => store.close());
    store.saveSettings(0, connection, settings);
    const contextId = store.saveLibrary(store.libraryRevision(), 'contexts', { ...defaultContextPreset, minTail: 1, batchSize: 1 });
    const chatId = store.createChat({ title: 'Managed', targetInputTokens: 5000, connectionId: 'main', promptId: 'default', characterId: null, personaId: null, contextPresetId: contextId });
    store.replaceHistory(store.snapshot(chatId).revision, chatId, [{ user: 'First', assistant: 'Reply', complete: true }, { user: 'Second', assistant: 'Reply', complete: true }]);
    const before = store.snapshot(chatId);
    store.saveAuthorNote(chatId, { revision: before.revision, settings: note });
    const after = store.snapshot(chatId);
    expect(after.context).toEqual(before.context);
    expect(after.turns).toEqual(before.turns);
    const assembled = assembleRequest(connection, after.settings, after.turns, after.sources, after.context);
    expect(contextPlan(after).inputTokens).toBe(assembled.budget.inputTokens);
    const summary = summaryRequest(after, { level: 1, turnIds: [after.turns[0].id], children: [] }, connection);
    expect(JSON.stringify(summary.request.body)).not.toContain(note.prompt);
    const managed = assembleRequest(connection, { ...settings, authorNote: note }, [turn(1, 'U', 'A')], sources([
      { id: 'summary', name: 'Memory', kind: 'marker', marker: 'summary', role: 'system', enabled: true }, messages,
    ]), emptyContextState());
    expect(managed.history?.verbatimTurnIds).toEqual(['t1']);
  });

  it('counts depth only against the managed verbatim tail, preserving selected memory', () => {
    const turns = [turn(1, 'Archived user', 'Archived reply'), turn(2, 'Recent user', 'Recent reply')];
    const memory = { id: 'saved', revision: 0, level: 1, turns: [sourceOf(turns[0])], children: [], prior: [], text: 'Saved facts', createdAt: '', approved: true, manual: false };
    const context = { ...emptyContextState(), selected: [{ id: memory.id, revision: 0 }], archivedTurnIds: ['t1'], summaries: [memory] };
    const request = assembleRequest(connection, { ...settings, authorNote: { ...note, depth: 1000 } }, turns, sources([
      { id: 'summary', name: 'Memory', kind: 'marker', marker: 'summary', role: 'system', enabled: true }, messages,
    ]), context);
    expect(request.body.messages.map(part => part.content)).toEqual(['[Memory L1 · turns 1–1]\nSaved facts', note.prompt, 'Recent user', 'Recent reply']);
    expect(request.context).toEqual({ selected: [{ id: 'saved', revision: 0 }], archivedTurnIds: ['t1'] });
    expect(request.coverage).toEqual(turns.map(sourceOf));
  });
});

it('preserves populated chats and immutable requests through note writes, rollback, old-client saves and restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ore-author-note-'));
  disposers.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'test.sqlite');
  const store = new Store(path);
  store.saveSettings(0, connection, settings);
  const before = store.snapshot();
  expect(store.authorNote('main')).toEqual({ revision: before.revision, settings: defaultAuthorNote });
  const operation = store.begin(before.revision, randomUUID(), 'Continue');
  const running = store.snapshot();
  const request = assembleRequest(connection, running.settings, running.turns, running.sources, running.context);
  store.saveRequest(operation.id, request);
  expect(() => store.saveAuthorNote('main', { revision: running.revision, settings: note })).toThrow('current response');
  store.finish(operation.id, 'succeeded', 'Saved reply');
  const current = store.snapshot();
  const saved = store.saveAuthorNote('main', { revision: current.revision, settings: note });
  expect(() => store.saveAuthorNote('main', { revision: current.revision, settings: defaultAuthorNote })).toThrow('changed on another device');
  expect(store.saveAuthorNote('main', saved)).toEqual(saved);
  store.sqlite.exec("CREATE TEMP TRIGGER reject_note BEFORE UPDATE ON chats BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END");
  expect(() => store.saveAuthorNote('main', { ...saved, settings: { ...note, prompt: 'Rejected' } })).toThrow('synthetic write failure');
  expect(store.authorNote('main')).toEqual(saved);
  store.sqlite.exec('DROP TRIGGER reject_note');
  store.saveSettings(saved.revision, connection, { ...settings, title: 'Old client title' });
  expect(store.snapshot().settings.authorNote).toEqual(note);
  expect(store.snapshot().turns).toEqual(current.turns);
  expect(store.snapshot().generations[0].request).toEqual(request);
  const final = store.snapshot(); store.close();
  const reopened = new Store(path); disposers.push(() => reopened.close());
  expect(reopened.snapshot()).toEqual(final);
});

it('validates HTTP writes, enforces authentication/operation ownership, and sends the saved note only to roleplay', async () => {
  const calls: RequestPreview[] = [];
  const { app, store, coordinator } = await createApp({ database: ':memory:', provider: { async stream(request, _key, _signal, onText) { calls.push(request); onText('Reply'); return { finishReason: 'stop' }; } } });
  disposers.push(() => app.close());
  const auth = await app.inject({ method: 'POST', url: '/api/setup', headers: { host: 'localhost', origin: 'http://localhost' }, payload: { password: 'author-note-test-password' } });
  const headers = { host: 'localhost', origin: 'http://localhost', cookie: String(auth.headers['set-cookie']).split(';')[0] };
  const url = '/api/chats/main/author-note';
  expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
  store.saveSettings(0, connection, settings, 'SYNTHETIC-NOTE-SECRET');
  const initial = store.authorNote('main');
  for (const invalid of [{ ...note, depth: -1 }, { ...note, depth: 1001 }, { ...note, depth: 1.5 }, { ...note, role: 'tool' }, { ...note, prompt: 'x'.repeat(100001) }]) {
    expect(authorNoteSchema.safeParse(invalid).success).toBe(false);
    expect((await app.inject({ method: 'PUT', url, headers, payload: { revision: initial.revision, settings: invalid } })).statusCode).toBe(400);
  }
  const write = await app.inject({ method: 'PUT', url, headers, payload: { revision: initial.revision, settings: note } });
  expect(write.statusCode).toBe(200);
  expect(write.body).not.toContain('SYNTHETIC-NOTE-SECRET');
  const saved = store.authorNote('main');
  expect((await app.inject({ method: 'PUT', url, headers, payload: initial })).statusCode).toBe(409);
  const other = store.createChat({ title: 'Other', targetInputTokens: 5000, connectionId: 'main', promptId: 'default', characterId: null, personaId: null });
  const held = store.begin(store.snapshot(other).revision, randomUUID(), 'Other pending', other);
  expect((await app.inject({ method: 'PUT', url, headers, payload: saved })).statusCode).toBe(200);
  store.finish(held.id, 'cancelled', '');
  const started = coordinator.start(saved.revision, randomUUID(), 'Continue', 'main');
  await vi.waitFor(() => expect(store.generation(started.generationId)?.status).toBe('succeeded'));
  expect(calls).toHaveLength(1);
  expect(calls[0].body.messages.filter(part => part.content === note.prompt)).toEqual([{ role: 'system', content: note.prompt }]);
  const contextId = store.saveLibrary(store.libraryRevision(), 'contexts', defaultContextPreset);
  store.updateChat(store.snapshot().revision, 'main', { title: 'Story', targetInputTokens: 5000, connectionId: 'main', promptId: 'default', characterId: null, personaId: null, contextPresetId: contextId });
  store.contexts.begin('main', store.snapshot().revision, randomUUID(), 'step');
  expect((await app.inject({ method: 'PUT', url, headers, payload: store.authorNote('main') })).statusCode).toBe(409);
});

it('releases the send gate after success, no-op, failure reconciliation and explicit retry', async () => {
  let saved = { revision: 0, settings: defaultAuthorNote };
  let fail = true;
  const editor = new SettingsAutosave<AuthorNote, AuthorNoteStatus>(saved, {
    read: async () => saved,
    write: async input => {
      saved = { revision: input.revision + 1, settings: input.settings };
      if (fail) throw new Error('Lost acknowledgement');
      return saved;
    }, committed: () => {},
  });
  editor.update({ prompt: note.prompt });
  expect(editor.getSnapshot().pending).toBe(true);
  await vi.waitFor(() => expect(editor.getSnapshot().saving).toBe(false));
  expect(editor.getSnapshot().pending).toBe(true);
  await editor.retry();
  expect(editor.getSnapshot()).toMatchObject({ pending: false, error: null });
  fail = false;
  editor.update({ prompt: '' });
  await vi.waitFor(() => expect(editor.getSnapshot().pending).toBe(false));
  editor.update({ prompt: '' });
  await vi.waitFor(() => expect(editor.getSnapshot().pending).toBe(false));
});

it('times out an unresponsive note save and clears its timer for recovery', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('window', { setTimeout, clearTimeout, dispatchEvent: vi.fn() });
  vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
  })));
  const request = authorNoteRequest('/chats/main/author-note', { revision: 0, settings: note });
  const assertion = expect(request).rejects.toThrow('timed out');
  await vi.advanceTimersByTimeAsync(15000);
  await assertion;
  expect(vi.getTimerCount()).toBe(0);
});

it('keeps a reverted edit pending until an ambiguous earlier write is reconciled', async () => {
  let saved = { revision: 0, settings: defaultAuthorNote };
  let rejectFirst: (error: Error) => void = () => {};
  const first = new Promise<AuthorNoteStatus>((_resolve, reject) => { rejectFirst = reject; });
  const write = vi.fn(async (input: AuthorNoteStatus) => {
    saved = { revision: input.revision + 1, settings: input.settings };
    return write.mock.calls.length === 1 ? first : saved;
  });
  const editor = new SettingsAutosave<AuthorNote, AuthorNoteStatus>(saved, { read: async () => saved, write, committed: () => {} });
  editor.update({ prompt: 'Possibly committed.' });
  editor.update({ prompt: '' });
  rejectFirst(new Error('Lost acknowledgement'));
  await vi.waitFor(() => expect(editor.getSnapshot().saving).toBe(false));
  expect(editor.getSnapshot().draft).toEqual(defaultAuthorNote);
  expect(saved.settings.prompt).toBe('Possibly committed.');
  expect(editor.getSnapshot().pending).toBe(true);
  expect(editor.getSnapshot().pendingChanges).toEqual({ prompt: '' });
  await editor.retry();
  expect(saved.settings).toEqual(defaultAuthorNote);
  expect(editor.getSnapshot().pending).toBe(false);
  expect(write).toHaveBeenCalledTimes(2);
});
