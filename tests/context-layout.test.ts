import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { sourceOf, staleSummaries } from '../src/core/context.js';
import { correctionProtection } from '../src/core/context-corrections.js';
import { inspectPreparation } from '../src/core/context-replay.js';
import { contextPlan } from '../src/core/context-plan.js';
import { assembleRequest } from '../src/core/prompt.js';
import { regenerationView } from '../src/core/regeneration.js';
import { validateContent } from '../src/persistence/backup-validation.js';
import { Store } from '../src/persistence/store.js';
import type { Provider } from '../src/provider/openai.js';
import { GenerationCoordinator } from '../src/server/coordinator.js';
import { defaultContextPreset, refKey, type SummaryNode } from '../src/shared/context.js';
import type { RequestPreview } from '../src/shared/contracts.js';
import { compactPrompt } from './support/compact-prompt.js';
import { seedTranscript } from './support/transcript-fixture.js';

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of disposals.splice(0)) await dispose(); });

function transcript(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    user: `Chapter ${i + 1}. ${'Mira crossed the bridge with the brass key. '.repeat(16)}`,
    assistant: 'Leon waited for her return. '.repeat(10), complete: true,
  }));
}

function fixture(count: number, minTail: number, targetInputTokens = 110, turns = transcript(count), output = 'Mira brought the key across the bridge.') {
  const directory = mkdtempSync(join(tmpdir(), 'ore-context-layout-'));
  const filename = join(directory, 'layout.sqlite');
  let store = new Store(filename);
  store.saveLibrary(store.libraryRevision(), 'prompts', compactPrompt, 'default');
  const connectionId = store.saveLibrary(store.libraryRevision(), 'connections', { name: 'Mock', endpoint: 'http://127.0.0.1/v1', model: 'mock', contextWindow: 100_000, maxOutputTokens: 1000, customParameters: {} });
  const preset = { ...defaultContextPreset, batchSize: 3, promotionGroup: 3, retainedPerLevel: 0, minTail };
  const contextPresetId = store.saveLibrary(store.libraryRevision(), 'contexts', preset);
  const settings = { title: 'Bridge chronicle', targetInputTokens, connectionId, promptId: 'default', characterId: null, personaId: null, contextPresetId };
  const chatId = store.createChat(settings);
  seedTranscript(store, store.engineSnapshot(chatId).revision, chatId, turns);
  const calls: RequestPreview[] = [];
  const provider: Provider = { async stream(request, _key, _signal, onText) {
    calls.push(request);
    onText(output);
    return { finishReason: 'stop' };
  } };
  let coordinator = new GenerationCoordinator(store, provider);
  const state = (id: string = chatId) => store.engineSnapshot(id);
  const step = async (id: string = chatId) => {
    const { jobId } = coordinator.context.start(id, state(id).revision, randomUUID(), 'step');
    await expect.poll(() => store.contexts.job(jobId).status).not.toBe('running');
    expect(store.contexts.job(jobId).status).toBe('succeeded');
    const [saved] = store.contexts.steps(jobId);
    expect(saved.status).toBe('saved');
    return saved;
  };
  const reopen = async () => {
    await coordinator.shutdown();
    store.close();
    store = new Store(filename);
    coordinator = new GenerationCoordinator(store, provider);
  };
  disposals.push(async () => { await coordinator.shutdown(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { get store() { return store; }, get coordinator() { return coordinator; }, state, step, reopen, calls, chatId, preset, settings, contextPresetId };
}

it('replays fine memory before promoting when lowering a 15-turn tail makes another batch eligible', async () => {
  const turns = Array.from({ length: 36 }, (_, index) => ({
    user: `Chapter ${index + 1}.` + ' Mira watched the lantern and waited.'.repeat(index >= 27 ? 307 : index >= 24 ? 338 : index >= 21 ? 140 : 338),
    assistant: 'Leon kept watch.', complete: true,
  }));
  const output = 'Mira brought the key across the bridge. ' + Array.from({ length: 100 }, (_, i) => `Ada catalogued relic ${i}.`).join(' ');
  const f = fixture(36, 15, 32_000, turns, output);
  const prepare = async () => {
    const { jobId } = f.coordinator.context.start(f.chatId, f.state().revision, randomUUID(), 'prepare');
    await expect.poll(() => f.store.contexts.job(jobId).status).toBe('succeeded');
    return f.store.contexts.job(jobId);
  };
  await prepare();
  const first = f.state();
  if (!first.connection) throw new Error('Missing story Connection');
  expect(first.context.archivedTurnIds).toHaveLength(21);
  expect(first.context.selected.some(ref => first.context.summaries.find(node => node.id === ref.id)?.level === 2)).toBe(true);
  expect(first.context.summaries.filter(node => node.level === 1)).toHaveLength(7);
  const callsBefore = f.calls.length;
  expect(callsBefore).toBe(9);
  f.store.saveLibrary(f.store.libraryRevision(), 'contexts', { ...f.preset, minTail: 5 }, f.contextPresetId);
  const anticipated = inspectPreparation(f.state());
  expect(anticipated.plan.next?.turnIds).toEqual(first.turns.slice(21, 24).map(turn => turn.id));
  expect(anticipated.plan.inputTokens).toBeGreaterThan(assembleRequest(first.connection, first.settings, first.turns, first.sources, first.context).budget.inputTokens);
  const replay = await prepare();
  const after = f.state();
  expect(after.context.archivedTurnIds).toEqual(after.turns.slice(0, 27).map(turn => turn.id));
  expect(after.context.selected).toEqual(after.context.summaries.filter(node => node.level === 1).map(({ id, revision }) => ({ id, revision })));
  expect(f.calls.slice(callsBefore).map(request => request.coverage?.map(source => source.turnId))).toEqual([21, 24].map(start => after.turns.slice(start, start + 3).map(turn => turn.id)));
  const steps = f.store.contexts.steps(replay.id);
  expect(steps[0].inputBefore).toBe(anticipated.plan.inputTokens);
  expect(steps[0].inputAfter).toBeGreaterThan(32_200);
  expect(steps[0].inputAfter).toBeLessThan(32_600);
  expect(steps[1].inputAfter).toBeLessThan(32_000);
  const repeated = await prepare();
  expect(f.calls).toHaveLength(callsBefore + 2);
  expect(f.state().context.revision).toBe(after.context.revision);
  expect(f.state().context.selected).toEqual(after.context.selected);
  expect(f.store.contexts.steps(repeated.id)).toEqual([]);
});

it('promotes a corrected leaf through L2 and L3 and blocks replay when that retained leaf is edited again', async () => {
  const output = 'Mira brought the key across the bridge.';
  const f = fixture(28, 1, 110, transcript(28), output);
  const leaf = await f.step();
  const beforeEdit = f.state();
  if (!leaf.result) throw new Error('The first batch was not saved');
  const corrected = f.store.contexts.editSummary(f.chatId, beforeEdit.revision, leaf.result, 'Ada owns the original key. Mira carries the silver duplicate.');
  const before = f.state();
  if (!before.connection) throw new Error('Missing story Connection');
  const expectedParent: SummaryNode = {
    id: randomUUID(), revision: 0, level: 3, text: output, turns: before.turns.slice(0, 27).map(sourceOf),
    children: [], prior: [], approved: true, manual: false, createdAt: '2026-10-20T00:00:00Z',
  };
  const context = { ...before.context, summaries: [expectedParent], selected: [expectedParent], archivedTurnIds: expectedParent.turns.map(turn => turn.turnId) };
  const target = assembleRequest(before.connection, before.settings, before.turns, before.sources, context, { validateLimits: false }).budget.inputTokens;
  f.store.updateChat(before.revision, f.chatId, { ...f.settings, targetInputTokens: target });
  const prepare = () => f.coordinator.context.start(f.chatId, f.state().revision, randomUUID(), 'prepare').jobId;
  const jobId = prepare();
  await expect.poll(() => f.store.contexts.job(jobId).status).toBe('succeeded');
  const saved = f.state();
  const protection = correctionProtection(saved.turns, saved.context);
  const l2 = saved.context.summaries.find(node => node.level === 2 && node.children.some(ref => refKey(ref) === refKey(corrected)));
  const l3 = saved.context.summaries.find(node => node.level === 3);
  if (!l2 || !l3 || !saved.connection) throw new Error('Expected both promotion levels and a story Connection');
  expect(l3.children.map(refKey)).toContain(refKey(l2));
  expect(protection.represented(l3).has(refKey(corrected))).toBe(true);
  expect(saved.context.selected.map(refKey)).toEqual([refKey(l3)]);
  expect(saved.context.archivedTurnIds).toEqual(context.archivedTurnIds);
  expect(protection.unresolved).toEqual([]);
  expect(f.calls).toHaveLength(13);
  expect(assembleRequest(saved.connection, saved.settings, saved.turns, saved.sources, saved.context).body.messages
    .filter(part => part.content.startsWith('[Memory')).map(part => part.content)).toEqual([`[Memory L3 · turns 1–27]\n${output}`]);

  const editedAgain = f.store.contexts.editSummary(f.chatId, saved.revision, corrected, 'Ada keeps the silver duplicate with Mira’s permission.');
  const edited = f.state();
  const stale = staleSummaries(edited.turns, edited.context);
  expect(stale.has(refKey(l2))).toBe(true);
  expect(stale.has(refKey(l3))).toBe(true);
  const plan = inspectPreparation(edited).plan;
  expect(plan.ready).toBe(false);
  expect(plan.repairCount).toBeGreaterThan(0);
  const blocked = prepare();
  await expect.poll(() => f.store.contexts.job(blocked).status).toBe('failed');
  expect(f.calls).toHaveLength(13);
  expect(f.state().context.selected).toEqual(saved.context.selected);
  expect(f.state().context.summaries.map(refKey)).toContain(refKey(editedAgain));
});

it('keeps a compatible saved prefix before a direct parent correction when the current floor prevents promotion', async () => {
  const f = fixture(25, 1);
  const initial = f.state();
  if (!initial.connection) throw new Error('Missing story Connection');
  const tailInput = assembleRequest(initial.connection, initial.settings, initial.turns.slice(-1), initial.sources, undefined, { validateLimits: false }).budget.inputTokens;
  f.store.updateChat(initial.revision, f.chatId, { ...f.settings, targetInputTokens: tailInput + 25 });
  for (let index = 0; index < 10; index++) await f.step();
  const before = f.state();
  const parents = before.context.selected.slice(0, 2);
  const edited = f.store.contexts.editSummary(f.chatId, before.revision, parents[1], 'Ada had the key all along.');
  f.store.saveLibrary(f.store.libraryRevision(), 'contexts', { ...f.preset, retainedPerLevel: 2 }, f.contextPresetId);
  f.store.updateChat(f.state().revision, f.chatId, { ...f.settings, targetInputTokens: 20_000 });
  const { jobId } = f.coordinator.context.start(f.chatId, f.state().revision, randomUUID(), 'prepare');
  await expect.poll(() => f.store.contexts.job(jobId).status).toBe('succeeded');
  expect(f.calls).toHaveLength(10);
  const after = f.state();
  expect(after.context.selected).toEqual([parents[0], edited]);
  expect(after.context.archivedTurnIds).toEqual(after.turns.slice(0, 18).map(turn => turn.id));
  expect(correctionProtection(after.turns, after.context).unresolved).toEqual([]);
});

it('rolls back a failed summary activation and reuses earlier committed progress on retry', async () => {
  const f = fixture(12, 3, 850);
  await f.step();
  const before = f.state();
  f.store.sqlite.exec(`CREATE TRIGGER reject_publish BEFORE UPDATE ON context_states
    WHEN NEW.revision = ${before.context.revision + 2}
    BEGIN SELECT RAISE(ABORT, 'synthetic publication failure'); END`);
  const prepare = () => f.coordinator.context.start(f.chatId, f.state().revision, randomUUID(), 'prepare').jobId;
  const id = prepare();
  await expect.poll(() => f.store.contexts.job(id).status).toBe('failed');
  const failed = f.state();
  expect(failed.context.revision).toBe(before.context.revision + 1);
  expect(failed.context.archivedTurnIds).toEqual(before.turns.slice(0, 6).map(turn => turn.id));
  expect(failed.context.summaries).toHaveLength(2);
  expect(failed.context.selected.map(refKey)).toEqual(failed.context.summaries.map(refKey));
  expect(f.store.contexts.steps(id)).toMatchObject([{ status: 'saved' }, { status: 'failed', result: null, after: null }]);
  expect(f.calls).toHaveLength(3);

  f.store.sqlite.exec('DROP TRIGGER reject_publish');
  const retry = prepare();
  await expect.poll(() => f.store.contexts.job(retry).status).toBe('succeeded');
  expect(f.state().context.selected.slice(0, 2)).toEqual(failed.context.selected);
  expect(f.store.contexts.job(retry)).toMatchObject({ reusedCount: 2, generatedCount: 1 });
  expect(f.calls).toHaveLength(4);
  expect(f.calls[3].coverage).toEqual(f.calls[2].coverage);
});

it('promotes within the saved cutoff when the prompt uses Summary alone', async () => {
  const f = fixture(16, 1);
  for (let index = 0; index < 4; index++) await f.step();
  const before = f.state();
  f.store.saveLibrary(f.store.libraryRevision(), 'prompts', {
    ...compactPrompt, blocks: compactPrompt.blocks.filter(block => block.id === 'summary'),
  }, 'default');
  const summaryOnly = f.state();
  if (!summaryOnly.connection) throw new Error('Missing story Connection');
  const leaves = summaryOnly.context.summaries;
  const parent: SummaryNode = {
    ...leaves[0], id: randomUUID(), level: 2, children: leaves.slice(0, 3).map(({ id, revision }) => ({ id, revision })),
    turns: leaves.slice(0, 3).flatMap(node => node.turns),
  };
  const context = { ...summaryOnly.context, selected: [parent, leaves[3]], summaries: [...leaves, parent] };
  const expected = assembleRequest(summaryOnly.connection, summaryOnly.settings, summaryOnly.turns, summaryOnly.sources, context, { validateLimits: false });
  f.store.updateChat(summaryOnly.revision, f.chatId, { ...f.settings, targetInputTokens: expected.budget.inputTokens });
  const { jobId } = f.coordinator.context.start(f.chatId, f.state().revision, randomUUID(), 'prepare');
  await expect.poll(() => f.store.contexts.job(jobId).status).toBe('succeeded');
  expect(f.state().context.archivedTurnIds).toEqual(before.context.archivedTurnIds);
  expect(f.store.contexts.steps(jobId).map(step => step.operation)).toEqual([{
    level: 2, turnIds: parent.turns.map(source => source.turnId), children: parent.children,
  }]);
  expect(f.store.contexts.job(jobId).outcome).toEqual({ inputTokens: expected.budget.inputTokens, verbatimTurns: 0 });
  expect(f.calls).toHaveLength(5);
});

function addLegacyAlternative(f: ReturnType<typeof fixture>, chatId: string, start: number, end: number, changes: Partial<SummaryNode> = {}) {
  const state = f.state(chatId);
  const node: SummaryNode = { id: randomUUID(), revision: 0, level: 1, text: 'Mira later traded the key for a map.',
    turns: state.turns.slice(start, end).map(sourceOf), children: [], prior: [], approved: true, manual: false,
    createdAt: '2026-10-20T00:00:00Z', ...changes };
  f.store.sqlite.prepare('INSERT INTO summaries (id, revision, chat_id, data) VALUES (?, ?, ?, ?)').run(node.id, node.revision, chatId, JSON.stringify(node));
  return node;
}

async function deletionReview(f: ReturnType<typeof fixture>, jobId: string) {
  await expect.poll(() => f.coordinator.context.progress(jobId).deletionReviewToken).toBeDefined();
  return f.coordinator.context.deletionPreview(jobId);
}

it('rejects a deletion approval captured before a revision changed', async () => {
  const f = fixture(12, 3);
  addLegacyAlternative(f, f.chatId, 0, 6);
  const before = f.state().context;
  const { jobId } = f.coordinator.context.start(f.chatId, f.state().revision, randomUUID(), 'prepare');
  const review = await deletionReview(f, jobId);
  f.store.bumpRevision(f.chatId);
  expect(() => f.coordinator.context.confirmDeletion(jobId, review.token)).toThrow(expect.objectContaining({ code: 'revision_conflict' }));
  f.coordinator.context.cancel(jobId);
  expect(f.state().context).toMatchObject({ selected: before.selected, archivedTurnIds: before.archivedTurnIds, summaries: before.summaries });
  expect(f.calls).toEqual([]);
});

it.each([false, true])('reviews a wider inactive batch and its dependents before replacement (reuse: %s)', async reuse => {
  const f = fixture(15, 3);
  await f.step();
  const old = addLegacyAlternative(f, f.chatId, 3, 9);
  const dependent = addLegacyAlternative(f, f.chatId, 9, 12, { prior: [old], manual: reuse });
  const unrelated = addLegacyAlternative(f, f.chatId, 12, 15);
  const cached = reuse ? addLegacyAlternative(f, f.chatId, 3, 6) : null;
  const before = f.state();
  const inputBefore = contextPlan(before).inputTokens;
  f.store.updateChat(before.revision, f.chatId, { ...f.settings, targetInputTokens: inputBefore - 50 });

  const { jobId } = f.coordinator.context.start(f.chatId, f.state().revision, randomUUID(), 'prepare');
  const review = await deletionReview(f, jobId);
  expect([...review.deletedIds].sort()).toEqual([old.id, dependent.id].sort());
  expect(review.restoredTurnIds).toEqual([]);
  expect(f.state().context.summaries).toEqual(before.context.summaries);
  expect(f.calls).toHaveLength(1);
  expect(() => f.coordinator.context.confirmDeletion(jobId, randomUUID())).toThrow(expect.objectContaining({ code: 'memory_impact_changed' }));
  f.coordinator.context.confirmDeletion(jobId, review.token);
  expect(() => f.coordinator.context.confirmDeletion(jobId, review.token)).toThrow(expect.objectContaining({ code: 'memory_impact_changed' }));
  await expect.poll(() => f.store.contexts.job(jobId).status).toBe('succeeded');

  const after = f.state().context;
  const [step] = f.store.contexts.steps(jobId);
  if (cached) expect(step).toBeUndefined();
  else expect(step.operation.turnIds).toEqual(before.turns.slice(3, 6).map(turn => turn.id));
  const result = cached ? { id: cached.id, revision: cached.revision } : step.result;
  expect(after.selected).toEqual([...before.context.selected, result]);
  expect(after.summaries.map(node => node.id)).not.toContain(old.id);
  expect(after.summaries.map(node => node.id)).not.toContain(dependent.id);
  expect(after.summaries.map(node => node.id)).toContain(unrelated.id);
  if (cached) expect(f.store.contexts.job(jobId)).toMatchObject({ generatedCount: 0, reusedCount: 2 });
  expect(f.calls).toHaveLength(reuse ? 1 : 2);
  expect(() => validateContent(f.store.sqlite)).not.toThrow();
  await f.reopen();
  expect(f.state().context.selected).toEqual(after.selected);
  expect(f.state().context.summaries).toEqual(after.summaries);
});

it('rolls back an uncommitted cascade and keeps the confirmed deletion after a later replacement write fails', async () => {
  const f = fixture(12, 3);
  for (let index = 0; index < 3; index++) await f.step();
  f.store.saveLibrary(f.store.libraryRevision(), 'contexts', { ...f.preset, promotionGroup: 2 }, f.contextPresetId);
  const before = f.state();
  const old = addLegacyAlternative(f, f.chatId, 0, 9, { level: 2, children: before.context.selected });
  const required = assembleRequest(before.connection!, before.settings, before.turns.slice(9), before.sources, undefined, { validateLimits: false }).budget.inputTokens;
  f.store.updateChat(before.revision, f.chatId, { ...f.settings, targetInputTokens: required + 10 });
  const beforeAttempt = f.state().context;

  f.store.sqlite.exec("CREATE TRIGGER reject_replacement BEFORE UPDATE ON context_states BEGIN SELECT RAISE(ABORT, 'synthetic selection write failure'); END");
  const { jobId } = f.coordinator.context.start(f.chatId, f.state().revision, randomUUID(), 'step');
  const review = await deletionReview(f, jobId);
  expect(review.deletedIds).toEqual([old.id]);
  expect(() => f.coordinator.context.confirmDeletion(jobId, review.token)).toThrow('synthetic selection write failure');
  expect(f.state().context.selected).toEqual(beforeAttempt.selected);
  expect(f.state().context.summaries).toEqual(beforeAttempt.summaries);
  expect(f.calls).toHaveLength(3);
  f.store.sqlite.exec('DROP TRIGGER reject_replacement');
  f.store.sqlite.exec("CREATE TRIGGER reject_summary BEFORE INSERT ON summaries BEGIN SELECT RAISE(ABORT, 'synthetic summary write failure'); END");
  f.coordinator.context.confirmDeletion(jobId, review.token);
  await expect.poll(() => f.store.contexts.job(jobId).status).toBe('failed');
  expect(f.state().context.selected).toEqual(beforeAttempt.selected);
  expect(f.state().context.summaries.map(node => node.id)).not.toContain(old.id);
  f.store.sqlite.exec('DROP TRIGGER reject_summary');

  const step = await f.step();
  expect(step.operation).toMatchObject({ level: 2, children: before.context.selected.slice(0, 2) });
  const after = f.state().context;
  expect(after.summaries.map(node => node.id)).not.toContain(old.id);
  expect(after.summaries.map(({ id, revision }) => ({ id, revision }))).toEqual([...before.context.selected, step.result]);
  expect(after.archivedTurnIds).toEqual(before.context.archivedTurnIds);
  expect(f.calls).toHaveLength(5);
  expect(() => validateContent(f.store.sqlite)).not.toThrow();
});

it('prunes unused overlaps during regeneration without deleting the committed layout', async () => {
  const f = fixture(9, 0);
  for (let index = 0; index < 3; index++) await f.step();
  f.store.saveLibrary(f.store.libraryRevision(), 'contexts', { ...f.preset, batchSize: 2 }, f.contextPresetId);
  const old = addLegacyAlternative(f, f.chatId, 5, 8);
  const before = f.state();
  const working = contextPlan(regenerationView(before));
  f.store.updateChat(before.revision, f.chatId, { ...f.settings, targetInputTokens: working.inputTokens - 150 });

  const { generationId } = f.coordinator.regenerate(f.state().revision, randomUUID(), before.turns[8].id, f.chatId);
  const find = () => f.state().context.jobs.find(item => item.generationId === generationId)?.id;
  await expect.poll(find).toBeDefined();
  const jobId = find();
  if (!jobId) throw new Error('Expected a regeneration preparation job');
  const review = await deletionReview(f, jobId);
  expect(review.deletedIds).toEqual([old.id]);
  expect(f.calls).toHaveLength(3);
  f.coordinator.context.confirmDeletion(jobId, review.token);
  await expect.poll(() => f.store.generation(generationId)?.status).toBe('succeeded');

  const after = f.state().context;
  const job = after.jobs.find(item => item.generationId === generationId);
  expect(job).toMatchObject({ status: 'succeeded', generatedCount: 1 });
  expect(f.store.generation(generationId)?.request?.context?.archivedTurnIds).toEqual(before.turns.slice(0, 8).map(turn => turn.id));
  expect(after.selected).toEqual(before.context.selected);
  expect(after.archivedTurnIds).toEqual(before.context.archivedTurnIds);
  expect(after.summaries.map(node => node.id)).not.toContain(old.id);
  expect(after.summaries.map(refKey)).toEqual(expect.arrayContaining(before.context.selected.map(refKey)));
  expect(f.calls).toHaveLength(5);
  expect(() => validateContent(f.store.sqlite)).not.toThrow();
});

it('lets a pending Send decline and then explicitly review deletion of an inactive correction with no repair', async () => {
  const f = fixture(12, 3);
  await f.step();
  // A direct correction in the protected tail cannot be restored as originals.
  const old = addLegacyAlternative(f, f.chatId, 8, 11);
  const edited = f.store.contexts.editSummary(f.chatId, f.state().revision, old, 'Mira had already promised Ada the key.');
  const before = f.state();
  expect(contextPlan(before).repairCount).toBe(0);
  f.store.updateChat(before.revision, f.chatId, { ...f.settings, targetInputTokens: 100_000 });
  const start = async (text?: string) => {
    const { generationId } = f.coordinator.start(f.state().revision, randomUUID(), text, f.chatId);
    const find = () => f.state().context.jobs.find(job => job.generationId === generationId)?.id;
    await expect.poll(find).toBeDefined();
    const jobId = find();
    if (!jobId) throw new Error('Expected a Send preparation job');
    return { generationId, jobId, review: await deletionReview(f, jobId) };
  };

  const first = await start('Leon asks about the key.');
  expect(first.review.deletedIds).toEqual([edited.id]);
  expect(f.calls).toHaveLength(1);
  f.coordinator.cancel(first.generationId);
  expect(f.store.generation(first.generationId)?.status).toBe('cancelled');
  expect(f.state().turns.at(-1)).toMatchObject({ complete: false, user: { text: 'Leon asks about the key.' } });
  expect(f.state().context.summaries).toEqual(before.context.summaries);
  expect(() => f.coordinator.context.confirmDeletion(first.jobId, first.review.token)).toThrow(expect.objectContaining({ code: 'memory_impact_changed' }));

  const second = await start();
  f.coordinator.context.confirmDeletion(second.jobId, second.review.token);
  await expect.poll(() => f.store.generation(second.generationId)?.status).toBe('succeeded');
  expect(f.state().context.summaries.map(node => node.id)).not.toContain(old.id);
  expect(f.state().context.selected).toEqual([]);
  expect(f.state().turns).toHaveLength(before.turns.length + 1);
  expect(f.calls).toHaveLength(2);
});

it('interrupts an unanswered deletion review on restart without changing memory or dispatching calls', async () => {
  const f = fixture(12, 3);
  const old = addLegacyAlternative(f, f.chatId, 0, 6);
  const { jobId } = f.coordinator.context.start(f.chatId, f.state().revision, randomUUID(), 'prepare');
  const preview = await deletionReview(f, jobId);
  await f.reopen();
  expect(f.store.contexts.job(jobId).status).toBe('interrupted');
  expect(f.state().context.summaries.map(node => node.id)).toEqual([old.id]);
  expect(f.state().context.selected).toEqual([]);
  expect(f.calls).toHaveLength(0);
  expect(() => f.coordinator.context.confirmDeletion(jobId, preview.token)).toThrow(expect.objectContaining({ code: 'memory_impact_changed' }));
});

it('reviews and atomically prunes obsolete batches and archived promotions across branches of a shared preset', async () => {
  const f = fixture(19, 3);
  const second = f.store.importBranch(f.chatId, { name: 'Earlier path', requestId: randomUUID(), turns: transcript(15) }).id;
  for (let step = 0; step < 4; step++) {
    await f.step();
    await f.step(second);
  }
  const futureBatch = addLegacyAlternative(f, f.chatId, 12, 15);
  const children = f.state(second).context.selected.slice(0, 3);
  const oldPromotion = addLegacyAlternative(f, second, 0, 9, { level: 2, children });
  const correction = 'Mira kept a second key for Leon.';
  f.store.contexts.editSummary(second, f.state(second).revision, oldPromotion, correction);

  const calls = f.calls.length;
  await f.reopen();
  expect(f.calls).toHaveLength(calls);
  expect(f.state().context.summaries.some(node => node.id === futureBatch.id)).toBe(true);
  expect(f.state(second).context.summaries.filter(node => node.id === oldPromotion.id)).toHaveLength(2);
  const revisedPreset = { ...f.preset, batchSize: 4, promotionGroup: 2 };
  const revision = f.store.libraryRevision();
  const preview = () => f.store.contextPresetMemoryImpact(revision, f.contextPresetId, revisedPreset);
  const initial = preview();
  expect(initial?.branches).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: f.chatId, discardedSummaries: 1, restoredTurns: 0, corrections: [] }),
    expect.objectContaining({ id: second, discardedSummaries: 1, restoredTurns: 0, corrections: [
      { id: oldPromotion.id, level: 2, firstTurn: 1, lastTurn: 9, text: correction },
    ] }),
  ]));
  const save = (token?: string) => f.store.saveLibrary(revision, 'contexts', revisedPreset, f.contextPresetId, undefined, undefined, token);
  expect(() => save()).toThrow(expect.objectContaining({ code: 'memory_impact_required' }));
  const sibling = f.state(second);
  const last = sibling.turns.at(-1)!;
  f.store.editPart(sibling.revision, last.id, 'user', `${last.user.text} She waits.`, second);
  expect(() => save(initial?.token)).toThrow(expect.objectContaining({ code: 'memory_impact_changed' }));

  const token = preview()?.token;
  expect(token).toBeDefined();
  const firstBefore = f.state();
  const secondBefore = f.state(second);
  f.store.sqlite.exec("CREATE TRIGGER reject_context_update BEFORE UPDATE ON library BEGIN SELECT RAISE(ABORT, 'synthetic preset write failure'); END");
  expect(() => save(token)).toThrow('synthetic preset write failure');
  expect(f.state()).toEqual(firstBefore);
  expect(f.state(second)).toEqual(secondBefore);
  f.store.sqlite.exec('DROP TRIGGER reject_context_update');
  save(token);

  expect(f.calls).toHaveLength(calls);
  for (const before of [firstBefore, secondBefore]) {
    const after = f.state(before.id);
    expect(after.context.selected).toEqual(before.context.selected);
    expect(after.context.archivedTurnIds).toEqual(before.context.archivedTurnIds);
    expect(after.context.summaries.map(refKey)).toEqual(before.context.selected.map(refKey));
  }
  const promoted = f.state(second);
  const required = assembleRequest(promoted.connection!, promoted.settings, promoted.turns.slice(12), promoted.sources, undefined, { validateLimits: false }).budget.inputTokens;
  f.store.updateChat(f.state().revision, f.chatId, { ...f.settings, targetInputTokens: required + 10 });
  expect(contextPlan(f.state()).next).toMatchObject({ level: 1, turnIds: firstBefore.turns.slice(12, 16).map(turn => turn.id) });
  expect(contextPlan(f.state(second)).next).toMatchObject({ level: 2, turnIds: secondBefore.turns.slice(0, 6).map(turn => turn.id) });
  expect((await f.step()).operation.turnIds).toEqual(firstBefore.turns.slice(12, 16).map(turn => turn.id));
  expect((await f.step(second)).operation.turnIds).toEqual(secondBefore.turns.slice(0, 6).map(turn => turn.id));
  expect(f.calls).toHaveLength(calls + 2);
  const promotedLayout = f.state(second).context;
  f.store.saveLibrary(f.store.libraryRevision(), 'contexts', { ...revisedPreset, promotionGroup: 4 }, f.contextPresetId);
  expect(f.state(second).context.summaries).toEqual(promotedLayout.summaries);
  expect(f.state(second).context.selected).toEqual(promotedLayout.selected);
  expect(f.calls).toHaveLength(calls + 2);
  expect(() => validateContent(f.store.sqlite)).not.toThrow();
});

