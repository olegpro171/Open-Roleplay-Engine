import { message } from '../shared/localization.js';
import type { Turn } from '../shared/contracts.js';
import { refKey, type ContextState, type SummaryNode, type SummaryRef } from '../shared/context.js';
import { AppError } from './errors.js';

export function latestApproved(state: ContextState): SummaryNode[] {
  const latest = new Map<string, SummaryNode>();
  for (const node of state.summaries) {
    if (node.approved && node.revision > (latest.get(node.id)?.revision ?? -1)) latest.set(node.id, node);
  }
  return [...latest.values()];
}

/** Editorial authority belongs to identities, independently of the selected tree.
 * Old revisions are history; prior context conveys interpretation, not coverage.
 */
export function correctionProtection(turns: Turn[], state: ContextState) {
  const existing = new Set(turns.map(turn => turn.id));
  const corrections = latestApproved(state).filter(node => node.manual && node.turns.some(source => existing.has(source.turnId)));
  const nodes = new Map(state.summaries.map(node => [refKey(node), node]));
  const memo = new Map<SummaryNode, Set<string>>();
  const represented = (node: SummaryNode): Set<string> => {
    const key = refKey(node), cached = memo.get(node);
    if (cached) return cached;
    const result = new Set([key]);
    memo.set(node, result);
    for (const ref of [...node.children, ...(node.corrections ?? [])]) {
      const dependency = nodes.get(refKey(ref));
      if (dependency) for (const item of represented(dependency)) result.add(item);
    }
    return result;
  };
  const correctionTurns = new Map(corrections.map(node => [refKey(node), new Set(node.turns.map(source => source.turnId))]));
  const overlaps = (node: SummaryNode, correction: SummaryNode) => node.turns.some(source => correctionTurns.get(refKey(correction))?.has(source.turnId));
  const missingFor = (node: SummaryNode) => corrections.filter(correction => overlaps(node, correction) && !represented(node).has(refKey(correction)));
  const selected = state.selected.flatMap(ref => { const node = nodes.get(refKey(ref)); return node ? [node] : []; });
  const unresolved = corrections.filter(correction => {
    const covered = new Set(selected.filter(node => represented(node).has(refKey(correction))).flatMap(node => node.turns.map(source => source.turnId)));
    return correction.turns.some(source => existing.has(source.turnId) && !covered.has(source.turnId));
  });
  return { corrections, represented, overlaps, missingFor, unresolved };
}

export const correctionDiagnostic = message('diagnostics.correctionRequired');
export const correctionMessage = correctionDiagnostic.fallback;

export function assertCorrectionSelection(turns: Turn[], state: ContextState): void {
  if (correctionProtection(turns, state).unresolved.length) throw new AppError(422, 'correction_reconciliation_required', correctionDiagnostic);
}

export const summaryDependencies = (node: SummaryNode): SummaryRef[] => [...node.children, ...node.prior, ...(node.corrections ?? [])];
