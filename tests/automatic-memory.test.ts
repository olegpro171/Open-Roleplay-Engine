import { seedTranscript } from './support/transcript-fixture.js';
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/persistence/store.js';
import { GenerationCoordinator } from '../src/server/coordinator.js';
import type { Provider } from '../src/provider/openai.js';
import { defaultChatBehavior, type ChatBehavior } from '../src/shared/chat-behavior.js';
import { defaultContextPreset } from '../src/shared/context.js';
import { assembleRequest } from '../src/core/prompt.js';
import { fitsInputTarget } from '../src/core/input-target.js';
import { contextPlan } from '../src/core/context-plan.js';
import { validateContent } from '../src/persistence/backup-validation.js';
import { compactPrompt } from './support/compact-prompt.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
function fixture(behavior: Partial<ChatBehavior> = {}, completedTurns = 8) {
  const folder = mkdtempSync(join(tmpdir(), 'ore-auto-memory-'));
  const filename = join(folder, 'chat.sqlite');
  let store = new Store(filename);
  store.saveLibrary(store.libraryRevision(), 'prompts', compactPrompt, 'default');
  const settings: ChatBehavior = { ...defaultChatBehavior, autoRetryMemory: false, ...behavior };
  const calls: string[] = [];
  let holdSummaryAt = Number.POSITIVE_INFINITY, failSummaries = 0, reply = 'Leon waits. ', summaryText = 'Mira kept the brass key.';
  const provider: Provider = { async stream(request, key, signal, onText) {
    const summary = request.body.model === 'summary';
    calls.push(request.body.model);
    expect(key).toBe(summary ? 'summary-secret' : 'story-secret');
    if (summary && calls.filter(model => model === 'summary').length >= holdSummaryAt) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    if (summary && failSummaries-- > 0) throw new Error('private upstream error');
    onText(summary ? summaryText : reply);
    return { finishReason: 'stop' };
  } };
  const connection = { name: 'Story', endpoint: 'http://localhost:1234/v1', model: 'story', contextWindow: 100_000, maxOutputTokens: 1_000, customParameters: {} };
  const storyId = store.saveLibrary(store.libraries().revision, 'connections', connection, undefined, 'story-secret');
  const summaryId = store.saveLibrary(store.libraries().revision, 'connections', { ...connection, name: 'Summary', model: 'summary' }, undefined, 'summary-secret');
  const presetId = store.saveLibrary(store.libraries().revision, 'contexts', { ...defaultContextPreset, connectionId: summaryId, minTail: 2, batchSize: 2, promotionGroup: 2, retainedPerLevel: 1 });
  const chatId = store.createChat({ title: 'Automatic memory', connectionId: storyId, promptId: 'default', characterId: null, personaId: null, contextPresetId: presetId, targetInputTokens: 20_000 });
  seedTranscript(store, store.snapshot(chatId).revision, chatId, Array.from({ length: completedTurns }, (_, index) => ({ user: sourceText(index), assistant: 'Leon waits by the door. '.repeat(12), complete: true })));
  let coordinator = new GenerationCoordinator(store, provider, () => settings);
  const state = () => store.snapshot(chatId);
  const target = (value: number) => store.updateChat(state().revision, chatId, { ...state().settings, connectionId: storyId, promptId: 'default', characterId: null, personaId: null, contextPresetId: presetId, targetInputTokens: value });
  const estimate = (text?: string) => {
    const snapshot = state();
    const turns = text === undefined ? snapshot.turns : [...snapshot.turns, { id: 'draft', position: completedTurns + 1, complete: false, user: { id: 'draft-u', text, revision: 0 }, assistant: { id: 'draft-a', text: '', revision: 0 } }];
    if (!snapshot.connection) throw new Error('Missing test Connection');
    return assembleRequest(snapshot.connection, snapshot.settings, turns, snapshot.sources, snapshot.context, { validateLimits: false }).budget.inputTokens;
  };
  const send = (text = 'Mira opens the door.', requestId = randomUUID()) => coordinator.start(state().revision, requestId, text, chatId).generationId;
  const regenerate = () => {
    const current = state();
    const latest = current.turns.at(-1);
    if (!latest) throw new Error('No turn to regenerate');
    return coordinator.regenerate(current.revision, randomUUID(), latest.id, chatId).generationId;
  };
  const idle = async () => { await expect.poll(() => coordinator.hasActiveWork(), { timeout: 8_000 }).toBe(false); };
  cleanups.push(async () => { await coordinator.shutdown(); store.close(); rmSync(folder, { recursive: true, force: true }); });
  return { get store() { return store; }, get coordinator() { return coordinator; }, state, settings, target, estimate, send, regenerate, idle, calls, chatId, presetId,
    hold(after = 1) { holdSummaryAt = after; }, fail(count: number) { failSummaries = count; }, reply(text: string) { reply = text; },
    summary(text: string) { summaryText = text; },
    physicalWindow(value: number) { const current = store.connection(storyId); store.saveLibrary(store.libraries().revision, 'connections', { ...current, contextWindow: value }, storyId); },
    async restart() { await coordinator.shutdown(); store.close(); store = new Store(filename); coordinator = new GenerationCoordinator(store, provider, () => settings); },
  };
}

