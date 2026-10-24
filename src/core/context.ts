import { blockedText } from '../shared/localization.js';
import { message } from '../shared/localization.js';
import { AppError } from './errors.js';
import type { Turn } from '../shared/contracts.js';
import { refKey, type ContextOperation, type ContextPreset, type ContextState, type SummaryNode, type SummaryRef, type TurnSource } from '../shared/context.js';

import { correctionMessage, correctionDiagnostic, correctionProtection, latestApproved, summaryDependencies } from './context-corrections.js';
import { assertRefusalSelection } from './summary-refusals.js';

export const sourceOf = (turn: Turn) => ({ turnId: turn.id, userRevision: turn.user.revision, assistantRevision: turn.assistant.sourceRevision ?? turn.assistant.revision, complete: turn.complete });
export const nodeFor = (state: ContextState, ref: SummaryRef) => state.summaries.find(node => refKey(node) === refKey(ref));

export function staleSummaries(turns: Turn[], state: ContextState): Set<string> {
  return staleSummarySources(turns.map(sourceOf), state);
}

export function staleSummarySources(turnSources: TurnSource[], state: ContextState): Set<string> {
  const sources = new Map(turnSources.map(source => [source.turnId, source]));
  const nodes = new Map(state.summaries.map(node => [refKey(node), node]));
  const approvedRevision = new Map<string, number>();
  for (const node of state.summaries) if (node.approved) approvedRevision.set(node.id, Math.max(approvedRevision.get(node.id) ?? -1, node.revision));
  const stale = new Set<string>(), checked = new Set<string>(), visiting = new Set<string>();
  const check = (ref: SummaryRef): boolean => {
    const key = refKey(ref);
    if (checked.has(key)) return stale.has(key);
    const node = nodes.get(key);
    if (!node || visiting.has(key)) { stale.add(key); return true; }
    visiting.add(key);
    let invalid = node.regeneration === 'refusal' || node.turns.some(source => {
      const current = sources.get(source.turnId);
      return !current || !current.complete || current.userRevision !== source.userRevision || current.assistantRevision !== source.assistantRevision;
    });
    for (const dependency of summaryDependencies(node)) {
      if ((approvedRevision.get(dependency.id) ?? -1) > dependency.revision || check(dependency)) invalid = true;
    }
    visiting.delete(key); checked.add(key);
    if (invalid) stale.add(key);
    return invalid;
  };
  for (const node of state.summaries) check(node);
  return stale;
}

export function selectedContext(turns: Turn[], state: ContextState, allowStale = false): { summaries: SummaryNode[]; verbatim: Turn[] } {
  if (!allowStale) assertRefusalSelection(state);
  const prefix = turns.slice(0, state.archivedTurnIds.length);
  const byRef = new Map(state.summaries.map(node => [refKey(node), node]));
  const nodes = state.selected.map(ref => byRef.get(refKey(ref)));
  if (nodes.some(node => !node || !node.approved)) throw new AppError(422, 'invalid_context', message("errors.the_saved_context_selection_contains_a_missing_or"));
  const summaries = nodes as SummaryNode[];
  const coverage = summaries.flatMap(node => node.turns.map(source => source.turnId));
  const prefixIds = prefix.map(turn => turn.id);
  const complete = prefix.every(turn => turn.complete);
  if (!allowStale && (!complete || JSON.stringify(prefixIds) !== JSON.stringify(state.archivedTurnIds) || JSON.stringify(coverage) !== JSON.stringify(prefixIds))) {
    throw new AppError(422, 'stale_context', message("errors.summary_coverage_changed_repair_and_review_the_affected"));
  }
  const stale = allowStale ? new Set<string>() : staleSummaries(turns, state);
  if (!allowStale && state.selected.some(ref => stale.has(refKey(ref)))) {
    throw new AppError(422, 'stale_context', message("errors.selected_memory_is_out_of_date_repair_and"));
  }
  const archived = new Set(state.archivedTurnIds);
  return { summaries, verbatim: turns.filter(turn => !archived.has(turn.id)) };
}

