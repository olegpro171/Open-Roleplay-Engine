import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchModels } from '../src/provider/openai.js';

afterEach(() => vi.unstubAllGlobals());

function mockCatalog(data: unknown[]) {
  const fetch = vi.fn(async () => Response.json({ data }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

describe('Connection model discovery', () => {
  it.each([
    ['https://openrouter.ai/api/v1/', 'https://openrouter.ai/api/v1/models'],
    ['https://proxy.invalid/custom/v1', 'https://proxy.invalid/custom/v1/models'],
  ])('uses the configured catalog and exposes only valid total windows for %s', async (endpoint, url) => {
    const fetch = mockCatalog([
      { id: 'reported', context_length: 32_768, max_output_tokens: 1_024, top_provider: { context_length: 16_384 } },
      { id: 'reported', context_length: null },
      { id: 'conflicting', context_length: 32_000 },
      { id: 'conflicting', context_length: 64_000 },
      { id: 'missing', max_output_tokens: 1_024, top_provider: { context_length: 16_384 } },
      { id: 'text', context_length: '32000' },
      { id: 'fraction', context_length: 4096.5 },
      { id: 'oversize', context_length: 10_000_001 },
      { id: 'zero', context_length: 0 },
    ]);
    expect(await fetchModels(endpoint, 'synthetic-key')).toEqual([
      { id: 'conflicting' }, { id: 'fraction' }, { id: 'missing' }, { id: 'oversize' },
      { id: 'reported', contextWindow: 32_768 }, { id: 'text' }, { id: 'zero' },
    ]);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(url, expect.objectContaining({
      redirect: 'error', headers: { Accept: 'application/json', Authorization: 'Bearer synthetic-key' },
    }));
  });

  it.each([
    'https://api.nano-gpt.com/api/v1',
    'https://nano-gpt.com/api/v1',
    'https://api.nano-gpt.com/api/subscription/v1',
    'https://api.nano-gpt.com/api/paid/v1',
  ])('requests detailed models on the configured NanoGPT catalog %s', async endpoint => {
    const fetch = mockCatalog([
      { id: 'available', context_length: 16_384 },
      { id: 'paused', available: false, context_length: 32_768 },
      { id: 'unknown', context_length: null },
    ]);
    expect(await fetchModels(endpoint, '')).toEqual([{ id: 'available', contextWindow: 16_384 }, { id: 'unknown' }]);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(`${endpoint}/models?detailed=true`, expect.objectContaining({
      redirect: 'error', headers: { Accept: 'application/json' },
    }));
  });

  it.each([
    'https://api.openai.com/v1',
    'https://api.nano-gpt.com.proxy.invalid/api/v1',
    'https://api.nano-gpt.com/custom/v1',
  ])('keeps ordinary ID-only discovery usable on %s', async endpoint => {
    const fetch = mockCatalog([{ id: 'literal-model', object: 'model', created: 123, owned_by: 'synthetic' }]);
    expect(await fetchModels(endpoint, '')).toEqual([{ id: 'literal-model' }]);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(`${endpoint}/models`, expect.anything());
  });
});
