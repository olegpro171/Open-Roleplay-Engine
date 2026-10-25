import { summaryRetrySchema } from '../src/shared/context.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateSummary } from '../src/core/summary-validation.js';
import { assembleRequest } from '../src/core/prompt.js';
import { OpenAICompatibleProvider, type Provider } from '../src/provider/openai.js';
import { generateSummary } from '../src/server/summarizer.js';

describe('summary output validation', () => {
  it.each(['', ' \n\t ', '\u200B\uFEFF', '...', '---', '🕯'])('rejects empty or non-text output: %j', (text) => {
    expect(validateSummary(text, 'stop')).toMatchObject({ accepted: false, code: 'empty_summary' });
  });

  it.each([
    'placeholder', 'PLACEHOLDER.', '[placeholder]', 'This is a placeholder.', 'placeholder summary',
    'Summary: placeholder', 'Here is the summary: placeholder', '<summary>placeholder</summary>',
    '```text\nplaceholder\n```', '{{summary}}', '[Insert summary here]', '<summary goes here>',
    'TBD', 'N/A', 'null', 'undefined', 'Lorem ipsum dolor sit amet.', 'place\u200Bholder',
  ])('rejects placeholder-only output: %j', (text) => {
    expect(validateSummary(text, 'stop')).toMatchObject({ accepted: false, code: 'placeholder_summary' });
  });

  it.each([
    "I can't help with this",
    "I can't help with this. Please ask about something else.",
    'I can’t help with that content.',
    'I cannot assist with this.',
    'I can not help you with that.',
    'I won’t assist you with this material.',
    'I will not help with that.',
    'I am unable to help with this.',
    'I’m unable to assist you with that.',
    'Sorry, but I can’t help with this.',
    'Unfortunately, I cannot help with that.',
    'I CANNOT HELP WITH THIS REQUEST.',
    "I'm sorry, but I can't help with this request.",
    "I can't continue with this task.",
    'I can’t continue with this task. Please try something else.',
    'Sorry, but I cannot continue with this request.',
    'I cannot summarize this content.',
    'I’m unable to summarize this passage.',
    'Unfortunately, I cannot comply with this request.',
    'Sorry! I am unable to provide a summary of this material.',
    'As an AI language model, I cannot assist with that.',
    'Your request violates our content policy.',
    'Извините, но я не могу выполнить этот запрос.',
  ])('rejects obvious model refusals: %j', (text) => {
    expect(validateSummary(text, 'stop')).toMatchObject({ accepted: false, code: 'refused_summary' });
  });

  it('rejects repetition loops and unfinished output', () => {
    expect(validateSummary('Leon takes the key. '.repeat(12), 'stop')).toMatchObject({ accepted: false, code: 'repetitive_summary' });
    expect(validateSummary('Leon takes the key', 'length')).toMatchObject({ accepted: false, code: 'incomplete_summary' });
  });

  it.each([
    'Leon leaves.',
    'The placeholder on the map marks the hidden cellar.',
    'Mira refuses to help Leon; he leaves without her key.',
    'Mira says, “I cannot help with this request.” Leon accepts her refusal.',
    '“I cannot summarize this content,” the broken automaton repeats.',
    'I cannot open the gate; Mira brings the key.',
    'I cannot help with thatching the roof; Mira works alone.',
    'Leon reads the note: I can’t help with this.',
    '“I can’t help with this,” Mira says, leaving Leon alone.',
    '“I can’t continue with this task,” Mira says before leaving.',
    'Mira and Leon find a note labeled TODO inside the cellar.',
    'Summary: Mira entrusts Leon with her only key after he promises to avoid the cellar.',
    '{"events":["Leon leaves"],"location":"cellar"}',
  ])('accepts legitimate short summaries and story references: %j', (text) => {
    expect(validateSummary(`\n${text}\n`, 'stop')).toEqual({ accepted: true, text });
  });
});

const request = assembleRequest(
  { name: 'Summary test', endpoint: 'https://example.invalid/v1', model: 'synthetic', contextWindow: 10_000, maxOutputTokens: 100, customParameters: {} },
  { title: 'Synthetic', instructions: 'Summarize the supplied passage.', character: '', persona: '', targetInputTokens: 5_000 },
  [],
);

function mockStream(text: string, finishReason = 'stop', refusal?: string) {
  const event = (delta: object, reason: string | null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;
  const stream = event({ content: text.slice(0, 5) }, null)
    + event({ content: text.slice(5), ...(refusal ? { refusal } : {}) }, null)
    + event({}, finishReason) + 'data: [DONE]\n\n';
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }));
}

afterEach(() => vi.restoreAllMocks());

