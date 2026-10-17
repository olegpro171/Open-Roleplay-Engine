import type { ChatSettings, Connection, Message, PromptEntry, RequestPreview, Turn } from '../shared/contracts.js';
import { AppError } from './errors.js';
import { promptSchema, type PromptSources } from '../shared/library.js';
import type { ContextState, SummaryNode } from '../shared/context.js';
import { selectedContext } from './context.js';

export function replaceNameMacros(text: string, user: string, character: string): string {
  return text.replace(/{{\s*(user|char)\s*}}/gi, (_match, key: string) => key.toLowerCase() === 'user' ? user : character);
}

// This measures bytes with generous framing, not a model-specific tokenizer.
export function estimateInputTokens(messages: Message[]): number {
  return new TextEncoder().encode(JSON.stringify(messages)).length + 128 + messages.length * 16;
}

export function summaryText(node: SummaryNode, turns: Turn[]): string {
  const positions = new Map(turns.map((turn, i) => [turn.id, i + 1]));
  return `[Memory L${node.level} · turns ${positions.get(node.turns[0]?.turnId) ?? '?'}–${positions.get(node.turns.at(-1)?.turnId ?? '') ?? '?'}]\n${node.text}`;
}

export function assembleRequest(connection: Connection, settings: ChatSettings, turns: Turn[], sources?: PromptSources, context?: ContextState, options: { validateLimits?: boolean; allowStale?: boolean } = {}): RequestPreview {
  const messages: Message[] = [];
  const positions = new Map(turns.map((turn, index) => [turn.id, index + 1]));
  const warnings: string[] = [];
  const layout: PromptEntry[] = [];
  const push = (message: Message, kind: PromptEntry['kind'], label: string) => {
    layout.push({ messageIndex: messages.length, kind, label, tokens: new TextEncoder().encode(JSON.stringify(message.content)).length - 2 });
    messages.push(message);
  };
  const resolved = context ? selectedContext(turns, context, options.allowStale) : { summaries: [], verbatim: turns };
  const summary = resolved.summaries.map(node => summaryText(node, turns)).join('\n\n');
  const separateSummary = sources?.prompt?.blocks.some(block => block.enabled && block.kind === 'marker' && block.marker === 'summary');
  const history = () => {
    if (summary && !separateSummary) push({ role: 'system', content: summary }, 'memory', 'Selected memory');
    for (const turn of resolved.verbatim) {
      if (turn.user.text !== '') push({ role: 'user', content: turn.user.text }, turn.id === 'draft' ? 'draft' : 'history', turn.id === 'draft' ? 'Unsent input' : `Turn ${positions.get(turn.id)} · input`);
      if (turn.complete && turn.assistant.text !== '') push({ role: 'assistant', content: turn.assistant.text }, 'history', `Turn ${positions.get(turn.id)} · response`);
    }
  };
  const card = sources?.character;
  const resolve = (text: string) => replaceNameMacros(text, sources?.persona?.name ?? 'You', card?.name ?? 'Character');
  if (sources?.prompt) {
    const preset = promptSchema.parse({ name: sources.prompt.name, blocks: sources.prompt.blocks });
    for (const block of preset.blocks) {
      if (!block.enabled) continue;
      if (block.kind === 'marker' && block.marker === 'messages') { history(); continue; }
      if (block.kind === 'marker' && block.marker === 'summary') { if (summary) push({ role: block.role, content: summary }, 'memory', block.name || 'Selected memory'); else warnings.push('The Summary marker is empty: no summaries have been selected.'); continue; }
      let content = '';
      if (block.kind === 'text') content = block.text;
      else switch (block.marker) {
        case 'character': content = card ? [card.name, card.description, card.personality, card.scenario, card.mes_example].filter(Boolean).join('\n\n') : settings.character; break;
        case 'persona': content = sources.persona?.description ?? settings.persona; break;
        case 'description': content = card?.description ?? ''; break;
        case 'personality': content = card?.personality ?? ''; break;
        case 'scenario': content = card?.scenario ?? ''; break;
        case 'examples': content = card?.mes_example ?? ''; break;
      }
      if (content !== '') push({ role: block.role, content: resolve(content) }, block.kind === 'text' ? 'prompt' : block.marker === 'persona' ? 'persona' : 'character', block.name || (block.kind === 'text' ? 'Prompt text' : block.marker));
    }
  } else {
    for (const [index, content] of [settings.instructions, settings.character, settings.persona].entries()) {
      if (content !== '') push({ role: 'system', content: resolve(content) }, (['prompt', 'character', 'persona'] as const)[index], ['Instructions', 'Character', 'Persona'][index]);
    }
    history();
  }
  const inputTokens = estimateInputTokens(messages);
  if (options.validateLimits !== false && inputTokens > settings.targetInputTokens) {
    throw new AppError(422, 'input_budget_exceeded', 'The estimated input exceeds your target. Prepare context, shorten the prompt, or raise the target.');
  }
  if (options.validateLimits !== false && inputTokens + connection.maxOutputTokens > connection.contextWindow) {
    throw new AppError(422, 'context_window_exceeded', 'The estimated input plus reserved output exceeds the Connection context window.');
  }
  return {
    warnings, layout,
    endpoint: `${connection.endpoint.replace(/\/+$/, '')}/chat/completions`,
    body: {
      ...connection.customParameters,
      model: connection.model, messages, stream: true, max_tokens: connection.maxOutputTokens,
      ...(connection.requestUsage !== false ? { stream_options: { include_usage: true as const } } : {}),
    },
    coverage: turns.map((turn) => ({
      turnId: turn.id, userRevision: turn.user.revision, assistantRevision: turn.assistant.revision, complete: turn.complete,
    })),
    ...(context ? { context: { selected: context.selected, archivedTurnIds: context.archivedTurnIds } } : {}),
    budget: {
      inputTokens, targetInputTokens: settings.targetInputTokens,
      reservedOutputTokens: connection.maxOutputTokens, contextWindow: connection.contextWindow,
      method: 'UTF-8 bytes + 128 framing + 16 per message (conservative estimate)', verified: false,
    },
  };
}
