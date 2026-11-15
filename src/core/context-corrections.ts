import { refKey, type ContextState, type SummaryNode, type SummaryRef } from '../shared/context.js';

export function latestApproved(state: ContextState): SummaryNode[] {
  const latest = new Map<string, SummaryNode>();
  for (const node of state.summaries) {
    if (node.approved && node.revision > (latest.get(node.id)?.revision ?? -1)) latest.set(node.id, node);
  }
  return [...latest.values()];
}

/** Only coverage and reviewed editorial links represent memory in the prompt.
 * Earlier context is a freshness dependency without coverage of its own.
 */
export function selectionRepresents(state: ContextState, target: SummaryRef): boolean {
  if (!state.selected.length) return false;
  const targetKey = refKey(target);
  const nodes = new Map(state.summaries.map(node => [refKey(node), node]));
  const remaining = state.selected.slice();
  const visited = new Set<string>();
  while (remaining.length) {
    const ref = remaining.pop();
    if (!ref) break;
    const key = refKey(ref);
    if (key === targetKey) return true;
    if (visited.has(key)) continue;
    visited.add(key);
    const node = nodes.get(key);
    if (!node) continue;
    for (const child of node.children) remaining.push(child);
    for (const correction of node.corrections ?? []) remaining.push(correction);
  }
  return false;
}

export const summaryDependencies = (node: SummaryNode): SummaryRef[] => [...node.children, ...node.prior, ...(node.corrections ?? [])];
