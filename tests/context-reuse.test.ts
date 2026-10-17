import { describe, expect, it } from 'vitest';
import type { ChatSnapshot, Turn } from '../src/shared/contracts.js';
import { defaultContextPreset, type SummaryNode } from '../src/shared/context.js';
import { sourceOf } from '../src/core/context.js';
import { savedReplacement } from '../src/core/context-reuse.js';

function fixture(): { snapshot: ChatSnapshot; node: SummaryNode } {
  const turns: Turn[] = Array.from({ length: 6 }, (_, i) => ({ id: `t${i}`, position: i, complete: true,
    user: { id: `u${i}`, revision: 0, text: 'Mira offers Leon her brass key. '.repeat(20) },
    assistant: { id: `a${i}`, revision: 0, text: 'Leon promises to return it before dawn. '.repeat(20) } }));
  const node: SummaryNode = { id: 'cached', revision: 0, level: 1, turns: turns.slice(0, 2).map(sourceOf), text: 'Leon borrowed the brass key.', children: [], prior: [], approved: true, manual: false, createdAt: '2026-10-17' };
  const snapshot: ChatSnapshot = { id: 'synthetic', revision: 0, hasApiKey: false, generations: [],
    settings: { title: 'Reuse', targetInputTokens: 1_000, instructions: '', character: '', persona: '' },
    connection: { name: 'Test', endpoint: 'http://localhost/v1', model: 'synthetic', contextWindow: 10_000, maxOutputTokens: 100, customParameters: {} },
    sources: { prompt: null, character: null, persona: null }, turns,
    context: { revision: 0, selected: [], archivedTurnIds: [], summaries: [node], jobs: [], preset: { ...defaultContextPreset, id: 'preset', revision: 0 } } };
  return { snapshot, node };
}
const operation = { level: 1, turnIds: ['t0', 't1'], children: [] };

describe('saved summary reuse', () => {
  it('reuses an exact approved batch without adding a duplicate node', () => {
    const { snapshot, node } = fixture();
    const result = savedReplacement(snapshot, operation)!;
    expect(result.node).toBe(node);
    expect(result.state.summaries).toBe(snapshot.context.summaries);
    expect(result.state.selected).toEqual([{ id: node.id, revision: node.revision }]);
    expect(result.state.archivedTurnIds).toEqual(operation.turnIds);
    expect(snapshot.context.selected).toEqual([]);
  });

  it('rejects unapproved, superseded, stale, mismatched and non-shrinking summaries', () => {
    for (const kind of ['unapproved', 'superseded', 'stale', 'mismatched', 'long'] as const) {
      const { snapshot, node } = fixture();
      if (kind === 'unapproved') node.approved = false;
      if (kind === 'superseded') snapshot.context.summaries.push({ ...node, revision: 1, approved: true, turns: snapshot.turns.slice(0, 3).map(sourceOf) });
      if (kind === 'stale') snapshot.turns[0].assistant.revision++;
      if (kind === 'mismatched') node.children = [{ id: 'other', revision: 0 }];
      if (kind === 'long') node.text = 'Long manual correction. '.repeat(5_000);
      expect(savedReplacement(snapshot, operation)).toBeNull();
    }
  });

  it('rejects a stale prior dependency even when covered turns have not changed', () => {
    const { snapshot, node } = fixture();
    const earlier = { ...node, id: 'earlier' }, revised = { ...earlier, revision: 1 };
    node.turns = snapshot.turns.slice(2, 4).map(sourceOf); node.prior = [{ id: earlier.id, revision: 0 }];
    snapshot.context.summaries.push(earlier, revised);
    snapshot.context.selected = [{ id: revised.id, revision: 1 }]; snapshot.context.archivedTurnIds = ['t0', 't1'];
    const next = { ...operation, turnIds: ['t2', 't3'] };
    expect(savedReplacement(snapshot, next)).toBeNull();
    node.prior = [{ id: revised.id, revision: 1 }];
    expect(savedReplacement(snapshot, next)?.node).toBe(node);
  });
});