/** Budget-driven state transition; callers measure and commit the actual replacement. */
export function nextCompaction(turns: Turn[], state: ContextState, config: ContextPreset, input: number, limit: number, required: number, summarySizes: Map<string, number>): { next: ContextOperation | null; blocked: string | null; blockedMessage?: import('../shared/localization.js').LocalizedMessage } {
  const { summaries, verbatim } = selectedContext(turns, state);
  if (correctionProtection(turns, state).unresolved.length) return { next: null, ...blockedText(correctionDiagnostic) };
  const completed = verbatim.filter(turn => turn.complete);
  if (state.archivedTurnIds.length && completed.length < config.minTail) return { next: null, ...blockedText(message("diagnostics.the_saved_cutoff_no_longer_leaves_the_configured")) };
  if (input <= limit) return { next: null, blocked: null };
  if (completed.length >= config.minTail + config.batchSize) {
    return { next: { level: 1, turnIds: completed.slice(0, config.batchSize).map(turn => turn.id), children: [] }, blocked: null };
  }
  if (required > limit) return { next: null, ...blockedText(message("diagnostics.the_required_verbatim_tail_pending_input_and_prompt")) };
  const pool = limit - required;
  if (pool <= 0) return { next: null, ...blockedText(message("diagnostics.no_input_capacity_remains_for_summaries_covering_archived")) };
  const best = rankedPromotions(summaries, config, summarySizes)[0];
  if (!best) return { next: null, ...blockedText(message("diagnostics.no_complete_promotion_group_satisfies_the_retained_summary")) };
  return { next: best, blocked: null };
}

/** Shared pressure ordering; eligibility may be restricted to saved parents by Refresh. */
export function rankedPromotions(summaries: SummaryNode[], config: ContextPreset, summarySizes: Map<string, number>): ContextOperation[] {
  const candidates: { score: number; level: number; children: SummaryNode[] }[] = [];
  for (const level of new Set(summaries.map(node => node.level))) {
    const layer = summaries.filter(node => node.level === level);
    if (layer.length < config.promotionGroup + config.retainedPerLevel) continue;
    const children = layer.slice(0, config.promotionGroup);
    const first = summaries.indexOf(children[0]);
    if (!children.every((node, index) => summaries[first + index] === node)) continue;
    // Promoting a middle range must not make it coarser than older memory.
    // This also keeps continuation safe after a manual detail restoration.
    if (first > 0 && summaries[first - 1].level < level + 1) continue;
    const used = layer.reduce((total, node) => total + (summarySizes.get(refKey(node)) ?? 0), 0);
    // Logarithms preserve U_k * 2^k ordering without overflow in deep trees.
    candidates.push({ score: Math.log2(Math.max(used, Number.MIN_VALUE)) + level, level, children });
  }
  candidates.sort((a, b) => b.score - a.score || b.level - a.level);
  return candidates.map(candidate => ({ level: candidate.level + 1, turnIds: candidate.children.flatMap(node => node.turns.map(source => source.turnId)), children: candidate.children.map(({ id, revision }) => ({ id, revision })) }));
}

export function hasChronologicalLevels(summaries: SummaryNode[]): boolean {
  return summaries.every((node, index) => index === 0 || summaries[index - 1].level >= node.level);
}

export function replaceSelection(state: ContextState, operation: ContextOperation, node: SummaryNode): ContextState {
  const removed = new Set(operation.children.map(refKey));
  const selected = [...state.selected.filter(ref => !removed.has(refKey(ref))), { id: node.id, revision: node.revision }];
  const summaries = [...state.summaries, node];
  const archivedTurnIds = operation.level === 1 ? [...state.archivedTurnIds, ...operation.turnIds] : state.archivedTurnIds;
  const order = new Map(archivedTurnIds.map((id, index) => [id, index]));
  const starts = new Map(summaries.map(node => [refKey(node), order.get(node.turns[0]?.turnId) ?? 0]));
  selected.sort((a, b) => starts.get(refKey(a))! - starts.get(refKey(b))!);
  return { revision: state.revision + 1, archivedTurnIds, selected, summaries };
}

