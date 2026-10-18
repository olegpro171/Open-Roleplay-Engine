import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/persistence/store.js';
import { defaultContextPreset, emptyContextState, type SummaryNode } from '../src/shared/context.js';
import { defaultPrompt, type Character, type ImportedTurn, type PromptPreset } from '../src/shared/library.js';
import { newLorebook, newLoreEntry, type LoreEntry } from '../src/shared/lorebook.js';
import type { ChatSnapshot } from '../src/shared/contracts.js';
import { assembleRequest } from '../src/core/prompt.js';
import { contextPlan, summaryRequest } from '../src/core/context-plan.js';
import { refreshContext } from '../src/core/context-refresh.js';
import { savedReplacement } from '../src/core/context-reuse.js';
import { sourceOf } from '../src/core/context.js';
import { parseLoreDirectives } from '../src/core/lorebook-directives.js';
import { LoreRegexPool } from '../src/server/lore-regex.js';
import { resolveRequestLore } from '../src/server/lore-resolution.js';
import { GenerationCoordinator } from '../src/server/coordinator.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
const loreEntry = (id: string, patch: Partial<LoreEntry> = {}): LoreEntry => ({ ...newLoreEntry(id), name: id, keys: ['ancient-key'], content: 'LIVE LORE ONLY: the key opens the northern vault.', ...patch });
const card: Character = { name: 'Mira', description: 'Description', personality: 'Personality', scenario: 'Scenario', first_mes: '', mes_example: '' };
const connection = { name: 'Synthetic only', endpoint: 'http://localhost:1234/v1', model: 'synthetic', contextWindow: 100000, maxOutputTokens: 100, customParameters: {} };
const initialTurns: ImportedTurn[] = Array.from({ length: 6 }, (_, index) => ({ user: `${index === 0 ? 'ancient-key' : `user-${index}`} ${'Original source detail. '.repeat(30)}`, assistant: `answer-${index} ${'Original reply detail. '.repeat(30)}`, complete: true }));