const sourceText = (index: number) => `Mira offers the key, turn ${index}. ` + 'The cellar remains closed. '.repeat(12);

it.each([
  [999, 1000, true, 100, true], [1000, 1000, false, 0, true],
  [1001, 1000, true, 100, true], [1099, 1000, true, 100, true],
  [1100, 1000, true, 100, false], [1001, 1000, false, 100, false],
  [1001, 1000, true, 0, false], [1001, 1000, true, Number.MAX_SAFE_INTEGER, true],
])('checks input %i against target %i with allowance %s/%i', (input, target, allowInputOvershoot, maximumOvershootTokens, expected) => {
  expect(fitsInputTarget(input, target, { allowInputOvershoot, maximumOvershootTokens })).toBe(expected);
});

it.each([-1, 0, 99, 100])('orders requests correctly when Send exceeds the target by %i tokens', async excess => {
  const f = fixture();
  f.target(f.estimate('Mira opens the door.') - excess);
  f.send();
  await f.idle();
  expect(f.state().generations[0].status).toBe('succeeded');
  if (excess < 100) expect(f.calls[0]).toBe('story');
  else expect(f.calls[0]).toBe('summary');
  expect(contextPlan(f.state()).ready).toBe(true);
  expect(f.state().context.jobs.every(job => !job.automatic || !job.generationId && !job.refresh && !job.finalRefresh)).toBe(true);
  expect(() => validateContent(f.store.sqlite)).not.toThrow();
  const request = f.state().generations[0].request;
  expect(request?.budget.targetInputTokens).toBe(f.state().settings.targetInputTokens);
  expect(JSON.stringify(request)).not.toContain('secret');
});

it('checks after a below-target request too, includes the saved response, and locks only the running independent job', async () => {
  const f = fixture();
  f.target(f.estimate('Mira opens the door.') + 10);
  f.reply('Leon describes the room. '.repeat(100));
  f.hold();
  const id = f.send();
  await expect.poll(() => f.calls).toEqual(['story', 'summary']);
  const state = f.state(), job = state.context.jobs[0];
  expect(state.generations[0]).toMatchObject({ id, status: 'succeeded', error: null });
  expect(state.turns.at(-1)?.complete).toBe(true);
  expect(job).toMatchObject({ status: 'running', generationId: null, automatic: true });
  expect(() => f.send('Next input')).toThrow('memory preparation');
  f.coordinator.context.cancel(job.id);
  await f.idle();
  expect(f.state().context.jobs[0].status).toBe('cancelled');
  expect(f.state().generations[0].status).toBe('succeeded');
  f.settings.maximumOvershootTokens = Number.MAX_SAFE_INTEGER;
  f.send('Next input');
  await expect.poll(() => f.state().generations[0].status).toBe('succeeded');
});

