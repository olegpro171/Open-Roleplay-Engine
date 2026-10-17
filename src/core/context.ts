import { AppError } from './errors.js';
import type { Turn } from '../shared/contracts.js';
import { refKey, type ContextOperation, type ContextPreset, type ContextState, type SummaryNode, type SummaryRef } from '../shared/context.js';

export const sourceOf = (turn: Turn) => ({ turnId: turn.id, userRevision: turn.user.revision, assistantRevision: turn.assistant.revision, complete: turn.complete });
export const nodeFor = (state: ContextState, ref: SummaryRef) => state.summaries.find(node => refKey(node) === refKey(ref));

export function staleSummaries(turns: Turn[], state: ContextState): Set<string> {
  const sources = new Map(turns.map(turn => [turn.id, sourceOf(turn)]));
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
    let invalid = node.turns.some(source => {
      const current = sources.get(source.turnId);
      return !current || !current.complete || current.userRevision !== source.userRevision || current.assistantRevision !== source.assistantRevision;
    });
    for (const dependency of [...node.children, ...node.prior]) {
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
  const prefix = turns.slice(0, state.archivedTurnIds.length);
  const byRef = new Map(state.summaries.map(node => [refKey(node), node]));
  const nodes = state.selected.map(ref => byRef.get(refKey(ref)));
  if (nodes.some(node => !node || !node.approved)) throw new AppError(422, 'invalid_context', 'The saved context selection contains a missing or unapproved summary.');
  const summaries = nodes as SummaryNode[];
  const coverage = summaries.flatMap(node => node.turns.map(source => source.turnId));
  const prefixIds = prefix.map(turn => turn.id);
  const complete = prefix.every(turn => turn.complete);
  if (!allowStale && (!complete || JSON.stringify(prefixIds) !== JSON.stringify(state.archivedTurnIds) || JSON.stringify(coverage) !== JSON.stringify(prefixIds))) {
    throw new AppError(422, 'stale_context', 'Summary coverage changed. Repair and review the affected memory before continuing.');
  }
  const stale = allowStale ? new Set<string>() : staleSummaries(turns, state);
  if (!allowStale && state.selected.some(ref => stale.has(refKey(ref)))) {
    throw new AppError(422, 'stale_context', 'Selected memory is out of date. Repair and review it before continuing.');
  }
  const archived = new Set(state.archivedTurnIds);
  return { summaries, verbatim: turns.filter(turn => !archived.has(turn.id)) };
}

/** Budget-driven state transition; callers measure and commit the actual replacement. */
export function nextCompaction(turns: Turn[], state: ContextState, config: ContextPreset, input: number, limit: number, required: number, summarySizes: Map<string, number>): { next: ContextOperation | null; blocked: string | null } {
  const { summaries, verbatim } = selectedContext(turns, state);
  const completed = verbatim.filter(turn => turn.complete);
  if (state.archivedTurnIds.length && completed.length < config.minTail) return { next: null, blocked: 'The saved cutoff no longer leaves the configured minimum tail. Clear memory or lower the minimum tail explicitly.' };
  if (input <= limit) return { next: null, blocked: null };
  if (completed.length >= config.minTail + config.batchSize) {
    return { next: { level: 1, turnIds: completed.slice(0, config.batchSize).map(turn => turn.id), children: [] }, blocked: null };
  }
  if (required > limit) return { next: null, blocked: 'The required verbatim tail, pending input and prompt exceed the input limit. Adjust the target, Connection limits or minimum tail; no complete turn batch is eligible.' };
  const pool = limit - required;
  if (pool <= 0) return { next: null, blocked: 'No input capacity remains for summaries covering archived history.' };
  const candidates: { score: number; level: number; children: SummaryNode[] }[] = [];
  for (const level of new Set(summaries.map(node => node.level))) {
    const layer = summaries.filter(node => node.level === level);
    if (layer.length < config.promotionGroup + config.retainedPerLevel) continue;
    const children = layer.slice(0, config.promotionGroup);
    const first = summaries.indexOf(children[0]);
    if (!children.every((node, index) => summaries[first + index] === node)) continue;
    const used = layer.reduce((total, node) => total + (summarySizes.get(refKey(node)) ?? 0), 0);
    // Logarithms preserve U_k * 2^k ordering without overflow in deep trees.
    candidates.push({ score: Math.log2(Math.max(used, Number.MIN_VALUE)) + level, level, children });
  }
  candidates.sort((a, b) => b.score - a.score || b.level - a.level);
  const best = candidates[0];
  if (!best) return { next: null, blocked: 'No complete promotion group satisfies the retained-summary floor. Adjust the settings explicitly.' };
  return { next: { level: best.level + 1, turnIds: best.children.flatMap(node => node.turns.map(source => source.turnId)), children: best.children.map(({ id, revision }) => ({ id, revision })) }, blocked: null };
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

export function nextRepair(turns: Turn[], state: ContextState, replacements: Map<string, SummaryRef | null>): ContextOperation | null {
  const stale = staleSummaries(turns, state), existing = new Set(turns.map(turn => turn.id));
  const currentRef = (ref: SummaryRef): SummaryRef => state.summaries.filter(node => node.id === ref.id && node.approved).sort((a, b) => b.revision - a.revision)[0] ?? ref;
  const visited = new Set<string>();
  const visit = (ref: SummaryRef): ContextOperation | null => {
    const key = refKey(ref);
    const current = currentRef(ref);
    if (refKey(current) !== key) {
      replacements.set(key, nodeFor(state, current)?.turns.length ? current : null);
      return visit(current);
    }
    if (visited.has(key) || replacements.has(key) || !stale.has(key)) return null;
    visited.add(key);
    const node = nodeFor(state, ref);
    if (!node) throw new AppError(422, 'invalid_context', 'A summary dependency is missing. Clear memory to rebuild it from the original turns.');
    for (const dependency of [...node.children, ...node.prior]) {
      const operation = visit(dependency);
      if (operation) return operation;
    }
    return { level: node.level, turnIds: node.turns.map(source => source.turnId).filter(id => existing.has(id)), children: node.children.flatMap(child => {
      const replacement = replacements.has(refKey(child)) ? replacements.get(refKey(child)) : currentRef(child);
      return replacement ? [replacement] : [];
    }), repair: ref };
  };
  for (const ref of state.selected) { const operation = visit(ref); if (operation) return operation; }
  return null;
}
