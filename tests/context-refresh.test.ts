import { describe, expect, it } from 'vitest';
import type { ChatSnapshot, Turn } from '../src/shared/contracts.js';
import { defaultContextPreset, refKey, type SummaryNode } from '../src/shared/context.js';
import { repairQueue, selectedContext, sourceOf } from '../src/core/context.js';
import { refreshContext } from '../src/core/context-refresh.js';
import { defaultPrompt } from '../src/shared/library.js';
import { contextPlan, summaryRequest } from '../src/core/context-plan.js';
import { inspectPreparation } from '../src/core/context-replay.js';
import { assembleRequest } from '../src/core/prompt.js';

function fixture(): ChatSnapshot {
  const turns: Turn[] = Array.from({ length: 64 }, (_, i) => ({ id: `t${i}`, position: i, complete: true,
    user: { id: `u${i}`, revision: 0, text: `Turn ${i}. Mira asks about the brass key. ` + 'The rain falls outside. '.repeat(12) },
    assistant: { id: `a${i}`, revision: 0, text: 'Leon promises to return before dawn. ' + 'The room is quiet. '.repeat(20) } }));
  const summaries: SummaryNode[] = [];
  let layer: SummaryNode[] = Array.from({ length: 31 }, (_, i) => ({ id: `leaf-${i}`, revision: 0, level: 1,
    turns: turns.slice(i * 2, i * 2 + 2).map(sourceOf), children: [], prior: [], approved: true, manual: false, createdAt: '2026-10-17',
    text: `Memory ${i}: Mira entrusted Leon with her brass key. ` + 'He promised to avoid the cellar and return before dawn. '.repeat(4) }));
  summaries.push(...layer);
  const roots: SummaryNode[] = [];
  while (layer.length) {
    if (layer.length % 2) roots.unshift(layer.at(-1)!);
    const parents: SummaryNode[] = [];
    for (let i = 0; i + 1 < layer.length; i += 2) {
      const children = layer.slice(i, i + 2);
      parents.push({ id: `parent-${children[0].level + 1}-${i}`, revision: 0, level: children[0].level + 1,
        turns: children.flatMap(node => node.turns), children: children.map(({ id, revision }) => ({ id, revision })), prior: [],
        text: 'Mira entrusted Leon with the brass key; he promised to return before dawn.', approved: true, manual: false, createdAt: '2026-10-17' });
    }
    summaries.push(...parents); layer = parents;
  }
  return { id: 'synthetic', revision: 0, hasApiKey: false, generations: [],
    connection: { name: 'Local test', endpoint: 'http://localhost/v1', model: 'synthetic', contextWindow: 100_000, maxOutputTokens: 1_000, customParameters: {} },
    settings: { title: 'Refresh fixture', targetInputTokens: 8_000, instructions: 'Continue the story.', character: '', persona: '' },
    sources: { prompt: null, character: null, persona: null }, turns,
    context: { revision: 4, selected: roots.map(({ id, revision }) => ({ id, revision })), archivedTurnIds: turns.slice(0, 62).map(turn => turn.id), summaries, jobs: [],
      preset: { ...defaultContextPreset, id: 'preset', revision: 0, minTail: 2, batchSize: 2, promotionGroup: 2, retainedPerLevel: 1 } } };
}
const measure = (snapshot: ChatSnapshot) => assembleRequest(snapshot.connection!, snapshot.settings, snapshot.turns, snapshot.sources, snapshot.context, { validateLimits: false }).budget.inputTokens;
const apply = (snapshot: ChatSnapshot, state: ReturnType<typeof refreshContext>['state']): ChatSnapshot => ({ ...snapshot, context: { ...snapshot.context, ...state } });