it('does not turn physical overflow into preparation even with an enormous allowance', async () => {
  const f = fixture({ maximumOvershootTokens: Number.MAX_SAFE_INTEGER });
  f.target(200);
  f.physicalWindow(1_100);
  f.send();
  await f.idle();
  expect(f.calls).toEqual([]);
  expect(f.state().context.jobs).toEqual([]);
  expect(f.state().generations[0]).toMatchObject({ status: 'failed', errorMessage: { key: 'errors.the_estimated_input_plus_reserved_output_exceeds_the' } });
});

it('rejects physical overflow below the working target without any summary request', async () => {
  const f = fixture();
  f.physicalWindow(1_100);
  f.send();
  await f.idle();
  expect(f.calls).toEqual([]);
  expect(f.state().generations[0].status).toBe('failed');
  expect(f.state().context.jobs).toHaveLength(0);
});

it.each([true, false])('uses configured retries for %s post-response preparation and preserves the response on failure', async autoRetryMemory => {
  const f = fixture({ autoRetryMemory, memoryMaxRetries: 1 });
  f.target(f.estimate('Mira opens the door.'));
  f.fail(2);
  f.send();
  await f.idle();
  expect(f.calls).toEqual(autoRetryMemory ? ['story', 'summary', 'summary'] : ['story', 'summary']);
  expect(f.state().context.jobs[0].status).toBe('failed');
  expect(f.state().generations[0]).toMatchObject({ status: 'succeeded', error: null });
  expect(f.state().turns.at(-1)?.complete).toBe(true);
  expect(f.store.contexts.running(f.chatId)).toBe(false);
  expect(JSON.stringify(f.state())).not.toContain('private upstream error');
});

it('uses configured retries before sending and stops preparing as soon as the input fits', async () => {
  const f = fixture({ allowInputOvershoot: false, autoRetryMemory: true, memoryMaxRetries: 1 });
  f.target(f.estimate('Mira opens the door.') - 1);
  f.fail(1);
  f.send();
  await f.idle();
  expect(f.calls).toEqual(['summary', 'summary', 'story']);
  expect(f.state().context.jobs[0].retry).toEqual({ maxRetries: 1 });
  expect(f.state().generations[0].status).toBe('succeeded');
});

it('preserves committed summaries after interruption and never resumes paid work on restart or reads', async () => {
  const f = fixture({ maximumOvershootTokens: Number.MAX_SAFE_INTEGER });
  f.target(500);
  f.hold();
  const requestId = randomUUID();
  const id = f.send('Mira opens the door.', requestId);
  await expect.poll(() => f.calls).toEqual(['story', 'summary']);
  await f.restart();
  expect(f.state().context.jobs[0].status).toBe('interrupted');
  expect(f.state().generations[0]).toMatchObject({ id, status: 'succeeded' });
  expect(f.store.contexts.running(f.chatId)).toBe(false);
  expect(f.send('Mira opens the door.', requestId)).toBe(id);
  await f.idle();
  f.state(); f.estimate();
  expect(f.calls).toEqual(['story', 'summary']);
});

it('does not prepare on reads or settings/source edits, or after an under-target completion', async () => {
  const f = fixture();
  f.state(); f.estimate();
  f.store.editPart(f.state().revision, f.state().turns[0].id, 'user', 'An edited source.', f.chatId);
  f.target(15_000);
  expect(f.calls).toEqual([]);
  expect(f.state().context.jobs).toEqual([]);
  f.send();
  await f.idle();
  expect(f.calls).toEqual(['story']);
  expect(f.state().context.jobs).toEqual([]);
});

