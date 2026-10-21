import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { newId } from '../src/web/uuid.js';

afterEach(() => vi.unstubAllGlobals());

it('creates valid, distinct command identities when randomUUID is unavailable on HTTP', () => {
  const getRandomValues = crypto.getRandomValues.bind(crypto);
  vi.stubGlobal('crypto', { getRandomValues });
  const ids = Array.from({ length: 100 }, () => newId());
  for (const id of ids) expect(z.uuidv4().safeParse(id).success).toBe(true);
  expect(new Set(ids).size).toBe(ids.length);
});

it('uses the native UUID API when available', () => {
  const id = 'cc405884-fc44-4e1f-9d05-70d64d80e6bd';
  vi.stubGlobal('crypto', { randomUUID: () => id });
  expect(newId()).toBe(id);
});
