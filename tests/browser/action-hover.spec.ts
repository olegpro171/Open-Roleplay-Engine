import { expect, type Locator } from '@playwright/test';
import sharp from 'sharp';
import { test } from './isolated-app';
import { appearanceStatusSchema } from '../../src/shared/appearance';
import type { ChatSnapshot } from '../../src/shared/contracts';

// Sample empty padding, away from the text, icon and rounded border. Screenshots
// include compositing filters, which computed background-color alone cannot catch.
async function fillPixel(button: Locator) {
  const image = sharp(await button.screenshot({ animations: 'disabled', scale: 'css' }));
  const { height } = await image.metadata();
  if (!height) throw new Error('Missing button image height');
  return [...await image.extract({ left: 4, top: Math.floor(height / 2), width: 1, height: 1 }).removeAlpha().raw().toBuffer()];
}

for (const theme of ['light', 'dark', 'midnight-black'] as const) {
  test(`${theme} action hover displays the palette fill and leaves cleanly`, async ({ page, browserApp }, testInfo) => {
    test.setTimeout(60_000);
    const headers = { Origin: browserApp.url };
    await page.goto('/');
    await page.getByLabel('Owner password').fill('browser-synthetic-password');
    await page.getByRole('button', { name: 'Create owner account', exact: true }).click();
    await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible();
    const appearance = appearanceStatusSchema.parse(await page.request.get('/api/application/appearance').then(response => response.json()));
    const saved = await page.request.put('/api/application/appearance', { headers, data: { revision: appearance.revision, settings: { ...appearance.settings, theme } } });
    expect(saved.ok()).toBe(true);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const state: ChatSnapshot = await page.request.get('/api/chat').then(response => response.json());
    const imported = await page.request.put(`/api/chats/${state.id}/history`, {
      headers, data: { revision: state.revision, turns: [{ user: 'A synthetic question.', assistant: 'A synthetic answer.', complete: true }] },
    });
    expect(imported.ok(), await imported.text()).toBe(true);
    await page.reload();
    const paletteFill = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Missing canvas');
      context.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--surface-raised');
      context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
    });
    const checkHover = async (button: Locator, screenshot: string) => {
      await button.scrollIntoViewIfNeeded();
      await page.mouse.move(0, 0);
      const idle = await fillPixel(button);
      await button.hover();
      expect(await fillPixel(button), screenshot).toEqual(paletteFill);
      await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`${screenshot}.png`) });
      await page.mouse.move(0, 0);
      expect(await fillPixel(button), `${screenshot} after leaving`).toEqual(idle);
    };
    for (const width of [1440, 801, 800, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      const edit = page.getByRole('button', { name: 'Edit response', exact: true });
      await checkHover(edit, `turn-${width}`);
      const details = page.getByRole('button', { name: 'Chat details', exact: true });
      if (await details.isVisible()) await details.click();
      await checkHover(page.getByRole('button', { name: 'Chat settings', exact: true }), `details-${width}`);
      await page.getByLabel('Your next turn').click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    // Category navigation and Library actions share the same hover treatment.
    await page.getByRole('button', { name: 'Libraries', exact: true }).click();
    const categories = page.getByRole('navigation', { name: 'Library categories' });
    for (const width of [1440, 801, 800, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await checkHover(categories.getByRole('button', { name: 'Connections', exact: true }), `library-category-${width}`);
      const selected = categories.getByRole('button', { name: 'Chats', exact: true });
      await expect(selected).toHaveAttribute('aria-pressed', 'true');
      const selectedFill = await fillPixel(selected);
      await selected.hover();
      expect(await fillPixel(selected), `selected category at ${width}px`).toEqual(selectedFill);
      await page.mouse.move(0, 0);
    }
    await checkHover(page.getByRole('button', { name: 'Delete chat', exact: true }).first(), 'library-quiet');
    await page.getByRole('button', { name: 'Prompts', exact: true }).click();
    await page.getByRole('heading', { name: 'Default prompt', exact: true }).getByRole('button').click();
    await checkHover(page.getByRole('button', { name: 'Add marker', exact: true }), 'library-secondary');
    await page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Settings', exact: true }).click();
    const settingsCategories = page.getByRole('navigation', { name: 'Settings categories' });
    for (const width of [1440, 801, 800, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await checkHover(settingsCategories.getByRole('button', { name: 'Chat appearance', exact: true }), `settings-category-${width}`);
    }
  });
}