it('keeps preparing across several fixed batches until the complete input fits', async () => {
  const f = fixture({ maximumOvershootTokens: Number.MAX_SAFE_INTEGER });
  f.target(500);
  f.send();
  await f.idle();
  expect(f.calls[0]).toBe('story');
  expect(f.calls.filter(model => model === 'summary').length).toBeGreaterThan(1);
  expect(f.state().context.jobs[0]).toMatchObject({ status: 'succeeded', automatic: true });
  expect(contextPlan(f.state()).inputTokens).toBeLessThanOrEqual(500);
  expect(f.state().turns).toHaveLength(9);
  expect(f.state().context.archivedTurnIds.length % 2).toBe(0);
  expect(() => validateContent(f.store.sqlite)).not.toThrow();
});

it('keeps completed steps selected when the following background step is interrupted', async () => {
  const f = fixture({ maximumOvershootTokens: Number.MAX_SAFE_INTEGER });
  f.target(500);
  f.hold(2);
  f.send();
  await expect.poll(() => f.calls).toEqual(['story', 'summary', 'summary']);
  const committed = f.state().context;
  expect(committed.summaries).toHaveLength(1);
  expect(committed.archivedTurnIds).toHaveLength(2);
  await f.restart();
  expect(f.state().context.summaries).toEqual(committed.summaries);
  expect(f.state().context.selected).toEqual(committed.selected);
  expect(f.state().context.archivedTurnIds).toEqual(committed.archivedTurnIds);
  expect(f.state().context.jobs[0].status).toBe('interrupted');
  expect(f.state().generations[0].status).toBe('succeeded');
  expect(f.calls).toHaveLength(3);
});

it('checks the saved replacement after a successful regeneration', async () => {
  const f = fixture();
  f.target(f.estimate() + 20);
  f.reply('Leon describes the room. '.repeat(100));
  f.hold();
  f.coordinator.regenerate(f.state().revision, randomUUID(), f.state().turns.at(-1)?.id ?? '', f.chatId);
  await expect.poll(() => f.calls).toEqual(['story', 'summary']);
  expect(f.state().generations[0]).toMatchObject({ kind: 'regeneration', status: 'succeeded' });
  expect(f.state().context.jobs[0]).toMatchObject({ automatic: true, generationId: null, status: 'running' });
});

it('does not start post-response preparation when the response fails acceptance', async () => {
  const f = fixture({ maximumOvershootTokens: Number.MAX_SAFE_INTEGER });
  f.target(500);
  f.reply('');
  f.send();
  await f.idle();
  expect(f.state().generations[0].status).toBe('failed');
  expect(f.state().context.jobs).toHaveLength(0);
  expect(f.calls).toEqual(['story']);
});

it.each(['prepare', 'send', 'regenerate', 'post-reply'] as const)('takes the same two full batches for %s after a sharp target drop', async trigger => {
  const f = fixture({ allowInputOvershoot: trigger === 'post-reply', maximumOvershootTokens: 20_000 }, trigger === 'regenerate' ? 8 : 7);
  const input = sourceText(7);
  f.target(700);
  if (trigger === 'prepare') {
    const pending = f.store.begin(f.state().revision, randomUUID(), input, f.chatId);
    f.store.finish(pending.id, 'failed', '');
    f.coordinator.context.start(f.chatId, f.state().revision, randomUUID(), 'prepare');
  } else if (trigger === 'regenerate') {
    f.regenerate();
  } else {
    f.send(input);
  }
  await f.idle();
  const state = f.state();
  const job = state.context.jobs.find(job => trigger === 'regenerate' ? job.generationId !== null : job.automatic === (trigger === 'post-reply' ? true : undefined));
  expect(job).toMatchObject({ status: 'succeeded', generatedCount: 2, reusedCount: 0 });
  if (!job) throw new Error('No preparation job');
  const steps = f.store.contexts.steps(job.id);
  expect(steps.map(step => step.operation)).toEqual([0, 2].map(start => ({
    level: 1, turnIds: state.turns.slice(start, start + 2).map(turn => turn.id), children: [],
  })));
  expect(steps[1].inputBefore).toBe(steps[0].inputAfter);
  for (const step of steps) expect(step.inputAfter).toBeLessThan(step.inputBefore);
  expect(steps[1].inputAfter).toBeLessThanOrEqual(700);
  if (trigger === 'regenerate') {
    const generation = state.generations[0];
    expect(generation).toMatchObject({ status: 'succeeded', kind: 'regeneration' });
    expect(generation.request?.budget.inputTokens).toBe(steps[1].inputAfter);
    expect(generation.request?.body.messages.at(-1)?.content).toBe(input);
    const followUp = state.context.jobs.find(job => job.automatic);
    expect(followUp).toMatchObject({ status: 'succeeded', generatedCount: 0, reusedCount: 2 });
  } else if (trigger === 'prepare') {
    expect(state.turns.at(-1)?.complete).toBe(false);
  } else {
    expect(state.generations[0].status).toBe('succeeded');
  }
  expect(state.context.archivedTurnIds).toEqual(state.turns.slice(0, 4).map(turn => turn.id));
  expect(f.calls).toEqual(trigger === 'prepare' ? ['summary', 'summary'] : trigger === 'post-reply'
    ? ['story', 'summary', 'summary'] : ['summary', 'summary', 'story']);
});

