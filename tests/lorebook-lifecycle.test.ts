import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/persistence/store.js';
import { GenerationCoordinator } from '../src/server/coordinator.js';
import { resolveRequestLore } from '../src/server/lore-resolution.js';
import type { Provider } from '../src/provider/openai.js';
import type { RequestPreview } from '../src/shared/contracts.js';
import { newLorebook, newLoreEntry } from '../src/shared/lorebook.js';
import { createApp } from '../src/server/app.js';
import { defaultContextPreset } from '../src/shared/context.js';

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of disposers.splice(0)) await dispose(); });
function fixture(content = '@@dont_activate_after_match\nThe key opens the observatory.') {
  const directory = mkdtempSync(join(tmpdir(), 'ore-lore-life-'));
  const filename = join(directory, 'state.sqlite');
  let store = new Store(filename);
  const calls: RequestPreview[] = [];
  let mode: 'normal' | 'fail' | 'hold' = 'normal';
  let release: (() => void) | undefined;
  const provider: Provider = { async stream(request, _key, signal, onText) {
    calls.push(structuredClone(request));
    if (mode === 'fail') throw new Error('Synthetic transport failure');
    if (mode === 'hold') await new Promise<void>(resolve => {
      release = resolve;
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
    onText('The keeper returns the key.');
    return { finishReason: 'stop' };
  } };
  const connectionId = store.saveLibrary(store.libraries().revision, 'connections', { name: 'Synthetic', endpoint: 'http://localhost:1234/v1', model: 'synthetic', contextWindow: 10_000, maxOutputTokens: 100, customParameters: {} }, undefined, 'synthetic-lore-secret');
  const bookId = store.saveLibrary(store.libraries().revision, 'lorebooks', { ...newLorebook(), entries: [{ ...newLoreEntry(randomUUID()), placement: 'history', name: 'Observatory', keys: ['key'], content }] });
  const chatId = store.createChat({ title: 'Stateful lore', connectionId, promptId: 'default', characterId: null, personaId: null, lorebookId: bookId, targetInputTokens: 9000 });
  let coordinator = new GenerationCoordinator(store, provider);
  const snapshot = () => store.snapshot(chatId);
  const book = () => store.libraries().lorebooks.find(book => book.id === bookId);
  const matches = () => Object.values(store.loreState(chatId, bookId).entries)[0]?.matches ?? 0;
  const idle = async (id: string) => { await expect.poll(() => store.generation(id)?.status).not.toBe('running'); return store.generation(id); };
  const send = async () => { const result = coordinator.start(snapshot().revision, randomUUID(), 'I examine the key.', chatId); await idle(result.generationId); return result.generationId; };
  const restart = async () => { release?.(); await coordinator.shutdown(); store.close(); store = new Store(filename); coordinator = new GenerationCoordinator(store, provider); };
  disposers.push(async () => { release?.(); await coordinator.shutdown(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { get store() { return store; }, get coordinator() { return coordinator; }, calls, bookId, chatId, snapshot, book, matches, idle, send, restart, setMode(value: typeof mode) { mode = value; }, release() { release?.(); } };
}

it('keeps previews read-only, commits actual admissions exactly once, and resumes state after restart/book switches', async () => {
  const f = fixture();
  for (let index = 0; index < 3; index++) {
    const snapshot = f.snapshot();
    await resolveRequestLore(snapshot, f.coordinator.loreRegex);
  }
  expect(f.matches()).toBe(0);
  const revision = f.snapshot().revision, requestId = randomUUID();
  const first = f.coordinator.start(revision, requestId, 'I examine the key.', f.chatId);
  await f.idle(first.generationId);
  expect(f.matches()).toBe(1);
  expect(f.coordinator.start(revision, requestId, 'I examine the key.', f.chatId)).toEqual(first);
  expect(f.calls).toHaveLength(1);
  await f.send(); expect(f.matches()).toBe(2);
  await f.restart(); expect(f.matches()).toBe(2);
  await f.send(); expect(f.matches()).toBe(2);
  expect(f.calls.at(-1)?.lore?.outcomes[0]).toMatchObject({ status: 'excluded', reason: 'dont_activate_after_match' });
  expect(f.calls.at(-1)?.body.messages.some(message => message.content.includes('observatory'))).toBe(false);
  const before = f.snapshot();
  f.store.updateChat(before.revision, f.chatId, { title: before.settings.title, connectionId: before.settings.connectionId ?? null, promptId: 'default', characterId: null, personaId: null, lorebookId: null, targetInputTokens: 9000 });
  await f.send(); expect(f.matches()).toBe(2);
  const none = f.snapshot();
  f.store.updateChat(none.revision, f.chatId, { title: none.settings.title, connectionId: none.settings.connectionId ?? null, promptId: 'default', characterId: null, personaId: null, lorebookId: f.bookId, targetInputTokens: 9000 });
  await f.send(); expect(f.matches()).toBe(2);
});

it('leaves state unchanged on failure, cancellation and interruption, then advances one successful explicit retry', async () => {
  const f = fixture(); await f.send();
  f.setMode('fail'); const failed = await f.send();
  expect(f.store.generation(failed)?.status).toBe('failed'); expect(f.matches()).toBe(1);
  f.setMode('hold');
  const cancelled = f.coordinator.start(f.snapshot().revision, randomUUID(), undefined, f.chatId).generationId;
  await expect.poll(() => f.calls.length).toBe(3);
  expect(() => f.store.saveLibrary(f.store.libraries().revision, 'lorebooks', newLorebook())).toThrow('current response');
  f.coordinator.cancel(cancelled); f.release();
  await f.idle(cancelled); expect(f.matches()).toBe(1); expect(f.snapshot().turns.at(-1)?.complete).toBe(false);
  const interrupted = f.coordinator.start(f.snapshot().revision, randomUUID(), undefined, f.chatId).generationId;
  await expect.poll(() => f.calls.length).toBe(4);
  await f.restart(); expect(f.store.generation(interrupted)?.status).toBe('interrupted'); expect(f.matches()).toBe(1);
  const calls = f.calls.length;
  await Promise.resolve(); expect(f.calls).toHaveLength(calls);
  f.setMode('normal');
  const retry = f.coordinator.start(f.snapshot().revision, randomUUID(), undefined, f.chatId).generationId;
  await f.idle(retry); expect(f.matches()).toBe(2); expect(f.snapshot().turns.at(-1)?.complete).toBe(true);
});

it('rolls response completion and lore state back together when the state write fails', async () => {
  const f = fixture();
  f.store.sqlite.exec("CREATE TRIGGER reject_lore_state BEFORE INSERT ON lore_states BEGIN SELECT RAISE(ABORT, 'synthetic state failure'); END");
  const id = await f.send();
  expect(f.store.generation(id)?.status).toBe('failed');
  expect(f.matches()).toBe(0);
  expect(f.snapshot().turns.at(-1)).toMatchObject({ complete: false, assistant: { text: '', revision: 0 } });
  f.store.sqlite.exec('DROP TRIGGER reject_lore_state');
  const retry = f.coordinator.start(f.snapshot().revision, randomUUID(), undefined, f.chatId).generationId;
  await f.idle(retry); expect(f.matches()).toBe(1);
});

it('preserves cosmetic state and saved provenance, but resets semantic edit epochs even when edits are reverted', async () => {
  const f = fixture(); const first = await f.send();
  const historical = structuredClone(f.store.generation(first)?.request);
  const original = f.book(); expect(original).toBeDefined(); if (!original) return;
  const { id, revision: _revision, ...editable } = original;
  f.store.saveLibrary(f.store.libraries().revision, 'lorebooks', { ...editable, name: 'Renamed archive', entries: editable.entries.map(entry => ({ ...entry, name: 'Renamed entry', comment: 'Human only' })) }, id);
  expect(f.matches()).toBe(1);
  const renamed = f.book(); if (!renamed) throw new Error('Missing saved book');
  const { id: _id, revision: _rev, ...changed } = renamed;
  f.store.saveLibrary(f.store.libraries().revision, 'lorebooks', { ...changed, entries: changed.entries.map(entry => ({ ...entry, keys: ['different'] })) }, id);
  expect(f.matches()).toBe(0);
  f.store.saveLibrary(f.store.libraries().revision, 'lorebooks', editable, id);
  expect(f.matches()).toBe(0);
  await f.send(); expect(f.matches()).toBe(1);
  expect(f.store.generation(first)?.request).toEqual(historical);
  const state = f.snapshot();
  f.store.editPart(state.revision, state.turns[0].id, 'user', 'A revised key.', f.chatId);
  expect(f.matches()).toBe(0);
  expect(f.snapshot().loreState?.epoch).toBeGreaterThan(state.loreState?.epoch ?? 0);
  expect(f.store.generation(first)?.request).toEqual(historical);
  const current = f.snapshot();
  f.store.updateChat(current.revision, f.chatId, { title: current.settings.title, targetInputTokens: 9000, connectionId: current.settings.connectionId ?? null, promptId: 'default', characterId: null, personaId: null, lorebookId: null });
  f.store.deleteLibrary(f.store.libraries().revision, 'lorebooks', id);
  expect(f.store.generation(first)?.request).toEqual(historical);
});

it('clears preparation provenance with memory while retaining roleplay state and deletes operation data with its turn', async () => {
  const f = fixture(); const generationId = await f.send();
  const contextPresetId = f.store.saveLibrary(f.store.libraries().revision, 'contexts', defaultContextPreset);
  const before = f.snapshot();
  f.store.updateChat(before.revision, f.chatId, { title: before.settings.title, targetInputTokens: 9000, connectionId: before.settings.connectionId ?? null, promptId: 'default', characterId: null, personaId: null, lorebookId: f.bookId, contextPresetId });
  const { jobId } = await f.coordinator.context.startResolved(f.chatId, f.snapshot().revision, randomUUID(), 'prepare');
  await expect.poll(() => f.store.contexts.job(jobId).status).toBe('succeeded');
  expect(f.store.loreOperation(jobId)).not.toBeNull();
  expect(f.store.loreOperation(generationId)).not.toBeNull();
  f.store.contexts.clearMemory(f.chatId, f.snapshot().revision);
  expect(f.matches()).toBe(1);
  expect(f.store.loreOperation(jobId)).toBeNull();
  expect(f.store.loreOperation(generationId)).not.toBeNull();
  expect(f.store.generation(generationId)?.request?.lore?.outcomes[0].status).toBe('admitted');
  const current = f.snapshot();
  f.store.deleteTurn(current.revision, current.turns[0].id, f.chatId);
  expect(f.store.loreOperation(generationId)).toBeNull();
  expect(f.store.generation(generationId)).toBeUndefined();
});

it('rejects a late state delta if the captured selection changed, even when a caller bypasses UI guards', async () => {
  const f = fixture(); f.setMode('hold');
  const id = f.coordinator.start(f.snapshot().revision, randomUUID(), 'The key.', f.chatId).generationId;
  await expect.poll(() => f.calls.length).toBe(1);
  const settings = { ...f.snapshot().settings, lorebookId: null };
  f.store.sqlite.prepare('UPDATE chats SET settings = ? WHERE id = ?').run(JSON.stringify(settings), f.chatId);
  f.release(); await f.idle(id);
  expect(f.store.generation(id)?.status).toBe('failed'); expect(f.matches()).toBe(0); expect(f.snapshot().turns[0].complete).toBe(false);
});

it('serves bounded routine snapshots and fetches exact historical lore on demand without exposing credentials', async () => {
  const f = fixture(); const id = await f.send();
  // A separate temporary app database exercises the authenticated HTTP mapping.
  const instance = await createApp({ database: ':memory:', provider: { async stream(_request, _key, _signal, onText) { onText('Saved response'); return { finishReason: 'stop' }; } } });
  try {
    const setup = await instance.app.inject({ method: 'POST', url: '/api/setup', headers: { host: 'localhost', origin: 'http://localhost' }, payload: { password: 'synthetic-lore-password' } });
    const cookie = String(setup.headers['set-cookie']).split(';')[0];
    const connectionId = instance.store.saveLibrary(instance.store.libraries().revision, 'connections', { name: 'Model', endpoint: 'http://localhost:1234', model: 'synthetic', contextWindow: 10_000, maxOutputTokens: 100, customParameters: {} }, undefined, 'NEVER-IN-LORE-RECORD');
    const bookId = instance.store.saveLibrary(instance.store.libraries().revision, 'lorebooks', { ...newLorebook(), entries: [{ ...newLoreEntry(randomUUID()), placement: 'history', constant: true, content: 'Immutable lore' }] });
    const chatId = instance.store.createChat({ title: 'HTTP lore', targetInputTokens: 9000, connectionId, promptId: 'default', characterId: null, personaId: null, lorebookId: bookId });
    const started = instance.coordinator.start(0, randomUUID(), 'Input', chatId);
    await expect.poll(() => instance.store.generation(started.generationId)?.status).toBe('succeeded');
    const routine = await instance.app.inject({ method: 'GET', url: `/api/chats/${chatId}`, headers: { host: 'localhost', cookie } });
    expect(routine.statusCode).toBe(200); expect(routine.body).not.toContain('NEVER-IN-LORE-RECORD');
    expect(routine.json().sources.lorebook).toBeUndefined();
    expect(routine.json().generations[0].request.lore).toMatchObject({ detailsAvailable: true, outcomes: [] });
    const detail = await instance.app.inject({ method: 'GET', url: `/api/chats/${chatId}/generations/${started.generationId}/request`, headers: { host: 'localhost', cookie } });
    expect(detail.json().lore.outcomes[0]).toMatchObject({ status: 'admitted', text: 'Immutable lore' });
    expect(detail.body).not.toContain('NEVER-IN-LORE-RECORD');
    const largeBookId = instance.store.saveLibrary(instance.store.libraries().revision, 'lorebooks', { ...newLorebook(), name: 'Large unselected archive', entries: Array.from({ length: 1000 }, (_, index) => ({ ...newLoreEntry(`large-${index}`), content: `Entry ${index}: ${'Synthetic archive prose. '.repeat(150)}` })) });
    const largeLibrary = await instance.app.inject({ method: 'GET', url: '/api/library', headers: { host: 'localhost', cookie } });
    const libraryRevision = largeLibrary.json().revision;
    expect(largeLibrary.body.length).toBeGreaterThan(3_000_000);
    const delta = await instance.app.inject({ method: 'GET', url: `/api/library?knownRevision=${libraryRevision}`, headers: { host: 'localhost', cookie } });
    expect(delta.json()).toMatchObject({ unchanged: true, revision: libraryRevision, chats: expect.arrayContaining([expect.objectContaining({ id: chatId, turnCount: 1, running: false })]) });
    expect(delta.body.length).toBeLessThan(2000);
    expect(delta.body).not.toContain('Synthetic archive prose');
    instance.store.saveLibrary(libraryRevision, 'lorebooks', { ...newLorebook(), name: 'Changed archive' }, largeBookId);
    const changedLibrary = await instance.app.inject({ method: 'GET', url: `/api/library?knownRevision=${libraryRevision}`, headers: { host: 'localhost', cookie } });
    expect(changedLibrary.json().lorebooks.find((book: { id: string }) => book.id === largeBookId)).toMatchObject({ name: 'Changed archive' });
    expect(f.store.generation(id)?.request?.lore?.outcomes[0].text).toContain('observatory');
  } finally { await instance.app.close(); }
});
