import { promptLabel } from '../shared/localization.js';
import { message } from '../shared/localization.js';
import type { ChatSettings, Connection, Message, PromptEntry, RequestPreview, Turn } from '../shared/contracts.js';
import { AppError } from './errors.js';
import { characterFieldLabels, defaultPrompt, hasPromptMarker, promptSchema, promptWarnings, promptWarningMessages, type PromptSources } from '../shared/library.js';
import type { ContextState, SummaryNode } from '../shared/context.js';
import { assertCorrectionSelection } from './context-corrections.js';
import { selectedContext, sourceOf } from './context.js';
import { countInput } from './tokens.js';
import { replaceNameMacros } from './names.js';
import type { LoreResolution } from '../shared/lorebook.js';
import { characterParts } from './character-prompt.js';
import { readCharacterDepthPrompt } from '../shared/card-instructions.js';
import { resolveCardInstruction } from './card-instructions.js';
import { injectHistory } from './history-injections.js';
export { replaceNameMacros } from './names.js';

export function estimateInputTokens(messages: Message[]): number {
  return countInput(messages).inputTokens;
}

export function summaryText(node: SummaryNode, turns: Turn[]): string {
  const positions = new Map(turns.map((turn, i) => [turn.id, i + 1]));
  return `[Memory L${node.level} · turns ${positions.get(node.turns[0]?.turnId) ?? '?'}–${positions.get(node.turns.at(-1)?.turnId ?? '') ?? '?'}]\n${node.text}`;
}

