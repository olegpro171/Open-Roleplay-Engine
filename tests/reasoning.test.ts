import { afterEach, describe, expect, it, vi } from 'vitest';
import { assembleRequest } from '../src/core/prompt.js';
import { OpenAICompatibleProvider } from '../src/provider/openai.js';

const request = assembleRequest(
  { name: 'Reasoning test', endpoint: 'https://example.invalid/v1', model: 'synthetic', contextWindow: 10_000, maxOutputTokens: 1000, customParameters: {} },
  { title: 'Synthetic', instructions: 'Continue the scene.', character: '', persona: '', targetInputTokens: 5000 }, [],
);
const event = (delta: object, finishReason: string | null = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
function stream(deltas: object[], reply = 'The lantern flickers.') {
  const chunks = [...deltas.map(delta => event(delta)), event({ content: reply }, 'stop'), 'data: [DONE]\n\n'];
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
    controller.close();
  } });
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }));
}
afterEach(() => vi.restoreAllMocks());

describe('provider reasoning stream', () => {
  it('keeps reasoning and reply separate, preserving chunk order and avoiding duplicate representations', async () => {
    stream([
      { reasoning: 'First thought. ', reasoning_content: 'First thought. ', reasoning_details: [{ type: 'reasoning.text', text: 'First thought. ' }] },
      { reasoning: null, reasoning_content: 'Second thought. ' },
      { reasoning_details: [{ type: 'reasoning.text', text: 'Third thought. ' }, { type: 'reasoning.encrypted', data: 'private-encrypted-data' }, { type: 'reasoning.summary', summary: 'Conclusion.' }] },
    ]);
    const reply: string[] = [], reasoning: string[] = [];
    await expect(new OpenAICompatibleProvider().stream(request, '', new AbortController().signal, text => reply.push(text), text => reasoning.push(text))).resolves.toEqual({ finishReason: 'stop' });
    expect(reply).toEqual(['The lantern flickers.']);
    expect(reasoning).toEqual(['First thought. ', 'Second thought. ', 'Third thought. Conclusion.']);
  });

  it('supports callers that do not consume reasoning, including summary generation', async () => {
    stream([{ reasoning: 'Private thought.' }]);
    const reply: string[] = [];
    await new OpenAICompatibleProvider().stream(request, '', new AbortController().signal, text => reply.push(text));
    expect(reply.join('')).toBe('The lantern flickers.');
  });

  it('does not accept reasoning alone as a completed reply', async () => {
    stream([{ reasoning: 'Only reasoning, with no reply.' }], '');
    await expect(new OpenAICompatibleProvider().stream(request, '', new AbortController().signal, vi.fn(), vi.fn())).rejects.toMatchObject({ code: 'empty_response' });
  });

  it('ignores encrypted reasoning and signatures', async () => {
    stream([{ reasoning_details: [{ type: 'reasoning.encrypted', data: 'private-data', signature: 'private-signature' }] }]);
    const reasoning = vi.fn();
    await new OpenAICompatibleProvider().stream(request, '', new AbortController().signal, vi.fn(), reasoning);
    expect(reasoning).not.toHaveBeenCalled();
  });

  it.each([{ reasoning: { text: 'invalid' } }, { reasoning_content: ['invalid'] }, { reasoning_details: [{ type: 'reasoning.text', text: 42 }] }])('rejects malformed reasoning fields: %j', async delta => {
    stream([delta]);
    await expect(new OpenAICompatibleProvider().stream(request, '', new AbortController().signal, vi.fn(), vi.fn())).rejects.toThrow();
  });

  it('bounds total reasoning independently of reply length', async () => {
    stream(Array.from({ length: 7 }, () => ({ reasoning: 'x'.repeat(600_000) })));
    await expect(new OpenAICompatibleProvider().stream(request, '', new AbortController().signal, vi.fn(), vi.fn())).rejects.toThrow('Reasoning too large.');
  });
});