it('keeps reusable verbatim checkpoints aligned with the unchanged batch size', async () => {
  const f = fixture(15, 3);
  await f.step();
  const before = f.state();
  const first = addLegacyAlternative(f, f.chatId, 3, 6);
  const later = addLegacyAlternative(f, f.chatId, 6, 9);
  const competing = addLegacyAlternative(f, f.chatId, 4, 7);
  const revision = f.store.libraryRevision();
  const next = { ...f.preset, promotionGroup: 2 };
  const impact = f.store.contextPresetMemoryImpact(revision, f.contextPresetId, next);
  expect(impact?.branches).toMatchObject([{ discardedSummaries: 1, restoredTurns: 0 }]);
  f.store.saveLibrary(revision, 'contexts', next, f.contextPresetId, undefined, undefined, impact?.token);

  const saved = f.state().context;
  expect(saved.selected).toEqual(before.context.selected);
  expect(saved.summaries.map(node => node.id)).toEqual([before.context.selected[0].id, first.id, later.id]);
  expect(saved.summaries.some(node => node.id === competing.id)).toBe(false);
  expect(await f.step()).toMatchObject({ result: { id: first.id, revision: first.revision }, reused: true, request: null });
  expect(await f.step()).toMatchObject({ result: { id: later.id, revision: later.revision }, reused: true, request: null });
  expect(f.calls).toHaveLength(1);
  expect(() => validateContent(f.store.sqlite)).not.toThrow();
});

