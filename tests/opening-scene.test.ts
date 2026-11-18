import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { AppError } from '../src/core/errors.js';
import { validateContent } from '../src/persistence/backup-validation.js';
import { Store } from '../src/persistence/store.js';
import { GenerationCoordinator } from '../src/server/coordinator.js';
import type { Provider } from '../src/provider/openai.js';
import type { RequestPreview } from '../src/shared/contracts.js';
import { defaultOpeningInstruction } from '../src/shared/default-prompt.js';
import { defaultContextPreset } from '../src/shared/context.js';
import { compactPrompt } from './support/compact-prompt.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of cleanup.splice(0)) await dispose(); });

const originalGreeting = 'The ferry bell rang.';
const alternateGreeting = 'Mira checked the tide.';
const newOpening = 'Mira pulled the empty ferry alongside the dock.';
const openingCue = 'Open the scene with {{char}} and {{user}}.';
const resolvedCue = { role: 'user', content: 'Open the scene with Mira and Rowan.' };

function fixture({ greeting = '', custom, messages = true, managed = false, targetInputTokens = 20_000 }: {
  greeting?: string; custom?: string; messages?: boolean; managed?: boolean; targetInputTokens?: number;
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'ore-opening-'));
  const database = join(directory, 'opening.sqlite');
  let store = new Store(database);
  const requests: RequestPreview[] = [];
  let fail = false, hold = false;
  const provider: Provider = { async stream(request, _key, signal, onText) {
    requests.push(request);
    if (fail || request.body.messages.every(part => part.role !== 'user')) throw new Error('Synthetic provider rejected the request');
    if (hold && !signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    onText(newOpening);
    return { finishReason: 'stop' };
  } };
  let coordinator = new GenerationCoordinator(store, provider);
  cleanup.push(async () => {
    await coordinator.shutdown();
    store.close();
    rmSync(directory, { force: true, recursive: true });
  });
  const connectionId = store.saveLibrary(store.libraryRevision(), 'connections', {
    name: 'Synthetic', endpoint: 'http://localhost:1/v1', model: 'mock',
    contextWindow: 32_000, maxOutputTokens: 256, customParameters: {},
  });
  const characterId = store.saveLibrary(store.libraryRevision(), 'characters', {
    name: 'Mira', description: 'A ferry keeper.', personality: '', scenario: 'The ferry is overdue.',
    mes_example: '', first_mes: greeting, alternate_greetings: greeting ? [alternateGreeting] : [],
  });
  const personaId = store.saveLibrary(store.libraryRevision(), 'personas', { name: 'Rowan', description: '' });
  const promptId = store.saveLibrary(store.libraryRevision(), 'prompts', {
    ...compactPrompt, ...(custom === undefined ? {} : { openingInstruction: custom }),
    blocks: [
      ...compactPrompt.blocks.filter(block => (messages || block.id !== 'messages') && (managed || block.id !== 'summary')),
      { id: 'style', name: 'Style', enabled: true, kind: 'text', role: 'system', text: 'Write in past tense.' },
    ],
  });
  const contextPresetId = managed ? store.saveLibrary(store.libraryRevision(), 'contexts', defaultContextPreset) : null;
  const chatId = store.createChat({ title: 'Ferry', connectionId, characterId, personaId, promptId, targetInputTokens, contextPresetId });
  const state = () => store.snapshot(chatId);
  const settle = async (id: string, status: string) => {
    await expect.poll(() => store.generation(id)?.status).toBe(status);
    return store.generation(id)?.request;
  };
  return {
    get store() { return store; }, get coordinator() { return coordinator; },
    chatId, state, settle, requests, fail(value: boolean) { fail = value; }, hold(value: boolean) { hold = value; },
    async restart() {
      await coordinator.shutdown();
      store.close();
      store = new Store(database);
      coordinator = new GenerationCoordinator(store, provider);
    },
  };
}

test.each(['', '  '])('regenerates a sole greeting with blank user text %j and keeps both copied variants', async userText => {
  const f = fixture({ greeting: originalGreeting });
  const created = f.state();
  if (userText) f.store.editPart(created.revision, created.turns[0].id, 'user', userText, f.chatId);
  const before = f.state();
  const id = f.coordinator.regenerate(before.revision, randomUUID(), before.turns[0].id, f.chatId).generationId;
  const request = await f.settle(id, 'succeeded');
  expect(request?.body.messages.at(-2)).toMatchObject({ role: 'user', content: expect.stringContaining('Write the opening scene for this roleplay.') });
  expect(request?.body.messages.at(-1)).toEqual({ role: 'system', content: 'Write in past tense.' });
  expect(request?.body.messages.filter(part => part.role === 'user')).toHaveLength(1);
  expect(request?.body.messages.map(part => part.content)).not.toContain(originalGreeting);
  const [turn] = f.state().turns;
  expect(turn).toMatchObject({ id: before.turns[0].id, complete: true, user: before.turns[0].user, assistant: { text: newOpening } });
  expect(turn.variants?.map(variant => variant.text)).toEqual([originalGreeting, alternateGreeting, newOpening]);

  f.fail(true);
  await f.settle(f.coordinator.regenerate(f.state().revision, randomUUID(), turn.id, f.chatId).generationId, 'failed');
  expect(f.state().turns).toEqual([turn]);
});

