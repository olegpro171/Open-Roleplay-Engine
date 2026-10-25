import type { EngineSnapshot, Turn } from '../shared/contracts.js';
import { refKey, type ContextOperation, type ContextState, type SummaryNode } from '../shared/context.js';
import { replaceSelection, selectedContext, staleSummaries } from './context.js';
import { correctionProtection } from './context-corrections.js';
import { assembleRequest } from './prompt.js';
import { refusalAffected } from './summary-refusals.js';

export const operationKey = (operation: ContextOperation) => JSON.stringify([operation.level, operation.turnIds, operation.children.map(refKey)]);

/** Current approved versions only, with exact surviving coverage and fresh dependencies. */
export function savedSummaries(turns: Turn[], state: ContextState): SummaryNode[] {
  const stale = staleSummaries(turns, state);
  const refused = refusalAffected(state);
  const latest = new Map<string, SummaryNode>();
  const positions = new Map(turns.map((turn, i) => [turn.id, i]));
  for (const node of state.summaries) if (node.approved && (!latest.has(node.id) || node.revision > latest.get(node.id)!.revision)) latest.set(node.id, node);
  return [...latest.values()].filter(node => {
    const first = positions.get(node.turns[0]?.turnId);
    return !stale.has(refKey(node)) && !refused.has(refKey(node)) && first !== undefined && node.turns.every((source, i) => turns[first + i]?.id === source.turnId);
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
}

/** Reuse the exact eligible batch/parent only when it reduces the complete input. */
export function savedReplacement(snapshot: EngineSnapshot, operation: ContextOperation): { node: SummaryNode; state: ContextState; inputAfter: number } | null {
  if (operation.repair || !snapshot.connection) return null;
  const protection = correctionProtection(snapshot.turns, snapshot.context);
  if (protection.unresolved.length) return null;
  selectedContext(snapshot.turns, snapshot.context);
  const measure = (state: ContextState) => assembleRequest(snapshot.connection!, snapshot.settings, snapshot.turns, snapshot.sources, state, { validateLimits: false, lore: snapshot.loreResolution }).budget.inputTokens;
  const inputBefore = measure(snapshot.context), key = operationKey(operation);
  for (const node of savedSummaries(snapshot.turns, snapshot.context)) {
    if (protection.missingFor(node).length) continue;
    if (operationKey({ level: node.level, turnIds: node.turns.map(source => source.turnId), children: node.children }) !== key) continue;
    const state = { ...replaceSelection(snapshot.context, operation, node), summaries: snapshot.context.summaries };
    selectedContext(snapshot.turns, state);
    const inputAfter = measure(state);
    if (inputAfter < inputBefore) return { node, state, inputAfter };
  }
  return null;
}