it('reuses a promotion of the same committed children after changing only the turn batch', async () => {
  const f = fixture(12, 3);
  for (let index = 0; index < 3; index++) await f.step();
  const before = f.state();
  const promotion = addLegacyAlternative(f, f.chatId, 0, 9, { level: 2, children: before.context.selected });
  const revision = f.store.libraryRevision();
  const next = { ...f.preset, batchSize: 4 };
  expect(f.store.contextPresetMemoryImpact(revision, f.contextPresetId, next)).toBeNull();
  f.store.saveLibrary(revision, 'contexts', next, f.contextPresetId);

  const required = assembleRequest(before.connection!, before.settings, before.turns.slice(9), before.sources, undefined, { validateLimits: false }).budget.inputTokens;
  f.store.updateChat(f.state().revision, f.chatId, { ...f.settings, targetInputTokens: required + 10 });
  expect(await f.step()).toMatchObject({ operation: { level: 2, children: before.context.selected },
    result: { id: promotion.id, revision: promotion.revision }, reused: true, request: null });
  expect(f.state().context.archivedTurnIds).toEqual(before.context.archivedTurnIds);
  expect(f.calls).toHaveLength(3);
  expect(() => validateContent(f.store.sqlite)).not.toThrow();
});

it('reviews both sibling branches when switching shape and leaves other chats using the old preset alone', async () => {
  const f = fixture(12, 2);
  await f.step();
  const sibling = f.store.importBranch(f.chatId, { name: 'Parallel path', requestId: randomUUID(), turns: transcript(8) }).id;
  const unrelated = f.store.createChat({ ...f.settings, title: 'Other story' });
  seedTranscript(f.store, f.state(unrelated).revision, unrelated, transcript(8));
  const unrelatedAlternative = addLegacyAlternative(f, unrelated, 0, 3);
  addLegacyAlternative(f, sibling, 0, 3);
  const corrected = addLegacyAlternative(f, f.chatId, 5, 8);
  const text = 'Mira had already traded the key to Ada.';
  f.store.contexts.editSummary(f.chatId, f.state().revision, corrected, text);
  const beforeDeletion = f.state();
  f.store.deleteTurn(beforeDeletion.revision, beforeDeletion.turns[3].id, f.chatId);

  const sameShape = f.store.saveLibrary(f.store.libraryRevision(), 'contexts', { ...f.preset, name: 'Identical sizes' });
  const newShape = f.store.saveLibrary(f.store.libraryRevision(), 'contexts', { ...f.preset, batchSize: 4 });
  const before = f.state();
  expect(f.store.contextSelectionMemoryImpact(before.revision, f.chatId, sameShape)).toBeNull();
  const impact = f.store.contextSelectionMemoryImpact(before.revision, f.chatId, newShape);
  expect(impact?.branches).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: f.chatId, discardedSummaries: 1, corrections: [{ id: corrected.id, level: 1, firstTurn: 5, lastTurn: 7, text }] }),
    expect.objectContaining({ id: sibling, discardedSummaries: 1 }),
  ]));
  expect(impact?.branches).toHaveLength(2);
  f.store.updateChat(before.revision, f.chatId, { ...f.settings, contextPresetId: newShape }, impact?.token);
  expect(f.state().context.selected).toEqual(before.context.selected);
  expect(f.state(sibling).context.summaries).toEqual([]);
  expect(f.state(sibling).context.preset?.id).toBe(newShape);
  expect(f.state(unrelated).context.summaries).toMatchObject([{ id: unrelatedAlternative.id }]);
  expect(f.state(unrelated).context.preset?.id).toBe(f.contextPresetId);
  expect(f.calls).toHaveLength(1);
});

