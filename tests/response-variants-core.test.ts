import { describe, expect, it } from 'vitest';
import { sourceOf, staleSummaries } from '../src/core/context.js';
import { emptyContextState, refKey, type SummaryNode } from '../src/shared/context.js';

describe('response content provenance', () => {
  it('does not clear unrelated stale memory or its dependents when the original variant returns', () => {
    const turn = (id: string) => ({ id, position: 1, complete: true, user: { id: `u-${id}`, text: 'Input', revision: 0 }, assistant: { id: `a-${id}`, text: 'A', revision: 3, sourceRevision: 1 } });
    const a = turn('a'), c = turn('c');
    const summary = (id: string, source: typeof a): SummaryNode => ({ id, revision: 0, level: 1, text: 'Memory', turns: [sourceOf(source)], children: [], prior: [], approved: true, manual: false, createdAt: '' });
    const first = summary('first', a), second = summary('second', c);
    const parent: SummaryNode = { ...first, id: 'parent', level: 2, turns: [...first.turns, ...second.turns], children: [first, second] };
    const state = { ...emptyContextState(), summaries: [first, second, parent] };
    const changedC = { ...c, user: { ...c.user, revision: 1 } };
    expect(staleSummaries([a, changedC], state)).toEqual(new Set([refKey(second), refKey(parent)]));
  });
  it('restores freshness on A → B → A without rolling back selection revisions or unrelated changes', () => {
    const turn = { id: 'turn', position: 1, complete: true,
      user: { id: 'u', text: 'An invitation', revision: 0 },
      assistant: { id: 'a', text: 'A', revision: 1, sourceRevision: 1 } };
    const summary: SummaryNode = { id: 'summary', revision: 0, level: 1, text: 'A', turns: [sourceOf(turn)], children: [], prior: [], approved: true, manual: false, createdAt: '' };
    const parent: SummaryNode = { ...summary, id: 'parent', level: 2, children: [summary] };
    const state = { ...emptyContextState(), summaries: [summary, parent] };
    expect(staleSummaries([turn], state).size).toBe(0);
    const b = { ...turn, assistant: { ...turn.assistant, text: 'B', revision: 2, sourceRevision: 2 } };
    expect(staleSummaries([b], state)).toEqual(new Set([refKey(summary), refKey(parent)]));
    const returned = { ...turn, assistant: { ...turn.assistant, revision: 3 } };
    expect(staleSummaries([returned], state).size).toBe(0);
    expect(staleSummaries([{ ...returned, user: { ...returned.user, revision: 1 } }], state).size).toBe(2);
    const edited = { ...returned, assistant: { ...returned.assistant, text: 'Edited A', revision: 4, sourceRevision: 4 } };
    expect(staleSummaries([edited], state).size).toBe(2);
    const repaired = { ...summary, revision: 1, turns: [sourceOf(b)] };
    expect(staleSummaries([returned], { ...state, summaries: [repaired] })).toContain(refKey(repaired));
  });
});
