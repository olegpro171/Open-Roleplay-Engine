import type { ChatSettings, Connection, Message, RequestPreview, Turn } from '../shared/contracts.js';
import { AppError } from './errors.js';

// This measures bytes with generous framing, not a model-specific tokenizer.
export function estimateInputTokens(messages: Message[]): number {
  return new TextEncoder().encode(JSON.stringify(messages)).length + 128 + messages.length * 16;
}

export function assembleRequest(connection: Connection, settings: ChatSettings, turns: Turn[]): RequestPreview {
  const messages: Message[] = [];
  for (const content of [settings.instructions, settings.character, settings.persona]) {
    if (content !== '') messages.push({ role: 'system', content });
  }
  for (const turn of turns) {
    if (turn.user.text !== '') messages.push({ role: 'user', content: turn.user.text });
    if (turn.complete && turn.assistant.text !== '') messages.push({ role: 'assistant', content: turn.assistant.text });
  }
  const inputTokens = estimateInputTokens(messages);
  if (inputTokens > settings.targetInputTokens) {
    throw new AppError(422, 'input_budget_exceeded', 'The estimated input exceeds your target. Shorten the prompt or history, or raise the target. Layered compaction is not available yet.');
  }
  if (inputTokens + connection.maxOutputTokens > connection.contextWindow) {
    throw new AppError(422, 'context_window_exceeded', 'The estimated input plus reserved output exceeds the Connection context window.');
  }
  return {
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
