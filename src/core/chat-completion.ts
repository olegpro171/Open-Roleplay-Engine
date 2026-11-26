import type { Connection, Message, RequestPreview } from '../shared/contracts.js';

export function chatCompletionRequest(connection: Connection, messages: Message[]): Pick<RequestPreview, 'endpoint' | 'body'> {
  return {
    endpoint: `${connection.endpoint.replace(/\/+$/, '')}/chat/completions`,
    body: {
      ...connection.customParameters,
      model: connection.model,
      messages,
      stream: true,
      max_tokens: connection.maxOutputTokens,
      stream_options: { include_usage: true },
    },
  };
}
