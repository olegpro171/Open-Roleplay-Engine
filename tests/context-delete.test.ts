import { describe, expect, it } from 'vitest';
import { summaryDeletion } from '../src/core/context-delete.js';
import { emptyContextState, type SummaryNode } from '../src/shared/context.js';

const ref = (id: string, revision = 0) => ({ id, revision });
const node = (id: string, turns: string[], extra: Partial<SummaryNode> = {}): SummaryNode => ({
  ...ref(id), level: 1, text: id, turns: turns.map(turnId => ({ turnId, userRevision: 0, assistantRevision: 0, complete: true })),
  children: [], prior: [], approved: true, manual: false, createdAt: '2026-10-20T00:00:00Z', ...extra,
});

describe('summary deletion planning', () => {
  it('follows child, prior and correction consumers across old versions without deleting sources or unrelated identities', () => {
    const state = { ...emptyContextState(), summaries: [
      node('source', ['1']), node('source', ['1'], { revision: 1 }),
      node('parent', ['1', '2'], { level: 2, children: [ref('source'), ref('sibling')] }),
      node('sibling', ['2']),
      node('later', ['3'], { prior: [ref('parent')] }),
      node('corrected', ['4'], { corrections: [ref('later')] }),
      node('corrected', ['4'], { revision: 1 }),
      node('unrelated', ['5']),
    ] };
    const result = summaryDeletion(state, ref('source', 1));
    expect([...result.deletedIds]).toEqual(['source', 'parent', 'later', 'corrected']);
    expect(result.deleted).toHaveLength(6);
    expect(result.after.summaries.map(node => node.id)).toEqual(['sibling', 'unrelated']);
    expect(state.summaries).toHaveLength(8);
    expect(() => summaryDeletion(state, ref('source'))).toThrow('current approved');
  });

  it('keeps the earlier selected prefix and saves unaffected later summaries for explicit reuse', () => {
    const state = { ...emptyContextState(), revision: 4, archivedTurnIds: ['1', '2', '3'],
      selected: [ref('a'), ref('b'), ref('c')], summaries: [node('a', ['1']), node('b', ['2']), node('c', ['3'])] };
    const result = summaryDeletion(state, ref('b'));
    expect(result.after).toMatchObject({ revision: 5, selected: [ref('a')], archivedTurnIds: ['1'] });
    expect(result.restoredTurnIds).toEqual(['2', '3']);
    expect(result.after.summaries.map(node => node.id)).toEqual(['a', 'c']);
    const retainedOnly = summaryDeletion({ ...state, selected: [ref('a')], archivedTurnIds: ['1'] }, ref('c'));
    expect(retainedOnly.restoredTurnIds).toEqual([]);
    expect(retainedOnly.after.selected).toEqual([ref('a')]);
  });
});
