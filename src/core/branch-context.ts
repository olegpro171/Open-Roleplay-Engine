import { refKey, type ContextSnapshot, type SummaryRef } from '../shared/context.js';
import type { Turn } from '../shared/contracts.js';
import { summaryDependencies } from './context-corrections.js';

export function contextAtFork(context: ContextSnapshot, turns: Turn[]): ContextSnapshot {
  const retained = new Set(turns.map(turn => turn.id));
  const summaries = context.summaries.filter(node => node.approved && node.turns.every(source => retained.has(source.turnId)));
  const compatible = new Set(summaries.map(refKey));
  const consumers = new Map<string, string[]>();
  const removed: string[] = [];
  for (const node of summaries) {
    const key = refKey(node);
    const dependencies = [...summaryDependencies(node), ...(node.basedOn ? [node.basedOn] : [])];
    for (const dependency of dependencies) {
      const source = refKey(dependency);
      if (!compatible.has(source)) removed.push(key);
      else {
        const uses = consumers.get(source);
        if (uses) uses.push(key);
        else consumers.set(source, [key]);
      }
    }
  }
  for (let i = 0; i < removed.length; i++) {
    const key = removed[i];
    if (compatible.delete(key)) for (const use of consumers.get(key) ?? []) removed.push(use);
  }
  const saved = summaries.filter(node => compatible.has(refKey(node)));
  const byRef = new Map(saved.map(node => [refKey(node), node]));
  const selected: SummaryRef[] = [];
  const archivedTurnIds: string[] = [];
  for (const ref of context.selected) {
    const node = byRef.get(refKey(ref));
    if (!node || node.turns.some((source, i) => turns[archivedTurnIds.length + i]?.id !== source.turnId)) break;
    selected.push(ref);
    for (const source of node.turns) archivedTurnIds.push(source.turnId);
  }
  return { ...context, selected, archivedTurnIds, summaries: saved, jobs: [] };
}
