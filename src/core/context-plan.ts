import { blockedText, type LocalizedMessage } from '../shared/localization.js';
import { message } from '../shared/localization.js';
import type { ChatSnapshot, Message, RequestPreview } from '../shared/contracts.js';
import { emptyContextState, refKey, type ContextOperation, type ContextPlan, type SummaryRef } from '../shared/context.js';
import { AppError } from './errors.js';
import { nextCompaction, nodeFor, rankedPromotions, repairQueue, sourceOf, staleSummaries } from './context.js';
import { hasPromptMarker } from '../shared/library.js';
import { assembleRequest, estimateInputTokens, summaryText } from './prompt.js';
import { countInput, countText } from './tokens.js';
import { savedReplacement } from './context-reuse.js';
import { correctionProtection, correctionMessage, correctionDiagnostic } from './context-corrections.js';
import { repairInputs } from './context-repair.js';
import { modelText } from './model-text.js';
import { assertCleanSummaryInput, refusalAffected } from './summary-refusals.js';

export function contextPlan(snapshot: ChatSnapshot): ContextPlan {
  if (!snapshot.connection) throw new AppError(422, 'connection_required', message("errors.select_a_roleplay_connection_to_measure_the_complete"));
  const state = snapshot.context;
  const request = assembleRequest(snapshot.connection, snapshot.settings, snapshot.turns, snapshot.sources, state, { validateLimits: false, allowStale: true, lore: snapshot.loreResolution });
  const effectiveLimit = Math.min(snapshot.settings.targetInputTokens, snapshot.connection.contextWindow - snapshot.connection.maxOutputTokens);
  if (!hasPromptMarker(snapshot.sources.prompt, 'summary')) {
    const blockedMessage = request.budget.inputTokens > effectiveLimit ? message('diagnostics.requiredInputTooLarge') : undefined;
    const blocked = blockedMessage?.fallback ?? null;
    return { inputTokens: request.budget.inputTokens, method: request.budget.method, counting: request.budget.counting, targetInputTokens: snapshot.settings.targetInputTokens, effectiveLimit,
      verbatimTurnIds: request.history!.verbatimTurnIds, next: null, ready: !blocked, blocked, blockedMessage, stale: [] };
  }
  const staleKeys = staleSummaries(snapshot.turns, state);
  const refused = refusalAffected(state);
  const stale = state.selected.filter(ref => staleKeys.has(refKey(ref)));
  const archived = new Set(state.archivedTurnIds);
  const verbatim = snapshot.turns.filter(turn => !archived.has(turn.id));
  const required = assembleRequest(snapshot.connection, snapshot.settings, verbatim, snapshot.sources, emptyContextState(), { validateLimits: false, lore: snapshot.loreResolution }).budget.inputTokens;
  // Rank with the shared reference tokenizer, including labels and separator.
  // Only the complete assembled request determines whether the limit is met.
  const sizes = new Map(state.summaries.map(node => [refKey(node), countText(`${summaryText(node, snapshot.turns)}\n\n`)]));
  const changedMembership = JSON.stringify(snapshot.turns.slice(0, archived.size).map(turn => turn.id)) !== JSON.stringify(state.archivedTurnIds);
  let blockedMessage: LocalizedMessage | undefined;
  let next: ContextOperation | null = null, blocked: string | null = null;
  if (state.selected.some(ref => refused.has(refKey(ref)))) ({ blocked, blockedMessage } = blockedText(message('refusals.resolve_before_using_memory')));
  else if (stale.length || changedMembership) ({ blocked, blockedMessage } = blockedText(message("diagnostics.selected_memory_is_out_of_date_generate_a")));
  else if (correctionProtection(snapshot.turns, state).unresolved.length) ({ blocked, blockedMessage } = blockedText(correctionDiagnostic));
  else if (state.preset && !hasPromptMarker(snapshot.sources.prompt, 'messages')) {
    if (request.budget.inputTokens > effectiveLimit) {
      next = required <= effectiveLimit ? rankedPromotions(state.selected.map(ref => nodeFor(state, ref)!), state.preset, sizes)[0] ?? null : null;
      if (!next) ({ blocked, blockedMessage } = blockedText(message("diagnostics.the_selected_summaries_and_prompt_cannot_fit_the")));
    }
  }
  else if (state.preset) ({ next, blocked, blockedMessage } = nextCompaction(snapshot.turns, state, state.preset, request.budget.inputTokens, effectiveLimit, required, sizes));
  else if (request.budget.inputTokens > effectiveLimit) ({ blocked, blockedMessage } = blockedText(message("diagnostics.full_history_exceeds_the_input_limit_select_a")));
  const reusable = next ? savedReplacement(snapshot, next)?.node : null;
  return { inputTokens: request.budget.inputTokens, method: request.budget.method, counting: request.budget.counting, targetInputTokens: snapshot.settings.targetInputTokens, effectiveLimit, verbatimTurnIds: request.history!.verbatimTurnIds, next, ready: !blocked && !next, blocked, blockedMessage, stale, repairCount: repairQueue(snapshot.turns, state).length, ...(reusable ? { reusable: { id: reusable.id, revision: reusable.revision } } : {}) };
}

