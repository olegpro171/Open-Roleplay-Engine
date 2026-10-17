import type { ChatSnapshot } from '../shared/contracts.js';
import { refKey, type ContextOperation, type ContextRefresh, type ContextState, type SummaryNode } from '../shared/context.js';
import { AppError } from './errors.js';
import { nodeFor, rankedPromotions, selectedContext } from './context.js';
import { operationKey, savedSummaries } from './context-reuse.js';
import { assembleRequest, summaryText } from './prompt.js';
import { countText } from './tokens.js';

/** Explicit re-selection only: never generates, deletes or edits a summary. */
export function refreshContext(snapshot: ChatSnapshot, options: { allowOverflowFallback?: boolean } = {}): { state: ContextState; report: ContextRefresh } {
  const { turns, context: original, connection, settings, sources } = snapshot;
  if (!connection) throw new AppError(422, 'connection_required', 'Select a roleplay Connection before refreshing memory.');
  const config = original.preset;
  if (!config) throw new AppError(422, 'context_required', 'Select a context preset before refreshing memory.');
  const current = selectedContext(turns, original); // Repair comes before restoration.
  const limit = Math.min(settings.targetInputTokens, connection.contextWindow - connection.maxOutputTokens);
  const measure = (state: ContextState) => assembleRequest(connection, settings, turns, sources, state, { validateLimits: false }).budget.inputTokens;
  const inputBefore = measure(original);
  const positions = new Map(turns.map((turn, i) => [turn.id, i]));
  // Protect selected parents too: their text may carry corrections from children
  // or earlier-context dependencies that are absent from the original transcript.
  const manualMemo = new Map<string, boolean>();
  const carriesManual = (node: SummaryNode): boolean => {
    const key = refKey(node);
    if (manualMemo.has(key)) return manualMemo.get(key)!;
    manualMemo.set(key, false);
    const manual = node.manual || [...node.children, ...node.prior].some(ref => {
      const dependency = nodeFor(original, ref);
      return Boolean(dependency && carriesManual(dependency));
    });
    manualMemo.set(key, manual); return manual;
  };
  const protectedNodes = current.summaries.filter(carriesManual);
  const protectedKeys = new Set(protectedNodes.map(refKey));
  const protectedTurns = new Set(protectedNodes.flatMap(node => node.turns.map(source => source.turnId)));
  const available = savedSummaries(turns, original).filter(node => (!carriesManual(node) || protectedKeys.has(refKey(node)))
    && (protectedKeys.has(refKey(node)) || !node.turns.some(source => protectedTurns.has(source.turnId))));
  const byKey = new Map(available.map(node => [refKey(node), node]));
  const saved = new Map<string, SummaryNode[]>();
  for (const node of available) {
    const key = operationKey({ level: node.level, turnIds: node.turns.map(source => source.turnId), children: node.children });
    saved.set(key, [...(saved.get(key) ?? []), node]);
  }
  const stateFor = (nodes: SummaryNode[]): ContextState => {
    const ordered = [...nodes].sort((a, b) => positions.get(a.turns[0].turnId)! - positions.get(b.turns[0].turnId)!);
    return { revision: original.revision, summaries: original.summaries, selected: ordered.map(({ id, revision }) => ({ id, revision })), archivedTurnIds: ordered.flatMap(node => node.turns.map(source => source.turnId)) };
  };
  const expand = (node: SummaryNode): SummaryNode[] => {
    if (protectedKeys.has(refKey(node)) || !node.children.length) return [node];
    const children = node.children.map(ref => byKey.get(refKey(ref)));
    if (children.some(child => !child || child.level >= node.level)
      || JSON.stringify(children.flatMap(child => child?.turns.map(source => source.turnId) ?? [])) !== JSON.stringify(node.turns.map(source => source.turnId))) return [node];
    return children.flatMap(child => expand(child!));
  };
  // A single archived prefix is retained. A protected span also requires summary
  // coverage before it; unprotected later spans can all return to verbatim.
  const protectedEnd = Math.max(-1, ...protectedNodes.map(node => positions.get(node.turns.at(-1)!.turnId)!));
  let state = stateFor(current.summaries.filter(node => positions.get(node.turns[0].turnId)! <= protectedEnd).flatMap(expand));
  const sizes = new Map(available.map(node => [refKey(node), countText(`${summaryText(node, turns)}\n\n`)]));
  const completed = turns.filter(turn => turn.complete).length;
  const tailFits = (candidate: ContextState) => !candidate.archivedTurnIds.length || completed - candidate.archivedTurnIds.length >= config.minTail;
  let input = measure(state), limited = false;
  while (input > limit || !tailFits(state)) {
    if (!tailFits(state)) { limited = true; break; }
    const operations: ContextOperation[] = [];
    const cutoff = state.archivedTurnIds.length;
    if (completed - cutoff >= config.minTail + config.batchSize) operations.push({ level: 1, turnIds: turns.slice(cutoff, cutoff + config.batchSize).map(turn => turn.id), children: [] });
    // Only saved eligible promotions participate. Pressure ordering, chronological
    // groups and retained floors are exactly those used in ordinary compaction.
    operations.push(...rankedPromotions(state.selected.map(ref => nodeFor(state, ref)!), config, sizes));
    let replacement: { state: ContextState; input: number } | null = null;
    for (const operation of operations) {
      for (const parent of saved.get(operationKey(operation)) ?? []) {
        const removed = new Set(operation.children.map(refKey));
        const candidate = stateFor([...state.selected.filter(ref => !removed.has(refKey(ref))).map(ref => nodeFor(state, ref)!), parent]);
        const candidateInput = measure(candidate);
        if (candidateInput < input) { replacement = { state: candidate, input: candidateInput }; break; }
      }
      if (replacement) break;
    }
    if (!replacement) { limited = true; break; }
    state = replacement.state; input = replacement.input;
  }
  if (limited) {
    if (!options.allowOverflowFallback && (inputBefore > limit || !tailFits(original))) throw new AppError(422, 'refresh_unavailable', 'Saved summaries cannot produce a fitting selection with the current settings and protected corrections. Memory is unchanged. Repair affected memory, adjust the settings, or prepare new summaries.');
    state = original; input = inputBefore;
  }
  selectedContext(turns, state);
  const before = { selected: original.selected, archivedTurnIds: original.archivedTurnIds };
  const after = { selected: state.selected, archivedTurnIds: state.archivedTurnIds };
  const changed = JSON.stringify(before) !== JSON.stringify(after);
  return { state: { ...state, revision: original.revision + Number(changed) }, report: {
    before, after, inputBefore, inputAfter: input,
    verbatimBefore: current.verbatim.length, verbatimAfter: turns.length - state.archivedTurnIds.length,
    changed, protectedSummaries: protectedNodes.length, limited,
  } };
}
