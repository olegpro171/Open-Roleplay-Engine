import type { ChatSnapshot, Message, RequestPreview } from '../shared/contracts.js';
import { emptyContextState, refKey, type ContextOperation, type ContextPlan, type SummaryRef } from '../shared/context.js';
import { AppError } from './errors.js';
import { nextCompaction, nodeFor, rankedPromotions, sourceOf, staleSummaries } from './context.js';
import { hasPromptMarker } from '../shared/library.js';
import { assembleRequest, estimateInputTokens, summaryText } from './prompt.js';
import { countInput, countText } from './tokens.js';
import { savedReplacement } from './context-reuse.js';

export function contextPlan(snapshot: ChatSnapshot): ContextPlan {
  if (!snapshot.connection) throw new AppError(422, 'connection_required', 'Select a roleplay Connection to measure the complete input.');
  const state = snapshot.context;
  const request = assembleRequest(snapshot.connection, snapshot.settings, snapshot.turns, snapshot.sources, state, { validateLimits: false, allowStale: true });
  const effectiveLimit = Math.min(snapshot.settings.targetInputTokens, snapshot.connection.contextWindow - snapshot.connection.maxOutputTokens);
  if (!hasPromptMarker(snapshot.sources.prompt, 'summary')) {
    const blocked = request.budget.inputTokens > effectiveLimit ? 'The prompt and pending input exceed the input limit. Shorten them or increase the limit.' : null;
    return { inputTokens: request.budget.inputTokens, method: request.budget.method, counting: request.budget.counting, targetInputTokens: snapshot.settings.targetInputTokens, effectiveLimit,
      verbatimTurnIds: request.history!.verbatimTurnIds, next: null, ready: !blocked, blocked, stale: [] };
  }
  const staleKeys = staleSummaries(snapshot.turns, state);
  const stale = state.selected.filter(ref => staleKeys.has(refKey(ref)));
  const archived = new Set(state.archivedTurnIds);
  const verbatim = snapshot.turns.filter(turn => !archived.has(turn.id));
  const required = assembleRequest(snapshot.connection, snapshot.settings, verbatim, snapshot.sources, emptyContextState(), { validateLimits: false }).budget.inputTokens;
  // Rank with the shared reference tokenizer, including labels and separator.
  // Only the complete assembled request determines whether the limit is met.
  const sizes = new Map(state.summaries.map(node => [refKey(node), countText(`${summaryText(node, snapshot.turns)}\n\n`)]));
  const changedMembership = JSON.stringify(snapshot.turns.slice(0, archived.size).map(turn => turn.id)) !== JSON.stringify(state.archivedTurnIds);
  let next: ContextOperation | null = null, blocked: string | null = null;
  if (stale.length || changedMembership) blocked = 'Selected memory is out of date. Generate a targeted repair and review its replacements before continuing.';
  else if (state.preset && !hasPromptMarker(snapshot.sources.prompt, 'messages')) {
    if (request.budget.inputTokens > effectiveLimit) {
      next = required <= effectiveLimit ? rankedPromotions(state.selected.map(ref => nodeFor(state, ref)!), state.preset, sizes)[0] ?? null : null;
      if (!next) blocked = 'The selected summaries and prompt cannot fit the input limit with the current promotion settings.';
    }
  }
  else if (state.preset) ({ next, blocked } = nextCompaction(snapshot.turns, state, state.preset, request.budget.inputTokens, effectiveLimit, required, sizes));
  else if (request.budget.inputTokens > effectiveLimit) blocked = 'Full history exceeds the input limit. Select a context preset to prepare it.';
  const reusable = next ? savedReplacement(snapshot, next)?.node : null;
  return { inputTokens: request.budget.inputTokens, method: request.budget.method, counting: request.budget.counting, targetInputTokens: snapshot.settings.targetInputTokens, effectiveLimit, verbatimTurnIds: request.history!.verbatimTurnIds, next, ready: !blocked && !next, blocked, stale, ...(reusable ? { reusable: { id: reusable.id, revision: reusable.revision } } : {}) };
}

