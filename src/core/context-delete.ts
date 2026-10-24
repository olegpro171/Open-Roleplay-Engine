import { message } from '../shared/localization.js';
import { AppError } from './errors.js';
import { latestApproved, summaryDependencies } from './context-corrections.js';
import { refKey, type ContextState, type SummaryRef } from '../shared/context.js';

/** Delete whole identities, including consumers of any of their saved versions. */
export function summaryDeletion(state: ContextState, ref: SummaryRef) {
  return summariesDeletion(state, [ref]);
}

function assertCurrentSummaryRefs(state: ContextState, refs: SummaryRef[]) {
  const latest = new Map(latestApproved(state).map(node => [node.id, node]));
  for (const ref of refs) {
    const current = latest.get(ref.id);
    if (!current || current.revision !== ref.revision) {
      throw new AppError(409, 'stale_summary', message("errors.reopen_the_current_approved_summary_before_deleting_it"));
    }
  }
}

export function summariesDeletion(state: ContextState, refs: SummaryRef[]) {
  assertCurrentSummaryRefs(state, refs);
  const consumers = new Map<string, Set<string>>();
  for (const node of state.summaries) {
    for (const dependency of [...summaryDependencies(node), ...(node.basedOn ? [node.basedOn] : [])]) {
      const ids = consumers.get(dependency.id) ?? new Set<string>();
      ids.add(node.id);
      consumers.set(dependency.id, ids);
    }
  }
  const deletedIds = new Set(refs.map(ref => ref.id));
  const queue = [...deletedIds];
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

/** A chronological suffix across every layer, including parents crossing its start. */
export function summarySuffixDeletion(state: ContextState, turnIds: string[], refs: SummaryRef[]) {
  assertCurrentSummaryRefs(state, refs);
  const positions = new Map(turnIds.map((id, index) => [id, index]));
  const targets = new Set(refs.map(refKey));
  const starts = state.summaries.filter(node => targets.has(refKey(node))).flatMap(node => node.turns.flatMap(source => {
    const position = positions.get(source.turnId);
    return position === undefined ? [] : [position];
  }));
  if (!starts.length) throw new AppError(409, 'stale_summary', message('refusals.no_surviving_coverage'));
  const boundary = starts.reduce((first, position) => Math.min(first, position), turnIds.length);
  // Historical versions may cross the boundary even when their current version does not.
  const ids = new Set(state.summaries.filter(node => node.turns.some(source => (positions.get(source.turnId) ?? -1) >= boundary)).map(node => node.id));
  const latest = new Map<string, SummaryRef>();
  for (const node of state.summaries) if (node.approved && ids.has(node.id) && node.revision > (latest.get(node.id)?.revision ?? -1)) latest.set(node.id, { id: node.id, revision: node.revision });
  return { ...summariesDeletion(state, [...latest.values()]), boundary };
}
