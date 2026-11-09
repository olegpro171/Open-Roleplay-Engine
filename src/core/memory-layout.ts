import type { Turn } from '../shared/contracts.js';
import { refKey, type ContextOperation, type ContextPreset, type ContextState, type SummaryNode, type SummaryRef } from '../shared/context.js';
import { latestApproved, summaryDependencies } from './context-corrections.js';

export type MemoryLayoutCleanup = {
  deletedIds: Set<string>;
  restoredTurnIds: string[];
  after: ContextState;
};

export function changedMemoryShape(previous: ContextPreset | null, next: ContextPreset | null): boolean {
  return Boolean(previous && next && (previous.batchSize !== next.batchSize || previous.promotionGroup !== next.promotionGroup));
}

const provenance = (node: SummaryNode) => [...summaryDependencies(node), ...(node.basedOn ? [node.basedOn] : [])];

function versionsByIdentity(summaries: SummaryNode[]): Map<string, SummaryNode[]> {
  const versions = new Map<string, SummaryNode[]>();
  for (const node of summaries) {
    const group = versions.get(node.id);
    if (group) group.push(node);
    else versions.set(node.id, [node]);
  }
  return versions;
}

function keepProvenance(kept: Set<string>, versions: Map<string, SummaryNode[]>) {
  for (const id of kept) {
    for (const node of versions.get(id) ?? []) {
      for (const dependency of provenance(node)) kept.add(dependency.id);
    }
  }
}

/** Identify the conflicting roots before requesting or selecting their replacement. */
export function supersededMemoryAlternatives(committed: ContextState, selection: SummaryRef[], operation: ContextOperation, reusable?: SummaryRef): SummaryRef[] {
  const sources = new Set(operation.turnIds);
  const competing = latestApproved(committed).filter(node => node.id !== reusable?.id && node.level === operation.level
    && node.turns.some(source => sources.has(source.turnId)));
  if (!competing.length) return [];

  // Regeneration advances a working selection while the branch's committed
  // selection still needs its own complete provenance.
  const kept = new Set([...committed.selected, ...selection, ...operation.children].map(ref => ref.id));
  if (reusable) kept.add(reusable.id);
  keepProvenance(kept, versionsByIdentity(committed.summaries));

  return competing.filter(node => !kept.has(node.id)).map(({ id, revision }) => ({ id, revision }));
}

type TurnMembership = Pick<Turn, 'id' | 'complete'>;
type CommittedSpan = { index: number; layerIndex: number; node: SummaryNode };

function cleanup(state: ContextState, deletedIds: Set<string>, selected: ContextState['selected'], archivedTurnIds: string[]): MemoryLayoutCleanup {
  const restoredTurnIds = state.archivedTurnIds.slice(archivedTurnIds.length);
  return {
    deletedIds, restoredTurnIds,
    after: { revision: state.revision + 1, selected, archivedTurnIds, summaries: state.summaries.filter(node => !deletedIds.has(node.id)) },
  };
}

function matchesPromotionGroup(node: SummaryNode, committed: Map<string, CommittedSpan>, groupSize: number): boolean {
  if (node.children.length !== groupSize) return false;
  const first = committed.get(refKey(node.children[0]));
  if (!first || first.layerIndex % groupSize !== 0) return false;
  let offset = 0;
  for (const [index, ref] of node.children.entries()) {
    const child = committed.get(refKey(ref));
    if (!child || child.index !== first.index + index || child.node.level !== node.level - 1) return false;
    if (child.node.turns.some((turn, index) => turn.turnId !== node.turns[offset + index]?.turnId)) return false;
    offset += child.node.turns.length;
  }
  return offset > 0 && offset === node.turns.length;
}