it('preserves and reuses batches deactivated by a higher target after deleting an unrelated latest turn', async () => {
  const f = fixture(13, 3, 1_200);
  const prepare = async () => {
    const { jobId } = f.coordinator.context.start(f.chatId, f.state().revision, randomUUID(), 'prepare');
    await expect.poll(() => f.store.contexts.job(jobId).status).toBe('succeeded');
    return jobId;
  };
  const initialJob = await prepare();
  const prepared = f.state();
  expect(prepared.context.selected).toHaveLength(3);
  const steps = f.store.contexts.steps(initialJob);
  const calls = f.calls.length;
  if (!prepared.connection) throw new Error('Missing story Connection');
  const oneBatch = { ...prepared.context, selected: prepared.context.selected.slice(0, 1), archivedTurnIds: prepared.context.archivedTurnIds.slice(0, 3) };
  const target = assembleRequest(prepared.connection, prepared.settings, prepared.turns, prepared.sources, oneBatch, { validateLimits: false }).budget.inputTokens;
  f.store.updateChat(prepared.revision, f.chatId, { ...f.settings, targetInputTokens: target });
  await prepare();
  const before = f.state();
  expect(before.context.selected).toEqual(oneBatch.selected);
  expect(before.context.summaries).toEqual(prepared.context.summaries);

  const last = before.turns.at(-1)!;
  expect(f.store.turnDeletionMemoryImpact(before.revision, last.id, f.chatId)).toBeNull();
  f.store.deleteTurn(before.revision, last.id, f.chatId);
  expect(f.state().turns).toEqual(before.turns.slice(0, -1));
  expect(f.state().context).toEqual(before.context);
  expect(f.store.contexts.steps(initialJob)).toEqual(steps);
  f.store.updateChat(f.state().revision, f.chatId, f.settings);
  await prepare();
  expect(f.state().context.selected).toEqual(prepared.context.selected);
  expect(f.calls).toHaveLength(calls);
});

