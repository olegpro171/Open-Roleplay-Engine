import { describe, expect, it } from 'vitest';
import { assembleRequest, estimateInputTokens } from '../src/core/prompt.js';
import { connectionSchema, type ChatSettings, type Connection, type Turn } from '../src/shared/contracts.js';

const connection: Connection = { name: 'Test', endpoint: 'http://localhost:1234/v1/', model: 'synthetic', contextWindow: 10_000, maxOutputTokens: 100, customParameters: { temperature: 0.7 } };
const settings: ChatSettings = { title: 'Test', instructions: 'Instructions', character: '{{literal}}', persona: 'Persona', targetInputTokens: 5000 };
const turn: Turn = { id: 'turn', position: 1, complete: true, user: { id: 'user', revision: 2, text: '' }, assistant: { id: 'assistant', revision: 3, text: '' } };

describe('request assembly', () => {
  it.each(['xhigh', 'max'])('preserves supported reasoning effort %s in the outgoing body', effort => {
    const configured = connectionSchema.parse({ ...connection, customParameters: { reasoning_effort: effort } });
    expect(assembleRequest(configured, settings, []).body.reasoning_effort).toBe(effort);
    expect(connectionSchema.safeParse({ ...connection, customParameters: { reasoning_effort: 'unrecognized' } }).success).toBe(false);
  });
  it('omits blank parts while retaining turn coverage and literal prompt text', () => {
    const request = assembleRequest(connection, settings, [turn]);
    expect(request.body.messages).toEqual(['Instructions', '{{literal}}', 'Persona'].map((content) => ({ role: 'system', content })));
    expect(request.coverage).toEqual([{ turnId: 'turn', userRevision: 2, assistantRevision: 3, complete: true }]);
    expect(request.endpoint).toBe('http://localhost:1234/v1/chat/completions');
    expect(request.body.temperature).toBe(0.7);
    expect(request.budget.verified).toBe(false);
  });
  it('includes pending user input, never a partial assistant response', () => {
    const request = assembleRequest(connection, settings, [{ ...turn, complete: false, user: { ...turn.user, text: 'Enter the tower.' }, assistant: { ...turn.assistant, text: 'Partial' } }]);
    expect(request.body.messages.at(-1)).toEqual({ role: 'user', content: 'Enter the tower.' });
    expect(JSON.stringify(request.body)).not.toContain('Partial');
  });
  it('enforces the input target independently of the physical window and output reserve', () => {
    const input = estimateInputTokens(assembleRequest(connection, settings, []).body.messages);
    expect(() => assembleRequest(connection, { ...settings, targetInputTokens: input - 1 }, [])).toThrow('exceeds your target');
    expect(() => assembleRequest(connection, { ...settings, targetInputTokens: input }, [])).not.toThrow();
    expect(() => assembleRequest({ ...connection, contextWindow: input + 99 }, settings, [])).toThrow('plus reserved output');
    expect(() => assembleRequest({ ...connection, contextWindow: input + 100 }, settings, [])).not.toThrow();
  });
  it('attributes resolved content without changing its order or budget, including escaped multibyte text', () => {
    const request = assembleRequest(connection, settings, [{ ...turn, user: { ...turn.user, text: 'A "key"\\\\\n🕯' }, assistant: { ...turn.assistant, text: 'Лампа.' } }]);
    expect(request.layout?.map(part => part.messageIndex)).toEqual(request.body.messages.map((_, i) => i));
    expect(request.layout?.map(part => [part.kind, part.tokens])).toEqual([['prompt', 1], ['character', 3], ['persona', 1], ['history', 9], ['history', 4]]);
    expect(request.budget.inputTokens).toBe(41);
    expect(request.body.stream_options).toEqual({ include_usage: true });
    expect(assembleRequest({ ...connection, requestUsage: false }, settings, []).body).not.toHaveProperty('stream_options');
  });
  it('forwards typed built-ins alongside scalar and nested provider-specific JSON', () => {
    const configured = connectionSchema.parse({ ...connection, requestUsage: false, customParameters: {
      temperature: 0, top_k: 50, min_p: 0.05, template: { thinking: false, options: ['literal', null, { count: 2 }] },
    } });
    expect(assembleRequest(configured, settings, []).body).toEqual({
      temperature: 0, top_k: 50, min_p: 0.05, template: { thinking: false, options: ['literal', null, { count: 2 }] },
      model: 'synthetic', messages: ['Instructions', '{{literal}}', 'Persona'].map(content => ({ role: 'system', content })),
      stream: true, max_tokens: 100,
    });
  });
  it.each([
    { max_completion_tokens: 200 }, { max_new_tokens: 200 }, { stream_options: { include_usage: true } },
    { n: 2 }, { tools: [] }, { temperature: '0.7' }, { top_p: 1.1 }, { seed: 0.5 }, [], null, new Map(),
    JSON.parse('{"extra":1e400}'),
    { nested: [{ apiKey: 'synthetic-secret' }] }, JSON.parse('{"nested":{"__proto__":{"polluted":true}}}'),
    { extra: '🕯'.repeat(17_000) }, JSON.parse('{"extra":' + '['.repeat(33) + '0' + ']'.repeat(33) + '}'),
  ].map(customParameters => ({ customParameters })))('validates the shape and limits of a parameter map (case %#)', ({ customParameters }) => {
    expect(connectionSchema.safeParse({ ...connection, requestUsage: false, customParameters }).success).toBe(false);
  });
  it('rejects request replacement and credential-bearing endpoint URLs', () => {
    expect(connectionSchema.safeParse({ ...connection, customParameters: { messages: [] } }).success).toBe(false);
    expect(connectionSchema.safeParse({ ...connection, customParameters: { api_key: 'secret' } }).success).toBe(false);
    for (const endpoint of ['https://user:secret@example.com/v1', 'https://example.com/v1?key=secret', 'file:///tmp/test']) {
      expect(connectionSchema.safeParse({ ...connection, endpoint }).success).toBe(false);
    }
  });
});