/** Keep committed provenance and inactive checkpoints that still match the new layout. */
export function resizedMemoryLayout(state: ContextState, turns: TurnMembership[], next: Pick<ContextPreset, 'batchSize' | 'promotionGroup'>): MemoryLayoutCleanup {
  const versions = versionsByIdentity(state.summaries);
  const byRef = new Map(state.summaries.map(node => [refKey(node), node]));
  const committed = new Map<string, CommittedSpan>();
  const layerCounts = new Map<number, number>();
  for (const [index, ref] of state.selected.entries()) {
    const key = refKey(ref);
    const node = byRef.get(key);
    if (!node) continue;
    const layerIndex = layerCounts.get(node.level) ?? 0;
    committed.set(key, { index, layerIndex, node });
    layerCounts.set(node.level, layerIndex + 1);
  }
  const kept = new Set(state.selected.map(ref => ref.id));
  const positions = new Map(turns.map((turn, index) => [turn.id, index]));
  // Earlier archived deletions can leave missing IDs in the stored cutoff until repair.
  const cutoff = state.archivedTurnIds.filter(id => positions.has(id)).length;
  for (const node of latestApproved(state)) {
    if (kept.has(node.id)) continue;
    if (node.level === 1) {
      const start = positions.get(node.turns[0]?.turnId);
      if (start !== undefined && start >= cutoff && (start - cutoff) % next.batchSize === 0 &&
        node.turns.length === next.batchSize && node.turns.every((source, index) => {
          const turn = turns[start + index];
          return turn?.complete && turn.id === source.turnId;
        })) kept.add(node.id);
    } else if (matchesPromotionGroup(node, committed, next.promotionGroup)) {
      kept.add(node.id);
    }
  }
  keepProvenance(kept, versions);
  const removed = new Set([...versions.keys()].filter(id => !kept.has(id)));
  return cleanup(state, removed, state.selected, state.archivedTurnIds);
}

/** Find the longest prefix of whole selected spans and all of their surviving provenance. */
export function shortenedMemoryLayout(state: ContextState, turns: TurnMembership[], minTail: number): MemoryLayoutCleanup {
  const positions = new Map(turns.map((turn, index) => [turn.id, index]));
  const shortened = turns.slice(0, -1);
  const tailBoundary = shortened.filter(turn => turn.complete).length - minTail;
  const endById = new Map<string, number>();
  const consumers = new Map<string, Set<string>>();
  for (const node of state.summaries) {
    let end = endById.get(node.id) ?? -1;
    for (const source of node.turns) end = Math.max(end, positions.get(source.turnId) ?? -1);
    endById.set(node.id, end);
    for (const dependency of provenance(node)) {
      const uses = consumers.get(dependency.id) ?? new Set<string>();
      uses.add(node.id);
      consumers.set(dependency.id, uses);
    }
  }

  // A summary requires every historical dependency to survive. Propagate each
  // identity's furthest source first so a consumer's bound is assigned once.
  const requiredEnd = new Map<string, number>();
  for (const [id, end] of [...endById].sort((a, b) => b[1] - a[1])) {
    if (requiredEnd.has(id)) continue;
    const affected = new Set([id]);
    for (const use of affected) {
      requiredEnd.set(use, end);
      for (const consumer of consumers.get(use) ?? []) if (!requiredEnd.has(consumer)) affected.add(consumer);
    }
  }

  const byRef = new Map(state.summaries.map(node => [refKey(node), node]));
  let offset = 0;
  let dependencyEnd = -1;
  let previousLevel = Infinity;
  let selectedCount = 0;
  let cutoff = 0;
  for (const [i, ref] of state.selected.entries()) {
    const node = byRef.get(refKey(ref));
    if (!node?.approved || !node.turns.length || node.level > previousLevel || offset + node.turns.length > tailBoundary) break;
    if (node.turns.some((source, j) => {
      const turn = shortened[offset + j];
      return !turn?.complete || turn.id !== source.turnId || state.archivedTurnIds[offset + j] !== turn.id;
    })) break;
    offset += node.turns.length;
    previousLevel = node.level;
    dependencyEnd = Math.max(dependencyEnd, requiredEnd.get(ref.id) ?? -1);
    if (dependencyEnd < offset) {
      cutoff = offset;
      selectedCount = i + 1;
    }
  }
  const removed = new Set([...requiredEnd].filter(([, end]) => end >= cutoff).map(([id]) => id));
  const result = cleanup(state, removed, state.selected.slice(0, selectedCount), state.archivedTurnIds.slice(0, cutoff));
  return { ...result, restoredTurnIds: result.restoredTurnIds.filter(id => (positions.get(id) ?? Infinity) < shortened.length) };
}