/** Repair selected dependencies and current editorial identities, never every old version. */
export function repairQueue(turns: Turn[], state: ContextState, replacements = new Map<string, SummaryRef | null>()): ContextOperation[] {
  const stale = staleSummaries(turns, state), existing = new Set(turns.map(turn => turn.id));
  const latest = new Map(latestApproved(state).map(node => [node.id, node]));
  const currentRef = (ref: SummaryRef): SummaryRef => { const node = latest.get(ref.id) ?? ref; return { id: node.id, revision: node.revision }; };
  const protection = correctionProtection(turns, state);
  const selectedNodes = state.selected.flatMap(ref => { const node = latest.get(ref.id); return node ? [node] : []; });
  const contains = (outer: SummaryNode, inner: SummaryNode) => {
    const ids = new Set(outer.turns.map(source => source.turnId));
    return inner.turns.every(source => ids.has(source.turnId));
  };
  const dependsOn = (node: SummaryNode, id: string, seen = new Set<string>()): boolean => {
    if (node.id === id) return true;
    if (seen.has(refKey(node))) return false;
    seen.add(refKey(node));
    return summaryDependencies(node).some(ref => {
      const dependency = latest.get(ref.id);
      return dependency ? dependsOn(dependency, id, seen) : false;
    });
  };
  let targets = [...selectedNodes];
  const groups: SummaryNode[][] = [];
  for (const correction of protection.corrections) {
    const overlaps = groups.filter(group => group.some(node => protection.overlaps(node, correction)));
    const group = [correction, ...overlaps.flat()];
    for (const previous of overlaps) groups.splice(groups.indexOf(previous), 1);
    groups.push(group);
  }
  for (const group of groups) {
    if (!group.some(node => protection.unresolved.some(correction => correction.id === node.id))) continue;
    // Prefer an already selected container. Otherwise reconcile the smallest
    // saved container, and leave its activation to explicit manual preparation.
    const candidates = [...latest.values()].filter(node => group.every(correction => contains(node, correction)
      && (node.id === correction.id || !dependsOn(correction, node.id))));
    candidates.sort((a, b) => Number(selectedNodes.some(node => node.id === b.id)) - Number(selectedNodes.some(node => node.id === a.id))
      || a.turns.length - b.turns.length || a.id.localeCompare(b.id));
    const container = candidates[0];
    if (container) {
      targets = targets.filter(node => !contains(container, node));
      targets.push(container);
    }
  }
  const targetIds = new Set(targets.map(node => node.id));
  const visited = new Set<string>(), visiting = new Set<string>();
  const queue: ContextOperation[] = [];
  const visit = (ref: SummaryRef): void => {
    const current = currentRef(ref), key = refKey(current);
    if (refKey(ref) !== key) replacements.set(refKey(ref), nodeFor(state, current)?.turns.length ? current : null);
    if (visited.has(key)) return;
    if (visiting.has(key)) throw new AppError(422, 'invalid_context', message("errors.memory_dependencies_form_a_cycle_review_the_conflicting"));
    const node = nodeFor(state, current);
    if (!node) throw new AppError(422, 'invalid_context', message("errors.a_summary_dependency_is_missing"));
    const children = node.children.map(currentRef).filter(child => Boolean(nodeFor(state, child)?.turns.length));
    const incorporated = (node.corrections ?? []).map(currentRef);
    const projected = { ...node, children, corrections: incorporated };
    // A retained ancestor is reconciled at its own level, never injected back
    // into its children, which would introduce a provenance cycle.
    const reconcile = (targetIds.has(node.id) ? protection.missingFor(projected) : []).filter(correction => !dependsOn(correction, node.id));
    if (!stale.has(key) && !reconcile.length) { visited.add(key); return; }
    visiting.add(key);
    for (const dependency of [...summaryDependencies(node), ...reconcile]) visit(dependency);
    visiting.delete(key); visited.add(key);
    queue.push({ level: node.level, turnIds: node.turns.map(source => source.turnId).filter(id => existing.has(id)), children, repair: current,
      ...(reconcile.length ? { reconcile: reconcile.map(({ id, revision }) => ({ id, revision })) } : {}) });
  };
  for (const correction of protection.corrections) visit(correction);
  for (const node of latest.values()) if (node.regeneration === 'refusal') visit(node);
  for (const ref of [...state.selected, ...targets]) visit(ref);
  return queue;
}

export function nextRepair(turns: Turn[], state: ContextState, replacements: Map<string, SummaryRef | null>): ContextOperation | null {
  return repairQueue(turns, state, replacements)[0] ?? null;
}