it('removes affected versions and dependents but keeps independent inactive memory when the cutoff retreats', async () => {
  const f = fixture(12, 3);
  for (let index = 0; index < 3; index++) await f.step();
  const displaced = f.state().context.selected[2];
  const independent = addLegacyAlternative(f, f.chatId, 9, 11);
  const consumer = addLegacyAlternative(f, f.chatId, 9, 11, { prior: [displaced] });
  const crossing = addLegacyAlternative(f, f.chatId, 9, 12);
  const correction = 'Ada locked the gate after the key went missing.';
  f.store.contexts.editSummary(f.chatId, f.state().revision, crossing, correction);
  const before = f.state();
  const last = before.turns.at(-1)!;
  const impact = f.store.turnDeletionMemoryImpact(before.revision, last.id, f.chatId);
  expect(impact?.branches).toMatchObject([{
    discardedSummaries: 3, restoredTurns: 3, corrections: [{ id: crossing.id, text: correction }],
  }]);
  f.store.deleteTurn(before.revision, last.id, f.chatId, impact?.token);

  const after = f.state();
  expect(after.context.selected).toEqual(before.context.selected.slice(0, 2));
  expect(after.context.archivedTurnIds).toEqual(before.turns.slice(0, 6).map(turn => turn.id));
  const removed = new Set([displaced.id, consumer.id, crossing.id]);
  expect(after.context.summaries).toEqual(before.context.summaries.filter(node => !removed.has(node.id)));
  expect(after.context.summaries.map(refKey)).toContain(refKey(independent));
  expect(() => validateContent(f.store.sqlite)).not.toThrow();
  await f.reopen();
  expect(f.state()).toEqual(after);
  expect(f.calls).toHaveLength(3);
});

