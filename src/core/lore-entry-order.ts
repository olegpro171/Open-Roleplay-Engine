import type { LoreEntry } from '../shared/lorebook.js';

export function compareInsertionOrder(left: LoreEntry, right: LoreEntry): number {
  return left.insertionOrder - right.insertionOrder;
}

/** Encode a changed list position without relying on array or World Info key order. */
export function rankLoreEntry(ordered: readonly LoreEntry[], moved: number): Map<string, number> {
  function assign(first: number, last: number) {
    const low = ordered[first - 1]?.insertionOrder;
    const high = ordered[last + 1]?.insertionOrder;
    const count = last - first + 1;
    const ranks = new Map<string, number>();
    let previous = low ?? -Infinity;
    for (let index = 0; index < count; index++) {
      const fraction = (index + 1) / (count + 1);
      const rank = low === undefined ? (high ?? count) - count + index
        : high === undefined ? low + index + 1 : low * (1 - fraction) + high * fraction;
      if (!Number.isFinite(rank) || rank <= previous || (high !== undefined && rank >= high)) return null;
      ranks.set(ordered[first + index].id, rank);
      previous = rank;
    }
    return ranks;
  }

  const single = assign(moved, moved);
  if (single) return single;

  // Moving into a tie needs distinct ranks across the tied run for numeric
  // World Info keys, whose JSON object order cannot express the move.
  const lower = ordered[moved - 1]?.insertionOrder;
  const upper = ordered[moved + 1]?.insertionOrder;
  let first = moved;
  let last = moved;
  while (first > 0 && ordered[first - 1].insertionOrder === lower) first--;
  while (last + 1 < ordered.length && ordered[last + 1].insertionOrder === upper) last++;
  return assign(first, last) ?? new Map(ordered.map((entry, index) => [entry.id, index]));
}