describe('summarization request gate', () => {
  it('reports observed phases once and never returns to reasoning after reply text', async () => {
    const phases: string[] = [];
    const provider: Provider = { async stream(_request, _key, _signal, text, reasoning) {
      reasoning?.('Thinking'); reasoning?.('More thought');
      text('Mira kept the key.'); reasoning?.('Late thought'); text(' Leon left.');
      return { finishReason: 'stop' };
    } };
    await expect(generateSummary(provider, request, '', new AbortController().signal, phase => phases.push(phase)))
      .resolves.toBe('Mira kept the key. Leon left.');
    expect(phases).toEqual(['connecting', 'reasoning', 'generating']);
  });

  it('returns a valid summary only after the stream finishes', async () => {
    mockStream('Mira gives Leon the key, trusting his promise to avoid the cellar.');
    await expect(generateSummary(new OpenAICompatibleProvider(), request, '', new AbortController().signal))
      .resolves.toBe('Mira gives Leon the key, trusting his promise to avoid the cellar.');
  });

  it.each([
    ['placeholder', 'stop', 'placeholder_summary'],
    ['I cannot summarize this content.', 'stop', 'refused_summary'],
    ["I can't help with this. Please try a different request.", 'stop', 'refused_summary'],
    ['', 'stop', 'empty_summary'],
    [' \n ', 'stop', 'empty_summary'],
    ['Leon takes the key. '.repeat(10), 'stop', 'repetitive_summary'],
    ['Mira gives Leon the key, but', 'length', 'incomplete_summary'],
  ])('rejects %j without returning replacement text', async (text, finishReason, code) => {
    mockStream(text, finishReason);
    await expect(generateSummary(new OpenAICompatibleProvider(), request, 'test-secret', new AbortController().signal))
      .rejects.toMatchObject({ code, localized: { key: expect.any(String), fallback: expect.any(String) } });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it.each(['stop', 'content_filter'])('rejects explicit refusal metadata or filtering: %s', async (finishReason) => {
    mockStream('Partial text', finishReason, finishReason === 'stop' ? 'upstream-private-refusal-text' : undefined);
    await expect(generateSummary(new OpenAICompatibleProvider(), request, 'test-secret', new AbortController().signal))
      .rejects.toMatchObject({ code: 'provider_refusal', message: 'The model refused or filtered the request. No completed response was accepted.' });
  });

  it('does not accept a summary from a provider without completion metadata', async () => {
    const provider: Provider = { async stream(_request, _key, _signal, onText) { onText('Leon leaves.'); } };
    await expect(generateSummary(provider, request, '', new AbortController().signal)).rejects.toMatchObject({ code: 'incomplete_summary' });
  });

  it('rejects a broken stream even when partial output looks valid', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('data: {"choices":[{"index":0,"delta":{"content":"Leon leaves."},"finish_reason":null}]}\n\n', { headers: { 'Content-Type': 'text/event-stream' } }));
    await expect(generateSummary(new OpenAICompatibleProvider(), request, '', new AbortController().signal))
      .rejects.toMatchObject({ code: 'incomplete_summary' });
  });

  it('does not expose raw transport errors or retry silently', async () => {
    const provider: Provider = { stream: vi.fn().mockRejectedValue(new Error('upstream-private-key-and-body')) };
    await expect(generateSummary(provider, request, '', new AbortController().signal))
      .rejects.toMatchObject({ code: 'summary_request_failed', message: 'The summary request failed or timed out. Its source context must remain selected.' });
    expect(provider.stream).toHaveBeenCalledTimes(1);
  });

  it('does not start a cancelled request', async () => {
    const controller = new AbortController();
    controller.abort();
    const provider: Provider = { stream: vi.fn() };
    await expect(generateSummary(provider, request, '', controller.signal)).rejects.toMatchObject({ code: 'summary_cancelled' });
    expect(provider.stream).not.toHaveBeenCalled();
  });

  it('rejects late output after cancellation', async () => {
    const controller = new AbortController();
    const provider: Provider = { async stream(_request, _key, _signal, onText) {
      onText('Leon leaves.');
      controller.abort();
      return { finishReason: 'stop' };
    } };
    await expect(generateSummary(provider, request, '', controller.signal)).rejects.toMatchObject({ code: 'summary_cancelled' });
  });
});


describe('summary retry policy boundary', () => {
  it.each([-1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, '10', null])('rejects invalid retry counts: %j', maxRetries => {
    expect(summaryRetrySchema.safeParse({ maxRetries }).success).toBe(false);
  });
  it.each([0, 1, 10])('accepts whole retry counts including unlimited: %j', maxRetries => {
    expect(summaryRetrySchema.parse({ maxRetries })).toEqual({ maxRetries });
  });
});
