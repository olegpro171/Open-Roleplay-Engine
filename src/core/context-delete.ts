import { AppError } from './errors.js';
import { summaryDependencies } from './context-corrections.js';
import { refKey, type ContextState, type SummaryRef } from '../shared/context.js';

/** Delete whole identities, including consumers of any of their saved versions. */
export function summaryDeletion(state: ContextState, ref: SummaryRef) {
  const current = state.summaries.filter(node => node.id === ref.id && node.approved)
    .sort((a, b) => b.revision - a.revision)[0];
  if (!current || current.revision !== ref.revision) {
    throw new AppError(409, 'stale_summary', 'Reopen the current approved summary before deleting it.');
  }
  const consumers = new Map<string, Set<string>>();
  for (const node of state.summaries) {
    for (const dependency of [...summaryDependencies(node), ...(node.basedOn ? [node.basedOn] : [])]) {
      const ids = consumers.get(dependency.id) ?? new Set<string>();
      ids.add(node.id);
      consumers.set(dependency.id, ids);
    }
  }
  const deletedIds = new Set([ref.id]);
  const queue = [ref.id];
  for (let i = 0; i < queue.length; i++) {
    for (const id of consumers.get(queue[i]) ?? []) {
      if (!deletedIds.has(id)) { deletedIds.add(id); queue.push(id); }
    }
  }
  // A selected suffix cannot remain archived across the gap left by deletion.
  const firstDeleted = state.selected.findIndex(selected => deletedIds.has(selected.id));
  const selected = firstDeleted < 0 ? state.selected : state.selected.slice(0, firstDeleted);
  const byRef = new Map(state.summaries.map(node => [refKey(node), node]));
  const retainedCoverage = selected.flatMap(selected => byRef.get(refKey(selected))?.turns.map(source => source.turnId) ?? []);
  const archivedTurnIds = firstDeleted < 0 ? state.archivedTurnIds : state.archivedTurnIds.slice(0, retainedCoverage.length);
  const restoredTurnIds = state.archivedTurnIds.slice(archivedTurnIds.length);
  const deleted = state.summaries.filter(node => deletedIds.has(node.id));
  const after: ContextState = {
    revision: state.revision + 1, selected, archivedTurnIds,
    summaries: state.summaries.filter(node => !deletedIds.has(node.id)),
  };
  return { deletedIds, deleted, restoredTurnIds, after };
}
