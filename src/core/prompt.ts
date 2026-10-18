import type { ChatSettings, Connection, Message, PromptEntry, RequestPreview, Turn } from '../shared/contracts.js';
import { AppError } from './errors.js';
import { defaultPrompt, hasPromptMarker, promptSchema, promptWarnings, type PromptSources } from '../shared/library.js';
import type { ContextState, SummaryNode } from '../shared/context.js';
import { assertCorrectionSelection } from './context-corrections.js';
import { selectedContext } from './context.js';
import { countInput } from './tokens.js';
import { replaceNameMacros } from './names.js';
import type { LoreResolution } from '../shared/lorebook.js';
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
    ...defaultPrompt, blocks: defaultPrompt.blocks.map(block => block.kind === 'text' ? { ...block, text: settings.instructions } : block),
  };
  const summariesEnabled = hasPromptMarker(preset, 'summary');
  if (summariesEnabled && context && !options.allowStale) assertCorrectionSelection(turns, context);
  const resolved = summariesEnabled && context ? selectedContext(turns, context, options.allowStale) : { summaries: [], verbatim: turns };
  const summary = resolved.summaries.map(node => summaryText(node, turns)).join('\n\n');
  const positions = new Map(turns.map((turn, index) => [turn.id, index + 1]));
  type Entry = { message: Message; kind: PromptEntry['kind']; label: string };
  let entries: Entry[] = [];
  const warnings = promptWarnings(preset);
  let historyIndex: number | null = null;
  const card = sources?.character;
  const resolve = (text: string) => replaceNameMacros(text, sources?.persona?.name ?? 'You', card?.name ?? 'Character');
  if (sources?.lorebook && !options.lore) throw new AppError(422, 'lore_unresolved', 'Resolve the selected lorebook from the original transcript before planning this request.');
  const admitted = options.lore?.outcomes.filter(outcome => outcome.status === 'admitted' && outcome.destination) ?? [];
  const loreEntry = (entry: typeof admitted[number]): Entry => ({ message: { role: entry.destination?.role ?? 'system', content: entry.text }, kind: 'lore', label: `Lore · ${entry.name}` });
  const historyLore = admitted.filter(entry => entry.destination?.placement === 'history');
  const anchored = admitted.filter(entry => entry.destination?.anchorId);
  const emitAnchored = (blockId: string, placement: string) => anchored.filter(entry => entry.destination?.anchorId === blockId && entry.destination.placement === placement).forEach(entry => entries.push(loreEntry(entry)));
  for (const block of preset.blocks) {
    if (!block.enabled) continue;
    if (block.kind === 'marker' && block.marker.startsWith('lore_')) {
      if (block.marker !== 'lore_history') admitted.filter(entry => entry.destination?.controlId === block.id && !entry.destination.anchorId && entry.destination.placement !== 'history').forEach(entry => entries.push(loreEntry(entry)));
      continue;
    }
    if (block.kind === 'marker' && block.marker === 'messages') { historyIndex = entries.length; continue; }
    if (block.kind === 'marker' && block.marker === 'summary') {
      if (summary) entries.push({ message: { role: block.role, content: summary }, kind: 'memory', label: block.name });
      continue;
    }
    let content = '';
    if (block.kind === 'text') content = block.text;
    else switch (block.marker) {
      case 'character': content = card ? [card.name, card.description, card.personality, card.scenario, card.mes_example].filter(Boolean).join('\n\n') : settings.character; break;
      case 'persona': content = sources?.persona?.description ?? settings.persona; break;
      case 'description': content = card?.description ?? ''; break;
      case 'personality': content = card?.personality ?? ''; break;
      case 'scenario': content = card?.scenario ?? ''; break;
      case 'examples': content = card?.mes_example ?? ''; break;
    }
    const hasAnchors = block.kind === 'marker' && anchored.some(entry => entry.destination?.anchorId === block.id);
    if (hasAnchors && block.kind === 'marker' && block.marker === 'character' && card) {
      let pieces: string[] = [];
      const flush = () => {
        if (pieces.length) entries.push({ message: { role: block.role, content: resolve(pieces.join('\n\n')) }, kind: 'character', label: block.name });
        pieces = [];
      };
      for (const [field, value] of [['name', card.name], ['description', card.description], ['personality', card.personality], ['scenario', card.scenario], ['examples', card.mes_example]]) {
        if (!value) continue;
        if (field === 'description' && anchored.some(entry => entry.destination?.anchorId === block.id && entry.destination.placement === 'before_desc')) { flush(); emitAnchored(block.id, 'before_desc'); }
        pieces.push(value);
        const placement = field === 'description' ? 'after_desc' : field;
        if (anchored.some(entry => entry.destination?.anchorId === block.id && entry.destination.placement === placement)) { flush(); emitAnchored(block.id, placement); }
      }
      flush();
    } else {
      if (hasAnchors) emitAnchored(block.id, 'before_desc');
      if (content !== '') entries.push({ message: { role: block.role, content: resolve(content) }, kind: block.kind === 'text' ? 'prompt' : block.marker === 'persona' ? 'persona' : 'character', label: block.name });
      if (hasAnchors) for (const placement of ['after_desc', 'personality', 'scenario']) emitAnchored(block.id, placement);
    }
  }
  const turnEntries = (turn: Turn): Entry[] => {
    const result: Entry[] = [];
    if (turn.user.text !== '') result.push({ message: { role: 'user', content: turn.user.text }, kind: turn.id === 'draft' ? 'draft' : 'history', label: turn.id === 'draft' ? 'Unsent input' : `Turn ${positions.get(turn.id)} · input` });
    if (turn.complete && turn.assistant.text !== '') result.push({ message: { role: 'assistant', content: turn.assistant.text }, kind: 'history', label: `Turn ${positions.get(turn.id)} · response` });
    return result;
  };
  let verbatim: Turn[] = [];
  if (historyIndex !== null) {
    if (summariesEnabled) verbatim = resolved.verbatim;
    else {
      const limit = Math.min(settings.targetInputTokens, connection.contextWindow - connection.maxOutputTokens);
      let used = countInput([...entries, ...historyLore.map(loreEntry)].map(entry => entry.message)).inputTokens;
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
    const eligibleHistory = history.flatMap((entry, index) => entry.message.content.trim() ? [index] : []);
    const insertions = new Map<number, Entry[]>();
    for (const entry of historyLore) {
      const depth = entry.destination?.depth ?? 0;
      const index = depth === 0 ? (eligibleHistory.at(-1) ?? -1) + 1 : eligibleHistory[Math.max(0, eligibleHistory.length - depth)] ?? 0;
      insertions.set(index, [...insertions.get(index) ?? [], loreEntry(entry)]);
    }
    const expanded = history.flatMap((entry, index) => [...insertions.get(index) ?? [], entry]).concat(insertions.get(history.length) ?? []);
    entries = entries.slice(0, historyIndex).concat(expanded, entries.slice(historyIndex));
  }
  const messages = entries.map(entry => entry.message);
  const layout: PromptEntry[] = entries.map((entry, messageIndex) => ({ messageIndex, kind: entry.kind, label: entry.label, tokens: 0 }));
  if (options.validateLimits !== false && !messages.length) throw new AppError(422, 'empty_prompt', 'The resolved prompt is empty. Enable a block or marker before sending.');
  const { contentTokens, ...measurement } = countInput(messages);
  const { inputTokens } = measurement;
  layout.forEach((part, index) => { part.tokens = contentTokens[index]; });
  if (options.validateLimits !== false && inputTokens > settings.targetInputTokens) {
    throw new AppError(422, 'input_budget_exceeded', 'The estimated input exceeds your target. Prepare context, shorten the prompt, or raise the target.');
  }
  if (options.validateLimits !== false && inputTokens + connection.maxOutputTokens > connection.contextWindow) {
    throw new AppError(422, 'context_window_exceeded', 'The estimated input plus reserved output exceeds the Connection context window.');
  }
  return {
    warnings, layout,
    ...(options.lore !== undefined ? { lore: options.lore } : {}),
    endpoint: `${connection.endpoint.replace(/\/+$/, '')}/chat/completions`,
    body: {
      ...connection.customParameters,
      model: connection.model, messages, stream: true, max_tokens: connection.maxOutputTokens,
      ...(connection.requestUsage !== false ? { stream_options: { include_usage: true as const } } : {}),
    },
    coverage: turns.map((turn) => ({
      turnId: turn.id, userRevision: turn.user.revision, assistantRevision: turn.assistant.revision, complete: turn.complete,
    })),
    ...(context ? { context: { selected: summariesEnabled ? context.selected : [], archivedTurnIds: summariesEnabled ? context.archivedTurnIds : [] } } : {}),
    history: { mode: summariesEnabled ? 'managed' : 'recent', verbatimTurnIds: verbatim.map(turn => turn.id) },
    budget: {
      ...measurement, targetInputTokens: settings.targetInputTokens,
      reservedOutputTokens: connection.maxOutputTokens, contextWindow: connection.contextWindow,
    },
  };
}
