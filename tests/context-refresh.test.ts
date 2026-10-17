import { describe, expect, it } from 'vitest';
import type { ChatSnapshot, Turn } from '../src/shared/contracts.js';
import { defaultContextPreset, refKey, type SummaryNode } from '../src/shared/context.js';
import { repairQueue, selectedContext, sourceOf } from '../src/core/context.js';
import { refreshContext } from '../src/core/context-refresh.js';
import { defaultPrompt } from '../src/shared/library.js';
import { contextPlan, summaryRequest } from '../src/core/context-plan.js';
import { correctionProtection } from '../src/core/context-corrections.js';
import { savedReplacement } from '../src/core/context-reuse.js';
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
  it('reconciles crossing alternatives through a saved container instead of choosing one correction', () => {
    const snapshot = fixture();
    const leaves = snapshot.context.summaries.filter(node => node.level === 1);
    snapshot.context.selected = leaves.map(({ id, revision }) => ({ id, revision }));
    const first = snapshot.context.summaries.find(node => node.id === 'parent-2-0')!;
    const a = { ...first, id: 'correction-a', manual: true, text: 'Mira owns the key.' };
    const children = leaves.slice(1, 3);
    const b = { ...first, id: 'correction-b', manual: true, text: 'Leon owns the key.', turns: children.flatMap(node => node.turns), children: children.map(({ id, revision }) => ({ id, revision })) };
    snapshot.context.summaries.push(a, b);
    expect(() => refreshContext(snapshot)).toThrow(/reconciliation/i);
    const operation = repairQueue(snapshot.turns, snapshot.context)[0];
    expect(operation.reconcile?.map(ref => ref.id).sort()).toEqual([a.id, b.id]);
    const request = summaryRequest(snapshot, operation, snapshot.connection!).request;
    expect(JSON.stringify(request.body)).toContain(a.text);
    expect(JSON.stringify(request.body)).toContain(b.text);
    const baseline = snapshot.context.summaries.find(node => refKey(node) === refKey(operation.repair!))!;
    // Simulate explicit approval: new editorial dependencies are not inferred.
    snapshot.context.summaries.push({ ...baseline, revision: baseline.revision + 1, text: 'Reviewed ownership and borrowing.', corrections: operation.reconcile });
    const result = refreshContext(snapshot);
    expect(correctionProtection(snapshot.turns, result.state).unresolved).toEqual([]);
    expect(result.state.selected).toContainEqual({ id: baseline.id, revision: baseline.revision + 1 });
  });

  it.each([90_000, 1_200])('represents a fresh retained alternative correction at budget %i', target => {
    const snapshot = fixture();
    const source = snapshot.context.summaries.find(node => node.id === 'parent-2-0')!;
    const correction = { ...source, id: 'retained-correction', manual: true, text: 'Mira kept the key. Her sister owns a duplicate.' };
    snapshot.context.summaries.push(correction);
    snapshot.settings.targetInputTokens = target;
    const before = structuredClone(snapshot);
    const result = refreshContext(snapshot, { allowOverflowFallback: true });
    const represented = (node: SummaryNode): boolean => node.id === correction.id || node.children.some(ref => represented(snapshot.context.summaries.find(child => refKey(child) === refKey(ref))!));
    expect(selectedContext(snapshot.turns, result.state).summaries.some(represented)).toBe(true);
    expect(snapshot).toEqual(before);
    expect(refreshContext(apply(snapshot, result.state), { allowOverflowFallback: true }).state.selected).toEqual(result.state.selected);
  });

  it('blocks ordinary preparation of a stale retained L2 correction instead of generating a different identity', () => {
    const snapshot = fixture();
    const source = snapshot.context.summaries.find(node => node.id === 'parent-2-0')!;
    snapshot.context.summaries.push({ ...source, id: 'retained-correction', manual: true, text: 'Mira kept the key.' });
    snapshot.turns[0].user.revision++;
    // The committed alternative uses current sources but never incorporated the correction.
    snapshot.context.summaries = snapshot.context.summaries.map(node => node.id === 'retained-correction' ? node : { ...node, turns: node.turns.map(source => source.turnId === 't0' ? { ...source, userRevision: 1 } : source) });
    expect(contextPlan(snapshot)).toMatchObject({ ready: false, next: null, blocked: expect.stringMatching(/correction.*repair|repair.*correction/i) });
    const replacement = { level: source.level, turnIds: source.turns.map(turn => turn.turnId), children: source.children };
    expect(savedReplacement(snapshot, replacement)).toBeNull();
    expect(() => summaryRequest(snapshot, replacement, snapshot.connection!)).toThrow(/correction.*reconciliation/i);
    expect(() => refreshContext(snapshot)).toThrow(/correction.*repair|repair.*correction/i);
  });
  it('restores the completed tail through prior dependencies while keeping the actual correction active', () => {
    const snapshot = fixture();
    snapshot.settings.targetInputTokens = 90_000;
    snapshot.context.preset!.minTail = 8;
    const leaves = snapshot.context.summaries.filter(node => node.level === 1);
    const corrected = leaves[5];
    corrected.manual = true;
    corrected.text += ' Author correction: her sister owns a duplicate.';
    for (let i = 6; i < leaves.length; i++) leaves[i].prior = [leaves[i - 1]];
    snapshot.turns.at(-1)!.complete = false;
    const result = refreshContext(snapshot, { allowOverflowFallback: true });
    expect(result.state.selected).toContainEqual({ id: corrected.id, revision: corrected.revision });
    expect(result.state.archivedTurnIds).toEqual(snapshot.turns.slice(0, 12).map(turn => turn.id));
    expect(result.report.protectedSummaries).toBe(1);
    expect(contextPlan(apply(snapshot, result.state))).toMatchObject({ ready: true, blocked: null });
    expect(refreshContext(apply(snapshot, result.state)).state.selected).toEqual(result.state.selected);
  });

  it('keeps older memory at least as compact as a later directly edited summary', () => {
    const snapshot = fixture();
    snapshot.settings.targetInputTokens = 90_000;
    const corrected = snapshot.context.summaries.find(node => refKey(node) === refKey(snapshot.context.selected.at(-2)!))!;
    expect(corrected.level).toBe(2);
    corrected.manual = true;
    const result = refreshContext(snapshot);
    const active = selectedContext(snapshot.turns, result.state).summaries;
    expect(active).toContainEqual(corrected);
    expect(active.every((node, i) => i === 0 || active[i - 1].level >= node.level)).toBe(true);
    expect(result.state.archivedTurnIds).toHaveLength(60);
    expect(refreshContext(apply(snapshot, result.state)).state.selected).toEqual(result.state.selected);
  });

  it('identifies a direct correction that conflicts with the completed-tail minimum without falling back', () => {
    const snapshot = fixture();
    snapshot.settings.targetInputTokens = 90_000;
    snapshot.context.preset!.minTail = 8;
    const corrected = snapshot.context.summaries.find(node => refKey(node) === refKey(snapshot.context.selected.at(-1)!))!;
    corrected.manual = true;
    const original = structuredClone(snapshot.context);
    expect(() => refreshContext(snapshot, { allowOverflowFallback: true })).toThrow(/manually edited summary.*61.*62.*minimum.*8/i);
    expect(snapshot.context).toEqual(original);
  });

  it('repairs a legacy middle-level hole while restoring newer history after a corrected child', () => {
    const snapshot = fixture();
    snapshot.settings.targetInputTokens = 90_000;
    const parent = snapshot.context.summaries.find(node => node.id === 'parent-2-28')!;
    const corrected = snapshot.context.summaries.find(node => refKey(node) === refKey(parent.children[0]))!;
    corrected.manual = true;
    const earlier = snapshot.context.summaries.find(node => node.id === 'parent-3-12')!;
    snapshot.context.selected = snapshot.context.selected.flatMap(ref => refKey(ref) === refKey(earlier) ? earlier.children : [ref]);
    const result = refreshContext(snapshot);
    const active = selectedContext(snapshot.turns, result.state).summaries;
    expect(active.every((node, i) => i === 0 || active[i - 1].level >= node.level)).toBe(true);
    expect(active).toContainEqual(corrected);
    expect(result.state.archivedTurnIds).toHaveLength(58);
  });

  it('restores an incompatible cutoff before generating missing compression instead of falling back to it', () => {
    const snapshot = fixture();
    snapshot.context.preset!.minTail = 8;
    snapshot.context.preset!.batchSize = 3; // No saved batches match these new settings.
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

  it('keeps direct corrections and allows their generated parents to expand into the corrected children', () => {
    for (const hiddenChild of [false, true]) {
      const snapshot = fixture(); snapshot.settings.targetInputTokens = 90_000;
      const root = snapshot.context.summaries.find(node => refKey(node) === refKey(snapshot.context.selected[0]))!;
      const corrected = hiddenChild ? snapshot.context.summaries.find(node => refKey(node) === refKey(root.children[0]))! : root;
      corrected.manual = true; corrected.text += ' Author correction: her sister owns a duplicate.';
      const result = refreshContext(snapshot);
      expect(result.report.protectedSummaries).toBe(1);
      expect(result.state.selected).toContainEqual({ id: corrected.id, revision: corrected.revision });
      if (hiddenChild) expect(result.state.selected).not.toContainEqual({ id: root.id, revision: root.revision });
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
