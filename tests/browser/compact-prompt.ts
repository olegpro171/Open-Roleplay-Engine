import { expect, type Page } from '@playwright/test';
import { z } from 'zod';
import type { LibrarySnapshot } from '../../src/shared/library';
import { compactPrompt } from '../support/compact-prompt';

// Give budget scenarios their own preset without changing the factory prompt
// used by other workflows on the shared browser-test server.
export async function createCompactPrompt(page: Page): Promise<string> {
  const library: LibrarySnapshot = await page.request.get('/api/library').then(response => response.json());
  const response = await page.request.post('/api/library', {
    headers: { Origin: new URL(page.url()).origin },
    data: { revision: library.revision, kind: 'prompts', data: { ...compactPrompt, name: 'Synthetic compact prompt' } },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return z.object({ id: z.string() }).parse(await response.json()).id;
}
