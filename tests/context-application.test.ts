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
import { defaultContextPreset, refKey, type ContextJob, type SummaryNode } from '../src/shared/context.js';
import { contextPlan } from '../src/core/context-plan.js';
import { repairQueue, selectedContext } from '../src/core/context.js';
import { correctionProtection } from '../src/core/context-corrections.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of cleanup.splice(0)) await dispose(); });
function fixture(count = 48, target = 500) {
  const directory = mkdtempSync(join(tmpdir(), 'roleplay-context-'));
  const filename = join(directory, 'chat.sqlite');
  let store = new Store(filename);
  const calls: { request: RequestPreview; apiKey: string }[] = [];
  let mode: 'normal' | 'unchanged' | 'near' | 'placeholder' | 'refusal' | 'length' | 'huge' = 'normal';
  let holdAt = -1, release: (() => void) | null = null;
  const provider: Provider = { async stream(request, apiKey, _signal, onText) {
    calls.push({ request, apiKey });
    const summary = request.body.model === 'summary-model';
    const outcome = mode;
    let old: string | undefined;
    try { old = JSON.parse(request.body.messages.at(-1)!.content).previous_summary; } catch { /* Roleplay input is plain text. */ }
    if (summary && calls.length === holdAt) await new Promise<void>(resolve => { release = resolve; });
    onText(!summary ? 'Leon pockets the brass key.' : outcome === 'placeholder' ? 'placeholder' : outcome === 'refusal' ? 'I cannot summarize this content.' : outcome === 'huge' ? Array.from({ length: 2_000 }, (_, i) => `detail${i}`).join(' ') : old !== undefined && (outcome === 'unchanged' || outcome === 'near') ? old + (outcome === 'near' ? '!' : '') : `Mira entrusted Leon with her brass key; he promised to avoid the cellar.${calls.length % 3 === 0 ? ' She still distrusts him.' : ''}${old !== undefined ? ` Repaired candidate ${calls.length}.` : ''}`);
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
  const start = (mode: Exclude<ContextJob['mode'], 'refresh'> = 'prepare') => coordinator.context.start(chatId, state().revision, randomUUID(), mode).jobId;
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

// Legacy alternatives are seeded only into an isolated temporary database.
function retainedAlternative(f: ReturnType<typeof fixture>, source: SummaryNode, overrides: Partial<SummaryNode> = {}): SummaryNode {
  const node: SummaryNode = { ...structuredClone(source), id: randomUUID(), revision: 0, basedOn: undefined, corrections: undefined, prior: [], createdAt: new Date().toISOString(), ...overrides };
  f.store.sqlite.prepare('INSERT INTO summaries (id, revision, chat_id, data) VALUES (?, ?, ?, ?)').run(node.id, node.revision, f.chatId, JSON.stringify(node));
  return node;
}

describe('retained editorial authority', () => {
  it('selects a fresh retained L2 edit with ample space, carries it into promotion under pressure, and restores it repeatedly', async () => {
    const f = fixture(24); await f.idle(f.start());
    const original = f.state();
    const source = original.context.summaries.find(node => node.level === 2)!;
    const alternative = retainedAlternative(f, source);
    const correction = 'Author correction: Mira kept a silver duplicate in her boot.';
    const edited = f.store.contexts.editSummary(f.chatId, f.state().revision, alternative, source.text + ' ' + correction);
    expect(f.state().context.selected).toEqual(original.context.selected);
    expect(contextPlan(f.state())).toMatchObject({ ready: false, next: null });
    const calls = f.calls.length;
    f.store.updateChat(f.state().revision, f.chatId, { title: 'Imported', targetInputTokens: 50_000, connectionId: f.state().settings.connectionId ?? null, promptId: 'default', characterId: null, personaId: null, contextPresetId: f.contextId });
    expect((await f.idle(f.start())).status).toBe('succeeded');
    expect(f.state().context.selected).toContainEqual(edited);
    expect(f.calls).toHaveLength(calls);
    expect(assembleRequest(f.state().connection!, f.state().settings, f.state().turns, f.state().sources, f.state().context).body.messages.some(message => message.content.includes(correction))).toBe(true);
    f.store.updateChat(f.state().revision, f.chatId, { title: 'Imported', targetInputTokens: 350, connectionId: f.state().settings.connectionId ?? null, promptId: 'default', characterId: null, personaId: null, contextPresetId: f.contextId });
    expect((await f.idle(f.start())).status).toBe('succeeded');
    expect(correctionProtection(f.state().turns, f.state().context).unresolved).toEqual([]);
    expect(f.calls.slice(calls).some(call => JSON.stringify(call.request.body).includes(correction))).toBe(true);
    const compact = f.state(), count = f.calls.length;
    expect((await f.idle(f.start())).status).toBe('succeeded');
    expect(f.state().context.selected).toEqual(compact.context.selected);
    expect(f.calls).toHaveLength(count);
    await f.resume();
    f.store.updateChat(f.state().revision, f.chatId, { title: 'Imported', targetInputTokens: 50_000, connectionId: f.state().settings.connectionId ?? null, promptId: 'default', characterId: null, personaId: null, contextPresetId: f.contextId });
    expect((await f.idle(f.start())).status).toBe('succeeded');
    expect(f.state().context.selected).toContainEqual(edited);
    expect(f.state().turns).toEqual(original.turns);
    expect(f.state().context.summaries).toEqual(expect.arrayContaining(original.context.summaries));
  });

  it('repairs a stale retained L2 baseline without selecting it, and rejects bypass through automatic or single-step preparation', async () => {
    const f = fixture(24); await f.idle(f.start());
    const source = f.state().context.summaries.find(node => node.level === 2)!;
    const child = f.state().context.summaries.find(node => refKey(node) === refKey(source.children[0]))!;
    const copiedChild = retainedAlternative(f, child);
    const correction = 'Editorial baseline: Mira kept the key; her sister has a duplicate.';
    const alternative = retainedAlternative(f, source, { manual: true, text: correction, children: [copiedChild, ...source.children.slice(1)] });
    retainedAlternative(f, copiedChild, { id: copiedChild.id, revision: 1, basedOn: copiedChild, text: 'Mira hid the key beneath the floor.' });
    const before = f.state(), calls = f.calls.length;
    expect(() => f.start()).toThrow(/correction.*reconciliation/i);
    expect((await f.idle(f.start('step'))).status).toBe('failed');
    expect(f.calls).toHaveLength(calls);
    f.coordinator.start(f.state().revision, randomUUID(), 'Leon waits.', f.chatId);
    await expect.poll(() => f.state().generations[0]?.status).toBe('failed');
    expect(f.calls).toHaveLength(calls);
    expect(f.state().context.selected).toEqual(before.context.selected);
    const job = f.start('repair');
    expect((await f.idle(job)).status).toBe('awaiting_review');
    const step = f.store.contexts.steps(job).at(-1)!;
    expect(step.operation.repair).toMatchObject({ id: alternative.id });
    expect(JSON.stringify(step.request?.body)).toContain(correction);
    expect(JSON.stringify(step.request?.body)).toContain('Mira hid the key beneath the floor.');
    expect(f.state().context.selected).toEqual(before.context.selected);
    f.coordinator.context.repairAction(job, f.state().revision, randomUUID(), 'close');
    expect(f.state().context.summaries.find(node => refKey(node) === refKey(alternative))?.text).toBe(correction);
    expect(f.state().context.summaries.some(node => !node.approved)).toBe(false);
  });

  it('reviews conflicting corrected identities together even when the model returns exactly unchanged text', async () => {
    const f = fixture(24); await f.idle(f.start());
    const parent = f.state().context.summaries.find(node => refKey(node) === refKey(f.state().context.selected[0]))!;
    const first = f.store.contexts.editSummary(f.chatId, f.state().revision, parent, 'Parent correction: Mira owns the key.');
    const childSource = f.state().context.summaries.find(node => node.level === 1 && node.turns[0].turnId === parent.turns[0].turnId)!;
    const child = retainedAlternative(f, childSource, { manual: true, text: 'Child correction: Leon owns the key.' });
    const before = f.state(), calls = f.calls.length;
    expect(() => f.start()).toThrow(/repair|reconciliation/i);
    f.setMode('unchanged');
    const id = f.start('repair');
    expect((await f.idle(id)).status).toBe('awaiting_review');
    const step = f.store.contexts.steps(id).at(-1)!;
    expect(step.operation).toMatchObject({ repair: first, reconcile: [{ id: child.id, revision: child.revision }] });
    const body = JSON.stringify(step.request?.body);
    expect(body).toContain('Parent correction: Mira owns the key.');
    expect(body).toContain(child.text);
    expect(f.calls).toHaveLength(calls + 1);
    expect(f.state().context.selected).toEqual(before.context.selected);
    const beforeRestart = f.calls.length;
    await f.resume();
    expect(f.calls).toHaveLength(beforeRestart);
    expect(f.store.contexts.job(id).status).toBe('awaiting_review');
    f.coordinator.context.repairAction(id, f.state().revision, randomUUID(), 'approve', 'Reviewed: Mira owns the key; Leon borrows it.');
    expect((await f.idle(id)).status).toBe('succeeded');
    expect(correctionProtection(f.state().turns, f.state().context).unresolved).toEqual([]);
    const approved = f.state().context.summaries.find(node => node.id === parent.id && node.approved && node.text.startsWith('Reviewed:'))!;
    expect(approved.corrections).toContainEqual({ id: child.id, revision: child.revision });
    const callCount = f.calls.length;
    expect((await f.idle(f.start())).status).toBe('succeeded');
    expect(f.calls).toHaveLength(callCount);
  });

  it('preserves editorial state across cancellation, stale review and a failed approval transaction', async () => {
    const f = fixture(24); await f.idle(f.start());
    const source = f.state().context.summaries.find(node => node.level === 1)!;
    const correction = retainedAlternative(f, source, { manual: true, text: 'Author correction: Mira kept a silver duplicate.' });
    const obsolete = retainedAlternative(f, source, { turns: source.turns.map(turn => ({ ...turn, userRevision: 999 })) });
    const other = f.store.createChat({ title: 'Independent', targetInputTokens: 500, connectionId: null, promptId: 'default', characterId: null, personaId: null });
    const untouched = f.store.snapshot(other), before = f.state().context.selected;
    expect(repairQueue(f.state().turns, f.state().context).some(operation => operation.repair?.id === obsolete.id)).toBe(false);
    f.holdNext();
    const cancelled = f.start('repair');
    await expect.poll(() => f.store.contexts.steps(cancelled).length).toBe(1);
    f.coordinator.context.cancel(cancelled);
    f.release();
    expect((await f.idle(cancelled)).status).toBe('cancelled');
    expect(f.state().context.selected).toEqual(before);
    expect(f.state().context.summaries.some(node => !node.approved)).toBe(false);
    f.setMode('unchanged');
    const id = f.start('repair');
    expect((await f.idle(id)).status).toBe('awaiting_review');
    const current = f.store.contexts.editSummary(f.chatId, f.state().revision, correction, correction.text + ' It opens the cellar.');
    expect(() => f.coordinator.context.repairAction(id, f.state().revision, randomUUID(), 'approve')).toThrow(/changed/i);
    f.coordinator.context.repairAction(id, f.state().revision, randomUUID(), 'regenerate');
    expect((await f.idle(id)).status).toBe('awaiting_review');
    const step = f.store.contexts.steps(id).at(-1)!;
    expect(step.operation.reconcile).toContainEqual(current);
    expect(JSON.stringify(step.request?.body)).toContain('It opens the cellar.');
    const pending = f.state();
    f.store.sqlite.exec("CREATE TRIGGER reject_editorial_approval BEFORE UPDATE ON context_states BEGIN SELECT RAISE(ABORT, 'synthetic editorial write failure'); END;");
    const command = randomUUID();
    expect(() => f.coordinator.context.repairAction(id, pending.revision, command, 'approve')).toThrow('synthetic editorial write failure');
    expect(f.state()).toEqual(pending);
    f.store.sqlite.exec('DROP TRIGGER reject_editorial_approval');
    f.coordinator.context.repairAction(id, pending.revision, command, 'approve');
    expect((await f.idle(id)).status).toBe('succeeded');
    expect(correctionProtection(f.state().turns, f.state().context).unresolved).toEqual([]);
    expect(f.store.snapshot(other)).toEqual(untouched);
    expect(f.state().context.summaries.find(node => refKey(node) === refKey(correction))?.text).toBe(correction.text);
  });
});

describe('durable imported-session preparation', () => {
  it('treats a normalized identical summary save as a no-op while validating conflicts', async () => {
    const f = fixture(24); await f.idle(f.start());
    const node = f.state().context.summaries.find(node => node.level === 1)!;
    const before = f.state();
    expect(f.store.contexts.editSummary(f.chatId, before.revision, node, `\n ${node.text} \n`)).toEqual({ id: node.id, revision: node.revision });
    expect(f.state()).toEqual(before);
    expect(() => f.store.contexts.editSummary(f.chatId, before.revision - 1, node, node.text)).toThrow();
    const legacy = retainedAlternative(f, node, { id: node.id, revision: node.revision + 1, manual: true, basedOn: node });
    const historical = f.state();
    expect(f.store.contexts.editSummary(f.chatId, historical.revision, legacy, legacy.text)).toEqual({ id: legacy.id, revision: legacy.revision });
    expect(f.state()).toEqual(historical);
    expect(() => f.store.contexts.editSummary(f.chatId, historical.revision, node, node.text)).toThrow('current approved summary revision');
  });
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

  it.each(['absent', 'disabled'] as const)('uses recent history with Summary %s, keeps saved memory, then prepares after re-enabling', async mode => {
    const f = fixture();
    await f.idle(f.start());
    const saved = structuredClone(f.state().context);
    const { defaultPrompt } = await import('../src/shared/library.js');
    const { assembleRequest } = await import('../src/core/prompt.js');
    const blocks = mode === 'absent' ? defaultPrompt.blocks.filter(block => block.id !== 'summary') : defaultPrompt.blocks.map(block => ({ ...block, enabled: block.id !== 'summary' }));
    f.store.saveLibrary(f.store.libraries().revision, 'prompts', { ...defaultPrompt, blocks }, 'default');
    expect(contextPlan(f.state())).toMatchObject({ ready: true, next: null, stale: [] });
    expect(() => f.start()).toThrow('Summaries are disabled');
    expect(f.state().context.jobs).toEqual(saved.jobs);
    const current = f.state();
    const text = 'Leon puts the brass key in his pocket.';
    const preview = assembleRequest(current.connection!, current.settings, [...current.turns, { id: 'draft', position: 49, complete: false, user: { id: 'draft-u', revision: 0, text }, assistant: { id: 'draft-a', revision: 0, text: '' } }], current.sources, current.context);
    const calls = f.calls.length;
    f.coordinator.start(current.revision, randomUUID(), text, f.chatId);
    await expect.poll(() => f.state().generations[0].status).toBe('succeeded');
    expect(f.calls.slice(calls).map(call => call.request.body.model)).toEqual(['story-model']);
    const sent = f.calls.at(-1)!.request;
    expect(sent.body).toEqual(preview.body);
    expect(sent.history?.mode).toBe('recent');
    expect(sent.budget.inputTokens).toBeLessThanOrEqual(current.settings.targetInputTokens);
    expect(sent.body.messages.some(message => message.content.includes('[Memory L'))).toBe(false);
    expect(f.state().context).toEqual(saved);
    f.store.saveLibrary(f.store.libraries().revision, 'prompts', defaultPrompt, 'default');
    expect((await f.idle(f.start())).status).toBe('succeeded');
    expect(contextPlan(f.state()).ready).toBe(true);
    expect(f.state().context.summaries).toEqual(expect.arrayContaining(saved.summaries));
    const preparedCalls = f.calls.length;
    expect((await f.idle(f.start())).status).toBe('succeeded');
    expect(f.calls).toHaveLength(preparedCalls);
  });

  it('allows continuation with unused stale memory while summaries are disabled, and requires repair when enabled', async () => {
    const f = fixture(); await f.idle(f.start());
    const { defaultPrompt } = await import('../src/shared/library.js');
    f.store.editPart(f.state().revision, f.state().turns[0].id, 'user', 'The key was never given away.', f.chatId);
    expect(contextPlan(f.state()).stale.length).toBeGreaterThan(0);
    f.store.saveLibrary(f.store.libraries().revision, 'prompts', { ...defaultPrompt, blocks: defaultPrompt.blocks.filter(block => block.id !== 'summary') }, 'default');
    const memory = structuredClone(f.state().context), calls = f.calls.length;
    expect(contextPlan(f.state())).toMatchObject({ ready: true, stale: [] });
    f.coordinator.start(f.state().revision, randomUUID(), 'Leon waits.', f.chatId);
    await expect.poll(() => f.state().generations[0].status).toBe('succeeded');
    expect(f.calls).toHaveLength(calls + 1);
    expect(f.state().context).toEqual(memory);
    f.store.saveLibrary(f.store.libraries().revision, 'prompts', defaultPrompt, 'default');
    expect(contextPlan(f.state()).blocked).toContain('out of date');
    expect(() => f.start()).toThrow('out of date');
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
    f.store.saveLibrary(f.store.libraries().revision, 'connections', { ...f.store.connection(connectionId), contextWindow: 350, maxOutputTokens: 100 }, connectionId);
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

  it('preserves selections after a settings change, then restores detail on manual Prepare', async () => {
    const f = fixture(); await f.idle(f.start());
    const saved = f.state(), selected = saved.context.selected, calls = f.calls.length;
    const settings = { title: saved.settings.title, targetInputTokens: 100_000, connectionId: saved.settings.connectionId!, promptId: 'default', characterId: null, personaId: null, contextPresetId: f.contextId };
    f.store.updateChat(saved.revision, f.chatId, settings);
    expect(f.state().context.selected).toEqual(selected);
    expect(() => f.store.updateChat(f.state().revision, f.chatId, { ...settings, contextPresetId: null })).toThrow('Clear memory');
    await f.idle(f.start());
    expect(f.calls).toHaveLength(calls); expect(f.state().context.selected).toEqual([]);
    expect(f.state().context.summaries).toEqual(saved.context.summaries);
    f.store.contexts.clearMemory(f.chatId, f.state().revision);
    expect(f.state().context.selected).toEqual([]); expect(f.state().context.archivedTurnIds).toEqual([]);
    expect(f.state().context.summaries).toEqual([]); expect(f.state().context.jobs).toEqual([]);
    expect(f.state().turns).toEqual(saved.turns);
    f.store.updateChat(f.state().revision, f.chatId, { ...settings, contextPresetId: null });
    expect(f.state().settings.contextPresetId).toBeNull();
  });

  it('uses one Prepare action to expand and shrink the budget without regenerating saved summaries', async () => {
    const f = fixture(); await f.idle(f.start());
    const original = f.state(), calls = f.calls.length;
    const settings = { title: original.settings.title, connectionId: original.settings.connectionId!, promptId: 'default', characterId: null, personaId: null, contextPresetId: f.contextId };
    f.store.updateChat(original.revision, f.chatId, { ...settings, targetInputTokens: 3_500 });
    const enlargedId = f.start(); expect((await f.idle(enlargedId)).status).toBe('succeeded');
    const enlarged = f.state();
    expect(enlarged.context.archivedTurnIds.length).toBeLessThan(original.context.archivedTurnIds.length);
    expect(enlarged.context.jobs[0]).toMatchObject({ mode: 'prepare', generatedCount: 0 });
    expect(enlarged.context.jobs[0].refresh?.changed).toBe(true);
    f.store.updateChat(enlarged.revision, f.chatId, { ...settings, targetInputTokens: 500 });
    const requestId = randomUUID(), revision = f.state().revision;
    const smallId = f.coordinator.context.start(f.chatId, revision, requestId, 'prepare').jobId;
    expect((await f.idle(smallId)).status).toBe('succeeded');
    const small = f.state();
    expect(small.context.archivedTurnIds.length).toBeGreaterThan(enlarged.context.archivedTurnIds.length);
    expect(small.context.selected.some(ref => small.context.summaries.find(node => refKey(ref) === refKey(node))!.level > 1)).toBe(true);
    expect(small.context.summaries).toEqual(original.context.summaries);
    expect(small.context.jobs[0]).toMatchObject({ generatedCount: 0, outcome: { inputTokens: contextPlan(small).inputTokens } });
    expect(f.coordinator.context.start(f.chatId, revision, requestId, 'prepare').jobId).toBe(smallId);
    await f.idle(f.start()); expect(f.state().context.selected).toEqual(small.context.selected);
    expect(f.calls).toHaveLength(calls);
    await f.resume(); expect(f.state().context.selected).toEqual(small.context.selected);
  });

  it('recovers the tail after a manual correction, retains all versions, and commits reselection atomically', async () => {
    const f = fixture(24);
    await f.idle(f.start());
    const child = f.state().context.summaries.find(node => node.level === 1 && node.turns[0].turnId === f.state().turns[4].id)!;
    const corrected = f.store.contexts.editSummary(f.chatId, f.state().revision, child, `${child.text} Author correction: her sister owns a duplicate key.`);
    f.setMode('unchanged');
    expect((await f.idle(f.start('repair'))).status).toBe('succeeded');
    expect(contextPlan(f.state()).stale).toEqual([]);
    const { id: presetId, revision: _, ...preset } = f.state().context.preset!;
    f.store.saveLibrary(f.store.libraries().revision, 'contexts', { ...preset, minTail: 6, connectionId: null }, presetId);
    const current = f.state();
    f.store.updateChat(current.revision, f.chatId, { title: current.settings.title, targetInputTokens: 50_000, connectionId: current.settings.connectionId!, promptId: 'default', characterId: null, personaId: null, contextPresetId: f.contextId });
    expect(contextPlan(f.state()).blocked).toContain('minimum tail');
    const before = f.state(), calls = f.calls.length;
    f.store.sqlite.exec("CREATE TRIGGER reject_corrected_prepare BEFORE INSERT ON context_jobs WHEN json_extract(NEW.data, '$.mode') = 'prepare' BEGIN SELECT RAISE(ABORT, 'synthetic reselection failure'); END;");
    expect(() => f.start()).toThrow('synthetic reselection failure');
    expect(f.state()).toEqual(before);
    f.store.sqlite.exec('DROP TRIGGER reject_corrected_prepare');
    const requestId = randomUUID();
    const id = f.coordinator.context.start(f.chatId, before.revision, requestId, 'prepare').jobId;
    expect((await f.idle(id)).status).toBe('succeeded');
    const after = f.state();
    expect(contextPlan(after)).toMatchObject({ ready: true, blocked: null });
    expect(after.context.selected).toContainEqual(corrected);
    expect(after.context.archivedTurnIds).toEqual(after.turns.slice(0, 6).map(turn => turn.id));
    expect(after.context.summaries).toEqual(before.context.summaries);
    expect(after.turns).toEqual(before.turns);
    expect(after.context.jobs[0]).toMatchObject({ stepCount: 0, generatedCount: 0, refresh: { protectedSummaries: 1, changed: true } });
    expect(f.calls).toHaveLength(calls);
    expect(f.coordinator.context.start(f.chatId, before.revision, requestId, 'prepare').jobId).toBe(id);
    await f.resume();
    expect(f.state().context.selected).toEqual(after.context.selected);
    expect((await f.idle(f.start())).status).toBe('succeeded');
    expect(f.state().context.selected).toEqual(after.context.selected);
    expect(f.calls).toHaveLength(calls);
  });

  it('reuses saved summaries in automatic preparation without expanding a fitting selection', async () => {
    const f = fixture(); await f.idle(f.start());
    const original = f.state();
    const settings = { title: original.settings.title, connectionId: original.settings.connectionId!, promptId: 'default', characterId: null, personaId: null, contextPresetId: f.contextId };
    f.store.updateChat(original.revision, f.chatId, { ...settings, targetInputTokens: 3_500 });
    let calls = f.calls.length;
    f.coordinator.start(f.state().revision, randomUUID(), 'Leon waits.', f.chatId);
    await expect.poll(() => f.state().generations[0].status).toBe('succeeded');
    expect(f.state().context.selected).toEqual(original.context.selected);
    expect(f.calls.slice(calls).map(call => call.request.body.model)).toEqual(['story-model']);
    await f.idle(f.start());
    const enlarged = f.state(), summaries = enlarged.context.summaries;
    f.store.updateChat(enlarged.revision, f.chatId, { ...settings, targetInputTokens: 600 });
    calls = f.calls.length;
    f.coordinator.start(f.state().revision, randomUUID(), 'Leon waits again.', f.chatId);
    await expect.poll(() => f.state().generations[0].status).toBe('succeeded');
    const prepared = f.state().context.jobs[0];
    expect(prepared.generationId).toBe(f.state().generations[0].id);
    expect(prepared.refresh).toBeUndefined(); expect(prepared.reusedCount).toBeGreaterThan(0);
    expect(prepared.generatedCount).toBe(0);
    expect(f.calls.slice(calls).map(call => call.request.body.model)).toEqual(['story-model']);
    expect(f.state().context.summaries).toEqual(summaries);
    expect(f.store.contexts.steps(prepared.id).every(step => step.reused && !step.request)).toBe(true);
    expect(f.store.contexts.steps(prepared.id).some(step => step.operation.level > 1)).toBe(true);
  });

  it('reuses an existing batch and generates only missing groups when the saved tree cannot fit', async () => {
    const f = fixture(); await f.idle(f.start('step'));
    const saved = f.state(), cached = saved.context.summaries[0], calls = f.calls.length;
    const settings = { title: saved.settings.title, connectionId: saved.settings.connectionId!, promptId: 'default', characterId: null, personaId: null, contextPresetId: f.contextId };
    f.store.updateChat(saved.revision, f.chatId, { ...settings, targetInputTokens: 50_000 });
    await f.idle(f.start()); expect(f.state().context.selected).toEqual([]);
    f.store.updateChat(f.state().revision, f.chatId, { ...settings, targetInputTokens: 500 });
    const id = f.start(); expect((await f.idle(id)).status).toBe('succeeded');
    const steps = f.store.contexts.steps(id), requests = f.calls.slice(calls);
    expect(steps[0]).toMatchObject({ reused: true, result: { id: cached.id, revision: cached.revision }, request: null });
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every(call => JSON.stringify(call.request.coverage.map(source => source.turnId)) !== JSON.stringify(cached.turns.map(source => source.turnId)))).toBe(true);
    expect(f.store.contexts.job(id).generatedCount).toBe(requests.length);
    expect(f.store.contexts.job(id).reusedCount).toBeGreaterThanOrEqual(1);
    expect(f.state().context.summaries.filter(node => node.id === cached.id)).toEqual([cached]);
    expect(f.store.contexts.sourceRequest(f.chatId, cached)?.body).toEqual(f.calls[0].request.body);
    expect(contextPlan(f.state()).ready).toBe(true);
  });

  it('finishes manual preparation in a repeatable selection after generating newly needed memory', async () => {
    const f = fixture(); await f.idle(f.start());
    for (let i = 0; i < 6; i++) {
      const generation = f.store.begin(f.state().revision, randomUUID(), `New turn ${i}. ` + 'Mira explains a new story detail. '.repeat(30), f.chatId);
      f.store.finish(generation.id, 'succeeded', 'Leon considers the new detail. '.repeat(40));
    }
    const current = f.state();
    f.store.updateChat(current.revision, f.chatId, { title: current.settings.title, targetInputTokens: 1_600, connectionId: current.settings.connectionId!, promptId: 'default', characterId: null, personaId: null, contextPresetId: f.contextId });
    const calls = f.calls.length;
    expect((await f.idle(f.start())).status).toBe('succeeded');
    const prepared = f.state();
    expect(f.calls.length).toBeGreaterThan(calls);
    expect(prepared.context.jobs[0].finalRefresh?.changed).toBe(true);
    const callsAfter = f.calls.length;
    await f.idle(f.start());
    expect(f.state().context.selected).toEqual(prepared.context.selected);
    expect(f.state().context.archivedTurnIds).toEqual(prepared.context.archivedTurnIds);
    expect(f.calls).toHaveLength(callsAfter);
  });

  it('prepares from saved memory without a summarization Connection and rolls back a failed job insert', async () => {
    const f = fixture(); await f.idle(f.start());
    const original = f.state(), { id, revision: _, ...config } = original.context.preset!;
    f.store.saveLibrary(f.store.libraries().revision, 'contexts', { ...config, connectionId: null }, id);
    const settings = { title: original.settings.title, targetInputTokens: 3_500, connectionId: original.settings.connectionId!, promptId: 'default', characterId: null, personaId: null, contextPresetId: f.contextId };
    f.store.updateChat(f.state().revision, f.chatId, settings);
    const before = f.state(), calls = f.calls.length;
    f.store.sqlite.exec("CREATE TRIGGER reject_prepare BEFORE INSERT ON context_jobs WHEN json_extract(NEW.data, '$.mode') = 'prepare' BEGIN SELECT RAISE(ABORT, 'synthetic preparation failure'); END;");
    expect(() => f.start()).toThrow('synthetic preparation failure'); expect(f.state()).toEqual(before);
    f.store.sqlite.exec('DROP TRIGGER reject_prepare');
    expect((await f.idle(f.start())).status).toBe('succeeded');
    expect(f.state().context.archivedTurnIds.length).toBeLessThan(before.context.archivedTurnIds.length);
    expect(f.calls).toHaveLength(calls);
  });

  it('refreshes locally, retains immutable content, retries idempotently and survives a restart', async () => {
    const f = fixture();
    f.coordinator.start(f.state().revision, randomUUID(), 'Leon pockets the key.', f.chatId);
    await expect.poll(() => f.state().generations[0].status).toBe('succeeded');
    const saved = f.state();
    f.store.updateChat(saved.revision, f.chatId, { title: saved.settings.title, targetInputTokens: 3_500, connectionId: saved.settings.connectionId!, promptId: 'default', characterId: null, personaId: null, contextPresetId: f.contextId });
    const before = f.state(), calls = f.calls.length, requestId = randomUUID();
    const result = f.store.contexts.refresh(f.chatId, before.revision, requestId);
    const after = f.state();
    expect(result.report.changed).toBe(true);
    expect(result.report.verbatimAfter).toBeGreaterThan(result.report.verbatimBefore);
    expect(contextPlan(after).ready).toBe(true);
    expect(after.context.summaries).toEqual(before.context.summaries);
    expect(after.turns).toEqual(before.turns); expect(after.generations).toEqual(before.generations);
    expect(after.context.jobs[0]).toMatchObject({ id: result.jobId, mode: 'refresh', status: 'succeeded', refresh: result.report, historyTurnIds: before.turns.map(turn => turn.id) });
    expect(f.store.contexts.steps(result.jobId)).toEqual([]);
    expect(f.store.contexts.refresh(f.chatId, before.revision, requestId)).toEqual(result);
    expect(f.state()).toEqual(after);
    expect(() => f.store.contexts.refresh('main', f.store.snapshot('main').revision, requestId)).toThrow('another memory command');
    const again = f.store.contexts.refresh(f.chatId, after.revision, randomUUID());
    expect(again.report.changed).toBe(false);
    expect(f.state().context.revision).toBe(after.context.revision);
    expect(f.calls).toHaveLength(calls);
    await f.resume();
    expect(f.state().context.selected).toEqual(after.context.selected);
    expect(f.state().context.jobs.find(job => job.id === result.jobId)?.refresh).toEqual(result.report);
    const previousCalls = f.calls.length; await f.idle(f.start());
    expect(f.calls).toHaveLength(previousCalls);
  });

  it('rolls back the selection, revisions and refresh history together on a failed write', async () => {
    const f = fixture(); await f.idle(f.start());
    const saved = f.state();
    f.store.updateChat(saved.revision, f.chatId, { title: saved.settings.title, targetInputTokens: 3_500, connectionId: saved.settings.connectionId!, promptId: 'default', characterId: null, personaId: null, contextPresetId: f.contextId });
    const before = f.state();
    f.store.sqlite.exec("CREATE TRIGGER reject_refresh BEFORE INSERT ON context_jobs WHEN json_extract(NEW.data, '$.mode') = 'refresh' BEGIN SELECT RAISE(ABORT, 'synthetic refresh failure'); END;");
    expect(() => f.store.contexts.refresh(f.chatId, before.revision, randomUUID())).toThrow('synthetic refresh failure');
    expect(f.state()).toEqual(before);
  });

  it('blocks stale or competing refresh commands and does not need a summarization Connection', async () => {
    const f = fixture(); f.holdNext();
    const running = f.start();
    expect(() => f.store.contexts.refresh(f.chatId, f.state().revision, randomUUID())).toThrow('preparation');
    f.coordinator.context.cancel(running); f.release(); await f.idle(running);
    await f.idle(f.start());
    const before = f.state(), { id, revision: _, ...config } = before.context.preset!;
    f.store.saveLibrary(f.store.libraries().revision, 'contexts', { ...config, connectionId: null }, id);
    expect(() => f.store.contexts.refresh(f.chatId, before.revision, randomUUID())).toThrow('another device');
    expect(f.store.contexts.refresh(f.chatId, f.state().revision, randomUUID()).jobId).toBeTruthy();
    const current = f.state();
    f.store.editPart(current.revision, current.context.archivedTurnIds[0], 'user', 'Mira kept the key.', f.chatId);
    const edited = f.state();
    expect(() => f.store.contexts.refresh(f.chatId, edited.revision, randomUUID())).toThrow('out of date');
    expect(f.state()).toEqual(edited);
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
  it('checks every direct consumer of changed A even when another consumer returns unchanged, and reuses only unchanged input paths', async () => {
    const f = fixture(48); await f.idle(f.start());
    const before = f.state();
    const a = before.context.summaries.find(node => node.level === 1)!;
    f.store.contexts.editSummary(f.chatId, before.revision, a, a.text + ' An incidental word.');
    const queued = repairQueue(f.state().turns, f.state().context);
    const consumers = queued.filter(operation => {
      const node = f.state().context.summaries.find(node => refKey(node) === refKey(operation.repair!))!;
      return [...node.children, ...node.prior].some(ref => ref.id === a.id);
    }).map(operation => operation.repair!.id);
    expect(consumers.length).toBeGreaterThan(1);
    expect(queued.length).toBeGreaterThan(consumers.length);
    f.setMode('unchanged');
    const calls = f.calls.length, id = f.start('repair');
    expect((await f.idle(id)).status).toBe('succeeded');
    const steps = f.store.contexts.steps(id);
    expect(steps.filter(step => step.request).map(step => step.operation.repair!.id).sort()).toEqual(consumers.sort());
    expect(f.calls.length - calls).toBe(consumers.length);
    expect(steps.filter(step => step.repairOutcome === 'model_unchanged')).toHaveLength(consumers.length);
    expect(steps.filter(step => step.repairOutcome === 'inputs_unchanged')).toHaveLength(queued.length - consumers.length);
    expect(f.store.contexts.job(id)).toMatchObject({ unchangedCount: consumers.length, revalidatedCount: queued.length - consumers.length });
    expect(f.store.contexts.job(id).reviewedCount ?? 0).toBe(0);
    expect(f.state().context.summaries.some(node => !node.approved)).toBe(false);
    expect(contextPlan(f.state()).stale).toEqual([]);
    expect(f.state().context.archivedTurnIds).toEqual(before.context.archivedTurnIds);
    expect(f.state().context.selected.map(ref => ref.id)).toEqual(before.context.selected.map(ref => ref.id));
    await f.resume();
    expect(contextPlan(f.state()).stale).toEqual([]);
    expect(f.store.contexts.steps(id)).toEqual(steps);
  });

  it('uses the separate repair prompt, includes only actual accumulated changes, and keeps a new baseline for later repairs', async () => {
    const f = fixture(8); await f.idle(f.start('step'));
    const initial = f.state(), source = initial.turns[0];
    const { id: presetId, revision: _, ...preset } = initial.context.preset!;
    f.store.saveLibrary(f.store.libraries().revision, 'contexts', { ...preset, repairPrompt: 'Only repair the changed detail at level {{level}}. Keep every other word exactly.' }, presetId);
    f.store.editPart(f.state().revision, source.id, 'user', 'First change.', f.chatId);
    f.store.editPart(f.state().revision, source.id, 'user', 'Mira quietly kept the key.', f.chatId);
    f.setMode('near');
    const id = f.start('repair');
    expect((await f.idle(id)).status).toBe('awaiting_review');
    const request = f.store.contexts.steps(id)[0].request!;
    expect(request.body.messages).toHaveLength(2);
    expect(request.body.messages[0].content).toBe('Only repair the changed detail at level 1. Keep every other word exactly.');
    const payload = JSON.parse(request.body.messages[1].content);
    expect(payload.changes).toEqual([expect.objectContaining({ kind: 'user', id: source.id, before: source.user.text, after: 'Mira quietly kept the key.', beforeRevision: 0, afterRevision: 2 })]);
    expect(payload.sources).toBeUndefined();
    expect(payload.previous_summary).toBe(initial.context.summaries[0].text);
    expect(request.summarySources?.[0]).toMatchObject({ turnId: source.id, user: 'Mira quietly kept the key.' });
    expect(JSON.stringify(request.body)).not.toContain('summarySources');
    f.store.contexts.review(id, f.state().revision, true);
    f.store.editPart(f.state().revision, source.id, 'user', 'Mira quietly kept the silver key.', f.chatId);
    f.setMode('unchanged');
    const next = f.start('repair');
    expect((await f.idle(next)).status).toBe('succeeded');
    const change = JSON.parse(f.store.contexts.steps(next)[0].request!.body.messages[1].content).changes[0];
    expect(change).toMatchObject({ before: 'Mira quietly kept the key.', after: 'Mira quietly kept the silver key.', beforeRevision: 2, afterRevision: 3 });
    expect(f.store.contexts.job(next).unchangedCount).toBe(1);
    expect(f.state().context.summaries.filter(node => node.approved).at(-1)!.text).toBe(initial.context.summaries[0].text + '!');
  });

  it('revalidates reverted source text without a model or summarization Connection', async () => {
    const f = fixture(8); await f.idle(f.start('step'));
    const source = f.state().turns[0], before = f.state().context.summaries[0];
    f.store.editPart(f.state().revision, source.id, 'user', source.user.text + ' Temporary word.', f.chatId);
    f.store.editPart(f.state().revision, source.id, 'user', source.user.text, f.chatId);
    const { id, revision: _, ...preset } = f.state().context.preset!;
    f.store.saveLibrary(f.store.libraries().revision, 'contexts', { ...preset, connectionId: null }, id);
    const calls = f.calls.length, job = f.start('repair');
    expect((await f.idle(job)).status).toBe('succeeded');
    expect(f.calls).toHaveLength(calls);
    expect(f.store.contexts.job(job).revalidatedCount).toBe(1);
    const step = f.store.contexts.steps(job)[0];
    expect(step).toMatchObject({ request: null, repairOutcome: 'inputs_unchanged', status: 'saved' });
    const node = f.state().context.summaries.find(node => refKey(node) === refKey(step.result!))!;
    expect(node.text).toBe(before.text); expect(node.turns[0].userRevision).toBe(2);
    expect(f.store.contexts.sourceRequest(f.chatId, node)?.body).toEqual(f.store.contexts.sourceRequest(f.chatId, before)?.body);
    expect(contextPlan(f.state()).stale).toEqual([]);
  });

  it('does not auto-accept identical text when source coverage changed or the old text baseline is unavailable', async () => {
    const f = fixture(8); await f.idle(f.start('step'));
    f.store.deleteTurn(f.state().revision, f.state().turns[0].id, f.chatId);
    f.setMode('unchanged');
    let job = f.start('repair');
    expect((await f.idle(job)).status).toBe('awaiting_review');
    expect(f.store.contexts.steps(job)[0].repairOutcome).toBeUndefined();
    f.store.contexts.review(job, f.state().revision, true);
    f.store.editPart(f.state().revision, f.state().turns[0].id, 'user', 'Another correction.', f.chatId);
    // An older database may lack usable saved source text. This must require review.
    f.store.sqlite.prepare("UPDATE context_steps SET data = json_set(data, '$.request', null)").run();
    job = f.start('repair');
    expect((await f.idle(job)).status).toBe('awaiting_review');
    expect(f.store.contexts.steps(job)[0].repairOutcome).toBeUndefined();
    expect(f.store.contexts.job(job).unchangedCount ?? 0).toBe(0);
  });

  it.each(['model', 'local'] as const)('rolls back automatic %s repair on a persistence failure without retrying', async route => {
    const f = fixture(8); await f.idle(f.start('step'));
    const source = f.state().turns[0];
    f.store.editPart(f.state().revision, source.id, 'user', source.user.text + ' An irrelevant word.', f.chatId);
    if (route === 'local') f.store.editPart(f.state().revision, source.id, 'user', source.user.text, f.chatId);
    const before = f.state(), calls = f.calls.length;
    f.setMode('unchanged');
    f.store.sqlite.exec("CREATE TRIGGER reject_auto_repair BEFORE UPDATE ON context_states BEGIN SELECT RAISE(ABORT, 'synthetic repair persistence failure'); END;");
    const id = f.start('repair');
    expect((await f.idle(id)).status).toBe('failed');
    expect(f.state().context.selected).toEqual(before.context.selected);
    expect(f.state().context.summaries).toEqual(before.context.summaries);
    expect(contextPlan(f.state()).stale.length).toBeGreaterThan(0);
    expect(f.calls.length - calls).toBe(route === 'model' ? 1 : 0);
    f.store.sqlite.exec('DROP TRIGGER reject_auto_repair');
    expect((await f.idle(f.start('repair'))).status).toBe('succeeded');
  });

  it('fails an oversized complete repair change bundle without omitting inputs or calling the model', async () => {
    const f = fixture(8); await f.idle(f.start('step'));
    const summaryId = f.state().context.preset!.connectionId!;
    const { id, revision: _, hasApiKey: __, ...connection } = f.store.libraries().connections.find(connection => connection.id === summaryId)!;
    f.store.saveLibrary(f.store.libraries().revision, 'connections', { ...connection, contextWindow: 1_100 }, id);
    f.store.editPart(f.state().revision, f.state().turns[0].id, 'user', 'Mira kept the key.', f.chatId);
    const before = f.state(), calls = f.calls.length, job = f.start('repair');
    expect((await f.idle(job)).error).toContain('complete input changes');
    expect(f.calls).toHaveLength(calls);
    expect(f.state().context.summaries).toEqual(before.context.summaries);
    expect(f.store.contexts.steps(job)).toEqual([]);
  });

  it('approves and continues one durable queue, using corrected children and idempotent commands', async () => {
    const f = fixture(24); await f.idle(f.start());
    const child = f.state().context.summaries.find(node => node.level === 1)!;
    f.store.contexts.editSummary(f.chatId, f.state().revision, child, 'Mira retained her key. Her sister holds a duplicate.');
    const queue = repairQueue(f.state().turns, f.state().context);
    expect(queue.length).toBeGreaterThan(1);
    expect(new Set(queue.map(operation => refKey(operation.repair!))).size).toBe(queue.length);
    const id = f.start('repair'); await f.idle(id);
    let count = 0;
    while (f.store.contexts.job(id).status === 'awaiting_review' && count < 100) {
      const details = f.store.contexts.details(id);
      expect(details.repair!.remaining).toBeGreaterThan(0);
      expect(details.repair!.previousSources).not.toBeNull();
      const revision = f.state().revision, requestId = randomUUID();
      const text = count === 0 ? 'Mira kept the key. Her sister has a duplicate. Reviewed continuity detail.' : undefined;
      f.coordinator.context.repairAction(id, revision, requestId, 'approve', text);
      const calls = f.calls.length;
      f.coordinator.context.repairAction(id, revision, requestId, 'approve', text);
      expect(f.calls.length).toBe(calls);
      expect(() => f.coordinator.context.repairAction(id, revision, requestId, 'regenerate')).toThrow('another repair command');
      await f.idle(id); count++;
    }
    expect(count).toBe(queue.length);
    expect(f.store.contexts.job(id)).toMatchObject({ status: 'succeeded', reviewedCount: count });
    expect(contextPlan(f.state()).stale).toEqual([]);
    expect(f.calls.some(call => JSON.stringify(call.request.body.messages).includes('Reviewed continuity detail'))).toBe(true);
    expect(f.state().context.summaries.filter(node => !node.approved)).toEqual([]);
  });

  it('keeps a candidate after failed regeneration, replaces it only on success, and discards it on Close', async () => {
    const f = fixture(8); await f.idle(f.start('step'));
    f.store.editPart(f.state().revision, f.state().turns[0].id, 'user', 'Mira kept her key.', f.chatId);
    const id = f.start('repair'); await f.idle(id);
    const candidate = f.state().context.summaries.find(node => !node.approved)!;
    const selection = f.state().context.selected;
    f.setMode('placeholder');
    f.coordinator.context.repairAction(id, f.state().revision, randomUUID(), 'regenerate'); await f.idle(id);
    expect(f.store.contexts.job(id)).toMatchObject({ status: 'awaiting_review' });
    expect(f.store.contexts.job(id).error).toBeTruthy();
    expect(f.state().context.summaries.find(node => refKey(node) === refKey(candidate))).toEqual(candidate);
    await f.resume();
    expect(f.store.contexts.job(id).status).toBe('awaiting_review');
    f.setMode('normal');
    f.coordinator.context.repairAction(id, f.state().revision, randomUUID(), 'regenerate'); await f.idle(id);
    expect(f.store.contexts.steps(id).filter(step => step.status === 'candidate')).toHaveLength(1);
    expect(f.store.contexts.steps(id).filter(step => step.status === 'discarded')).toHaveLength(1);
    expect(f.state().context.summaries.filter(node => !node.approved)).toHaveLength(1);
    f.coordinator.context.repairAction(id, f.state().revision, randomUUID(), 'close');
    expect(f.store.contexts.job(id).status).toBe('cancelled');
    expect(f.state().context.summaries.filter(node => !node.approved)).toEqual([]);
    expect(f.state().context.selected).toEqual(selection);
    const calls = f.calls.length;
    const reopened = f.start('repair'); await f.idle(reopened);
    expect(f.calls.length).toBe(calls + 1);
    expect(f.store.contexts.steps(reopened)[0].operation.repair).toEqual({ id: candidate.id, revision: candidate.revision - 1 });
  });

  it('retains an approval when the next generation fails, and closing prevents a late result from saving', async () => {
    const f = fixture(24); await f.idle(f.start());
    f.store.editPart(f.state().revision, f.state().turns[0].id, 'user', 'Mira kept her key.', f.chatId);
    const id = f.start('repair'); await f.idle(id);
    f.setMode('placeholder');
    f.coordinator.context.repairAction(id, f.state().revision, randomUUID(), 'approve', 'Approved and saved correction.'); await f.idle(id);
    expect(f.store.contexts.job(id)).toMatchObject({ status: 'failed', reviewedCount: 1 });
    expect(f.state().context.summaries.some(node => node.approved && node.text === 'Approved and saved correction.')).toBe(true);
    f.setMode('normal'); f.holdNext();
    f.coordinator.context.repairAction(id, f.state().revision, randomUUID(), 'regenerate');
    expect(f.store.contexts.job(id).status).toBe('running');
    const saved = f.state().context.summaries;
    const requestId = randomUUID(), revision = f.state().revision;
    f.coordinator.context.repairAction(id, revision, requestId, 'close');
    f.coordinator.context.repairAction(id, revision, requestId, 'close');
    f.release(); await new Promise(resolve => setTimeout(resolve, 20));
    expect(f.store.contexts.job(id)).toMatchObject({ status: 'cancelled', reviewedCount: 1 });
    expect(f.state().context.summaries).toEqual(saved);
    expect(f.state().context.jobs.some(job => job.status === 'running')).toBe(false);
  });

  it('cannot approve an old candidate after source changes and a failed regeneration', async () => {
    const f = fixture(8); await f.idle(f.start('step'));
    f.store.editPart(f.state().revision, f.state().turns[0].id, 'user', 'First correction.', f.chatId);
    const id = f.start('repair'); await f.idle(id);
    f.store.editPart(f.state().revision, f.state().turns[0].id, 'user', 'Second correction.', f.chatId);
    expect(() => f.coordinator.context.repairAction(id, f.state().revision, randomUUID(), 'approve')).toThrow('changed');
    f.setMode('placeholder');
    f.coordinator.context.repairAction(id, f.state().revision, randomUUID(), 'regenerate'); await f.idle(id);
    expect(f.store.contexts.job(id).status).toBe('failed');
    expect(f.state().context.summaries.filter(node => !node.approved)).toEqual([]);
    expect(() => f.coordinator.context.repairAction(id, f.state().revision, randomUUID(), 'approve')).toThrow('no longer awaits review');
  });

  it('does not disturb another review when closing or restarting an older failed repair', async () => {
    const f = fixture(8); await f.idle(f.start('step'));
    f.store.editPart(f.state().revision, f.state().turns[0].id, 'user', 'Mira kept her key.', f.chatId);
    f.setMode('placeholder');
    const older = f.start('repair'); await f.idle(older);
    f.setMode('normal');
    const current = f.start('repair'); await f.idle(current);
    expect(() => f.coordinator.context.repairAction(older, f.state().revision, randomUUID(), 'regenerate')).toThrow('Another repair');
    const saved = f.state();
    f.coordinator.context.repairAction(older, 0, randomUUID(), 'close');
    expect(f.state().revision).toBe(saved.revision);
    expect(f.state().context.summaries).toEqual(saved.context.summaries);
    expect(f.store.contexts.job(current).status).toBe('awaiting_review');
    f.coordinator.context.repairAction(current, f.state().revision, randomUUID(), 'approve'); await f.idle(current);
    expect(f.store.contexts.job(current).status).toBe('succeeded');
  });

  it('recovers a candidate after interrupted regeneration without orphaning it', async () => {
    const f = fixture(8); await f.idle(f.start('step'));
    f.store.editPart(f.state().revision, f.state().turns[0].id, 'user', 'Mira kept her key.', f.chatId);
    const id = f.start('repair'); await f.idle(id);
    const candidate = f.state().context.summaries.find(node => !node.approved)!;
    f.holdNext();
    f.coordinator.context.repairAction(id, f.state().revision, randomUUID(), 'regenerate');
    // Persist the same interruption transition used on restart before releasing the late stream.
    f.store.contexts.finish(id, 'interrupted', 'Synthetic server interruption.');
    f.release(); await new Promise(resolve => setTimeout(resolve, 20));
    await f.resume();
    expect(f.store.contexts.job(id).status).toBe('awaiting_review');
    expect(f.state().context.summaries.find(node => refKey(node) === refKey(candidate))).toEqual(candidate);
    expect(() => f.start('repair')).toThrow('existing repair candidate');
    f.coordinator.context.repairAction(id, f.state().revision, randomUUID(), 'close');
    expect(f.state().context.summaries.filter(node => !node.approved)).toEqual([]);
  });

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
    const selected = new Set(f.state().context.selected.map(refKey));
    const child = f.state().context.summaries.find(node => node.level === 1 && !selected.has(refKey(node)))!;
    expect(child).toBeDefined();
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