it('keeps a fitting committed cutoff after deleting a verbatim turn, then returns a whole span to protect the tail', async () => {
  const f = fixture(16, 2, 10_000);
  // Historical roleplay requests belong to their turns. Keep one and delete the other.
  for (const text of ['Mira goes upstairs.', 'Leon remains at the bridge.']) {
    const { generationId } = f.coordinator.start(f.state().revision, randomUUID(), text, f.chatId);
    await expect.poll(() => f.store.generation(generationId)?.status).toBe('succeeded');
  }
  f.store.updateChat(f.state().revision, f.chatId, { ...f.settings, targetInputTokens: 110 });
  for (let step = 0; step < 5; step++) await f.step();
  const before = f.state();
  const generations = f.store.snapshot(f.chatId).generations;
  const calls = f.calls.length;
  const last = before.turns.at(-1)!;
  expect(f.store.turnDeletionMemoryImpact(before.revision, last.id, f.chatId)).toBeNull();
  f.store.deleteTurn(before.revision, last.id, f.chatId);
  const firstDeletion = f.state();
  expect(firstDeletion.context).toEqual(before.context);
  expect(f.store.snapshot(f.chatId).generations).toEqual([generations[1]]);

  const next = firstDeletion.turns.at(-1)!;
  const impact = f.store.turnDeletionMemoryImpact(firstDeletion.revision, next.id, f.chatId);
  expect(impact?.branches).toMatchObject([{ discardedSummaries: 1, restoredTurns: 3, corrections: [] }]);
  expect(() => f.store.deleteTurn(firstDeletion.revision, next.id, f.chatId)).toThrow(expect.objectContaining({ code: 'memory_impact_required' }));
  expect(f.state()).toEqual(firstDeletion);
  f.store.deleteTurn(firstDeletion.revision, next.id, f.chatId, impact?.token);
  expect(f.state().context.selected).toEqual(before.context.selected.slice(0, 4));
  expect(f.state().context.archivedTurnIds).toEqual(before.turns.slice(0, 12).map(turn => turn.id));
  expect(f.store.snapshot(f.chatId).generations).toEqual([]);
  expect(f.calls).toHaveLength(calls);
});

