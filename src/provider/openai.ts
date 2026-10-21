import { message } from '../shared/localization.js';
import { AppError } from '../core/errors.js';
import { z } from 'zod';
import type { RequestPreview, TokenUsage } from '../shared/contracts.js';

export interface ProviderCompletion {
  finishReason: 'stop' | 'length';
  usage?: TokenUsage;
}

export interface Provider {
  stream(request: RequestPreview, apiKey: string, signal: AbortSignal, onText: (text: string) => void, onReasoning?: (text: string) => void): Promise<ProviderCompletion | void>;
}

const choicesSchema = z.array(z.object({
  index: z.number().int(),
  finish_reason: z.string().nullish(),
  delta: z.object({
    content: z.string().nullish(), refusal: z.string().nullish(),
    reasoning: z.string().nullish(), reasoning_content: z.string().nullish(),
    reasoning_details: z.array(z.object({
      type: z.string(), text: z.string().nullish(), summary: z.string().nullish(),
    })).nullish(),
  }).nullish(),
}));

function httpFailureMessage(status: number, apiKey: string, action: 'models' | 'generation'): string {
  const retry = action === 'models' ? 'fetch the model list again' : 'retry the request';
  if (status === 401) {
    return apiKey
      ? `The provider rejected the API key (HTTP 401). Check or replace it in this Connection, then ${retry}.`
      : `The provider requires authentication (HTTP 401). Enter your provider’s API key in this Connection, then ${retry}.`;
  }
  if (status === 403) {
    return `The provider denied access (HTTP 403). Check that your API key and provider account have permission to ${action === 'models' ? 'list models' : 'use this model'}, then try again.`;
  }
  if (status === 429) {
    return 'The provider’s request or usage limit was reached (HTTP 429). Check your account’s limits and balance, then try again when requests are available.';
  }
  if (status >= 500 && status <= 599) {
    return `The provider could not complete the request (HTTP ${status}). Try again later. If this continues, check the provider’s service status.`;
  }
  if (action === 'models') {
    return `Could not fetch the model list (HTTP ${status}). Check the API base URL. If your provider does not support fetching models, enter its model identifier manually.`;
  }
  return `The provider could not accept the request (HTTP ${status}). Check the API base URL, model identifier and request parameters in this Connection, then try again.`;
}

export async function fetchModels(endpoint: string, apiKey: string): Promise<string[]> {
  try {
    const response = await fetch(`${endpoint.replace(/\/+$/, '')}/models`, {
      redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: { Accept: 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new AppError(502, 'model_list_unavailable', httpFailureMessage(response.status, apiKey, 'models'));
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
    throw new AppError(502, 'model_list_unavailable', message("errors.could_not_read_the_provider_s_model_list"));
  }
}

export class OpenAICompatibleProvider implements Provider {
  async stream(request: RequestPreview, apiKey: string, signal: AbortSignal, onText: (text: string) => void, onReasoning?: (text: string) => void) {
    const response = await fetch(request.endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(300_000)]),
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify(request.body),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new AppError(502, 'provider_error', httpFailureMessage(response.status, apiKey, 'generation'));
    }
    if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
      await response.body?.cancel();
      throw new AppError(502, 'invalid_stream', message("errors.the_endpoint_did_not_return_a_chat_completions"));
    }
    let buffer = '';
    let finishReason: ProviderCompletion['finishReason'] | undefined;
    let usage: TokenUsage | undefined;
    let done = false;
    let outputLength = 0;
    let reasoningLength = 0;
    const consume = (event: string) => {
      const data = event.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
      if (!data) return;
      if (data === '[DONE]') { done = true; return; }
      const chunk: unknown = JSON.parse(data);
      if (!chunk || typeof chunk !== 'object' || 'error' in chunk) throw new Error('Invalid provider event.');
      const reported = (chunk as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown } }).usage;
      if (reported && [reported.prompt_tokens, reported.completion_tokens, reported.total_tokens].every(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)) {
        usage = { inputTokens: reported.prompt_tokens as number, outputTokens: reported.completion_tokens as number, totalTokens: reported.total_tokens as number };
      }
      const rawChoices = (chunk as { choices?: unknown }).choices;
      if (rawChoices == null) return;
      const choice = choicesSchema.parse(rawChoices).find(item => item.index === 0);
      if (!choice) return;
      if (choice.delta?.refusal || choice.finish_reason === 'content_filter') {
        throw new AppError(502, 'provider_refusal', message("errors.the_model_refused_or_filtered_the_request_no"));
      }
      if (choice.finish_reason != null) {
        if (!['stop', 'length'].includes(choice.finish_reason)) throw new Error('Unsupported completion outcome.');
        finishReason = choice.finish_reason === 'stop' ? 'stop' : 'length';
      }
      const delta = choice.delta;
      // Some gateways repeat the same text in both the legacy and details fields.
      // Display one representation, and never expose encrypted data or signatures.
      const reasoning = delta?.reasoning || delta?.reasoning_content || delta?.reasoning_details?.map(detail =>
        detail.type === 'reasoning.text' ? detail.text ?? '' : detail.type === 'reasoning.summary' ? detail.summary ?? '' : '',
      ).join('');
      if (reasoning) {
        reasoningLength += reasoning.length;
        if (reasoningLength > 4_000_000) throw new Error('Reasoning too large.');
        onReasoning?.(reasoning);
      }
      const content = choice.delta?.content;
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
      if (!done || !finishReason) throw new AppError(502, 'incomplete_stream', message("errors.the_model_stream_ended_without_a_completed_response"));
      if (outputLength === 0) throw new AppError(502, 'empty_response', message("errors.the_model_returned_no_text_the_turn_remains"));
      return { finishReason, ...(usage ? { usage } : {}) };
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}