test('reuses a failed opening turn, rejects competing commands and preserves ordinary sends', async () => {
  const f = fixture({ custom: openingCue, managed: true });
  const before = f.state();
  const requestId = randomUUID();
  f.fail(true);
  const first = f.coordinator.generateOpening(before.revision, requestId, f.chatId);
  expect(f.coordinator.generateOpening(before.revision, requestId, f.chatId)).toEqual(first);
  expect(() => f.coordinator.start(before.revision, requestId, 'I step aboard.', f.chatId)).toThrow(AppError);
  await f.settle(first.generationId, 'failed');
  const pending = f.state();
  expect(pending.turns).toHaveLength(1);
  expect(pending.turns[0]).toMatchObject({ complete: false, user: { text: '' }, assistant: { text: '' } });
  expect(() => f.coordinator.generateOpening(pending.revision, randomUUID(), f.chatId)).toThrow(AppError);
  expect(() => f.coordinator.start(pending.revision, randomUUID(), 'I step aboard.', f.chatId)).toThrow(AppError);
  expect(f.requests).toHaveLength(1);

  f.fail(false);
  const retry = f.coordinator.start(pending.revision, randomUUID(), undefined, f.chatId);
  const request = await f.settle(retry.generationId, 'succeeded');
  expect(request?.body.messages.filter(part => part.role === 'user')).toEqual([resolvedCue]);
  expect(request?.layout?.find(entry => entry.kind === 'opening')).toMatchObject({ tokens: expect.any(Number) });
  const story = f.state();
  expect(story.turns).toHaveLength(1);
  expect(story.turns[0]).toMatchObject({ id: pending.turns[0].id, complete: true, user: pending.turns[0].user, assistant: { text: newOpening } });
  expect(f.requests).toHaveLength(2);
  expect(() => validateContent(f.store.sqlite)).not.toThrow();

  const next = f.coordinator.start(story.revision, randomUUID(), 'I step aboard.', f.chatId);
  const followUp = await f.settle(next.generationId, 'succeeded');
  expect(followUp?.body.messages.filter(part => part.role !== 'system')).toEqual([
    { role: 'assistant', content: newOpening }, { role: 'user', content: 'I step aboard.' },
  ]);
});

test('an interrupted opening uses explicit retry after reopening the database', async () => {
  const f = fixture({ custom: '![poster](https://example.test/poster.png)' });
  f.hold(true);
  const first = f.coordinator.generateOpening(f.state().revision, randomUUID(), f.chatId);
  await expect.poll(() => f.requests.length).toBe(1);
  const pending = f.state().turns[0];
  await f.restart();
  const interrupted = f.state();
  expect(interrupted.turns).toEqual([pending]);
  expect(interrupted.generations[0]).toMatchObject({ id: first.generationId, status: 'interrupted' });
  expect(f.requests).toHaveLength(1);
  f.hold(false);
  const retry = f.coordinator.start(interrupted.revision, randomUUID(), undefined, f.chatId);
  const request = await f.settle(retry.generationId, 'succeeded');
  expect(request?.body.messages.filter(part => part.role === 'user')).toEqual([{ role: 'user', content: defaultOpeningInstruction }]);
  expect(request?.body).toEqual(interrupted.generations[0].request?.body);
  expect(f.state().turns[0].id).toBe(pending.id);
});

test('requires Messages before reserving an opening or a replacement', () => {
  const empty = fixture({ messages: false });
  const greeting = fixture({ messages: false, greeting: originalGreeting });
  expect(() => empty.coordinator.generateOpening(empty.state().revision, randomUUID(), empty.chatId))
    .toThrow('Enable the Messages marker');
  expect(empty.state().turns).toEqual([]);
  const saved = greeting.state();
  expect(() => greeting.coordinator.regenerate(saved.revision, randomUUID(), saved.turns[0].id, greeting.chatId))
    .toThrow('Enable the Messages marker');
  expect(greeting.state()).toEqual(saved);
  expect([...empty.requests, ...greeting.requests]).toEqual([]);
});

test.each([false, true])('the opening instruction cannot bypass the input budget (managed: %s)', async managed => {
  const f = fixture({ managed, custom: 'Opening direction. '.repeat(200), targetInputTokens: 200 });
  const attempt = f.coordinator.generateOpening(f.state().revision, randomUUID(), f.chatId);
  await f.settle(attempt.generationId, 'failed');
  expect(f.requests).toEqual([]);
  expect(f.state().turns[0]).toMatchObject({ complete: false, assistant: { text: '' } });
});