it('returns surviving turns from an incomplete archived span and marks its deleted result without rewriting the request', async () => {
  const f = fixture(15, 0);
  for (let step = 0; step < 4; step++) await f.step();
  const archived = await f.step();
  const saved = f.state();
  expect(saved.context.archivedTurnIds).toHaveLength(15);
  const selected = saved.context.selected.at(-1)!;
  const correction = 'Mira gave the brass key to Ada, who agreed to keep it.';
  f.store.contexts.editSummary(f.chatId, saved.revision, selected, correction);
  const before = f.state();
  const last = before.turns.at(-1)!;
  const calls = f.calls.length;
  const impact = f.store.turnDeletionMemoryImpact(before.revision, last.id, f.chatId);
  expect(impact?.branches).toMatchObject([{ discardedSummaries: 1, restoredTurns: 2, corrections: [{ id: selected.id, text: correction, firstTurn: 13, lastTurn: 15 }] }]);
  f.store.deleteTurn(before.revision, last.id, f.chatId, impact?.token);
  const after = f.state();
  expect(after.turns.map(turn => turn.id)).toEqual(before.turns.slice(0, 14).map(turn => turn.id));
  expect(after.context.selected).toEqual(before.context.selected.slice(0, 4));
  expect(after.context.archivedTurnIds).toEqual(before.turns.slice(0, 12).map(turn => turn.id));
  expect(after.context.summaries.some(node => node.id === selected.id)).toBe(false);
  expect(f.store.contexts.steps(archived.jobId)).toEqual([{ ...archived, resultDeleted: true }]);
  expect(() => validateContent(f.store.sqlite)).not.toThrow();
  await f.reopen();
  expect(f.state()).toEqual(after);
  expect(f.calls).toHaveLength(calls);
});
