import { devices, expect } from '@playwright/test';
import { appearanceStatusSchema } from '../../src/shared/appearance';
import type { ChatSnapshot } from '../../src/shared/contracts';
import { test } from './isolated-app';

const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = devices['iPhone 13'];
for (const input of ['mouse', 'touch'] as const) {
  test.describe(input, () => {
    test.use(input === 'touch'
      ? { viewport: { ...viewport, height: 844 }, userAgent, deviceScaleFactor, isMobile, hasTouch }
      : { viewport: { width: 800, height: 900 } });

    test('dismissing Chat details consumes the first interaction over a turn action', async ({ page, browserApp }, testInfo) => {
      const headers = { Origin: browserApp.url };
      await page.goto('/');
      await page.getByLabel('Owner password').fill('browser-synthetic-password');
      await page.getByRole('button', { name: 'Create owner account', exact: true }).click();
      await expect(page.getByLabel('Your next turn')).toBeVisible();
      const chat: ChatSnapshot = await page.request.get('/api/chat').then(response => response.json());
      const imported = await page.request.put(`/api/__test/transcripts/${chat.id}`, {
        headers, data: { revision: chat.revision, turns: [{
          user: 'A synthetic question.', assistant: 'A line of synthetic dialogue.\n\n'.repeat(60), complete: true,
        }] },
      });
      expect(imported.ok(), await imported.text()).toBe(true);
      await page.reload();

      const toggle = page.getByRole('button', { name: 'Chat details', exact: true });
      const details = page.locator('.chat-details');
      const edit = page.getByRole('button', { name: 'Edit response', exact: true });
      const cancelEdit = page.getByRole('button', { name: 'Cancel edit', exact: true });
      for (const theme of ['dark', 'light', 'midnight-black'] as const) {
        const appearance = appearanceStatusSchema.parse(await page.request.get('/api/application/appearance').then(response => response.json()));
        const saved = await page.request.put('/api/application/appearance', {
          headers, data: { revision: appearance.revision, settings: { ...appearance.settings, theme } },
        });
        expect(saved.ok()).toBe(true);
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        await edit.scrollIntoViewIfNeeded();
        await expect(edit).toBeInViewport();
        const button = await edit.boundingBox();
        if (!button) throw new Error('Missing turn action');
        const x = button.x + button.width / 2, y = button.y + button.height / 2;

        await (input === 'touch' ? toggle.tap() : toggle.click());
        await expect(toggle).toHaveAttribute('aria-expanded', 'true');
        const panel = await details.boundingBox();
        if (!panel) throw new Error('Missing expanded Chat details');
        expect(y).toBeGreaterThan(panel.y + panel.height);
        await page.screenshot({ path: testInfo.outputPath(`${theme}-expanded.png`) });

        const activateAtTurnAction = () => input === 'touch' ? page.touchscreen.tap(x, y) : page.mouse.click(x, y);
        await activateAtTurnAction();
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');
        await expect(cancelEdit).toBeHidden();
        await activateAtTurnAction();
        await expect(page.getByRole('textbox', { name: 'Edit assistant text', exact: true })).toBeVisible();
        await cancelEdit.click();
      }
    });
  });
}