it('records a no-savings attempt and leaves Send pending without dispatching the reply', async () => {
  const f = fixture({ allowInputOvershoot: false, autoRetryMemory: true });
  f.target(700);
  f.summary('A vault contains forty sealed maps. '.repeat(60) + 'Leon held the brass key.');
  f.send();
  await f.idle();
  const state = f.state();
  const job = state.context.jobs[0];
  expect(job).toMatchObject({ status: 'failed', errorMessage: { key: 'errors.the_summary_did_not_reduce_the_assembled_input' } });
  expect(state.turns.at(-1)).toMatchObject({ complete: false, user: { text: 'Mira opens the door.' } });
  expect(state.generations[0]).toMatchObject({ status: 'failed', request: null });
  expect(state.context.selected).toEqual([]);
  expect(state.context.summaries).toEqual([]);
  expect(f.store.contexts.steps(job.id)).toMatchObject([{ status: 'failed', request: { body: { model: 'summary' } }, result: null, after: null }]);
  expect(f.calls).toEqual(['summary']);
});

it('Stops Send during a retry delay and resumes its existing pending turn only on explicit Retry', async () => {
  const f = fixture({ allowInputOvershoot: false, autoRetryMemory: true });
  f.target(700);
  f.fail(1);
  const id = f.send();
  await expect.poll(() => {
    const job = f.state().context.jobs[0];
    return job && f.store.contexts.steps(job.id)[0]?.status;
  }).toBe('failed');
  f.coordinator.cancel(id);
  await f.idle();
  const stopped = f.state();
  expect(stopped.generations[0]).toMatchObject({ status: 'cancelled', request: null });
  expect(stopped.context.jobs[0]).toMatchObject({ status: 'cancelled' });
  expect(stopped.context.selected).toEqual([]);
  expect(stopped.turns.at(-1)?.complete).toBe(false);
  expect(f.calls).toEqual(['summary']);
  const { generationId } = f.coordinator.start(stopped.revision, randomUUID(), undefined, f.chatId);
  await f.idle();
  const resumed = f.state();
  expect(resumed.generations[0]).toMatchObject({ id: generationId, status: 'succeeded' });
  expect(resumed.turns).toHaveLength(stopped.turns.length);
  expect(resumed.turns.at(-1)).toMatchObject({ id: stopped.turns.at(-1)?.id, complete: true });
  expect(f.calls).toEqual(['summary', 'summary', 'summary', 'story']);
});

