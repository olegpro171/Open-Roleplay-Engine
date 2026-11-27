import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, test } from 'vitest';
import { Store } from '../src/persistence/store.js';
import { StoryReader } from '../src/persistence/story-reader.js';
import { restoreLegacyGenerationSchema } from '../src/persistence/legacy-generation-schema.js';
import { validateContent } from '../src/persistence/backup-validation.js';
import { GenerationCoordinator } from '../src/server/coordinator.js';
import { newLorebook, newLoreEntry } from '../src/shared/lorebook.js';
import { defaultContextPreset } from '../src/shared/context.js';
import type { RequestPreview } from '../src/shared/contracts.js';
import type { Provider } from '../src/provider/openai.js';
import { seedTranscript } from './support/transcript-fixture.js';

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of disposals.splice(0)) await dispose(); });

function fixture(managed = false) {
  const directory = mkdtempSync(join(tmpdir(), 'ore-impersonate-'));
  const file = join(directory, 'story.sqlite');
  let store = new Store(file);
  const calls: RequestPreview[] = [];
  let result = 'I offer Mira the key.', hold = false;
  const provider: Provider = { async stream(request, key, signal, emit) {
    expect(key).toBe('synthetic-secret');
    calls.push(request);
    if (hold && !signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    emit(request.body.messages.at(-1)?.role === 'system' ? result : 'The keeper waited at the dock.');
    return { finishReason: 'stop', usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 } };
  } };
  let coordinator = new GenerationCoordinator(store, provider);
  disposals.push(async () => { await coordinator.shutdown(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const connectionId = store.saveLibrary(store.libraryRevision(), 'connections', {
    name: 'Mock', endpoint: 'http://localhost:1/v1', model: 'test', contextWindow: 32_000, maxOutputTokens: 256, customParameters: { temperature: 0.8 },
  }, undefined, 'synthetic-secret');
  const characterId = store.saveLibrary(store.libraryRevision(), 'characters', { name: 'Mira', description: 'Keeper of the keys.',
    personality: 'Patient', scenario: 'A locked door.', mes_example: '“Wait here.”', first_mes: '',
    system_prompt: 'Only write NPCs', post_history_instructions: 'Never write the player', depth_prompt: { prompt: 'Card injection', depth: 0, role: 'system' } });
  const personaId = store.saveLibrary(store.libraryRevision(), 'personas', { name: 'Rowan', description: 'A traveler.' });
  const promptId = store.saveLibrary(store.libraryRevision(), 'prompts', { name: 'Opposing instructions',
    impersonateInstruction: 'Draft for {{user}}, facing {{char}}. Guidance: {{DRAFT}}',
    blocks: [{ id: 'rules', name: 'Rules', kind: 'text', role: 'system', enabled: true, text: 'Never write Rowan. '.repeat(500) },
      { id: 'summary', name: 'Memory', kind: 'marker', marker: 'summary', role: 'system', enabled: managed }] });
  const contextPresetId = store.saveLibrary(store.libraryRevision(), 'contexts', { ...defaultContextPreset, batchSize: 1, minTail: 1 });
  const lorebookId = store.saveLibrary(store.libraryRevision(), 'lorebooks', { ...newLorebook(),
    entries: [{ ...newLoreEntry('door'), keys: ['knock'], content: 'Ordinary lore only.' }] });
  const chatId = store.createChat({ title: 'Keys', connectionId, lorebookId, characterId, personaId, promptId, contextPresetId, targetInputTokens: managed ? 250 : 20_000 });
  const state = () => store.snapshot(chatId);
  const session = randomUUID();
  const start = (draft = '', requestId = randomUUID(), revision = state().revision) =>
    coordinator.impersonate(revision, requestId, chatId, session, draft).generationId;
  const settle = async (id: string, status = 'succeeded') => {
    await expect.poll(() => store.generation(id)?.status).toBe(status);
    return store.generation(id);
  };
  return { chatId, session, state, calls, start, settle, get store() { return store; }, get coordinator() { return coordinator; },
    hold(value: boolean) { hold = value; }, result(value: string) { result = value; },
    async reopen(asVersion20 = false) {
      await coordinator.shutdown(); store.close();
      if (asVersion20) {
        const db = new Database(file);
        try { restoreLegacyGenerationSchema(db); db.pragma('user_version = 20'); } finally { db.close(); }
      }
      store = new Store(file); coordinator = new GenerationCoordinator(store, provider);
    } };
}

test('uses the six-section layout, actual selected reply, and literal guidance without committing a turn', async () => {
  const f = fixture();
  seedTranscript(f.store, f.state().revision, f.chatId, [{ user: 'I knock.', assistant: 'Who is there?', complete: true }]);
  const turn = f.state().turns[0];
  const other = f.store.beginRegeneration(f.state().revision, randomUUID(), turn.id, f.chatId);
  f.store.finish(other.id, 'succeeded', 'Enter now.');
  f.store.saveAuthorNote(f.chatId, { revision: f.state().revision, settings: { role: 'system', depth: 0, prompt: 'Ordinary note only.' } });
  f.store.setTurnPin(f.chatId, turn.id, f.state().revision, true);
  const before = f.state(), draft = 'Rephrase {{char}} and $&. ![](https://example.com/p.png)';
  const savedDraft = f.store.drafts.save(f.chatId, { baseRevision: 0, edit: { editorId: randomUUID(), sequence: 1 }, text: draft }).draft;
  const command = randomUUID();
  const id = f.start(draft, command);
  const attempt = await f.settle(id);
  expect(f.start(draft, command, before.revision)).toBe(id);
  expect(f.calls).toHaveLength(1);
  const request = f.calls[0];
  expect(request.body.messages).toEqual([
    ...['Mira', 'Keeper of the keys.', 'Patient', 'A locked door.', '“Wait here.”', 'Rowan\nA traveler.', expect.stringContaining('[Turn 1]')].map(content => ({ role: 'system', content })),
    { role: 'user', content: 'I knock.' }, { role: 'assistant', content: 'Enter now.' },
    { role: 'system', content: 'Draft for Rowan, facing Mira. Guidance: Rephrase {{char}} and $&. ' },
  ]);
  expect(request.body.temperature).toBe(0.8);
  expect(attempt).toMatchObject({ turnId: null, request, usage: { totalTokens: 25 } });
  expect(JSON.stringify(request)).not.toContain('synthetic-secret');
  expect(f.state().turns).toEqual(before.turns);
  expect(f.state().context).toEqual(before.context);
  expect(f.state().loreState).toEqual(before.loreState);
  expect(f.store.drafts.read(f.chatId)).toEqual(savedDraft);
  validateContent(f.store.sqlite);
  const copy = { requestId: randomUUID(), revision: f.state().revision, name: 'Copy' };
  const source = f.store.forkSource(f.chatId, copy);
  const branch = f.store.commitBranch(f.chatId, copy, source, source.snapshot.context);
  expect(f.store.snapshot(branch).generations[0]).toMatchObject({ kind: 'impersonate', turnId: null, request });
  expect(new StoryReader(f.store).read(branch, { shift: 0, limit: 15 }).suggestion).toBeUndefined();
});

test('prepares over-budget managed history before drafting and reuses it on retry', async () => {
  const f = fixture(true);
  seedTranscript(f.store, f.state().revision, f.chatId, [
    { user: 'I remember the dock. '.repeat(400), assistant: 'It was empty.', complete: true },
    { user: 'I knock.', assistant: 'Come in.', complete: true },
  ]);
  f.store.setTurnPin(f.chatId, f.state().turns[1].id, f.state().revision, true);
  const before = f.state().turns;
  const saved = await f.settle(f.start('stall'));
  expect(f.calls).toHaveLength(2);
  const request = saved?.request;
  expect(request?.layout?.map(part => part.kind)).toEqual(['character','character','character','character','character','persona','memory','pinned','history','history','prompt']);
  expect(request?.history?.verbatimTurnIds).toEqual([before[1].id]);
  expect(f.state().context.archivedTurnIds).toEqual([before[0].id]);
  expect(f.state().context.jobs).toHaveLength(1);
  expect(f.state().turns).toEqual(before);
  await f.settle(f.start('ask about the ferry'));
  expect(f.calls).toHaveLength(3);
  expect(f.calls[2].body.messages.at(-1)?.content).toContain('ask about the ferry');
  expect(f.state().context.jobs).toHaveLength(1);
});

test('retains alternatives across blank output, cancellation and restart and rejects late completions', async () => {
  const f = fixture();
  const initial = await f.settle(f.start());
  f.result('I wait.');
  const next = await f.settle(f.start());
  f.result('  ');
  await f.settle(f.start(), 'failed');
  f.hold(true);
  const cancelled = f.start();
  await expect.poll(() => f.calls.length).toBe(4);
  expect(() => f.store.begin(f.state().revision, randomUUID(), 'New input.', f.chatId)).toThrow();
  f.coordinator.cancel(cancelled);
  expect(f.store.finish(cancelled, 'succeeded', 'Late suggestion')).toBe(false);
  const interrupted = f.start();
  await expect.poll(() => f.calls.length).toBe(5);
  await f.reopen();
  expect(f.store.generation(interrupted)?.status).toBe('interrupted');
  expect(f.calls).toHaveLength(5);
  const reader = new StoryReader(f.store);
  expect(reader.suggestion(f.chatId, f.session)).toMatchObject({ id: next?.id, text: 'I wait.', number: 2, previous: initial?.id, next: null });
  expect(reader.suggestion(f.chatId, f.session, initial?.id)).toMatchObject({ next: next?.id, previous: null });
  expect(reader.suggestion(f.chatId, f.session, 1)).toMatchObject({ id: initial?.id, number: 1 });
  expect(reader.suggestion(f.chatId, f.session, 3)).toBeNull();
  expect(reader.read(f.chatId, { shift: 0, limit: 15 }).suggestion?.completedCount).toBe(2);
  expect(reader.suggestion('another-branch', f.session)).toBeNull();
  expect(f.state().turns).toEqual([]);
  f.store.begin(f.state().revision, randomUUID(), 'My real move', f.chatId);
  expect(() => f.start()).toThrow();
  expect(f.calls).toHaveLength(5);
});

test('schema 21 preserves populated turns, variants, generation bodies and a shared draft', async () => {
  const f = fixture();
  const sent = f.coordinator.start(f.state().revision, randomUUID(), 'I knock.', f.chatId);
  await f.settle(sent.generationId);
  const draft = f.store.drafts.save(f.chatId, { baseRevision: 0, edit: { editorId: randomUUID(), sequence: 0 }, text: 'Next turn.' }).draft;
  const before = f.state();
  await f.reopen(true);
  expect(f.state()).toEqual(before);
  expect(f.store.drafts.read(f.chatId)).toEqual(draft);
  expect(f.store.sqlite.pragma('foreign_key_check')).toEqual([]);
  await f.settle(f.start(draft.text));
  expect(f.state().turns).toEqual(before.turns);
});

test('guards stale drafting sessions and rejects oversized suggestions without losing earlier choices', async () => {
  const f = fixture();
  const good = await f.settle(f.start('First idea.'));
  f.result('x'.repeat(100_001));
  const failed = await f.settle(f.start('Second idea.'), 'failed');
  expect(failed).toMatchObject({ errorMessage: { key: 'impersonate.too_long' }, usage: { totalTokens: 25 } });
  const reader = new StoryReader(f.store);
  expect(reader.suggestion(f.chatId, f.session)?.id).toBe(good?.id);
  f.store.saveAuthorNote(f.chatId, { revision: f.state().revision, settings: { role: 'system', depth: 0, prompt: 'A new scene note.' } });
  expect(() => f.start('A stale retry.')).toThrow(/scene has changed/);
  expect(f.calls).toHaveLength(2);
  expect(f.state().turns).toEqual([]);
});
