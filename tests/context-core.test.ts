import { describe, expect, it } from 'vitest';
import reference from './fixtures/compaction-reference.json';
import { defaultContextPreset, emptyContextState, refKey, type ContextState, type SummaryNode } from '../src/shared/context.js';
import type { Turn } from '../src/shared/contracts.js';
import { nextCompaction, rankedPromotions, repairQueue, replaceSelection, selectedContext, sourceOf, staleSummaries } from '../src/core/context.js';
import { assembleRequest } from '../src/core/prompt.js';
import { defaultPrompt } from '../src/shared/library.js';

const turn = (position: number): Turn => ({ id: `t${position}`, position, complete: true, user: { id: `u${position}`, text: `User ${position}`, revision: 0 }, assistant: { id: `a${position}`, text: `Assistant ${position}`, revision: 0 } });
const node = (id: string, level: number, turns: Turn[]): SummaryNode => ({ id, revision: 0, level, turns: turns.map(sourceOf), children: [], prior: [], text: `Saved facts from ${id}`, createdAt: '', approved: true, manual: false });

describe('stateful layered context', () => {
  it('rejects promotions that would deepen an existing chronological hole', () => {
    const turns = Array.from({ length: 20 }, (_, i) => turn(i + 1));
    const manual = { ...node('corrected', 2, turns.slice(0, 4)), manual: true };
    const recent = Array.from({ length: 7 }, (_, i) => node(`recent-${i}`, 2, turns.slice(4 + i * 2, 6 + i * 2)));
    const summaries = [node('older', 1, turns.slice(0, 2)), { ...manual, turns: turns.slice(2, 4).map(sourceOf) }, ...recent];
    const sizes = new Map(summaries.map(node => [refKey(node), 500]));
    // Legacy selections can contain this hole. A deeper promotion would cement
    // it; manual Prepare must restore chronological detail first.
    expect(rankedPromotions(summaries, { ...defaultContextPreset, promotionGroup: 2, retainedPerLevel: 1 }, sizes)).toEqual([]);
  });
  it('orders over a hundred affected dependencies once, excluding unrelated retained versions', () => {
    const turns = Array.from({ length: 151 }, (_, i) => turn(i + 1));
    const summaries = turns.slice(0, 150).map((turn, i) => ({ ...node(`s${i}`, 1, [turn]), prior: i ? [{ id: `s${i - 1}`, revision: 0 }] : [] }));
    const unrelated = node('unrelated-retained', 1, [turns[150]]);
    const state: ContextState = { revision: 0, summaries: [...summaries, unrelated], selected: summaries, archivedTurnIds: turns.slice(0, 150).map(turn => turn.id) };
    turns[0].user.revision++; turns[150].user.revision++;
    expect(repairQueue(turns, state).map(operation => operation.repair!.id)).toEqual(summaries.map(node => node.id));
  });
  for (const golden of reference) it(`matches the Python model across 1,000 requests: batch ${golden.settings.batch}`, () => {
    const settings = { ...defaultContextPreset, minTail: golden.settings.tail, batchSize: golden.settings.batch, promotionGroup: golden.settings.group, retainedPerLevel: golden.settings.retained };
    let state = emptyContextState();
    const retired = new Set<string>();
    for (let count = 1; count <= 1_000; count++) {
      const turns = Array.from({ length: count }, (_, i) => turn(i + 1));
      const before = state.selected.map(refKey);
      while (true) {
        const verbatim = count - state.archivedTurnIds.length;
        const required = golden.settings.overhead + verbatim * 1_000;
        const input = required + state.selected.length * golden.settings.summary_tokens;
        const sizes = new Map(state.selected.map(ref => [refKey(ref), golden.settings.summary_tokens]));
        const decision = nextCompaction(turns, state, settings, input, golden.settings.target, required, sizes);
        expect(decision.blocked).toBeNull();
        if (!decision.next) break;
        const summary = { ...node(`s${state.summaries.length}`, decision.next.level, turns.filter(turn => decision.next!.turnIds.includes(turn.id))), children: decision.next.children };
        state = replaceSelection(state, decision.next, summary);
      }
      const selected = state.selected.map(refKey);
      expect(selected.some(id => retired.has(id))).toBe(false);
      before.filter(id => !selected.includes(id)).forEach(id => retired.add(id));
      const resolved = selectedContext(turns, state);
      expect(resolved.summaries.flatMap(node => node.turns.map(source => source.turnId))).toEqual(state.archivedTurnIds);
      const expected = golden.frames.find(frame => frame.turns === count);
      if (expected) {
        expect(state.archivedTurnIds.length).toBe(expected.archived);
        expect(resolved.summaries.map(node => [node.level, Number(node.turns[0].turnId.slice(1)), Number(node.turns.at(-1)!.turnId.slice(1))])).toEqual(expected.active);
      }
      // A serialized checkpoint alone must support continuation, including 301 -> 302.
      if (count === 301) state = JSON.parse(JSON.stringify(state)) as ContextState;
    }
    const saved = state.selected;
    expect(nextCompaction(Array.from({ length: 1_000 }, (_, i) => turn(i + 1)), state, settings, 1, golden.settings.target, 0, new Map()).next).toBeNull();
    expect(state.selected).toEqual(saved);
  });

  it('protects residual turns and a pending input without inventing smaller batches', () => {
    const turns = Array.from({ length: 102 }, (_, i) => turn(i + 1));
    const decision = nextCompaction(turns, emptyContextState(), { ...defaultContextPreset, minTail: 100, batchSize: 3 }, 102_000, 101_000, 102_000, new Map());
    expect(decision.next).toBeNull(); expect(decision.blocked).toContain('required verbatim');
    const pending = { ...turn(103), complete: false };
    expect(nextCompaction([...turns, pending], emptyContextState(), { ...defaultContextPreset, minTail: 100 }, 105_000, 101_000, 105_000, new Map()).next).toBeNull();
  });

  it('uses uneven actual sizes for pressure, but counts for retained floors and fixed groups', () => {
    const turns = Array.from({ length: 14 }, (_, i) => turn(i + 1));
    const summaries = [node('deep-a', 2, turns.slice(0, 2)), node('deep-b', 2, turns.slice(2, 4)), node('deep-c', 2, turns.slice(4, 6)), ...Array.from({ length: 6 }, (_, i) => node(`recent-${i}`, 1, turns.slice(6 + i, 7 + i)))];
    const state: ContextState = { revision: 0, archivedTurnIds: turns.slice(0, 12).map(turn => turn.id), selected: summaries.map(({ id, revision }) => ({ id, revision })), summaries };
    const sizes = new Map(summaries.map(node => [refKey(node), node.level === 2 ? 500 : 50]));
    const config = { ...defaultContextPreset, minTail: 2, promotionGroup: 2, retainedPerLevel: 1 };
    expect(nextCompaction(turns, state, config, 2_500, 2_000, 700, sizes).next?.children.map(ref => ref.id)).toEqual(['deep-a', 'deep-b']);
    sizes.set('recent-5:0', 8_000); // Protected newest summary raises pressure; oldest group is still selected.
    expect(nextCompaction(turns, state, config, 10_000, 2_000, 700, sizes).next?.children.map(ref => ref.id)).toEqual(['recent-0', 'recent-1']);
  });

  it('detects changed sources and dependent prior context, and refuses overlapping coverage', () => {
    const turns = [turn(1), turn(2)];
    const first = node('first', 1, turns.slice(0, 1)), second = { ...node('second', 1, turns.slice(1)), prior: [{ id: first.id, revision: 0 }] };
    const state: ContextState = { revision: 0, archivedTurnIds: turns.map(turn => turn.id), selected: [first, second], summaries: [first, second] };
    const edited = [{ ...turns[0], user: { ...turns[0].user, revision: 1 } }, turns[1]];
    expect(staleSummaries(edited, state)).toEqual(new Set(['first:0', 'second:0']));
    expect(() => selectedContext(edited, state)).toThrow('out of date');
    expect(() => selectedContext(turns, { ...state, selected: [first, first] })).toThrow('coverage changed');
  });

  it('shares one cutoff across Summary and Messages markers, with no doubled history', () => {
    const turns = [turn(1), turn(2), { ...turn(3), complete: false }];
    const summary = node('memory', 1, turns.slice(0, 2));
    const state: ContextState = { revision: 1, summaries: [summary], archivedTurnIds: ['t1', 't2'], selected: [summary] };
    const connection = { name: 'Test', endpoint: 'http://localhost/v1', model: 'synthetic', contextWindow: 10_000, maxOutputTokens: 100, customParameters: {} };
    const settings = { title: 'Test', targetInputTokens: 5_000, instructions: '', character: '', persona: '' };
    const sources = { prompt: { ...defaultPrompt, id: 'prompt', revision: 0, blocks: [{ id: 's', name: 'Summary', enabled: true, kind: 'marker' as const, marker: 'summary' as const, role: 'system' as const }, defaultPrompt.blocks.find(block => block.id === 'messages')!] }, character: null, persona: null };
    const request = assembleRequest(connection, settings, turns, sources, state);
    expect(request.body.messages).toHaveLength(2);
    expect(request.body.messages[0].content).toContain(summary.text);
    expect(request.body.messages[1]).toEqual({ role: 'user', content: 'User 3' });
    expect(request.context?.archivedTurnIds).toEqual(['t1', 't2']);
    expect(request.coverage).toHaveLength(3);
  });
});