it('keeps the completed Send checkpoint when Stop rejects a late summary', async () => {
  const f = fixture({ allowInputOvershoot: false });
  f.target(700);
  f.hold(2);
  const id = f.send();
  await expect.poll(() => f.calls).toEqual(['summary', 'summary']);
  const before = f.state();
  const job = before.context.jobs[0];
  const steps = f.store.contexts.steps(job.id);
  expect(steps).toMatchObject([
    { status: 'saved', after: { selected: before.context.selected, archivedTurnIds: before.context.archivedTurnIds } },
    { status: 'running', request: { body: { model: 'summary' } }, result: null, after: null },
  ]);
  expect(before.context.archivedTurnIds).toEqual(before.turns.slice(0, 2).map(turn => turn.id));

  f.coordinator.cancel(id);
  await f.idle();
  const stopped = f.state();
  expect(stopped.context.jobs[0]).toMatchObject({ status: 'cancelled', generatedCount: 1 });
  expect(stopped.context.summaries).toEqual(before.context.summaries);
  expect(stopped.context.selected).toEqual(before.context.selected);
  expect(stopped.turns.at(-1)).toEqual(before.turns.at(-1));
  expect(stopped.turns.at(-1)?.complete).toBe(false);
  expect(f.calls).toEqual(['summary', 'summary']);

  f.hold(Number.POSITIVE_INFINITY);
  f.coordinator.start(stopped.revision, randomUUID(), undefined, f.chatId);
  await f.idle();
  const resumed = f.state();
  expect(resumed.generations[0].status).toBe('succeeded');
  expect(resumed.turns).toHaveLength(stopped.turns.length);
  expect(resumed.context.selected[0]).toEqual(stopped.context.selected[0]);
  expect(f.calls).toEqual(['summary', 'summary', 'summary', 'story']);
});

it.each(['stop', 'restart'] as const)('keeps the previous reply and the saved working checkpoint after regeneration %s', async outcome => {
  const f = fixture({ allowInputOvershoot: false });
  f.target(700);
  f.hold(2);
  const committed = f.state();
  const id = f.regenerate();
  await expect.poll(() => f.calls).toEqual(['summary', 'summary']);
  const before = f.state();
  const working = f.store.generation(id)?.contextSelection;
  expect(working?.archivedTurnIds).toEqual(committed.turns.slice(0, 2).map(turn => turn.id));
  expect(before.context.summaries).toHaveLength(1);
  expect(before.context.selected).toEqual(committed.context.selected);
  expect(before.turns.at(-1)).toEqual(committed.turns.at(-1));
  if (outcome === 'stop') {
    f.coordinator.cancel(id);
    await f.idle();
  } else {
    await f.restart();
  }
  const stopped = f.state();
  const status = outcome === 'stop' ? 'cancelled' : 'interrupted';
  expect(stopped.generations[0]).toMatchObject({ id, status, request: null });
  expect(stopped.context.jobs[0]).toMatchObject({ status });
  expect(stopped.turns.at(-1)).toEqual(committed.turns.at(-1));
  expect(stopped.context.selected).toEqual(committed.context.selected);
  expect(stopped.context.summaries).toEqual(before.context.summaries);
  expect(f.store.generation(id)?.contextSelection).toEqual(working);
  expect(f.calls).toEqual(['summary', 'summary']);

  f.hold();
  const retryId = f.regenerate();
  await expect.poll(() => f.calls).toHaveLength(3);
  const resumed = f.state();
  expect(resumed.context.jobs[0]).toMatchObject({ generationId: retryId, reusedCount: 1, generatedCount: 0 });
  expect(f.store.contexts.steps(resumed.context.jobs[0].id)[0]).toMatchObject({ status: 'saved', reused: true, request: null });
  expect(f.store.generation(retryId)?.contextSelection?.selected).toEqual(working?.selected);
  expect(resumed.context.selected).toEqual(committed.context.selected);
  expect(resumed.turns.at(-1)).toEqual(committed.turns.at(-1));
  f.coordinator.cancel(retryId);
  await f.idle();
});
