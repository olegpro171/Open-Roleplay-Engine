import { limitationText, message } from '../shared/localization.js';
import type { EngineSnapshot } from '../shared/contracts.js';
import { type ContextRefresh, type ContextState, type SummaryNode } from '../shared/context.js';
import { AppError } from './errors.js';
import { hasChronologicalLevels, selectedContext } from './context.js';
import { contextPlan } from './context-plan.js';
import { savedSummaries } from './context-reuse.js';
import { planSavedSelection, replaySavedPressure } from './context-saved-plan.js';
import { assembleRequest, managedInputCosts } from './prompt.js';
import { hasPromptMarker } from '../shared/library.js';

/** Explicit re-selection only: never generates, deletes or edits a summary. */
export function refreshContext(snapshot: EngineSnapshot, options: { allowOverflowFallback?: boolean } = {}): { state: ContextState; report: ContextRefresh } {
  const { turns, context: original, connection, settings, sources } = snapshot;
  if (!hasPromptMarker(sources.prompt, 'summary')) throw new AppError(422, 'summaries_disabled', message("errors.summaries_are_disabled_enable_a_summary_marker_in"));
  const config = original.preset;
  if (!config) throw new AppError(422, 'context_required', message("errors.select_a_context_preset_before_refreshing_memory"));
  if (!connection) throw new AppError(422, 'connection_required', message("errors.select_a_roleplay_connection_before_refreshing_memory"));
  const current = selectedContext(turns, original); // Repair comes before restoration.
  const limit = Math.min(settings.targetInputTokens, connection.contextWindow - connection.maxOutputTokens);
  const measure = (state: ContextState) => assembleRequest(connection, settings, turns, sources, state,
    { validateLimits: false, allowStale: true, lore: snapshot.loreResolution }).budget.inputTokens;
  const inputBefore = measure(original);
  const before = { selected: original.selected, archivedTurnIds: original.archivedTurnIds };
  const hasMessages = hasPromptMarker(sources.prompt, 'messages');
  const summaryOnly = !hasMessages;
  if (summaryOnly && inputBefore <= limit) {
    return { state: original, report: { before, after: before, inputBefore, inputAfter: inputBefore, verbatimBefore: 0, verbatimAfter: 0,
      changed: false, protectedSummaries: 0, limited: false } };
  }

  const completed = turns.filter(turn => turn.complete).length;
  // Summary-only prompts cannot restore detail to Messages or extract unused turns.
  const lastCutoff = summaryOnly ? original.archivedTurnIds.length : Math.max(0, completed - config.minTail);
  const firstCutoff = summaryOnly ? lastCutoff : 0;
  const available = savedSummaries(turns, original);
  const { tailInput, summaryFrame } = managedInputCosts(connection, settings, turns, sources, snapshot.loreResolution);
  const originalValid = original.archivedTurnIds.length <= lastCutoff && hasChronologicalLevels(current.summaries);
  const candidateFor = (nodes: SummaryNode[] | null) => {
    if (!nodes) return null;
    const state = { ...original, selected: nodes.map(({ id, revision }) => ({ id, revision })),
      archivedTurnIds: nodes.flatMap(node => node.turns.map(source => source.turnId)) };
    return { state, input: measure(state) };
  };
  const chooseSaved = (maxCutoff: number, preferredCutoff?: number) => candidateFor(
    planSavedSelection(turns, available, original.selected, firstCutoff, maxCutoff, tailInput, summaryFrame, limit, preferredCutoff),
  );
  const baseline = summaryOnly
    ? originalValid ? current.summaries : null
    : [];
  const replay = baseline && candidateFor(
    replaySavedPressure(turns, available, baseline, lastCutoff, tailInput, summaryFrame, limit),
  );
  // An alternative tiling can reach a fit when incremental reuse hits crossing
  // boundaries. It is a fallback, not a reason to replace a fitting replay.
  const planned = replay && replay.input <= limit ? replay
    : originalValid && inputBefore <= limit ? { state: original, input: inputBefore }
    : chooseSaved(lastCutoff, replay?.state.archivedTurnIds.length);
  let state = original, inputAfter = inputBefore;
  if (planned && (planned.input <= limit || options.allowOverflowFallback && (!originalValid || planned.input < inputBefore))) {
    state = planned.state;
    inputAfter = planned.input;
  }
  if (inputAfter > limit) {
    if (!options.allowOverflowFallback || state === original && !originalValid) {
      throw new AppError(422, 'refresh_unavailable', message("errors.saved_summaries_cannot_produce_a_fitting_chronological_selection"));
    }
    if (state !== original && contextPlan({ ...snapshot, context: state }).blocked) {
      // A shorter saved prefix can leave enough room for a full new batch.
      // If it cannot advance either, retain a valid committed path that can.
      const batchCutoff = lastCutoff - config.batchSize;
      const shorter = !summaryOnly && batchCutoff >= firstCutoff && state.archivedTurnIds.length > batchCutoff
        ? chooseSaved(batchCutoff) : null;
      if (shorter && (!originalValid || shorter.input < inputBefore) && contextPlan({ ...snapshot, context: shorter.state }).next) {
        state = shorter.state;
        inputAfter = shorter.input;
      } else if (originalValid && contextPlan(snapshot).next) {
        state = original;
        inputAfter = inputBefore;
      }
    }
  }
  selectedContext(turns, state);
  const after = { selected: state.selected, archivedTurnIds: state.archivedTurnIds };
  const changed = JSON.stringify(before) !== JSON.stringify(after);
  const limited = inputAfter > limit;
  return { state: { ...state, revision: original.revision + Number(changed) }, report: {
    before, after, inputBefore, inputAfter,
    verbatimBefore: hasMessages ? current.verbatim.length : 0, verbatimAfter: hasMessages ? turns.length - state.archivedTurnIds.length : 0,
    changed, protectedSummaries: 0, limited,
    ...(limited ? limitationText(message("diagnostics.saved_summaries_could_not_produce_a_finer_fitting")) : {}),
  } };
}
