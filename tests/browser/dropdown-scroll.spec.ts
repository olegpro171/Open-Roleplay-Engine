import { expect } from '@playwright/test';
import { test } from './isolated-app';
import { appearanceStatusSchema } from '../../src/shared/appearance';
import type { LibrarySnapshot } from '../../src/shared/library';

for (const width of [1280, 390]) {
  test.describe(`dropdown scrolling at ${width}px`, () => {
    test.use({ viewport: { width, height: 700 }, hasTouch: width === 390 });

    for (const theme of ['dark', 'light', 'midnight-black'] as const) {
      test(`${theme} opens a wrapped marker list without scrolling its editor`, async ({ page, browserApp }, testInfo) => {
        await page.goto('/');
        await page.getByLabel('Owner password').fill('browser-synthetic-password');
        await page.getByRole('button', { name: 'Create owner account', exact: true }).click();
        await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible();
        const appearance = appearanceStatusSchema.parse(await page.request.get('/api/application/appearance').then(response => response.json()));
        const saved = await page.request.put('/api/application/appearance', {
          headers: { Origin: browserApp.url }, data: { revision: appearance.revision, settings: { ...appearance.settings, theme } },
        });
        expect(saved.ok()).toBe(true);
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        await page.getByRole('button', { name: 'Libraries', exact: true }).click();
        await page.getByRole('button', { name: 'Prompts', exact: true }).click();
        await page.getByRole('button', { name: 'New prompt', exact: true }).click();
        await page.getByLabel('Name', { exact: true }).fill('Keep this prompt draft');
        await page.getByRole('button', { name: 'Add marker', exact: true }).click();
        await page.getByRole('button', { name: 'Expand block 7', exact: true }).click();
        const marker = page.getByRole('combobox', { name: 'Marker source for block 7', exact: true });
        const menu = page.getByRole('listbox', { name: 'Marker source for block 7', exact: true });
        const outerPositions = () => page.evaluate(() => Array.from(document.querySelectorAll('.library-layout, .library-panel')).map(node => node.scrollTop));
        // The click must reveal this below-fold trigger itself. Its queued scroll
        // event can arrive after the menu opens and must not close that menu.
        await marker.click();
        await expect(menu.getByRole('option', { selected: true })).toBeInViewport();
        // Deterministically deliver an already-queued ancestor scroll event:
        // the position is unchanged from opening, so selection must still work.
        for (const scroller of await page.locator('.library-layout, .library-panel').all()) {
          await scroller.dispatchEvent('scroll');
        }
        await page.getByRole('option', { name: 'Card system prompt — card text or fallback', exact: true }).click();
        await expect(marker).toHaveText('Card system prompt — card text or fallback');
        const before = await outerPositions();
        await marker.click();
        await expect(menu.getByRole('option', { selected: true })).toBeInViewport();
        await marker.press('Home');
        await expect(menu.getByRole('option').first()).toBeInViewport();
        await marker.press('End');
        await expect(menu.getByRole('option').last()).toBeInViewport();
        await page.screenshot({ path: testInfo.outputPath('wrapped-marker-open.png') });
        await marker.press('Enter');
        await expect(marker).toHaveText('Card post-history instructions — card text or fallback');
        await expect(menu).toHaveCount(0);
        expect(await outerPositions()).toEqual(before);
        await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Keep this prompt draft');
      });

      test(`${theme} closes on outside scrolling`, async ({ page, browserApp }, testInfo) => {
        await page.goto('/');
        await page.getByLabel('Owner password').fill('browser-synthetic-password');
        await page.getByRole('button', { name: 'Create owner account', exact: true }).click();
        await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible();
        const headers = { Origin: browserApp.url };
        const appearance = appearanceStatusSchema.parse(await page.request.get('/api/application/appearance').then(response => response.json()));
        const saved = await page.request.put('/api/application/appearance', {
          headers, data: { revision: appearance.revision, settings: { ...appearance.settings, theme } },
        });
        expect(saved.ok()).toBe(true);
        for (let index = 0; index < 16; index++) {
          const library: LibrarySnapshot = await page.request.get('/api/library').then(response => response.json());
          const response = await page.request.post('/api/library', { headers, data: {
            kind: 'characters', revision: library.revision,
            data: { name: `Scroll character ${index}`, description: 'Synthetic scrolling fixture.', personality: '', scenario: '', first_mes: '', mes_example: '' },
          } });
          expect(response.ok(), await response.text()).toBe(true);
        }
        await page.reload();
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        await page.getByRole('button', { name: 'Libraries', exact: true }).click();
        await page.getByRole('button', { name: 'Characters', exact: true }).click();
        const sort = page.getByRole('combobox', { name: 'Sort characters', exact: true });
        const sortMenu = page.getByRole('listbox', { name: 'Sort characters', exact: true });
        const originalSort = await sort.textContent();
        await sort.click();
        await expect(sortMenu).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('regular-open.png') });
        // Exercise a real nested scroll without an outside pointer press.
        const scroller = page.locator(width > 800 ? '.library-panel' : '.library-layout');
        await scroller.evaluate(node => { node.scrollTop += 80; });
        await expect.poll(() => scroller.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
        await expect(sortMenu).toHaveCount(0);
        await expect(sort).toHaveText(originalSort ?? '');
        await sort.click();
        await sort.dispatchEvent('wheel', { deltaY: 80 });
        await expect(sortMenu).toHaveCount(0);
        await sort.click();
        await sort.dispatchEvent('touchmove');
        await expect(sortMenu).toHaveCount(0);
        await sort.click();
        await page.getByRole('option', { name: 'Name A–Z', exact: true }).click();
        await expect(sort).toHaveText('Name A–Z');

      });
    }
  });
}