describe('separate continuity summary requests', () => {
  it.each([1, 2, 3])('uses the level %i template with exact sources and reference-only earlier memory', level => {
    const snapshot = fixture();
    const leaves = snapshot.context.summaries.filter(node => node.level === 1);
    snapshot.context.selected = leaves.slice(0, 4).map(({ id, revision }) => ({ id, revision }));
    snapshot.context.preset = { ...defaultContextPreset, id: 'preset', revision: 0, summaryTokens: 321 };
    const sourceNodes = leaves.slice(2, 4).map(node => ({ ...node, level: level - 1 }));
    if (level > 1) snapshot.context.summaries = [...snapshot.context.summaries.filter(node => !sourceNodes.some(source => source.id === node.id)), ...sourceNodes];
    const turns = snapshot.turns.slice(4, level === 1 ? 6 : 8);
    const operation = { level, turnIds: turns.map(turn => turn.id), children: level === 1 ? [] : sourceNodes.map(({ id, revision }) => ({ id, revision })) };
    const { request, prior } = summaryRequest(snapshot, operation, snapshot.connection!);
    const template = level === 1 ? defaultContextPreset.extractionPrompt : defaultContextPreset.promotionPrompt;
    expect(request.body.messages[0]).toEqual({ role: 'system', content: template.replaceAll('{{target_tokens}}', '321').replaceAll('{{level}}', String(level)) });
    expect(prior).toEqual(leaves.slice(0, 2).map(({ id, revision }) => ({ id, revision })));
    expect(request.body.messages.slice(1, -1)).toEqual(leaves.slice(0, 2).map(node => ({ role: 'system', content: `Earlier memory for reference only; do not repeat or extend its coverage:\n${node.text}` })));
    expect(JSON.parse(request.body.messages.at(-1)!.content)).toEqual({ task: 'Summarize only the supplied sources.', sources: level === 1
      ? turns.map(turn => ({ turn: turn.position + 1, user: turn.user.text, assistant: turn.assistant.text }))
      : sourceNodes.map(node => ({ level: node.level, text: node.text })) });
    expect(request.coverage).toEqual(turns.map(sourceOf));
    expect(request.body.max_tokens).toBe(snapshot.connection!.maxOutputTokens);
  });

  it('fits the complete default instructions and fixed sources exactly, or fails without truncation', () => {
    const snapshot = fixture();
    const operation = { level: 1, turnIds: snapshot.turns.slice(0, 2).map(turn => turn.id), children: [] };
    const connection = snapshot.connection!;
    const initial = summaryRequest(snapshot, operation, connection).request;
    const exact = { ...connection, contextWindow: initial.budget.inputTokens + connection.maxOutputTokens };
    expect(summaryRequest(snapshot, operation, exact).request.body).toEqual(initial.body);
    expect(() => summaryRequest(snapshot, operation, { ...exact, contextWindow: exact.contextWindow - 1 })).toThrow('fixed source batch and summary instructions do not fit');
  });
});

