import { message } from '../shared/localization.js';
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
export function correctionProtection(turns: readonly { id: string }[], state: ContextState) {
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
  const correctionsByTurn = new Map<string, SummaryNode[]>();
  const correctionOrder = new Map(corrections.map((node, index) => [node, index]));
  for (const correction of corrections) {
    for (const source of correction.turns) {
      const matches = correctionsByTurn.get(source.turnId) ?? [];
      matches.push(correction);
      correctionsByTurn.set(source.turnId, matches);
    }
  }
  const overlaps = (node: SummaryNode, correction: SummaryNode) => node.turns.some(source => correctionTurns.get(refKey(correction))?.has(source.turnId));
  const missingFor = (node: SummaryNode) => {
    if (!corrections.length) return [];
    const missing = new Set<SummaryNode>();
    for (const source of node.turns) {
      for (const correction of correctionsByTurn.get(source.turnId) ?? []) {
        if (!represented(node).has(refKey(correction))) missing.add(correction);
      }
    }
    return [...missing].sort((a, b) => (correctionOrder.get(a) ?? 0) - (correctionOrder.get(b) ?? 0));
  };
  const representedByTurn = new Map<string, Set<string>>();
  for (const ref of corrections.length ? state.selected : []) {
    const node = nodes.get(refKey(ref));
    if (!node) continue;
    for (const source of node.turns) {
      const matches = correctionsByTurn.get(source.turnId);
      if (!matches) continue;
      const covered = representedByTurn.get(source.turnId) ?? new Set<string>();
      for (const correction of matches) {
        const key = refKey(correction);
        if (represented(node).has(key)) covered.add(key);
      }
      representedByTurn.set(source.turnId, covered);
    }
  }
  const unresolved = corrections.filter(correction => correction.turns.some(source =>
    existing.has(source.turnId) && !representedByTurn.get(source.turnId)?.has(refKey(correction))));
  return { corrections, represented, overlaps, missingFor, unresolved };
}

export const correctionDiagnostic = message('diagnostics.correctionRequired');
export const correctionMessage = correctionDiagnostic.fallback;

export function assertCorrectionSelection(turns: readonly { id: string }[], state: ContextState): void {
  if (correctionProtection(turns, state).unresolved.length) throw new AppError(422, 'correction_reconciliation_required', correctionDiagnostic);
}

export const summaryDependencies = (node: SummaryNode): SummaryRef[] => [...node.children, ...node.prior, ...(node.corrections ?? [])];