export function summaryRequest(snapshot: ChatSnapshot, operation: ContextOperation, connection: NonNullable<ChatSnapshot['connection']>, replacements = new Map<string, SummaryRef | null>(), previousRequest: RequestPreview | null = null): { request: RequestPreview; prior: SummaryRef[] } {
  const config = snapshot.context.preset;
  if (!config) throw new AppError(422, 'context_required', message("errors.select_a_context_preset_first"));
  const ids = new Set(operation.turnIds), turns = snapshot.turns.filter(turn => ids.has(turn.id));
  const inputs = operation.repair ? repairInputs(snapshot, operation, previousRequest) : null;
  const template = operation.repair && !inputs?.rebuilding ? config.repairPrompt : operation.level === 1 ? config.extractionPrompt : config.promotionPrompt;
  const values: Record<string, string> = { target_tokens: String(config.summaryTokens), level: String(operation.level), user: snapshot.sources.persona?.name ?? 'You', char: snapshot.sources.character?.name ?? 'Character' };
  const instructions = modelText(template.replace(/{{\s*(target_tokens|level|user|char)\s*}}/gi, (match, name: string) => values[name.toLowerCase()] ?? match));
  const summaryInput = (ref: SummaryRef) => {
    const node = nodeFor(snapshot.context, ref);
    if (!node) throw new AppError(422, 'invalid_context', message('errors.a_source_summary_is_missing'));
    assertCleanSummaryInput(node);
    return { level: node.level, text: modelText(node.text) };
  };
  if (inputs) {
    const payload = inputs.rebuilding ? {
      task: 'Reconstruct this memory from the complete current sources. The previous output was unusable and is deliberately unavailable. Return only the complete replacement. Incorporate the supplied clean editorial corrections, if any, and use earlier memory only to clarify references.',
      sources: operation.level === 1 ? inputs.currentSources.map(source => ({ turn: snapshot.turns.findIndex(turn => turn.id === source.turnId) + 1, user: modelText(source.user), assistant: modelText(source.assistant) })) : operation.children.map(summaryInput),
      earlier_memory: inputs.prior.map(summaryInput), corrections: inputs.corrections.map(summaryInput),
    } : {
      task: 'Apply only the necessary factual corrections from these input changes to the existing summary. Return the complete summary with all unaffected text preserved exactly. If no correction belongs in this memory, return the existing summary exactly. When a previous input is marked unusable_summary, its text is deliberately withheld: incorporate its replacement and correct affected conclusions; do not interpret withheld text as an unchanged input.',
      previous_summary: modelText(inputs.old.text), previously_manually_corrected: inputs.old.manual,
      coverage_unchanged: inputs.structureUnchanged, previous_inputs_available: inputs.known,
      changes: inputs.changes.map(change => ({ ...change, before: change.before === null ? null : modelText(change.before), after: change.after === null ? null : modelText(change.after) })),
      ...(operation.reconcile?.length ? { reconciliation: 'The supplied manual corrections overlap this memory. Reconcile them with the existing summary. Do not silently prefer one correction or discard editorial content. Make conflicts explicit for user review; this result requires approval.' } : {}),
    };
    const messages: Message[] = [{ role: 'system', content: instructions }, { role: 'user', content: JSON.stringify(payload) }];
    const physicalInput = connection.contextWindow - connection.maxOutputTokens;
    const { contentTokens: _, ...measurement } = countInput(messages);
    if (measurement.inputTokens > physicalInput) throw new AppError(422, 'summary_window_exceeded', inputs.rebuilding
      ? message('refusals.reconstruction_too_large') : message("errors.the_existing_summary_repair_instructions_and_complete_input"));
    return { prior: inputs.prior, request: {
      endpoint: `${connection.endpoint.replace(/\/+$/, '')}/chat/completions`,
      body: { ...connection.customParameters, model: connection.model, messages, stream: true, max_tokens: connection.maxOutputTokens, ...(connection.requestUsage !== false ? { stream_options: { include_usage: true as const } } : {}) },
      coverage: turns.map(sourceOf), ...(operation.level === 1 ? { summarySources: inputs.currentSources } : {}),
      budget: { ...measurement, targetInputTokens: physicalInput, reservedOutputTokens: connection.maxOutputTokens, contextWindow: connection.contextWindow },
    } };
  }
  const protection = correctionProtection(snapshot.turns, snapshot.context);
  const proposed = { id: 'proposed', revision: 0, level: operation.level, text: '', turns: turns.map(sourceOf), children: operation.children, prior: [], approved: false, manual: false, createdAt: '' };
  if (protection.missingFor(proposed).length) throw new AppError(422, 'correction_reconciliation_required', correctionMessage);
  const source = operation.level === 1 ? turns.map(turn => ({ turn: snapshot.turns.indexOf(turn) + 1, user: modelText(turn.user.text), assistant: modelText(turn.assistant.text) })) : operation.children.map(summaryInput);
  const sourceMessage: Message = { role: 'user', content: JSON.stringify({ task: 'Summarize only the supplied sources.', sources: source }) };
  const messages: Message[] = [{ role: 'system', content: instructions }, sourceMessage];
  const physicalInput = connection.contextWindow - connection.maxOutputTokens;
  if (estimateInputTokens(messages) > physicalInput) throw new AppError(422, 'summary_window_exceeded', message("errors.this_fixed_source_batch_and_summary_instructions_do"));
  const first = snapshot.turns.findIndex(turn => turn.id === operation.turnIds[0]);
  const prior: SummaryRef[] = [];
  const currentRef = (ref: SummaryRef) => replacements.has(refKey(ref)) ? replacements.get(refKey(ref)) : snapshot.context.summaries.filter(node => node.id === ref.id && node.approved).sort((a, b) => b.revision - a.revision)[0] ?? ref;
  const earlier = snapshot.context.selected.map(currentRef).filter((ref): ref is SummaryRef => Boolean(ref)).flatMap(ref => {
    const node = nodeFor(snapshot.context, ref);
    return node?.turns.length && snapshot.turns.findIndex(turn => turn.id === node.turns.at(-1)?.turnId) < first ? [node] : [];
  });
  const usedPriorTurns = new Set<string>();
  const priorNodes = earlier.filter(node => {
    if (node.turns.some(source => usedPriorTurns.has(source.turnId))) return false;
    node.turns.forEach(source => usedPriorTurns.add(source.turnId)); return true;
  }).sort((a, b) => snapshot.turns.findIndex(turn => turn.id === a.turns[0].turnId) - snapshot.turns.findIndex(turn => turn.id === b.turns[0].turnId)).slice(-3);
  // Bounded earlier context only. Never add later events to a summary's sources.
  for (const node of [...priorNodes].reverse()) {
    if (!node) continue;
    assertCleanSummaryInput(node);
    const candidate: Message = { role: 'system', content: `Earlier memory for reference only; do not repeat or extend its coverage:\n${modelText(node.text)}` };
    const insert = 1;
    const proposed = [...messages.slice(0, insert), candidate, ...messages.slice(insert)];
    if (estimateInputTokens(proposed) <= physicalInput) { messages.splice(insert, 0, candidate); prior.unshift({ id: node.id, revision: node.revision }); }
  }
  const { contentTokens: _, ...measurement } = countInput(messages);
  // Ordinary extraction can recover its baseline from the provider JSON. When
  // display images were excluded, retain the original source separately for repair.
  const filteredSources = operation.level === 1 && turns.some(turn => modelText(turn.user.text) !== turn.user.text || modelText(turn.assistant.text) !== turn.assistant.text);
  return { prior, request: {
    endpoint: `${connection.endpoint.replace(/\/+$/, '')}/chat/completions`,
    body: { ...connection.customParameters, model: connection.model, messages, stream: true, max_tokens: connection.maxOutputTokens, ...(connection.requestUsage !== false ? { stream_options: { include_usage: true as const } } : {}) },
    coverage: turns.map(sourceOf), ...(filteredSources ? { summarySources: turns.map(turn => ({ turnId: turn.id, user: turn.user.text, assistant: turn.assistant.text })) } : {}),
    budget: { ...measurement, targetInputTokens: physicalInput, reservedOutputTokens: connection.maxOutputTokens, contextWindow: connection.contextWindow },
  } };
}