export function assembleRequest(connection: Connection, settings: ChatSettings, turns: Turn[], sources?: PromptSources, context?: ContextState, options: { validateLimits?: boolean; allowStale?: boolean; lore?: LoreResolution | null } = {}): RequestPreview {
  // The default template also supports the legacy inline-settings API. An
  // explicitly supplied preset, including an empty one, is always authoritative.
  const preset = sources?.prompt ? promptSchema.parse({ name: sources.prompt.name, blocks: sources.prompt.blocks }) : {
    ...defaultPrompt, blocks: defaultPrompt.blocks.map(block => block.kind === 'marker' && block.marker === 'card_system_prompt' ? { ...block, fallback: settings.instructions } : block),
  };
  const summariesEnabled = hasPromptMarker(preset, 'summary');
  if (summariesEnabled && context && !options.allowStale) assertCorrectionSelection(turns, context);
  const resolved = summariesEnabled && context ? selectedContext(turns, context, options.allowStale) : { summaries: [], verbatim: turns };
  const summary = resolved.summaries.map(node => summaryText(node, turns)).join('\n\n');
  const positions = new Map(turns.map((turn, index) => [turn.id, index + 1]));
  type Entry = { message: Message; kind: PromptEntry['kind']; label: string; labelMessage?: PromptEntry['labelMessage']; group?: PromptEntry['group'] };
  let entries: Entry[] = [];
  const warnings = promptWarnings(preset);
  let historyIndex: number | null = null;
  const card = sources?.character;
  const resolve = (text: string) => replaceNameMacros(text, sources?.persona?.name ?? 'You', card?.name ?? 'Character');
  const messagesBlock = preset.blocks.find(block => block.enabled && block.kind === 'marker' && block.marker === 'messages');
  let depthNote: { depth: number; entry: Entry } | null = null;
  if (messagesBlock?.kind === 'marker' && messagesBlock.allowDepthPrompt) {
    const note = readCharacterDepthPrompt(card ?? {});
    if (!note.success) throw new AppError(422, 'invalid_character_depth_prompt', message("errors.this_character_s_depth_note_has_invalid_settings"));
    if (note.data.prompt.trim()) depthNote = {
      depth: note.data.depth,
      entry: { message: { role: note.data.role, content: resolve(note.data.prompt) }, kind: 'character', ...promptLabel(message("diagnostics.character_depth_note_depth", { depth: String(note.data.depth) })) },
    };
  }
  if (sources?.lorebook && !options.lore) throw new AppError(422, 'lore_unresolved', message("errors.resolve_the_selected_lorebook_from_the_original_transcript"));
  // Saved request inspection reads immutable bodies directly. An unfinished old
  // operation must explicitly resolve again instead of dropping retired anchors.
  if (options.lore?.outcomes.some(outcome => outcome.destination?.controlId !== undefined)) {
    throw new AppError(409, 'lore_layout_changed', message("errors.this_operation_captured_lore_with_an_older_prompt"));
  }
  const admitted = options.lore?.outcomes.filter(outcome => outcome.status === 'admitted' && outcome.destination) ?? [];
  const groups = new Map(preset.blocks.filter(block => block.enabled && block.kind === 'marker' && block.marker === 'character').map(block => [block.id, { id: block.id, label: block.name }]));
  const loreEntry = (entry: typeof admitted[number]): Entry => {
    const destination = entry.destination;
    const fieldRelative = destination && ['before_desc', 'after_desc', 'personality', 'scenario'].includes(destination.placement);
    const group = fieldRelative && destination.anchorId ? groups.get(destination.anchorId) : undefined;
    return {
      message: { role: destination?.role ?? 'system', content: entry.text },
      kind: 'lore', ...promptLabel(message("prompt_peek.lore_2", { name: String(entry.name) })), ...(group ? { group } : {}),
    };
  };
  const historyLore = admitted.filter(entry => entry.destination?.placement === 'history');
  const anchored = admitted.filter(entry => entry.destination?.anchorId);
  const emitAnchored = (blockId: string, placement: string) => anchored.filter(entry => entry.destination?.anchorId === blockId && entry.destination.placement === placement).forEach(entry => entries.push(loreEntry(entry)));
  for (const block of preset.blocks) {
    if (!block.enabled) continue;
    if (block.kind === 'marker' && block.marker === 'messages') { historyIndex = entries.length; continue; }
    if (block.kind === 'marker' && block.marker === 'summary') {
      if (summary) entries.push({ message: { role: block.role, content: summary }, kind: 'memory', label: block.name });
      continue;
    }
    if (block.kind === 'marker' && (block.marker === 'card_system_prompt' || block.marker === 'card_post_history_instructions')) {
      const field = block.marker === 'card_system_prompt' ? 'system_prompt' : 'post_history_instructions';
      const instruction = resolveCardInstruction(card, field, block.fallback ?? '', sources?.persona?.name ?? 'You');
      if (instruction.text.trim()) entries.push({ message: { role: block.role, content: instruction.text }, kind: instruction.fallback ? 'prompt' : 'character', ...promptLabel(message("diagnostics.text", { name: String(block.name), field: String(field), value: String(instruction.fallback ? 'fallback' : 'card') })) });
      continue;
    }
    const parts = characterParts(block, card, settings.character);
    if (parts.length) {
      emitAnchored(block.id, 'before_char');
      for (const part of parts) {
        if (part.field === 'description') emitAnchored(block.id, 'before_desc');
        const group = groups.get(block.id);
        entries.push({
          message: { role: block.role, content: resolve(part.text) }, kind: 'character',
          label: group ? characterFieldLabels[part.field] : block.name,
          ...(group ? { group } : {}),
        });
        const placement = part.field === 'description' ? 'after_desc' : part.field;
        emitAnchored(block.id, placement);
      }
      emitAnchored(block.id, 'after_char');
      continue;
    }
    let content = '';
    if (block.kind === 'text') content = block.text;
    else switch (block.marker) {
      case 'persona': content = sources?.persona?.description ?? settings.persona; break;
    }
    if (content !== '') entries.push({ message: { role: block.role, content: resolve(content) }, kind: block.kind === 'text' ? 'prompt' : 'persona', label: block.name });
  }
  const turnEntries = (turn: Turn): Entry[] => {
    const result: Entry[] = [];
    if (turn.user.text !== '') result.push({ message: { role: 'user', content: turn.user.text }, kind: turn.id === 'draft' ? 'draft' : 'history', label: turn.id === 'draft' ? 'Unsent input' : `Turn ${positions.get(turn.id)} · input` });
    if (turn.complete && turn.assistant.text !== '') result.push({ message: { role: 'assistant', content: turn.assistant.text }, kind: 'history', ...promptLabel(message("diagnostics.turn_response", { value: String(positions.get(turn.id)) })) });
    return result;
  };
  let verbatim: Turn[] = [];
  if (historyIndex !== null) {
    if (summariesEnabled) verbatim = resolved.verbatim;
    else {
      const limit = Math.min(settings.targetInputTokens, connection.contextWindow - connection.maxOutputTokens);
      let used = countInput([...entries, ...historyLore.map(loreEntry), ...(depthNote ? [depthNote.entry] : [])].map(entry => entry.message)).inputTokens;
      let start = turns.length;
      // A pending input is required when Messages is enabled. Completed turns
      // form a contiguous newest suffix; neither parts nor text are truncated.
      for (let index = turns.length - 1; index >= 0; index--) {
        const turn = turns[index];
        const cost = countInput(turnEntries(turn).map(entry => entry.message)).inputTokens - countInput([]).inputTokens;
        if (turn.complete && used + cost > limit) break;
        used += cost; start = index;
      }
      verbatim = turns.slice(start);
    }
    const history = verbatim.flatMap(turnEntries);
    const expanded = injectHistory(history, entry => Boolean(entry.message.content.trim()), [
      ...historyLore.map(entry => ({ depth: entry.destination?.depth ?? 0, entry: loreEntry(entry) })),
      ...(depthNote ? [depthNote] : []),
    ]);
    entries = entries.slice(0, historyIndex).concat(expanded, entries.slice(historyIndex));
  }
  const messages = entries.map(entry => entry.message);
  const layout: PromptEntry[] = entries.map((entry, messageIndex) => ({ messageIndex, kind: entry.kind, label: entry.label, ...(entry.labelMessage ? { labelMessage: entry.labelMessage } : {}), tokens: 0, ...(entry.group ? { group: entry.group } : {}) }));
  if (options.validateLimits !== false && !messages.length) throw new AppError(422, 'empty_prompt', message("errors.the_resolved_prompt_is_empty_enable_a_block"));
  const { contentTokens, ...measurement } = countInput(messages);
  const { inputTokens } = measurement;
  layout.forEach((part, index) => { part.tokens = contentTokens[index]; });
  if (options.validateLimits !== false && inputTokens > settings.targetInputTokens) {
    throw new AppError(422, 'input_budget_exceeded', message("errors.the_estimated_input_exceeds_your_target_prepare_context"));
  }
  if (options.validateLimits !== false && inputTokens + connection.maxOutputTokens > connection.contextWindow) {
    throw new AppError(422, 'context_window_exceeded', message("errors.the_estimated_input_plus_reserved_output_exceeds_the"));
  }
  return {
    warnings, warningMessages: promptWarningMessages(preset), layout,
    ...(options.lore !== undefined ? { lore: options.lore } : {}),
    endpoint: `${connection.endpoint.replace(/\/+$/, '')}/chat/completions`,
    body: {
      ...connection.customParameters,
      model: connection.model, messages, stream: true, max_tokens: connection.maxOutputTokens,
      ...(connection.requestUsage !== false ? { stream_options: { include_usage: true as const } } : {}),
    },
    coverage: turns.map(sourceOf),
    ...(context ? { context: { selected: summariesEnabled ? context.selected : [], archivedTurnIds: summariesEnabled ? context.archivedTurnIds : [] } } : {}),
    history: { mode: summariesEnabled ? 'managed' : 'recent', verbatimTurnIds: verbatim.map(turn => turn.id) },
    budget: {
      ...measurement, targetInputTokens: settings.targetInputTokens,
      reservedOutputTokens: connection.maxOutputTokens, contextWindow: connection.contextWindow,
    },
  };
}