describe('manual memory refresh using the saved tree', () => {
  it('restores originals while keeping overlapping manual alternatives and their provenance', () => {
    const snapshot = fixture();
    const leaves = snapshot.context.summaries.filter(node => node.level === 1);
    const parent = snapshot.context.summaries.find(node => node.id === 'parent-2-0')!;
    const alternative = { ...parent, id: 'alternative', manual: true, text: 'Mira owns the duplicate key.' };
    const children = leaves.slice(1, 3);
    const crossing = { ...parent, id: 'crossing', manual: true, text: 'Leon owns the duplicate key.',
      turns: children.flatMap(node => node.turns), children: children.map(({ id, revision }) => ({ id, revision })),
    };
    snapshot.context.summaries.push(alternative, crossing);
    snapshot.settings.targetInputTokens = 90_000;
    expect(repairQueue(snapshot.turns, snapshot.context)).toEqual([]);
    const result = refreshContext(snapshot);
    expect(result.state.selected).toEqual([]);
    expect(result.state.summaries).toEqual(snapshot.context.summaries);
    const replay = inspectPreparation(snapshot);
    expect(replay.plan.ready).toBe(true);
    expect(replay.snapshot.context.selected).toEqual([]);
    expect(replay.snapshot.context.summaries).toEqual(snapshot.context.summaries);
  });

  it('ignores an inactive stale edit and restores the raised completed-tail minimum', () => {
    const snapshot = fixture();
    const selected = snapshot.context.summaries.find(node => refKey(node) === refKey(snapshot.context.selected.at(-1)!))!;
    selected.manual = true;
    const stale = { ...selected, id: 'inactive', turns: selected.turns.map(turn => ({ ...turn, userRevision: 99 })) };
    snapshot.context.summaries.push(stale);
    snapshot.settings.targetInputTokens = 90_000;
    snapshot.context.preset!.minTail = 8;
    snapshot.turns.at(-1)!.complete = false;
    const result = refreshContext(snapshot, { allowOverflowFallback: true });
    expect(result.state.archivedTurnIds).toEqual([]);
    expect(result.state.summaries).toEqual(snapshot.context.summaries);
    expect(result.report).toMatchObject({ verbatimAfter: snapshot.turns.length, limited: false });
    expect(contextPlan(apply(snapshot, result.state))).toMatchObject({ ready: true, blocked: null, repairCount: 0 });
  });

  it('restores an incompatible cutoff before generating missing compression instead of falling back to it', () => {
    const snapshot = fixture();
    const wide = { ...snapshot.context.summaries[0], turns: snapshot.turns.slice(0, 62).map(sourceOf) };
    snapshot.context.summaries = [wide];
    snapshot.context.selected = [{ id: wide.id, revision: wide.revision }];
    snapshot.context.preset!.minTail = 8;
    snapshot.context.preset!.batchSize = 3;
    snapshot.settings.targetInputTokens = 2_000;
    const result = refreshContext(snapshot, { allowOverflowFallback: true });
    expect(result.state.archivedTurnIds).toEqual([]);
    expect(contextPlan(apply(snapshot, result.state))).toMatchObject({ blocked: null, next: { level: 1, turnIds: ['t0', 't1', 't2'] } });
    expect(result.report.inputAfter).toBeGreaterThan(snapshot.settings.targetInputTokens);
  });

  it('preserves summary-only selections during Prepare without restoring turns or extracting unused history', () => {
    const snapshot = fixture();
    snapshot.sources.prompt = { ...defaultPrompt, id: 'summary-only', revision: 0, blocks: defaultPrompt.blocks.filter(block => block.id !== 'messages') };
    const original = structuredClone(snapshot.context);
    const result = refreshContext(snapshot);
    expect(result.state.selected).toEqual(original.selected);
    expect(result.report).toMatchObject({ changed: false, verbatimBefore: 0, verbatimAfter: 0 });
    expect(contextPlan(snapshot)).toMatchObject({ ready: true, next: null, verbatimTurnIds: [] });
    snapshot.settings.targetInputTokens = measure(snapshot) - 1;
    const plan = contextPlan(snapshot);
    expect(plan.next?.level).not.toBe(1);
    expect(plan.next || plan.blocked).toBeTruthy();
    expect(snapshot.context).toEqual(original);
  });

  it('restores recent verbatim history, retains every summary and is repeatable across checkpoints', () => {
    const snapshot = fixture(), original = structuredClone(snapshot);
    const { state, report } = refreshContext(snapshot);
    expect(report.changed).toBe(true); expect(report.limited).toBe(false);
    expect(report.verbatimAfter).toBeGreaterThan(report.verbatimBefore);
    expect(report.inputAfter).toBeLessThanOrEqual(snapshot.settings.targetInputTokens);
    expect(state.summaries).toBe(snapshot.context.summaries);
    expect(snapshot).toEqual(original);
    const resolved = selectedContext(snapshot.turns, state);
    expect(resolved.summaries.length).toBeGreaterThan(0);
    expect(resolved.summaries.every(node => node.level === 1)).toBe(true);
    expect(resolved.summaries.flatMap(node => node.turns.map(source => source.turnId))).toEqual(state.archivedTurnIds);
    const checkpoint = JSON.parse(JSON.stringify(apply(snapshot, state))) as ChatSnapshot;
    expect(refreshContext(checkpoint).report).toMatchObject({ changed: false, inputAfter: report.inputAfter });
    expect(refreshContext(checkpoint).state.selected).toEqual(state.selected);
  });

  it('uses saved promotions under pressure and keeps the same result when refreshed again', () => {
    const snapshot = fixture();
    snapshot.settings.targetInputTokens = measure(snapshot) + 250;
    const result = refreshContext(snapshot);
    expect(result.report.limited).toBe(false);
    expect(result.report.changed).toBe(true);
    const resolved = selectedContext(snapshot.turns, result.state);
    expect(resolved.summaries.some(node => node.level > 1)).toBe(true);
    expect(resolved.summaries.length).toBeGreaterThan(snapshot.context.selected.length);
    expect(measure(apply(snapshot, result.state))).toBeLessThanOrEqual(snapshot.settings.targetInputTokens);
    expect(refreshContext(apply(snapshot, result.state)).state.selected).toEqual(result.state.selected);
  });

  it('rebuilds an already fitting L4-only selection from finer saved layers', () => {
    const snapshot = fixture();
    const deep = snapshot.context.summaries.find(node => node.level === 4)!;
    snapshot.context.selected = [{ id: deep.id, revision: deep.revision }];
    snapshot.context.archivedTurnIds = deep.turns.map(turn => turn.turnId);
    snapshot.settings.targetInputTokens = measure(snapshot);
    const prepared = refreshContext(snapshot);
    const { summaries, verbatim } = selectedContext(snapshot.turns, prepared.state);

    expect(summaries.length).toBeGreaterThan(1);
    expect(summaries.every(node => node.level < deep.level)).toBe(true);
    expect(verbatim.length).toBeLessThan(snapshot.turns.length - deep.turns.length);
    expect(prepared.report.inputAfter).toBeLessThanOrEqual(snapshot.settings.targetInputTokens);
    expect(prepared.state.summaries).toBe(snapshot.context.summaries);
    expect(refreshContext(apply(snapshot, prepared.state)).report.changed).toBe(false);
  });

  it.each([false, true])('ranks cached promotions by actual geometric pressure with larger L2 summaries = %s', largerLevelTwo => {
    const snapshot = fixture();
    snapshot.turns = snapshot.turns.slice(0, 14);
    for (const turn of snapshot.turns) turn.user.text = 'Mira explains what she found under the floorboards. '.repeat(100);
    const leaves = snapshot.context.summaries.filter(node => node.level === 1).slice(0, 6);
    for (const leaf of leaves) leaf.text = 'The key belongs to Mira. '.repeat(15).trimEnd();
    const parents = snapshot.context.summaries.filter(node => node.level === 2).slice(0, 3);
    for (const parent of parents.slice(0, 2)) parent.text = 'The key belongs to Mira. '.repeat(largerLevelTwo ? 12 : 4).trimEnd();
    const grandparent = snapshot.context.summaries.find(node => node.level === 3)!;
    snapshot.context.summaries = [...leaves, ...parents, grandparent];
    Object.assign(snapshot.context.preset!, { batchSize: 3, promotionGroup: 5, retainedPerLevel: 4 });
    const selection = (nodes: SummaryNode[]) => ({ ...snapshot.context,
      selected: nodes.map(({ id, revision }) => ({ id, revision })),
      archivedTurnIds: nodes.flatMap(node => node.turns.map(source => source.turnId)),
    });
    const levelOnePromotion = selection(parents);
    const levelTwoPromotion = selection([grandparent, ...leaves.slice(4)]);
    snapshot.context = selection([grandparent]);
    snapshot.settings.targetInputTokens = Math.max(measure(apply(snapshot, levelOnePromotion)), measure(apply(snapshot, levelTwoPromotion)));

    const expected = largerLevelTwo ? levelTwoPromotion : levelOnePromotion;
    const result = refreshContext(snapshot);
    expect(result.state.selected).toEqual(expected.selected);
    expect(result.state.archivedTurnIds).toEqual(expected.archivedTurnIds);
    expect(refreshContext(apply(snapshot, result.state)).report.changed).toBe(false);
  });

  it('returns all turns verbatim when they fit, including blank complete turns and a pending input', () => {
    const snapshot = fixture(); snapshot.settings.targetInputTokens = 90_000;
    snapshot.turns.at(-2)!.user.text = ''; snapshot.turns.at(-2)!.assistant.text = '';
    snapshot.turns.at(-1)!.complete = false;
    const result = refreshContext(snapshot);
    expect(result.state.selected).toEqual([]); expect(result.state.archivedTurnIds).toEqual([]);
    expect(result.report.verbatimAfter).toBe(64);
    const request = assembleRequest(snapshot.connection!, snapshot.settings, snapshot.turns, snapshot.sources, result.state);
    expect(request.body.messages.at(-1)?.role).toBe('user');
    expect(request.coverage).toHaveLength(64);
  });

  it('restores an increased or deleted minimum tail and checks the physical limit independently', () => {
    const snapshot = fixture(); snapshot.context.preset!.minTail = 12;
    snapshot.connection!.contextWindow = 7_000;
    const result = refreshContext(snapshot);
    expect(result.report.verbatimAfter).toBeGreaterThanOrEqual(12);
    expect(result.report.inputAfter).toBeLessThanOrEqual(6_000);
    const shortened = fixture(); shortened.turns = shortened.turns.slice(0, -2);
    const restored = refreshContext(shortened);
    expect(restored.report.verbatimBefore).toBe(0);
    expect(restored.report.verbatimAfter).toBeGreaterThanOrEqual(2);
    expect(restored.report.limited).toBe(false);
  });

  it('reselects the same saved spans after changing extraction, promotion and retention settings', () => {
    const snapshot = fixture();
    const before = refreshContext(snapshot);
    Object.assign(snapshot.context.preset!, { batchSize: 3, promotionGroup: 5, retainedPerLevel: 4 });
    const after = refreshContext(snapshot);
    expect(after.report).toMatchObject({ changed: true, limited: false, inputAfter: before.report.inputAfter });
    expect(after.state.selected).toEqual(before.state.selected);
  });

  it('replaces crossing active ranges with a saved parent and protects completed turns plus pending input', () => {
    const snapshot = fixture();
    snapshot.turns = snapshot.turns.slice(0, 10);
    snapshot.turns[9].complete = false;
    const parent = snapshot.context.summaries.find(node => node.level === 2 && node.turns[0].turnId === 't0')!;
    const leaf = snapshot.context.summaries.find(node => node.level === 1 && node.turns[0].turnId === 't4')!;
    const ref = ({ id, revision }: SummaryNode) => ({ id, revision });
    const archivedTurnIds = snapshot.turns.slice(0, 6).map(turn => turn.id);
    const fitting = { ...snapshot.context, selected: [ref(parent), ref(leaf)], archivedTurnIds };
    const crossing = [0, 3].map(index => ({
      ...leaf, id: `crossing-${index}`, text: 'The room remains very quiet. '.repeat(80),
      turns: snapshot.turns.slice(index, index + 3).map(sourceOf),
    }));
    snapshot.context.summaries.push(...crossing);
    snapshot.context.selected = crossing.map(ref);
    snapshot.context.archivedTurnIds = archivedTurnIds;
    Object.assign(snapshot.context.preset!, { minTail: 3, batchSize: 5, promotionGroup: 5, retainedPerLevel: 4 });
    snapshot.settings.targetInputTokens = measure(apply(snapshot, fitting));
    expect(measure(snapshot)).toBeGreaterThan(snapshot.settings.targetInputTokens);

    const result = refreshContext(snapshot);
    expect(result.state.selected).toEqual([ref(parent), ref(leaf)]);
    expect(result.state.summaries).toBe(snapshot.context.summaries);
    expect(selectedContext(snapshot.turns, result.state).verbatim.map(turn => [turn.id, turn.complete]))
      .toEqual([['t6', true], ['t7', true], ['t8', true], ['t9', false]]);
    expect(result.report.inputAfter).toBe(snapshot.settings.targetInputTokens);
  });

  it('leaves room for a full new batch when the smallest saved input would block further preparation', () => {
    const snapshot = fixture();
    snapshot.turns = snapshot.turns.slice(0, 10);
    snapshot.context.summaries = snapshot.context.summaries.filter(node => node.level === 1 && node.turns.every(turn => ['t0', 't1', 't2', 't3', 't4', 't5'].includes(turn.turnId)));
    snapshot.context.selected = [];
    snapshot.context.archivedTurnIds = [];
    Object.assign(snapshot.context.preset!, { minTail: 2, batchSize: 3, promotionGroup: 5 });
    snapshot.settings.targetInputTokens = 200;

    const result = refreshContext(snapshot, { allowOverflowFallback: true });
    expect(result.state.archivedTurnIds).toEqual(['t0', 't1', 't2', 't3']);
    expect(contextPlan(apply(snapshot, result.state))).toMatchObject({ blocked: null, next: { level: 1, turnIds: ['t4', 't5', 't6'] } });
  });

  it('rejects stale sources and cannot silently omit history when no saved selection fits', () => {
    const snapshot = fixture(); snapshot.turns[0].user.revision++;
    expect(() => refreshContext(snapshot)).toThrow('out of date');
    snapshot.turns[0].user.revision--; snapshot.settings.targetInputTokens = 20;
    expect(() => refreshContext(snapshot)).toThrow('Memory is unchanged');
    expect(snapshot.context.archivedTurnIds).toHaveLength(62);
  });

  it('keeps repeated selections stable over budgets and saved-group settings', () => {
    for (const group of [2, 3]) for (const batch of [2, 3]) for (const target of [800, 1_200, 2_000, 4_000, 8_000, 16_000]) {
      const snapshot = fixture();
      snapshot.context.preset!.promotionGroup = group; snapshot.context.preset!.batchSize = batch;
      snapshot.settings.targetInputTokens = target;
      const result = refreshContext(snapshot);
      const repeated = refreshContext(apply(snapshot, result.state));
      expect(repeated.state.selected).toEqual(result.state.selected);
      expect(repeated.state.archivedTurnIds).toEqual(result.state.archivedTurnIds);
      expect(repeated.report.changed).toBe(false);
      expect(result.report.inputAfter).toBeLessThanOrEqual(target);
    }
  });
});