function fixture(entries: LoreEntry[] = [loreEntry('key')], prompt: PromptPreset = defaultPrompt, turns: ImportedTurn[] = initialTurns) {
  const directory = mkdtempSync(join(tmpdir(), 'roleplay-lore-integration-'));
  const store = new Store(join(directory, 'chat.sqlite'));
  const pool = new LoreRegexPool();
  cleanup.push(async () => { await pool.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const connectionId = store.saveLibrary(store.libraries().revision, 'connections', connection);
  const contextId = store.saveLibrary(store.libraries().revision, 'contexts', { ...defaultContextPreset, minTail: 2, batchSize: 2, promotionGroup: 2, retainedPerLevel: 0, connectionId });
  const lorebookId = store.saveLibrary(store.libraries().revision, 'lorebooks', { ...newLorebook(), scanDepth: 20, recursiveScanning: true, entries });
  const characterId = store.saveLibrary(store.libraries().revision, 'characters', card);
  const promptId = store.saveLibrary(store.libraries().revision, 'prompts', prompt);
  const chatId = store.createChat({ title: 'Synthetic lore integration', targetInputTokens: 50000, connectionId, contextPresetId: contextId, promptId, characterId, personaId: null, lorebookId });
  store.replaceHistory(store.snapshot(chatId).revision, chatId, turns);
  const snapshot = () => store.snapshot(chatId);
  const withLore = async (input: ChatSnapshot = snapshot()): Promise<ChatSnapshot> => ({ ...input, loreResolution: await resolveRequestLore(input, pool) });
  return { store, pool, chatId, snapshot, withLore };
}

function selectedMemory(f: ReturnType<typeof fixture>) {
  const turns = f.snapshot().turns;
  const leaves: SummaryNode[] = [0, 2].map((start, index) => ({ id: `leaf-${index}`, revision: 0, level: 1,
    turns: turns.slice(start, start + 2).map(sourceOf), children: [], prior: [], approved: true, manual: false, createdAt: '2026-10-18T00:00:00.000Z',
    text: `Saved leaf ${index}. ${'Relevant saved continuity. '.repeat(30)}` }));
  const parent: SummaryNode = { ...leaves[0], id: 'parent', level: 2, text: 'The companions retain their promise.', turns: leaves.flatMap(node => node.turns), children: leaves.map(({ id, revision }) => ({ id, revision })) };
  for (const node of [...leaves, parent]) f.store.sqlite.prepare('INSERT INTO summaries (id, revision, chat_id, data) VALUES (?, ?, ?, ?)').run(node.id, node.revision, f.chatId, JSON.stringify(node));
  f.store.sqlite.prepare('INSERT INTO context_states (chat_id, revision, data) VALUES (?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET revision=excluded.revision, data=excluded.data').run(f.chatId, 1, JSON.stringify({ selected: leaves.map(({ id, revision }) => ({ id, revision })), archivedTurnIds: turns.slice(0, 4).map(turn => turn.id) }));
  return { leaves, parent };
}

function measure(snapshot: ChatSnapshot) {
  if (!snapshot.connection) throw new Error('The fixture must have a Connection.');
  return assembleRequest(snapshot.connection, snapshot.settings, snapshot.turns, snapshot.sources, snapshot.context, { validateLimits: false, lore: snapshot.loreResolution });
}

describe('frozen lore across request and memory representations', () => {
  it('keeps archived original triggers in required-input checks using reduced verbatim history', async () => {
    const f = fixture([loreEntry('key', { content: 'LIVE LORE ONLY '.repeat(200) })]);
    selectedMemory(f);
    const snapshot = await f.withLore();
    if (!snapshot.connection || !snapshot.loreResolution) throw new Error('The fixture must resolve lore.');
    const tail = snapshot.turns.slice(4);
    const required = assembleRequest(snapshot.connection, snapshot.settings, tail, snapshot.sources, emptyContextState(), { validateLimits: false, lore: snapshot.loreResolution });
    expect(required.body.messages.some(message => message.content === snapshot.loreResolution?.outcomes[0].text)).toBe(true);
    const constrained = { ...snapshot, settings: { ...snapshot.settings, targetInputTokens: required.budget.inputTokens - 1 } };
    const plan = contextPlan(constrained);
    expect(plan.ready).toBe(false);
    expect(plan.next).toBeNull();
    expect(plan.blocked).toContain('required verbatim');
    expect(snapshot.loreResolution.scan.map(message => message.turnId)).toContain(snapshot.turns[0].id);
    expect(required.lore).toEqual(snapshot.loreResolution);
    const noLore = assembleRequest(snapshot.connection, constrained.settings, tail, { ...snapshot.sources, lorebook: null }, emptyContextState(), { validateLimits: false });
    expect(noLore.budget.inputTokens).toBeLessThan(constrained.settings.targetInputTokens);
  });

  it('uses the same lore in saved reuse, manual reselection and complete-request savings', async () => {
    const f = fixture();
    const { leaves, parent } = selectedMemory(f);
    const snapshot = await f.withLore();
    const parentState = { ...snapshot.context, selected: [{ id: parent.id, revision: parent.revision }] };
    const parentRequest = measure({ ...snapshot, context: parentState });
    const constrained = { ...snapshot, settings: { ...snapshot.settings, targetInputTokens: parentRequest.budget.inputTokens } };
    const operation = { level: 2, turnIds: parent.turns.map(source => source.turnId), children: leaves.map(({ id, revision }) => ({ id, revision })) };
    const replacement = savedReplacement(constrained, operation);
    expect(replacement?.node.id).toBe(parent.id);
    expect(replacement?.inputAfter).toBe(parentRequest.budget.inputTokens);
    const refreshed = refreshContext(constrained);
    expect(refreshed.state.selected).toEqual([{ id: parent.id, revision: parent.revision }]);
    expect(refreshed.report.inputAfter).toBe(parentRequest.budget.inputTokens);
    expect(refreshed.report.inputBefore).toBe(measure(snapshot).budget.inputTokens);
    expect(refreshed.report.inputAfter).toBeLessThan(refreshed.report.inputBefore);
    const outgoing = measure({ ...constrained, context: { ...constrained.context, ...refreshed.state } });
    expect(outgoing.body.messages.filter(message => message.content.startsWith('LIVE LORE ONLY'))).toHaveLength(1);
    expect(outgoing.lore).toEqual(snapshot.loreResolution);
    expect(f.snapshot().loreState?.entries).toEqual({});
    expect(f.snapshot().context.selected).toEqual(leaves.map(({ id, revision }) => ({ id, revision })));
  });

  it('lets pending input trigger required fixed lore before memory planning', async () => {
    const f = fixture([loreEntry('pending', { keys: ['pending-key'], content: 'Pending input lore. '.repeat(100) })], defaultPrompt, [...initialTurns.map(value => ({ ...value, user: value.user.replace('ancient-key', 'ordinary') })), { user: 'pending-key', assistant: '', complete: false }]);
    const before = f.snapshot();
    const noLorePlan = contextPlan({ ...before, sources: { ...before.sources, lorebook: null } });
    const snapshot = await f.withLore(before);
    const complete = measure(snapshot);
    const constrained = { ...snapshot, settings: { ...snapshot.settings, targetInputTokens: noLorePlan.inputTokens } };
    const plan = contextPlan(constrained);
    expect(snapshot.loreResolution?.outcomes[0].status).toBe('admitted');
    expect(snapshot.loreResolution?.scan.at(-1)?.partId).toBe(snapshot.turns.at(-1)?.user.id);
    expect(plan.inputTokens).toBe(complete.budget.inputTokens);
    expect(plan.inputTokens).toBeGreaterThan(constrained.settings.targetInputTokens);
    expect(plan.ready).toBe(false);
    expect(plan.next?.level).toBe(1);
    expect(f.snapshot()).toEqual(before);
  });

  it('keeps lore from excluded original history while recent mode selects a whole-turn suffix', async () => {
    const recentPrompt = { ...defaultPrompt, blocks: defaultPrompt.blocks.filter(block => block.kind !== 'marker' || block.marker !== 'summary') };
    const f = fixture([loreEntry('original-trigger')], recentPrompt, [...initialTurns.slice(0, 3), { user: 'pending', assistant: '', complete: false }]);
    const initial = await f.withLore();
    const newest = { ...initial, turns: initial.turns.slice(-2) };
    const exact = measure(newest).budget.inputTokens;
    const snapshot = await f.withLore({ ...f.snapshot(), settings: { ...f.snapshot().settings, targetInputTokens: exact } });
    const request = measure(snapshot);
    expect(request.history?.mode).toBe('recent');
    expect(request.history?.verbatimTurnIds).toEqual(snapshot.turns.slice(-2).map(turn => turn.id));
    expect(request.budget.inputTokens).toBe(exact);
    expect(request.body.messages.some(message => message.content.startsWith('ancient-key'))).toBe(false);
    expect(request.body.messages.filter(message => message.content.startsWith('LIVE LORE ONLY'))).toHaveLength(1);
    expect(snapshot.loreResolution?.pressure).toBe(true);
    expect(f.snapshot().context.archivedTurnIds).toEqual([]);
  });

  it('recomputes pressure-optional recursion once, then freezes exclusions under later representations', async () => {
    const f = fixture([loreEntry('optional', { content: '@@ignore_on_max_context\nrecursive-child-key ' + 'Long optional lore. '.repeat(100) }), loreEntry('child', { keys: ['recursive-child-key'], content: 'Dependent recursive lore.' })]);
    const base = f.snapshot();
    const without = measure({ ...base, sources: { ...base.sources, lorebook: null } });
    const constrained = { ...base, settings: { ...base.settings, targetInputTokens: without.budget.inputTokens } };
    const snapshot = await f.withLore(constrained);
    expect(snapshot.loreResolution?.pressure).toBe(true);
    expect(snapshot.loreResolution?.outcomes.map(value => [value.name, value.status, value.reason])).toEqual([['optional', 'excluded', 'pressure'], ['child', 'excluded', 'no_match']]);
    const relaxed = measure({ ...snapshot, settings: { ...snapshot.settings, targetInputTokens: 50000 } });
    expect(relaxed.body.messages.some(message => message.content.includes('Dependent recursive lore.'))).toBe(false);
    expect(relaxed.lore).toEqual(snapshot.loreResolution);
    expect(f.snapshot().loreState?.entries).toEqual({});
  });

  it('keeps live lore out of extraction, promotion and repair requests', async () => {
    const f = fixture();
    const { leaves } = selectedMemory(f);
    const snapshot = await f.withLore();
    if (!snapshot.connection) throw new Error('The fixture must have a Connection.');
    const extractionOperation = { level: 1, turnIds: snapshot.turns.slice(0, 2).map(turn => turn.id), children: [] };
    const extraction = summaryRequest(snapshot, extractionOperation, snapshot.connection).request;
    const promotion = summaryRequest(snapshot, { level: 2, turnIds: snapshot.turns.slice(0, 4).map(turn => turn.id), children: leaves.map(({ id, revision }) => ({ id, revision })) }, snapshot.connection).request;
    const edited = { ...snapshot, turns: snapshot.turns.map((turn, index) => index ? turn : { ...turn, user: { ...turn.user, revision: turn.user.revision + 1, text: turn.user.text + ' Corrected possession.' } }) };
    const repair = summaryRequest(edited, { ...extractionOperation, repair: { id: leaves[0].id, revision: leaves[0].revision } }, snapshot.connection, new Map(), extraction).request;
    for (const request of [extraction, promotion, repair]) {
      expect(JSON.stringify(request.body)).not.toContain('LIVE LORE ONLY');
      expect(request.lore).toBeUndefined();
    }
    expect(JSON.stringify(repair.body)).toContain('Corrected possession.');
    expect(JSON.stringify(promotion.body)).toContain(leaves[0].text);
  });
});

describe('lore placement in authoritative outgoing messages', () => {
  it('places roles, first composite field anchors, repeated character sources and clamped history depths exactly', async () => {
    const prompt = { ...defaultPrompt, blocks: defaultPrompt.blocks.filter(block => block.id !== 'instructions' && block.id !== 'persona' && block.id !== 'summary') };
    const messageIndex = prompt.blocks.findIndex(block => block.id === 'messages');
    prompt.blocks.splice(messageIndex, 0, { id: 'repeat-character', name: 'Repeated Character', enabled: true, kind: 'marker', marker: 'character', role: 'system' });
    const entries = [
      loreEntry('before', { constant: true, placement: 'before_char', role: 'user', content: 'Before' }),
      loreEntry('before-desc', { constant: true, placement: 'before_desc', role: 'assistant', content: 'Field before' }),
      loreEntry('after-desc', { constant: true, placement: 'after_desc', content: 'Field after' }),
      loreEntry('personality', { constant: true, placement: 'personality', content: 'Personality lore' }),
      loreEntry('scenario', { constant: true, placement: 'scenario', role: 'user', content: 'Scenario lore' }),
      loreEntry('after', { constant: true, content: 'After' }),
      loreEntry('old', { constant: true, placement: 'history', depth: 99, role: 'user', content: 'Oldest lore' }),
      loreEntry('one', { constant: true, placement: 'history', depth: 1, content: 'Before pending' }),
      loreEntry('zero', { constant: true, placement: 'history', depth: 0, role: 'assistant', content: 'Newest lore' }),
    ];
    const f = fixture(entries, prompt, [{ user: 'trigger', assistant: 'reply', complete: true }, { user: 'pending', assistant: '', complete: false }]);
    const snapshot = await f.withLore();
    expect(measure(snapshot).body.messages).toEqual([
      { role: 'user', content: 'Before' }, { role: 'system', content: 'Mira' },
      { role: 'assistant', content: 'Field before' }, { role: 'system', content: 'Description' }, { role: 'system', content: 'Field after' },
      { role: 'system', content: 'Personality' }, { role: 'system', content: 'Personality lore' },
      { role: 'system', content: 'Scenario' }, { role: 'user', content: 'Scenario lore' },
      { role: 'system', content: 'After' }, { role: 'system', content: 'Mira\n\nDescription\n\nPersonality\n\nScenario' },
      { role: 'user', content: 'Oldest lore' }, { role: 'user', content: 'trigger' }, { role: 'assistant', content: 'reply' },
      { role: 'system', content: 'Before pending' }, { role: 'user', content: 'pending' }, { role: 'assistant', content: 'Newest lore' },
    ]);
  });

  it('counts depth using nonblank original messages while preserving untouched blank outgoing parts', async () => {
    const prompt = { ...defaultPrompt, blocks: defaultPrompt.blocks.filter(block => block.kind === 'marker' && (block.marker === 'messages' || block.marker === 'lore_history')) };
    const f = fixture([
      loreEntry('old', { constant: true, placement: 'history', depth: 99, content: 'Old lore' }),
      loreEntry('one', { constant: true, placement: 'history', depth: 1, content: 'Before reply' }),
      loreEntry('zero', { constant: true, placement: 'history', depth: 0, content: 'After reply' }),
    ], prompt, [{ user: 'trigger', assistant: 'reply', complete: true }, { user: ' ', assistant: '\n', complete: true }, { user: '\t', assistant: '', complete: false }]);
    const snapshot = await f.withLore();
    expect(measure(snapshot).body.messages).toEqual([
      { role: 'system', content: 'Old lore' }, { role: 'user', content: 'trigger' },
      { role: 'system', content: 'Before reply' }, { role: 'assistant', content: 'reply' },
      { role: 'system', content: 'After reply' }, { role: 'user', content: ' ' },
      { role: 'assistant', content: '\n' }, { role: 'user', content: '\t' },
    ]);
    const noLore = measure({ ...snapshot, sources: { ...snapshot.sources, lorebook: null }, loreResolution: undefined });
    expect(noLore.body.messages).toEqual([
      { role: 'user', content: 'trigger' }, { role: 'assistant', content: 'reply' },
      { role: 'user', content: ' ' }, { role: 'assistant', content: '\n' }, { role: 'user', content: '\t' },
    ]);
  });

  it('allows anchored lore without Messages and omits unauthorized destinations before recursion/cap', async () => {
    const prompt = { ...defaultPrompt, blocks: defaultPrompt.blocks.filter(block => block.id !== 'instructions' && block.id !== 'messages' && block.id !== 'summary' && block.id !== 'lore-before') };
    const f = fixture([loreEntry('field', { placement: 'after_desc', content: 'Anchored lore.' }), loreEntry('blocked', { placement: 'before_char', content: 'blocked-child-key' }), loreEntry('child', { keys: ['blocked-child-key'], content: 'Should not activate.' })], prompt);
    const snapshot = await f.withLore();
    const request = measure(snapshot);
    expect(request.body.messages).toEqual([{ role: 'system', content: 'Mira\n\nDescription' }, { role: 'system', content: 'Anchored lore.' }, { role: 'system', content: 'Personality\n\nScenario' }]);
    expect(snapshot.loreResolution?.outcomes.map(value => value.reason)).toEqual(['keyword', 'unavailable_destination', 'no_match']);
    expect(request.history?.verbatimTurnIds).toEqual([]);
  });

  it('leaves provider messages, estimates and layout unchanged when lore controls insert nothing', async () => {
    const f = fixture([]);
    const snapshot = await f.withLore();
    if (!snapshot.sources.prompt) throw new Error('Fixture preset missing.');
    const withControls = measure(snapshot);
    const baseline = measure({ ...snapshot, sources: { ...snapshot.sources, lorebook: null, prompt: { ...snapshot.sources.prompt, blocks: snapshot.sources.prompt.blocks.filter(block => block.kind !== 'marker' || !block.marker.startsWith('lore_')) } }, loreResolution: undefined });
    expect(JSON.stringify(withControls.body)).toBe(JSON.stringify(baseline.body));
    expect(withControls.budget).toEqual(baseline.budget);
    expect(withControls.layout).toEqual(baseline.layout);
  });

  it('rejects excessive decorator control lines before resolution or a paid call', () => {
    expect(() => parseLoreDirectives('@@activate\n'.repeat(257) + 'Prose', 'entry', () => true)).toThrow(expect.objectContaining({ code: 'lore_directive_limit', status: 422 }));
  });
});

describe('lore asynchronous preflight lifecycle', () => {
  it('rejects shutdown during preflight without creating a context job or making a provider request', async () => {
    const f = fixture([]);
    const provider = { stream: vi.fn(async () => { throw new Error('Unexpected synthetic provider request.'); }) };
    const coordinator = new GenerationCoordinator(f.store, provider);
    cleanup.push(() => coordinator.shutdown());
    const before = f.snapshot();
    const start = coordinator.context.startResolved(f.chatId, before.revision, randomUUID(), 'prepare');
    const rejected = expect(start).rejects.toMatchObject({ code: 'server_stopping', status: 503 });
    await coordinator.shutdown();
    await rejected;
    expect(f.snapshot()).toEqual(before);
    expect(f.store.contexts.running(f.chatId)).toBe(false);
    expect(provider.stream).not.toHaveBeenCalled();
    expect(() => coordinator.start(before.revision, randomUUID(), 'Input', f.chatId)).toThrow(expect.objectContaining({ code: 'server_stopping' }));
    await expect(coordinator.context.startResolved(f.chatId, before.revision, randomUUID(), 'prepare')).rejects.toMatchObject({ code: 'server_stopping' });
  });
});

describe('isolated bounded lore regex workers', () => {
  function poolFixture() {
    const pool = new LoreRegexPool();
    cleanup.push(() => pool.close());
    return pool;
  }

  it('supports Unicode, case policy and explicit flags while rejecting all invalid patterns and flags', async () => {
    const matcher = poolFixture().matcher();
    expect(await matcher(['^ПРИВЕТ$'], ['привет'], false)).toEqual({ matched: true });
    expect(await matcher(['\\p{Script=Cyrillic}+'], ['Ёж'], true)).toEqual({ matched: true });
    expect(await matcher(['/^HELLO$/u'], ['hello'], false)).toEqual({ matched: false });
    expect(await matcher(['/^HELLO$/iu'], ['hello'], true)).toEqual({ matched: true });
    expect(await matcher(['^safe$', '['], ['safe'], true)).toMatchObject({ matched: false, invalid: expect.any(String) });
    expect(await matcher(['/a/uv'], ['a'], true)).toMatchObject({ matched: false, invalid: expect.any(String) });
  });

  it('terminates catastrophic backtracking and recovers with a subsequent isolated task', async () => {
    const matcher = poolFixture().matcher();
    await expect(matcher(['(a+)+$'], ['a'.repeat(40000) + '!'], true)).rejects.toMatchObject({ code: 'lore_regex_timeout', status: 422 });
    expect(await matcher(['^safe$'], ['safe'], true)).toEqual({ matched: true });
  });

  it('cancels work and supports later requests without retaining the cancelled worker', async () => {
    const pool = poolFixture();
    const controller = new AbortController();
    const task = pool.matcher(controller.signal)(['(a+)+$'], ['a'.repeat(40000) + '!'], true);
    const cancelled = expect(task).rejects.toMatchObject({ code: 'lore_cancelled', status: 409 });
    controller.abort();
    await cancelled;
    expect(await pool.matcher()(['safe'], ['safe'], true)).toEqual({ matched: true });
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(pool.matcher(alreadyAborted.signal)(['safe'], ['safe'], true)).rejects.toMatchObject({ code: 'lore_cancelled' });
  });

  it('cancels a queued task and bounds queue capacity while independent workers are busy', async () => {
    const pool = poolFixture();
    const matcher = pool.matcher();
    const text = 'a'.repeat(40000) + '!';
    const active = Array.from({ length: 2 }, () => matcher(['(a+)+$'], [text], true).then(() => 'unexpected success', (error: { code: string }) => error.code));
    const controller = new AbortController();
    const queued = pool.matcher(controller.signal)(['safe'], ['safe'], true);
    const cancelled = expect(queued).rejects.toMatchObject({ code: 'lore_cancelled' });
    controller.abort();
    await cancelled;
    expect(await Promise.all(active)).toEqual(['lore_regex_timeout', 'lore_regex_timeout']);
    expect(await matcher(['^safe$'], ['safe'], true)).toEqual({ matched: true });
    const accepted = Array.from({ length: 34 }, () => matcher(['(a+)+$'], [text], true).then(() => 'unexpected success', (error: { code: string }) => error.code));
    await expect(matcher(['safe'], ['safe'], true)).rejects.toMatchObject({ code: 'lore_busy', status: 503 });
    await pool.close();
    expect(await Promise.all(accepted)).toEqual(Array.from({ length: 34 }, () => 'lore_cancelled'));
  });

  it('enforces the matcher deadline after queued work has waited behind busy workers', async () => {
    const pool = poolFixture();
    const originalTime = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(originalTime);
    try {
      const matcher = pool.matcher();
      const busy = Array.from({ length: 2 }, () => matcher(['(a+)+$'], ['a'.repeat(40000) + '!'], true).then(() => 'unexpected success', (error: { code: string }) => error.code));
      const queued = matcher(['^safe$'], ['safe'], true);
      const expired = expect(queued).rejects.toMatchObject({ code: 'lore_regex_timeout', status: 422 });
      clock.mockReturnValue(originalTime + 5001);
      await expired;
      expect(await Promise.all(busy)).toEqual(['lore_regex_timeout', 'lore_regex_timeout']);
    } finally { clock.mockRestore(); }
    expect(await pool.matcher()(['^safe$'], ['safe'], true)).toEqual({ matched: true });
  });

  it('closes both active and queued work as cancellation and rejects future work', async () => {
    const pool = poolFixture();
    const matcher = pool.matcher();
    const tasks = Array.from({ length: 3 }, () => matcher(['(a+)+$'], ['a'.repeat(40000) + '!'], true));
    const observed = tasks.map(task => task.then(() => 'unexpected success', (error: { code: string }) => error.code));
    await pool.close();
    expect(await Promise.all(observed)).toEqual(['lore_cancelled', 'lore_cancelled', 'lore_cancelled']);
    await expect(matcher(['safe'], ['safe'], true)).rejects.toMatchObject({ code: 'lore_cancelled' });
  });
});
