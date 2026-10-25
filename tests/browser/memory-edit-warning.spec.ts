import { expect, test } from '@playwright/test';
import type { ChatSnapshot } from '../../src/shared/contracts';
import { defaultContextPreset } from '../../src/shared/context';
import type { LibrarySnapshot } from '../../src/shared/library';

const headers = { Origin: 'http://127.0.0.1:4173' };

for (const width of [1280, 390]) {
  for (const kind of ['characters', 'personas'] as const) {
    for (const operation of ['memory preparation', 'response'] as const) {
      test(`dismisses the ${operation} warning without losing ${kind} edits at ${width}px`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width, height: 844 });
        const session = await page.request.get('/api/session').then(response => response.json());
        await page.goto('/');
        await page.getByLabel('Owner password').fill('browser-synthetic-password');
        await page.getByRole('button', { name: session.setupRequired ? 'Create owner account' : 'Sign in', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Libraries', exact: true })).toBeVisible();

        const libraries = () => page.request.get('/api/library').then(response => response.json() as Promise<LibrarySnapshot>);
        const command = async (path: string, data: unknown, method = 'POST') => {
          const response = await page.request.fetch(`/api${path}`, { method, headers, data });
          expect(response.ok(), await response.text()).toBe(true);
          return response.json();
        };
        const { endpoint } = await page.request.get('/__test/endpoint').then(response => response.json());
        const { id: connectionId } = await command('/library', { revision: (await libraries()).revision, kind: 'connections', data: {
          name: `Warning model ${kind} ${width}`, endpoint, model: 'synthetic-summary', contextWindow: 100_000, maxOutputTokens: 1_000, customParameters: {},
        } });
        const { id: contextPresetId } = await command('/library', { revision: (await libraries()).revision, kind: 'contexts', data: {
          ...defaultContextPreset, name: `Warning memory ${kind} ${width}`, connectionId, minTail: 1, batchSize: 2, summaryTokens: 100,
        } });
        const name = `Warning draft ${operation} ${kind} ${width}`;
        const description = 'Original saved description.';
        const draft = 'Keep these unsaved edits while the operation finishes.';
        const { id: itemId } = await command('/library', { revision: (await libraries()).revision, kind, data: {
          name, description, ...(kind === 'characters' ? { personality: '', scenario: '', first_mes: '', mes_example: '' } : {}),
        } });
        const { id: chatId } = await command('/chats', {
          title: `Warning chat ${kind} ${width}`, connectionId, contextPresetId, targetInputTokens: operation === 'memory preparation' ? 600 : 20_000, promptId: 'default', characterId: null, personaId: null,
        });
        const state = () => page.request.get(`/api/chats/${chatId}`).then(response => response.json() as Promise<ChatSnapshot>);
        await command(`/chats/${chatId}/history`, { revision: (await state()).revision,
          turns: Array.from({ length: 6 }, (_, index) => ({ user: `Turn ${index + 1}. ` + 'Mira carries the silver key. '.repeat(20), assistant: 'Leon waits beside the old tower. '.repeat(20), complete: true })),
        }, 'PUT');

        await page.getByRole('button', { name: 'Libraries', exact: true }).click();
        await page.getByRole('navigation', { name: 'Library categories' }).getByRole('button', { name: kind === 'characters' ? 'Characters' : 'Personas', exact: true }).click();
        await page.getByRole('heading', { name, exact: true }).getByRole('button').click();
        const editor = page.getByRole('textbox', { name: kind === 'characters' ? 'Character description' : 'Persona description', exact: true });
        await editor.fill(draft);

        let operationId: string | null = null;
        const operationStatus = async () => operation === 'memory preparation'
          ? (await state()).context.jobs.find(job => job.id === operationId)?.status
          : (await state()).generations.find(generation => generation.id === operationId)?.status;
        const cancelOperation = () => command(operation === 'memory preparation' ? `/context/jobs/${operationId}/cancel` : `/generations/${operationId}/cancel`, {});
        await page.request.post('/__test/mode', { data: { mode: 'hold-first-token' } });
        try {
          if (operation === 'memory preparation') {
            const started: { jobId: string } = await command(`/chats/${chatId}/context/prepare`, {
              revision: (await state()).revision, requestId: crypto.randomUUID(), mode: 'prepare',
            });
            operationId = started.jobId;
          } else {
            const started: { generationId: string } = await command(`/chats/${chatId}/turns`, {
              revision: (await state()).revision, requestId: crypto.randomUUID(), text: 'Mira opens the door.',
            });
            operationId = started.generationId;
          }
          await expect.poll(operationStatus).toBe('running');

          const rejection = page.waitForResponse(response => response.url().endsWith(`/api/library/${itemId}`) && response.request().method() === 'PUT');
          await page.getByRole('button', { name: 'Save', exact: true }).click();
          expect((await rejection).status()).toBe(409);
          const banner = page.locator('.error-banner').filter({ hasText: 'before editing shared items or this chat.' });
          await expect(banner).toBeVisible();
          await expect(banner.getByRole('button')).toHaveCount(1);
          await expect(banner.locator('span')).toHaveText(operation === 'memory preparation'
            ? 'Wait for memory preparation before editing shared items or this chat.'
            : 'Wait for the current response before editing shared items or this chat.');
          await expect(banner.getByRole('button', { name: 'Dismiss', exact: true })).toBeVisible();
          await expect(editor).toHaveValue(draft);
          expect((await libraries())[kind].find(item => item.id === itemId)?.description).toBe(description);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          await page.screenshot({ path: testInfo.outputPath('memory-edit-warning.png') });

          await banner.getByRole('button', { name: 'Dismiss', exact: true }).click();
          await expect(banner).toHaveCount(0);
          await expect(editor).toHaveValue(draft);
          expect(await operationStatus()).toBe('running');

          await cancelOperation();
          await expect.poll(operationStatus).toBe('cancelled');
          await page.getByRole('button', { name: 'Save', exact: true }).click();
          await expect(editor).toHaveCount(0);
          expect((await libraries())[kind].find(item => item.id === itemId)?.description).toBe(draft);
        } finally {
          if (operationId && await operationStatus() === 'running') {
            await cancelOperation();
          }
          await page.request.post('/__test/finish');
          await page.request.post('/__test/mode', { data: { mode: 'normal' } });
        }
      });
    }
  }
}