export function summaryRequest(snapshot: ChatSnapshot, operation: ContextOperation, connection: NonNullable<ChatSnapshot['connection']>, replacements = new Map<string, SummaryRef | null>(), previousRequest: RequestPreview | null = null): { request: RequestPreview; prior: SummaryRef[] } {
  const config = snapshot.context.preset;
  if (!config) throw new AppError(422, 'context_required', 'Select a context preset first.');
  const ids = new Set(operation.turnIds), turns = snapshot.turns.filter(turn => ids.has(turn.id));
  const template = operation.level === 1 ? config.extractionPrompt : config.promotionPrompt;
  const values: Record<string, string> = { target_tokens: String(config.summaryTokens), level: String(operation.level), user: snapshot.sources.persona?.name ?? 'You', char: snapshot.sources.character?.name ?? 'Character' };
  const instructions = template.replace(/{{\s*(target_tokens|level|user|char)\s*}}/gi, (match, name: string) => values[name.toLowerCase()] ?? match);
  const old = operation.repair ? nodeFor(snapshot.context, operation.repair) : null;
  const source = operation.level === 1 ? turns.map(turn => ({ turn: snapshot.turns.indexOf(turn) + 1, user: turn.user.text, assistant: turn.assistant.text })) : operation.children.map(ref => {
    const node = nodeFor(snapshot.context, ref);
    if (!node) throw new AppError(422, 'invalid_context', 'A source summary is missing.');
    return { level: node.level, text: node.text };
  });
  const previousSourceText = previousRequest?.body.messages.at(-1)?.content;
  let previousSources: unknown = undefined;
  if (previousSourceText) { try { previousSources = (JSON.parse(previousSourceText) as { sources?: unknown }).sources; } catch { /* Older request formats may not have structured source text. */ } }
  const sourceMessage: Message = { role: 'user', content: JSON.stringify({ task: old ? 'Repair this existing summary using the previous and current sources. Remove facts whose source was deleted, cleared or changed; do not retain them solely because the old summary contains them. Current sources supersede old source facts. Preserve unrelated manual additions and leave conflicting author corrections explicit for human review.' : 'Summarize only the supplied sources.', ...(old ? { previous_summary: old.text, previously_manually_corrected: old.manual, previous_sources: previousSources } : {}), sources: source }) };
  const messages: Message[] = [{ role: 'system', content: instructions }, sourceMessage];
  const physicalInput = connection.contextWindow - connection.maxOutputTokens;
  if (estimateInputTokens(messages) > physicalInput) throw new AppError(422, 'summary_window_exceeded', 'This fixed source batch and summary instructions do not fit the summarization Connection. Use a larger window, shorter prompts or explicitly change the batch setting.');
  const first = snapshot.turns.findIndex(turn => turn.id === operation.turnIds[0]);
  const prior: SummaryRef[] = [];
  const currentRef = (ref: SummaryRef) => replacements.has(refKey(ref)) ? replacements.get(refKey(ref)) : snapshot.context.summaries.filter(node => node.id === ref.id && node.approved).sort((a, b) => b.revision - a.revision)[0] ?? ref;
  const earlier = [...(old?.prior ?? []), ...snapshot.context.selected].map(currentRef).filter((ref): ref is SummaryRef => Boolean(ref)).flatMap(ref => {
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
    const candidate: Message = { role: 'system', content: `Earlier memory for reference only; do not repeat or extend its coverage:\n${node.text}` };
    const insert = 1;
    const proposed = [...messages.slice(0, insert), candidate, ...messages.slice(insert)];
    if (estimateInputTokens(proposed) <= physicalInput) { messages.splice(insert, 0, candidate); prior.unshift({ id: node.id, revision: node.revision }); }
  }
  const { contentTokens: _, ...measurement } = countInput(messages);
  return { prior, request: {
    endpoint: `${connection.endpoint.replace(/\/+$/, '')}/chat/completions`,
    body: { ...connection.customParameters, model: connection.model, messages, stream: true, max_tokens: connection.maxOutputTokens, ...(connection.requestUsage !== false ? { stream_options: { include_usage: true as const } } : {}) },
    coverage: turns.map(sourceOf), budget: { ...measurement, targetInputTokens: physicalInput, reservedOutputTokens: connection.maxOutputTokens, contextWindow: connection.contextWindow },
  } };
}
