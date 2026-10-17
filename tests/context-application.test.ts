import { assembleRequest } from '../src/core/prompt.js';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/persistence/store.js';
import { GenerationCoordinator } from '../src/server/coordinator.js';
import type { Provider } from '../src/provider/openai.js';
import type { RequestPreview } from '../src/shared/contracts.js';
import { defaultContextPreset, refKey, type ContextJob } from '../src/shared/context.js';
import { contextPlan } from '../src/core/context-plan.js';
import { selectedContext } from '../src/core/context.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of cleanup.splice(0)) await dispose(); });
function fixture(count = 48, target = 2_200) {
  const directory = mkdtempSync(join(tmpdir(), 'roleplay-context-'));
  const filename = join(directory, 'chat.sqlite');
  let store = new Store(filename);
  const calls: { request: RequestPreview; apiKey: string }[] = [];
  let mode: 'normal' | 'placeholder' | 'refusal' | 'length' | 'huge' = 'normal';
  let holdAt = -1, release: (() => void) | null = null;
  const provider: Provider = { async stream(request, apiKey, _signal, onText) {
    calls.push({ request, apiKey });
    const summary = request.body.model === 'summary-model';
    const outcome = mode;
    if (summary && calls.length === holdAt) await new Promise<void>(resolve => { release = resolve; });
    onText(!summary ? 'Leon pockets the brass key.' : outcome === 'placeholder' ? 'placeholder' : outcome === 'refusal' ? 'I cannot summarize this content.' : outcome === 'huge' ? Array.from({ length: 2_000 }, (_, i) => `detail${i}`).join(' ') : `Mira entrusted Leon with her brass key; he promised to avoid the cellar.${calls.length % 3 === 0 ? ' She still distrusts him.' : ''}`);
    return { finishReason: outcome === 'length' && summary ? 'length' : 'stop' };
  } };
  const connection = { name: 'Story', endpoint: 'http://localhost:1234/v1', model: 'story-model', contextWindow: 100_000, maxOutputTokens: 1_000, customParameters: {} };
  const connectionId = store.saveLibrary(store.libraries().revision, 'connections', connection, undefined, 'story-secret');
  const summaryId = store.saveLibrary(store.libraries().revision, 'connections', { ...connection, name: 'Summary', model: 'summary-model' }, undefined, 'summary-secret');
  const contextId = store.saveLibrary(store.libraries().revision, 'contexts', { ...defaultContextPreset, connectionId: summaryId, minTail: 2, batchSize: 2, promotionGroup: 2, retainedPerLevel: 1 });
  const chatId = store.createChat({ title: 'Imported', targetInputTokens: target, connectionId, promptId: 'default', characterId: null, personaId: null, contextPresetId: contextId });
  const imported = Array.from({ length: count }, (_, i) => ({ user: `Turn ${i + 1}: Mira offers Leon the brass key, but warns him about the cellar. ${'Atmospheric detail. '.repeat(8)}`, assistant: `Leon promises not to enter the cellar. ${'The room remains quiet. '.repeat(7)}`, complete: true }));
  store.replaceHistory(store.snapshot(chatId).revision, chatId, imported);
  let coordinator = new GenerationCoordinator(store, provider);
  const state = () => store.snapshot(chatId);
  const start = (mode: ContextJob['mode'] = 'prepare') => coordinator.context.start(chatId, state().revision, randomUUID(), mode).jobId;
  const idle = async (id: string) => { await expect.poll(() => store.contexts.job(id).status, { timeout: 5_000 }).not.toBe('running'); return store.contexts.job(id); };
  const resume = async () => {
    release?.(); release = null; await coordinator.shutdown(); store.close();
    store = new Store(filename); coordinator = new GenerationCoordinator(store, provider);
  };
  cleanup.push(async () => { release?.(); await coordinator.shutdown(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { get store() { return store; }, get coordinator() { return coordinator; }, state, start, idle, resume, calls, imported, chatId, contextId,
    setMode(value: typeof mode) { mode = value; }, holdNext(offset = 1) { holdAt = calls.length + offset; }, release() { release?.(); release = null; holdAt = -1; },
  };
}

describe('durable imported-session preparation', () => {
  it('keeps all history verbatim when the complete request fits', async () => {
    const f = fixture(4, 10_000);
    expect((await f.idle(f.start())).status).toBe('succeeded');
    expect(f.calls).toHaveLength(0); expect(f.state().context.selected).toEqual([]);
  });

  it('prepares imported history, promotes uneven results, and resumes the exact committed selection', async () => {
    const f = fixture();
    const original = f.state().turns;
    expect((await f.idle(f.start())).status).toBe('succeeded');
    const saved = f.state();
    expect(contextPlan(saved).ready).toBe(true);
    expect(saved.turns).toEqual(original);
    expect(Math.max(...saved.context.summaries.map(node => node.level))).toBeGreaterThan(1);
    expect(selectedContext(saved.turns, saved.context).summaries.flatMap(node => node.turns.map(source => source.turnId))).toEqual(saved.context.archivedTurnIds);
    expect(f.calls.every(call => call.apiKey === 'summary-secret')).toBe(true);
    expect(JSON.stringify(saved)).not.toContain('summary-secret');
    const steps = f.store.contexts.steps(saved.context.jobs[0].id);
    expect(steps.every(step => step.status === 'saved' && step.inputAfter! < step.inputBefore)).toBe(true);
    await f.resume();
    expect(f.state().context.selected).toEqual(saved.context.selected);
    expect(f.state().context.archivedTurnIds).toEqual(saved.context.archivedTurnIds);
    const calls = f.calls.length;
    await f.idle(f.start()); expect(f.calls).toHaveLength(calls);
  });

  it('automatically prepares before a roleplay request, using separate credentials and saved coverage', async () => {
    const f = fixture();
    f.coordinator.start(f.state().revision, randomUUID(), 'Leon puts the key in his pocket.', f.chatId);
    await expect.poll(() => f.state().generations[0].status, { timeout: 5_000 }).toBe('succeeded');
    const saved = f.state(), roleplay = f.calls.at(-1)!;
    expect(roleplay.apiKey).toBe('story-secret'); expect(roleplay.request.body.model).toBe('story-model');
    expect(f.calls.slice(0, -1).every(call => call.apiKey === 'summary-secret')).toBe(true);
    expect(saved.generations[0].request?.context?.selected).toEqual(saved.context.selected);
    expect(saved.generations[0].request?.body).toEqual(roleplay.request.body);
    expect(saved.turns.at(-1)?.complete).toBe(true);
    expect(saved.turns.at(-1)?.assistant.text).toBe('Leon pockets the brass key.');
  });

  it.each(['placeholder', 'refusal', 'length', 'huge'] as const)('keeps sources selected after %s output and retries only explicitly', async mode => {
    const f = fixture(); f.setMode(mode);
    const failed = await f.idle(f.start());
    expect(failed.status).toBe('failed'); expect(failed.error).toBeTruthy();
    expect(f.state().context.archivedTurnIds).toEqual([]); expect(f.state().context.summaries).toEqual([]);
    expect(f.calls).toHaveLength(1);
    expect(f.store.contexts.steps(failed.id)[0].status).toBe('failed');
    f.setMode('normal'); expect((await f.idle(f.start('step'))).status).toBe('succeeded');
    expect(f.state().context.archivedTurnIds).toHaveLength(2);
  });

  it('stops during a later request, retains saved progress and ignores late results', async () => {
    const f = fixture(); f.holdNext(2);
    const id = f.start();
    await expect.poll(() => f.calls.length).toBe(2);
    const saved = f.state().context;
    expect(saved.archivedTurnIds).toHaveLength(2);
    expect(() => f.store.editPart(f.state().revision, f.state().turns[0].id, 'user', 'Competing edit', f.chatId)).toThrow('preparation');
    f.coordinator.context.cancel(id); f.release();
    await f.idle(id);
    expect(f.state().context.selected).toEqual(saved.selected);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.state().context.summaries).toHaveLength(1);
    expect((await f.idle(f.start())).status).toBe('succeeded');
    expect(f.state().context.summaries.some(node => refKey(node) === refKey(saved.selected[0]))).toBe(true);
  });

  it('recovers interrupted preparation without issuing another model request', async () => {
    const f = fixture(); await f.idle(f.start('step')); f.holdNext();
    const id = f.start(), selected = f.state().context.selected;
    await expect.poll(() => f.calls.length).toBe(2);
    // Shut down while the provider still holds the request, then release the late result.
    const stopping = f.coordinator.shutdown(); f.release(); await stopping;
    await f.resume();
    expect(f.store.contexts.job(id).status).toBe('interrupted');
    expect(f.state().context.selected).toEqual(selected); expect(f.calls).toHaveLength(2);
    expect(f.store.contexts.steps(id)[0].status).toBe('interrupted');
  });

  it('ignores a late cancelled result after the transcript and its old jobs were replaced', async () => {
    const f = fixture(); f.holdNext(); const id = f.start();
    await expect.poll(() => f.calls.length).toBe(1);
    f.coordinator.context.cancel(id);
    f.store.replaceHistory(f.state().revision, f.chatId, [{ user: 'A new scene.', assistant: 'The gate opens.', complete: true }]);
    f.release(); await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.state().context.summaries).toEqual([]); expect(f.state().context.jobs).toEqual([]);
    expect(f.state().turns[0].assistant.text).toBe('The gate opens.');
  });

  it('immediately cancels response-owned preparation and permits resolving the pending turn', async () => {
    const f = fixture(); f.holdNext();
    const { generationId } = f.coordinator.start(f.state().revision, randomUUID(), 'Leon waits.', f.chatId);
    await expect.poll(() => f.calls.length).toBe(1);
    f.coordinator.cancel(generationId);
    expect(f.state().context.jobs[0].status).toBe('cancelled');
    f.store.deleteTurn(f.state().revision, f.state().turns.at(-1)!.id, f.chatId);
    f.release(); await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.state().turns).toHaveLength(f.imported.length); expect(f.state().context.selected).toEqual([]);
  });

  it('rejects a stale asynchronous result before any coverage change', async () => {
    const f = fixture(); f.holdNext(); const id = f.start();
    await expect.poll(() => f.calls.length).toBe(1);
    f.store.sqlite.prepare('UPDATE turns SET user_revision = user_revision + 1 WHERE id = ?').run(f.state().turns[0].id);
    // Even a missed chat-revision bump must not bypass the captured part revisions.
    f.release();
    expect((await f.idle(id)).status).toBe('failed');
    expect(f.state().context.selected).toEqual([]); expect(f.state().context.summaries).toEqual([]);
  });

  it('rolls back the summary and cutoff together when the selection write fails', async () => {
    const f = fixture();
    f.store.sqlite.exec("CREATE TRIGGER synthetic_context_write_failure BEFORE INSERT ON context_states BEGIN SELECT RAISE(ABORT, 'synthetic_write_failure'); END");
    expect((await f.idle(f.start('step'))).status).toBe('failed');
    expect(f.state().context.summaries).toEqual([]); expect(f.state().context.archivedTurnIds).toEqual([]);
    f.store.sqlite.exec('DROP TRIGGER synthetic_context_write_failure');
    await f.idle(f.start('step')); expect(f.state().context.summaries).toHaveLength(1); expect(f.state().context.archivedTurnIds).toHaveLength(2);
  });

  it('fails before a model call when the fixed batch cannot fit the summary Connection', async () => {
    const f = fixture(), connectionId = f.state().context.preset!.connectionId!;
    f.store.saveLibrary(f.store.libraries().revision, 'connections', { ...f.store.connection(connectionId), contextWindow: 1_200, maxOutputTokens: 100 }, connectionId);
    const job = await f.idle(f.start());
    expect(job.status).toBe('failed'); expect(job.error).toContain('fixed source batch'); expect(f.calls).toHaveLength(0);
    expect(f.state().context.archivedTurnIds).toEqual([]);
  });

  it('leaves the response pending when automatic preparation rejects output', async () => {
    const f = fixture(); f.setMode('placeholder');
    f.coordinator.start(f.state().revision, randomUUID(), 'Leon waits.', f.chatId);
    await expect.poll(() => f.state().generations[0].status).toBe('failed');
    expect(f.state().turns.at(-1)?.complete).toBe(false); expect(f.calls).toHaveLength(1);
    expect(f.state().context.selected).toEqual([]);
    f.setMode('normal'); f.coordinator.start(f.state().revision, randomUUID(), undefined, f.chatId);
    await expect.poll(() => f.state().generations[0].status, { timeout: 5_000 }).toBe('succeeded');
    expect(f.state().turns).toHaveLength(f.imported.length + 1);
  });

  it('allows another chat to generate while the first chat is preparing, and blocks shared edits', async () => {
    const f = fixture(); f.holdNext(); const id = f.start();
    await expect.poll(() => f.calls.length).toBe(1);
    const first = f.state();
    const secondId = f.store.createChat({ title: 'Independent', targetInputTokens: 2_200, connectionId: first.settings.connectionId!, promptId: 'default', characterId: null, personaId: null, contextPresetId: f.contextId });
    f.store.replaceHistory(f.store.snapshot(secondId).revision, secondId, f.imported.slice(0, 8));
    f.coordinator.start(f.store.snapshot(secondId).revision, randomUUID(), 'A separate scene.', secondId);
    await expect.poll(() => f.store.snapshot(secondId).generations[0].status).toBe('succeeded');
    expect(f.store.contexts.job(id).status).toBe('running');
    expect(() => f.store.saveLibrary(f.store.libraries().revision, 'contexts', defaultContextPreset, f.contextId)).toThrow('preparation');
    f.coordinator.context.cancel(id); f.release();
  });

  it('preserves selections when capacity grows and restores originals only on an explicit action', async () => {
    const f = fixture(); await f.idle(f.start());
    const saved = f.state(), selected = saved.context.selected, calls = f.calls.length;
    const settings = { title: saved.settings.title, targetInputTokens: 100_000, connectionId: saved.settings.connectionId!, promptId: 'default', characterId: null, personaId: null, contextPresetId: f.contextId };
    f.store.updateChat(saved.revision, f.chatId, settings); await f.idle(f.start());
    expect(f.calls).toHaveLength(calls); expect(f.state().context.selected).toEqual(selected);
    expect(() => f.store.updateChat(f.state().revision, f.chatId, { ...settings, contextPresetId: null })).toThrow('Clear memory');
    f.store.contexts.clearMemory(f.chatId, f.state().revision);
    expect(f.state().context.selected).toEqual([]); expect(f.state().context.archivedTurnIds).toEqual([]);
    expect(f.state().context.summaries).toEqual([]); expect(f.state().context.jobs).toEqual([]);
    expect(f.state().turns).toEqual(saved.turns);
    f.store.updateChat(f.state().revision, f.chatId, { ...settings, contextPresetId: null });
    expect(f.state().settings.contextPresetId).toBeNull();
  });

  it('remeasures a retained-floor block after raising the target and can prepare again under changed settings', async () => {
    const f = fixture(8); await f.idle(f.start('step'));
    const saved = f.state();
    const { id: _presetId, revision: _presetRevision, ...preset } = saved.context.preset!;
    f.store.saveLibrary(f.store.libraries().revision, 'contexts', { ...defaultContextPreset, ...preset, minTail: 6 }, f.contextId);
    const current = f.state();
    const selection = { title: current.settings.title, connectionId: current.settings.connectionId ?? null, promptId: current.settings.promptId ?? 'default', characterId: current.settings.characterId ?? null, personaId: current.settings.personaId ?? null, contextPresetId: f.contextId };
    const tail = current.turns.filter(turn => !current.context.archivedTurnIds.includes(turn.id));
    const required = assembleRequest(current.connection!, current.settings, tail, current.sources, undefined, { validateLimits: false }).budget.inputTokens;
    f.store.updateChat(current.revision, f.chatId, { ...selection, targetInputTokens: required + 1 });
    expect(contextPlan(f.state()).blocked).toContain('retained-summary floor');
    expect((await f.idle(f.start())).error).toContain('retained-summary floor');
    const blocked = f.state(), calls = f.calls.length;
    f.store.updateChat(blocked.revision, f.chatId, { ...selection, targetInputTokens: contextPlan(blocked).inputTokens + 100 });
    expect(contextPlan(f.state()).ready).toBe(true);
    expect((await f.idle(f.start())).status).toBe('succeeded'); expect(f.calls).toHaveLength(calls);
    f.store.saveLibrary(f.store.libraries().revision, 'contexts', { ...defaultContextPreset, ...preset, minTail: 2 }, f.contextId);
    f.store.updateChat(f.state().revision, f.chatId, { ...selection, targetInputTokens: required + 1 });
    expect(contextPlan(f.state()).next?.level).toBe(1);
    expect((await f.idle(f.start('step'))).status).toBe('succeeded');
  });

  it('clears all layers and review candidates while retaining turns, selected preset and immutable roleplay requests', async () => {
    const f = fixture();
    f.coordinator.start(f.state().revision, randomUUID(), 'Leon waits.', f.chatId);
    await expect.poll(() => f.state().generations[0].status).toBe('succeeded');
    f.store.editPart(f.state().revision, f.state().turns[0].id, 'user', 'Mira kept the key.', f.chatId);
    const id = f.start('repair'); await f.idle(id);
    const saved = f.state();
    expect(saved.context.summaries.some(node => node.level > 1)).toBe(true);
    expect(saved.context.summaries.some(node => !node.approved)).toBe(true);
    f.store.contexts.clearMemory(f.chatId, saved.revision);
    const cleared = f.state();
    expect(cleared.context.selected).toEqual([]); expect(cleared.context.archivedTurnIds).toEqual([]);
    expect(cleared.context.summaries).toEqual([]); expect(cleared.context.jobs).toEqual([]);
    expect(f.store.sqlite.prepare('SELECT COUNT(*) as count FROM context_steps').get()).toEqual({ count: 0 });
    expect(cleared.turns).toEqual(saved.turns); expect(cleared.generations).toEqual(saved.generations);
    expect(cleared.settings.contextPresetId).toBe(f.contextId);
    await f.resume(); expect(f.state().context.summaries).toEqual([]);
  });

  it('rejects duplicate command identities used for a different operation', async () => {
    const f = fixture(); const requestId = randomUUID();
    const first = f.coordinator.context.start(f.chatId, f.state().revision, requestId, 'step');
    expect(f.coordinator.context.start(f.chatId, 0, requestId, 'step')).toEqual(first);
    expect(() => f.coordinator.context.start(f.chatId, f.state().revision, requestId, 'prepare')).toThrow('another memory command');
    await f.idle(first.jobId); expect(f.calls).toHaveLength(1);
  });

  it('clears dependent memory atomically when replacing the transcript', async () => {
    const f = fixture(); await f.idle(f.start('step'));
    const old = f.state().turns[0].id;
    f.store.replaceHistory(f.state().revision, f.chatId, [{ user: 'New story', assistant: 'A different opening.', complete: true }]);
    expect(f.state().context.selected).toEqual([]); expect(f.state().context.jobs).toEqual([]); expect(f.state().context.summaries).toEqual([]);
    expect(f.state().turns[0].id).not.toBe(old);
  });
});

