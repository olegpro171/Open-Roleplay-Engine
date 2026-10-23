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
    expect(request.layout?.map(part => [part.kind, part.tokens])).toEqual([['prompt', 1], ['character', 3], ['persona', 1], ['history', 9], ['history', 5]]);
    expect(request.budget.inputTokens).toBe(42);
    expect(request.body.stream_options).toEqual({ include_usage: true });
    expect(assembleRequest({ ...connection, requestUsage: false }, settings, []).body).not.toHaveProperty('stream_options');
  });
  it('rejects request replacement and credential-bearing endpoint URLs', () => {
    expect(connectionSchema.safeParse({ ...connection, customParameters: { messages: [] } }).success).toBe(false);
    expect(connectionSchema.safeParse({ ...connection, customParameters: { api_key: 'secret' } }).success).toBe(false);
    for (const endpoint of ['https://user:secret@example.com/v1', 'https://example.com/v1?key=secret', 'file:///tmp/test']) {
      expect(connectionSchema.safeParse({ ...connection, endpoint }).success).toBe(false);
    }
  });
});
