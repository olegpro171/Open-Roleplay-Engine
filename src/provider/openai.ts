import { AppError } from '../core/errors.js';
import type { RequestPreview } from '../shared/contracts.js';

export interface Provider {
  stream(request: RequestPreview, apiKey: string, signal: AbortSignal, onText: (text: string) => void): Promise<void>;
}

export async function fetchModels(endpoint: string, apiKey: string): Promise<string[]> {
  try {
    const response = await fetch(`${endpoint.replace(/\/+$/, '')}/models`, {
      redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: { Accept: 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new AppError(502, 'model_list_unavailable', `Model discovery returned HTTP ${response.status}. You can still enter a model identifier manually.`);
    }
    if (!response.body) throw new Error('Missing model list.');
    const reader = response.body.getReader();
    let size = 0, body = '';
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 2_000_000) throw new Error('Model list too large.');
        body += decoder.decode(value, { stream: true });
      }
      body += decoder.decode();
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const result: unknown = JSON.parse(body);
    if (!result || typeof result !== 'object' || !('data' in result) || !Array.isArray(result.data)) throw new Error('Invalid model list.');
    const models = result.data.map((model: unknown) => model && typeof model === 'object' && 'id' in model ? model.id : null);
    if (models.some(id => typeof id !== 'string' || !id.trim() || id.length > 200) || models.length > 10_000) throw new Error('Invalid model identifiers.');
    return [...new Set(models as string[])].sort();
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(502, 'model_list_unavailable', 'Could not fetch this endpoint’s model list. Check the URL and API key, or enter a model identifier manually.');
  }
}

export class OpenAICompatibleProvider implements Provider {
  async stream(request: RequestPreview, apiKey: string, signal: AbortSignal, onText: (text: string) => void) {
    const response = await fetch(request.endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(300_000)]),
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify(request.body),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new AppError(502, 'provider_error', `The model endpoint returned HTTP ${response.status}. Check the Connection and retry.`);
    }
    if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
      await response.body?.cancel();
      throw new AppError(502, 'invalid_stream', 'The endpoint did not return a Chat Completions event stream.');
    }
    let buffer = '';
    let finished = false;
    let done = false;
    let outputLength = 0;
    const consume = (event: string) => {
      const data = event.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
      if (!data) return;
      if (data === '[DONE]') { done = true; return; }
      const chunk: unknown = JSON.parse(data);
      if (!chunk || typeof chunk !== 'object' || 'error' in chunk) throw new Error('Invalid provider event.');
      const choices = (chunk as { choices?: unknown }).choices;
      if (!Array.isArray(choices) || choices.length === 0) return;
      const choice = choices.find((item) => item?.index === 0);
      if (!choice) return;
      if (choice.finish_reason != null) {
        if (!['stop', 'length'].includes(choice.finish_reason)) throw new Error('Unsupported completion outcome.');
        finished = true;
      }
      const content = choice.delta?.content;
      if (content != null && typeof content !== 'string') throw new Error('Unsupported response content.');
      if (content) {
        outputLength += content.length;
        if (outputLength > 4_000_000) throw new Error('Response too large.');
        onText(content);
      }
    };
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    try {
      while (!done) {
        const item = await reader.read();
        if (item.done) break;
        buffer += decoder.decode(item.value, { stream: true });
        buffer = buffer.replace(/\r\n/g, '\n');
        if (buffer.length > 1_000_000) throw new Error('Provider event too large.');
        let boundary: number;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const event = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          consume(event);
          if (done) break;
        }
      }
      if (!done || !finished) throw new AppError(502, 'incomplete_stream', 'The model stream ended without a completed response. The turn remains pending.');
      if (outputLength === 0) throw new AppError(502, 'empty_response', 'The model returned no text. The turn remains pending; retry or delete it.');
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}
