import { describe, expect, it } from 'vitest';
import type { ChatSnapshot, Turn } from '../src/shared/contracts.js';
import { defaultContextPreset, refKey, type SummaryNode } from '../src/shared/context.js';
import { selectedContext, sourceOf } from '../src/core/context.js';
import { refreshContext } from '../src/core/context-refresh.js';
import { defaultPrompt } from '../src/shared/library.js';
import { contextPlan } from '../src/core/context-plan.js';
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

describe('manual memory refresh using the saved tree', () => {
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

  it('keeps selected manual corrections and parents carrying manual dependency content', () => {
    for (const hiddenChild of [false, true]) {
      const snapshot = fixture(); snapshot.settings.targetInputTokens = 90_000;
      const root = snapshot.context.summaries.find(node => refKey(node) === refKey(snapshot.context.selected[0]))!;
      const corrected = hiddenChild ? snapshot.context.summaries.find(node => refKey(node) === refKey(root.children[0]))! : root;
      corrected.manual = true; corrected.text += ' Author correction: her sister owns a duplicate.';
      const result = refreshContext(snapshot);
      expect(result.report.protectedSummaries).toBe(1);
      expect(result.state.selected).toContainEqual({ id: root.id, revision: root.revision });
      expect(refreshContext(apply(snapshot, result.state)).state.selected).toEqual(result.state.selected);
    }
  });

  it('keeps the current selection when changed groups have no saved replacement', () => {
    const snapshot = fixture(); snapshot.context.preset!.batchSize = 3;
    const result = refreshContext(snapshot);
    expect(result.report).toMatchObject({ changed: false, limited: true });
    expect(result.state.selected).toEqual(snapshot.context.selected);
    snapshot.context.preset!.batchSize = 2; snapshot.context.preset!.promotionGroup = 3;
    snapshot.settings.targetInputTokens = measure(snapshot) + 50;
    expect(refreshContext(snapshot).report).toMatchObject({ changed: false, limited: true });
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
