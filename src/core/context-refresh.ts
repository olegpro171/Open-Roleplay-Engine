import type { ChatSnapshot } from '../shared/contracts.js';
import { refKey, type ContextOperation, type ContextRefresh, type ContextState, type SummaryNode } from '../shared/context.js';
import { AppError } from './errors.js';
import { hasChronologicalLevels, rankedPromotions, selectedContext, staleSummaries } from './context.js';
import { operationKey, savedSummaries } from './context-reuse.js';
import { assembleRequest, summaryText } from './prompt.js';
import { countText } from './tokens.js';
import { assertCorrectionSelection, correctionMessage, correctionProtection } from './context-corrections.js';
import { hasPromptMarker } from '../shared/library.js';

/** Explicit re-selection only: never generates, deletes or edits a summary. */
export function refreshContext(snapshot: ChatSnapshot, options: { allowOverflowFallback?: boolean } = {}): { state: ContextState; report: ContextRefresh } {
  const { turns, context: original, connection, settings, sources } = snapshot;
  if (!hasPromptMarker(sources.prompt, 'summary')) throw new AppError(422, 'summaries_disabled', 'Summaries are disabled. Enable a Summary marker in the prompt before preparing memory.');
  const config = original.preset;
  if (!config) throw new AppError(422, 'context_required', 'Select a context preset before refreshing memory.');
  // With no Messages marker, restoring turns cannot add input detail. Keep the
  // committed memory unless a retained correction needs explicit reconciliation.
  // Summary-only overflow is handled by saved/new promotions.
  if (!hasPromptMarker(sources.prompt, 'messages') && !correctionProtection(turns, original).unresolved.length) {
    selectedContext(turns, original);
    assertCorrectionSelection(turns, original);
    if (!connection) throw new AppError(422, 'connection_required', 'Select a roleplay Connection before preparing memory.');
    const input = assembleRequest(connection, settings, turns, sources, original, { validateLimits: false, allowStale: true }).budget.inputTokens;
    const selection = { selected: original.selected, archivedTurnIds: original.archivedTurnIds };
    return { state: original, report: { before: selection, after: selection, inputBefore: input, inputAfter: input, verbatimBefore: 0, verbatimAfter: 0, changed: false, protectedSummaries: 0, limited: false } };
  }
  if (!connection) throw new AppError(422, 'connection_required', 'Select a roleplay Connection before refreshing memory.');
  const current = selectedContext(turns, original); // Repair comes before restoration.
  const limit = Math.min(settings.targetInputTokens, connection.contextWindow - connection.maxOutputTokens);
  const measure = (state: ContextState) => assembleRequest(connection, settings, turns, sources, state, { validateLimits: false, allowStale: true }).budget.inputTokens;
  const inputBefore = measure(original);
  const positions = new Map(turns.map((turn, i) => [turn.id, i]));
  const nodes = new Map(original.summaries.map(node => [refKey(node), node]));
  const resolve = (ref: { id: string; revision: number }): SummaryNode => {
    const node = nodes.get(refKey(ref));
    if (!node) throw new AppError(422, 'invalid_context', 'A saved summary dependency is missing. Repair memory before preparing it.');
    return node;
  };
  const start = (node: SummaryNode) => positions.get(node.turns[0]?.turnId) ?? -1;
  const end = (node: SummaryNode) => positions.get(node.turns.at(-1)?.turnId ?? '') ?? -1;

  const protection = correctionProtection(turns, original);
  const corrections = new Map(protection.corrections.map(node => [refKey(node), node]));
  const stale = staleSummaries(turns, original);
  if (protection.corrections.some(node => stale.has(refKey(node)))) {
    throw new AppError(422, 'correction_reconciliation_required', correctionMessage);
  }
  const available = savedSummaries(turns, original).filter(node => !protection.missingFor(node).length);
  const byKey = new Map(available.map(node => [refKey(node), node]));
  const saved = new Map<string, SummaryNode[]>();
  for (const node of available) {
    const key = operationKey({ level: node.level, turnIds: node.turns.map(source => source.turnId), children: node.children });
    saved.set(key, [...(saved.get(key) ?? []), node]);
  }
  const stateFor = (selectedNodes: SummaryNode[]): ContextState => {
    const ordered = [...selectedNodes].sort((a, b) => start(a) - start(b));
    return { revision: original.revision, summaries: original.summaries, selected: ordered.map(({ id, revision }) => ({ id, revision })), archivedTurnIds: ordered.flatMap(node => node.turns.map(source => source.turnId)) };
  };
  const protectedNodes = [...corrections.values()].sort((a, b) => end(a) - end(b) || start(a) - start(b));
  const lastCorrection = protectedNodes.at(-1);
  const protectedEnd = lastCorrection ? end(lastCorrection) : -1;
  const completed = turns.filter(turn => turn.complete).length;
  const tailFits = (candidate: ContextState) => !candidate.archivedTurnIds.length || completed - candidate.archivedTurnIds.length >= config.minTail;
  if (lastCorrection && completed - protectedEnd - 1 < config.minTail) {
    throw new AppError(422, 'manual_tail_conflict', `The manually edited summary for turns ${start(lastCorrection) + 1}–${protectedEnd + 1} must remain represented, but it leaves fewer completed verbatim turns than the configured minimum of ${config.minTail}. Adjust the minimum tail, or preserve the correction in the original turns before explicitly clearing memory. Memory is unchanged.`);
  }

  // Restore newer ranges first. A direct edit (or an unavailable child group)
  // limits the detail of older ranges too, preventing holes between layers.
  const expand = (node: SummaryNode, newerLevel: number): SummaryNode[] => {
    if (start(node) > protectedEnd) return [];
    if (corrections.has(refKey(node)) || !node.children.length) return [node];
    const children = node.children.flatMap(ref => {
      const child = byKey.get(refKey(ref));
      return child ? [child] : [];
    });
    if (children.length !== node.children.length || children.some(child => child.level >= node.level)
      || JSON.stringify(children.flatMap(child => child.turns.map(source => source.turnId))) !== JSON.stringify(node.turns.map(source => source.turnId))) return [node];
    const expanded: SummaryNode[][] = [];
    let floor = newerLevel;
    for (const child of [...children].reverse()) {
      const group = expand(child, floor);
      if (group.some(item => item.level < floor)) return [node];
      expanded.push(group);
      floor = group[0]?.level ?? floor;
    }
    return expanded.reverse().flat();
  };
  const detailed: SummaryNode[][] = [];
  let floor = 0;
  for (const node of [...current.summaries].reverse()) {
    const group = expand(node, floor);
    detailed.push(group);
    floor = group[0]?.level ?? floor;
  }
  let baseline = stateFor(detailed.reverse().flat());
  if (protectedNodes.length) {
    // Tile the protected prefix from newest to oldest. Every candidate must carry
    // all editorial authority overlapping its coverage; alternatives cannot win
    // just because they have the same level/range or happen to be newer.
    const ending = new Map<number, SummaryNode[]>();
    for (const node of available) ending.set(end(node), [...ending.get(end(node)) ?? [], node]);
    for (const group of ending.values()) group.sort((a, b) => a.level - b.level || a.id.localeCompare(b.id));
    let protectedPrefix: SummaryNode[] | null = null;
    const endpoints = [...ending.keys()].filter(last => last >= protectedEnd && completed - last - 1 >= config.minTail).sort((a, b) => a - b);
    const failed = new Set<string>();
    for (const endpoint of endpoints) {
      const stack: { last: number; floor: number; index: number; via: SummaryNode | null }[] = [{ last: endpoint, floor: 0, index: 0, via: null }];
      while (stack.length) {
        const frame = stack[stack.length - 1];
        if (frame.last < 0) {
          protectedPrefix = stack.flatMap(item => item.via ? [item.via] : []).reverse();
          break;
        }
        const choices = ending.get(frame.last) ?? [];
        const node = choices[frame.index++];
        if (!node) {
          failed.add(`${frame.last}:${frame.floor}`);
          stack.pop();
          continue;
        }
        const first = start(node);
        if (node.level < frame.floor || first < 0 || failed.has(`${first - 1}:${node.level}`)) continue;
        stack.push({ last: first - 1, floor: node.level, index: 0, via: node });
      }
      if (protectedPrefix) break;
    }
    if (protectedPrefix) baseline = stateFor(protectedPrefix);
    else if (correctionProtection(turns, baseline).unresolved.length) {
      throw new AppError(422, 'correction_reconciliation_required', correctionMessage);
    }
  }
  let state = baseline;
  const sizes = new Map(available.map(node => [refKey(node), countText(`${summaryText(node, turns)}\n\n`)]));
  let input = measure(state), limited = false;
  const ordered = (candidate: ContextState) => hasChronologicalLevels(candidate.selected.map(resolve));
  while (input > limit || !tailFits(state) || !ordered(state)) {
    if (!tailFits(state)) { limited = true; break; }
    const operations: ContextOperation[] = [];
    const cutoff = state.archivedTurnIds.length;
    if (input > limit && completed - cutoff >= config.minTail + config.batchSize) operations.push({ level: 1, turnIds: turns.slice(cutoff, cutoff + config.batchSize).map(turn => turn.id), children: [] });
    // Only saved eligible promotions participate. Pressure ordering, chronological
    // groups and retained floors are exactly those used in ordinary compaction.
    operations.push(...rankedPromotions(state.selected.map(resolve), config, sizes));
    let replacement: { state: ContextState; input: number } | null = null;
    for (const operation of operations) {
      for (const parent of saved.get(operationKey(operation)) ?? []) {
        const removed = new Set(operation.children.map(refKey));
        const candidate = stateFor([...state.selected.filter(ref => !removed.has(refKey(ref))).map(resolve), parent]);
        const candidateInput = measure(candidate);
        if (candidateInput < input) { replacement = { state: candidate, input: candidateInput }; break; }
      }
      if (replacement) break;
    }
    if (!replacement) { limited = true; break; }
    state = replacement.state; input = replacement.input;
  }
  if (limited) {
    if (!protection.unresolved.length && tailFits(original) && hasChronologicalLevels(current.summaries) && (inputBefore <= limit || options.allowOverflowFallback)) {
      state = original;
      input = inputBefore;
    } else if (options.allowOverflowFallback && tailFits(baseline) && ordered(baseline)) {
      // A cutoff that violates the new tail cannot be a fallback. Commit the
      // restored boundary and let ordinary preparation compress older history.
      state = baseline;
      input = measure(baseline);
    } else {
      throw new AppError(422, 'refresh_unavailable', 'Saved summaries cannot produce a fitting chronological selection with the current settings and manual corrections. Memory is unchanged. Adjust the input limit or batch and promotion settings; stale memory must be repaired first.');
    }
  }
  selectedContext(turns, state);
  assertCorrectionSelection(turns, state);
  const before = { selected: original.selected, archivedTurnIds: original.archivedTurnIds };
  const after = { selected: state.selected, archivedTurnIds: state.archivedTurnIds };
  const changed = JSON.stringify(before) !== JSON.stringify(after);
  return { state: { ...state, revision: original.revision + Number(changed) }, report: {
    before, after, inputBefore, inputAfter: input,
    verbatimBefore: current.verbatim.length, verbatimAfter: turns.length - state.archivedTurnIds.length,
    changed, protectedSummaries: protectedNodes.length, limited: limited || protectedNodes.length > 0,
    ...(limited ? { limitation: 'Saved summaries could not produce a finer fitting selection with the current batch and promotion settings.' }
      : lastCorrection ? { limitation: `The manual correction for turns ${start(lastCorrection) + 1}–${end(lastCorrection) + 1} remains represented; that span cannot return to original turns.` } : {}),
  } };
}
