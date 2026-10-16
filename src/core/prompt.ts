import type { ChatSettings, Connection, Message, RequestPreview, Turn } from '../shared/contracts.js';
import { AppError } from './errors.js';
import { promptSchema, type PromptSources } from '../shared/library.js';

export function replaceNameMacros(text: string, user: string, character: string): string {
  return text.replace(/{{\s*(user|char)\s*}}/gi, (_match, key: string) => key.toLowerCase() === 'user' ? user : character);
}

// This measures bytes with generous framing, not a model-specific tokenizer.
export function estimateInputTokens(messages: Message[]): number {
  return new TextEncoder().encode(JSON.stringify(messages)).length + 128 + messages.length * 16;
}

export function assembleRequest(connection: Connection, settings: ChatSettings, turns: Turn[], sources?: PromptSources): RequestPreview {
  const messages: Message[] = [];
  const warnings: string[] = [];
  const history = () => {
    for (const turn of turns) {
      if (turn.user.text !== '') messages.push({ role: 'user', content: turn.user.text });
      if (turn.complete && turn.assistant.text !== '') messages.push({ role: 'assistant', content: turn.assistant.text });
    }
  };
  const card = sources?.character;
  const resolve = (text: string) => replaceNameMacros(text, sources?.persona?.name ?? 'You', card?.name ?? 'Character');
  if (sources?.prompt) {
    const preset = promptSchema.parse({ name: sources.prompt.name, blocks: sources.prompt.blocks });
    for (const block of preset.blocks) {
      if (!block.enabled) continue;
      if (block.kind === 'marker' && block.marker === 'messages') { history(); continue; }
      if (block.kind === 'marker' && block.marker === 'summary') { warnings.push('The Summary marker is empty: layered compaction is not implemented.'); continue; }
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
      if (content !== '') messages.push({ role: block.role, content: resolve(content) });
    }
  } else {
    for (const content of [settings.instructions, settings.character, settings.persona]) {
      if (content !== '') messages.push({ role: 'system', content: resolve(content) });
    }
    history();
  }
  const inputTokens = estimateInputTokens(messages);
  if (inputTokens > settings.targetInputTokens) {
    throw new AppError(422, 'input_budget_exceeded', 'The estimated input exceeds your target. Shorten the prompt or history, or raise the target. Layered compaction is not available yet.');
  }
  if (inputTokens + connection.maxOutputTokens > connection.contextWindow) {
    throw new AppError(422, 'context_window_exceeded', 'The estimated input plus reserved output exceeds the Connection context window.');
  }
  return {
    warnings,
    endpoint: `${connection.endpoint.replace(/\/+$/, '')}/chat/completions`,
    body: {
      ...connection.customParameters,
      model: connection.model, messages, stream: true, max_tokens: connection.maxOutputTokens,
    },
    coverage: turns.map((turn) => ({
      turnId: turn.id, userRevision: turn.user.revision, assistantRevision: turn.assistant.revision, complete: turn.complete,
    })),
    budget: {
      inputTokens, targetInputTokens: settings.targetInputTokens,
      reservedOutputTokens: connection.maxOutputTokens, contextWindow: connection.contextWindow,
      method: 'UTF-8 bytes + 128 framing + 16 per message (conservative estimate)', verified: false,
    },
  };
}
