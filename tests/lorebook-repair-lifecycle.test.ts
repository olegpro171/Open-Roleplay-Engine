import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/persistence/store.js';
import { GenerationCoordinator } from '../src/server/coordinator.js';
import { defaultContextPreset, type SummaryNode } from '../src/shared/context.js';
import { newLorebook, newLoreEntry } from '../src/shared/lorebook.js';
import type { RequestPreview } from '../src/shared/contracts.js';
import type { Provider } from '../src/provider/openai.js';
import { sourceOf } from '../src/core/context.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of cleanup.splice(0)) await dispose(); });

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ore-lore-repair-'));
  const store = new Store(join(directory, 'state.sqlite'));
  const calls: RequestPreview[] = [];
  const provider: Provider = { async stream(request, _key, _signal, onText) {
    calls.push(structuredClone(request));
    onText(`Mira keeps the corrected brass key. Repair candidate ${calls.length}.`);
    return { finishReason: 'stop' };
  } };
  const coordinator = new GenerationCoordinator(store, provider);
  cleanup.push(async () => { await coordinator.shutdown(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const connectionId = store.saveLibrary(store.libraries().revision, 'connections', { name: 'Synthetic', endpoint: 'http://localhost:1234/v1', model: 'synthetic', contextWindow: 100000, maxOutputTokens: 100, customParameters: {} });
  const contextId = store.saveLibrary(store.libraries().revision, 'contexts', { ...defaultContextPreset, connectionId, minTail: 1, batchSize: 2 });
  const bookId = store.saveLibrary(store.libraries().revision, 'lorebooks', { ...newLorebook(), scanDepth: 20, entries: [{ ...newLoreEntry('initial'), constant: true, content: 'OLD LIVE LORE: the vault is blue.' }] });
  const chatId = store.createChat({ title: 'Synthetic repair', targetInputTokens: 90000, connectionId, promptId: 'default', characterId: null, personaId: null, contextPresetId: contextId, lorebookId: bookId });
  store.replaceHistory(store.snapshot(chatId).revision, chatId, Array.from({ length: 3 }, (_, index) => ({ user: `Mira asks about the brass key ${index}.`, assistant: `The keeper answers ${index}.`, complete: true })));
  const before = store.snapshot(chatId);
  const node: SummaryNode = { id: randomUUID(), revision: 0, level: 1, text: 'Mira remembers the original promise.', turns: before.turns.slice(0, 2).map(sourceOf), children: [], prior: [], approved: true, manual: false, createdAt: '2026-10-18T00:00:00.000Z' };
  store.sqlite.prepare('INSERT INTO summaries (id, revision, chat_id, data) VALUES (?, ?, ?, ?)').run(node.id, node.revision, chatId, JSON.stringify(node));
  store.sqlite.prepare('INSERT INTO context_states (chat_id, revision, data) VALUES (?, ?, ?)').run(chatId, 1, JSON.stringify({ selected: [{ id: node.id, revision: node.revision }], archivedTurnIds: node.turns.map(source => source.turnId) }));
  store.editPart(store.snapshot(chatId).revision, before.turns[0].id, 'user', 'Mira corrects who possesses the brass key.', chatId);
  const { jobId } = await coordinator.context.startResolved(chatId, store.snapshot(chatId).revision, randomUUID(), 'repair');
  const awaitingReview = async () => { await expect.poll(() => store.contexts.job(jobId).status).not.toBe('running'); expect(store.contexts.job(jobId).status).toBe('awaiting_review'); };
  await awaitingReview();
  const currentBook = () => {
    const book = store.libraries().lorebooks.find(book => book.id === bookId);
    if (!book) throw new Error('Missing synthetic lorebook.');
    const { id: _id, revision: _revision, ...editable } = book;
    return editable;
  };
  return { store, coordinator, calls, chatId, bookId, jobId, awaitingReview, currentBook };
}

it('captures current lore on an explicit repair regeneration after a shared book edit and remains idempotent', async () => {
  const f = await fixture();
  const original = structuredClone(f.store.loreOperation(f.jobId));
  expect(original?.outcomes[0].text).toContain('OLD LIVE LORE');
  const book = f.currentBook();
  f.store.saveLibrary(f.store.libraries().revision, 'lorebooks', { ...book, entries: book.entries.map(entry => ({ ...entry, content: 'NEW LIVE LORE: the vault is green.' })) }, f.bookId);
  const revision = f.store.snapshot(f.chatId).revision;
  const requestId = randomUUID();
  await f.coordinator.context.repairActionResolved(f.jobId, revision, requestId, 'regenerate');
  await f.awaitingReview();
  const captured = f.store.loreOperation(f.jobId);
  expect(captured?.book.revision).toBe((original?.book.revision ?? -1) + 1);
  expect(captured?.outcomes[0].text).toContain('NEW LIVE LORE');
  expect(f.calls).toHaveLength(2);
  for (const request of f.calls) expect(JSON.stringify(request.body)).not.toMatch(/OLD LIVE LORE|NEW LIVE LORE/);
  await f.coordinator.context.repairActionResolved(f.jobId, revision, requestId, 'regenerate');
  expect(f.calls).toHaveLength(2);
  expect(f.store.loreOperation(f.jobId)).toEqual(captured);
});

it('clears the previous frozen book when an explicit repair retry selects None', async () => {
  const f = await fixture();
  expect(f.store.loreOperation(f.jobId)).not.toBeNull();
  const snapshot = f.store.snapshot(f.chatId);
  f.store.updateChat(snapshot.revision, f.chatId, { title: snapshot.settings.title, targetInputTokens: snapshot.settings.targetInputTokens, connectionId: snapshot.settings.connectionId ?? null, promptId: snapshot.settings.promptId ?? 'default', characterId: null, personaId: null, contextPresetId: snapshot.settings.contextPresetId, lorebookId: null });
  await f.coordinator.context.repairActionResolved(f.jobId, f.store.snapshot(f.chatId).revision, randomUUID(), 'regenerate');
  await f.awaitingReview();
  expect(f.store.loreOperation(f.jobId)).toBeNull();
  expect(f.calls).toHaveLength(2);
});

it('leaves the existing candidate and captured context intact when retry lore preflight fails', async () => {
  const f = await fixture();
  const snapshot = f.store.snapshot(f.chatId);
  f.store.editPart(snapshot.revision, snapshot.turns[0].id, 'user', 'a'.repeat(40000) + '!', f.chatId);
  const book = f.currentBook();
  f.store.saveLibrary(f.store.libraries().revision, 'lorebooks', { ...book, entries: book.entries.map(entry => ({ ...entry, useRegex: true, keys: ['(a+)+$'] })) }, f.bookId);
  const before = { job: f.store.contexts.job(f.jobId), steps: f.store.contexts.steps(f.jobId), lore: f.store.loreOperation(f.jobId), revision: f.store.snapshot(f.chatId).revision };
  await expect(f.coordinator.context.repairActionResolved(f.jobId, before.revision, randomUUID(), 'regenerate')).rejects.toMatchObject({ code: 'lore_regex_timeout', status: 422 });
  expect(f.store.contexts.job(f.jobId)).toEqual(before.job);
  expect(f.store.contexts.steps(f.jobId)).toEqual(before.steps);
  expect(f.store.loreOperation(f.jobId)).toEqual(before.lore);
  expect(f.store.snapshot(f.chatId).revision).toBe(before.revision);
  expect(f.calls).toHaveLength(1);
});