describe('targeted repair with review', () => {
  it('repairs changed children before parents, preserves manual corrections, and pauses continuation until review', async () => {
    const f = fixture(24); await f.idle(f.start());
    const original = f.state().context.selected;
    f.store.editPart(f.state().revision, f.state().turns[0].id, 'user', 'Mira kept the key instead of giving it away.', f.chatId);
    expect(contextPlan(f.state()).stale.length).toBeGreaterThan(0);
    let reviewed = 0, corrected = false;
    while (contextPlan(f.state()).stale.length && reviewed < 100) {
      const before = f.state().context.selected, id = f.start('repair');
      expect((await f.idle(id)).status).toBe('awaiting_review');
      expect(f.state().context.selected).toEqual(before);
      const candidate = f.store.contexts.steps(id).at(-1)!;
      const node = f.state().context.summaries.find(node => candidate.result && refKey(node) === refKey(candidate.result))!;
      expect(node.approved).toBe(false);
      const override = !corrected ? 'Mira kept her brass key. Leon never received it. Author correction: her sister owns a duplicate.' : undefined;
      f.store.contexts.review(id, f.state().revision, true, override);
      if (override) corrected = true;
      reviewed++;
    }
    expect(reviewed).toBeGreaterThan(1); expect(reviewed).toBeLessThan(100);
    expect(contextPlan(f.state()).stale).toEqual([]);
    expect(f.state().context.selected).not.toEqual(original);
    expect(f.state().context.summaries.some(node => node.approved && node.manual && node.text.includes('her sister'))).toBe(true);
    expect(f.calls.some(call => JSON.stringify(call.request.body.messages).includes('her sister'))).toBe(true);
    expect(f.state().context.summaries.some(node => refKey(node) === refKey(original[0]))).toBe(true);
  });

  it('rejects approval after another edit, and allows discarding the obsolete candidate', async () => {
    const f = fixture(8); await f.idle(f.start('step'));
    f.store.editPart(f.state().revision, f.state().turns[0].id, 'user', 'Changed handoff.', f.chatId);
    const before = f.state().context.selected, id = f.start('repair'); await f.idle(id);
    await f.resume(); expect(f.store.contexts.job(id).status).toBe('awaiting_review');
    f.store.editPart(f.state().revision, f.state().turns.at(-1)!.id, 'user', 'Another edit.', f.chatId);
    expect(() => f.store.contexts.review(id, f.state().revision, true)).toThrow('changed');
    expect(f.state().context.selected).toEqual(before);
    f.store.contexts.review(id, f.state().revision, false);
    expect(f.store.contexts.job(id).status).toBe('cancelled');
  });

  it('lets a manual child correction invalidate parents and uses that corrected version in repair', async () => {
    const f = fixture(24); await f.idle(f.start());
    const child = f.state().context.summaries.find(node => node.level === 1)!;
    const original = f.state().context.selected;
    const ref = f.store.contexts.editSummary(f.chatId, f.state().revision, child, 'Mira retained her key. Author note: her sister holds a duplicate.');
    expect(f.state().context.selected).toEqual(original);
    expect(contextPlan(f.state()).stale.length).toBeGreaterThan(0);
    expect(f.store.contexts.sourceRequest(f.chatId, ref)).not.toBeNull();
    let jobId = f.start('repair'); await f.idle(jobId);
    let step = f.store.contexts.steps(jobId)[0];
    expect(JSON.stringify(step.request?.body.messages)).toContain('her sister');
    let repairs = 0;
    while (step.operation.level === 1 && repairs++ < 100) {
      f.store.contexts.review(jobId, f.state().revision, true);
      jobId = f.start('repair'); await f.idle(jobId); step = f.store.contexts.steps(jobId)[0];
    }
    expect(step.operation.level).toBeGreaterThan(1);
    expect(step.request?.body.messages.at(-1)?.content).toContain('her sister');
    expect(f.state().context.summaries.some(node => refKey(node) === refKey(child) && node.text === child.text)).toBe(true);
    expect(() => f.store.contexts.editSummary(f.chatId, f.state().revision, child, 'Overwriting an old revision.')).toThrow('current approved');
  });

  it('reviews deleted source coverage without calling the model for an empty batch', async () => {
    const f = fixture(8); await f.idle(f.start('step'));
    for (const id of [...f.state().context.archivedTurnIds]) f.store.deleteTurn(f.state().revision, id, f.chatId);
    const calls = f.calls.length, id = f.start('repair'); await f.idle(id);
    expect(f.calls).toHaveLength(calls);
    f.store.contexts.review(id, f.state().revision, true);
    expect(f.state().context.selected).toEqual([]); expect(f.state().context.archivedTurnIds).toEqual([]);
  });
});
