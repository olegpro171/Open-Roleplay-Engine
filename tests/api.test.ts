import { afterEach, expect, it, vi } from 'vitest';
import { api, ApiError, NetworkError } from '../src/web/api';

afterEach(() => vi.unstubAllGlobals());

it.each(['Load failed', 'Failed to fetch'])('localizes browser network failures while retaining their cause: %s', async text => {
  const cause = new TypeError(text);
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(cause));
  const error = await api('/application/appearance').catch((error: unknown) => error);
  expect(error).toBeInstanceOf(NetworkError);
  expect(error).not.toBeInstanceOf(ApiError);
  expect(error).toMatchObject({ localized: { key: 'errors.network_request_failed' }, cause });
});

it('preserves cancellation as a distinct outcome', async () => {
  const cause = new DOMException('Request aborted', 'AbortError');
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(cause));
  await expect(api('/application/appearance')).rejects.toBe(cause);
});
