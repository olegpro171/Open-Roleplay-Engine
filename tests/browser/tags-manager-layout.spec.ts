import { expect } from '@playwright/test';
import { test } from './isolated-app';
import type { LibrarySnapshot } from '../../src/shared/library';
import { appearanceStatusSchema } from '../../src/shared/appearance';

for (const browserName of ['chromium', 'webkit'] as const) {
  test.describe(browserName, () => {
    const engineTest = test.extend({ page: async ({ playwright, baseURL }, use) => {
      const browser = await playwright[browserName].launch();
      try {
        const context = await browser.newContext({ baseURL, hasTouch: true, viewport: { width: 1280, height: 844 } });
        await use(await context.newPage());
      } finally { await browser.close(); }
    } });

    for (const theme of ['dark', 'light', 'midnight-black'] as const) {
      engineTest(`tag manager keeps its size, pagination and safe dismissal in ${theme}`, async ({ page, browserApp }, testInfo) => {
        await page.goto('/');
        await page.getByLabel('Owner password').fill('browser-synthetic-password');
        await page.getByRole('button', { name: 'Create owner account', exact: true }).click();
        await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible();
        const headers = { Origin: browserApp.url };
        const readLibrary = (): Promise<LibrarySnapshot> => page.request.get('/api/library').then(response => response.json());
        const appearance = appearanceStatusSchema.parse(await page.request.get('/api/application/appearance').then(response => response.json()));
        expect((await page.request.put('/api/application/appearance', { headers, data: { revision: appearance.revision, settings: { ...appearance.settings, theme } } })).ok()).toBe(true);
        for (let index = 0; index < 54; index++) {
          expect((await page.request.post('/api/library/tags', { headers, data: { revision: (await readLibrary()).revision, name: `Sweep tag ${String(index).padStart(2, '0')}` } })).ok()).toBe(true);
        }
        await page.getByRole('button', { name: 'Libraries', exact: true }).click();
        await page.getByRole('button', { name: 'Characters', exact: true }).click();
        await page.getByRole('button', { name: /^Tags/ }).click();
        const manage = page.getByRole('button', { name: 'Manage tags', exact: true });
        await manage.focus();
        await manage.press('Enter');
        const manager = page.getByRole('dialog', { name: 'Manage tags', exact: true });
        for (const width of [1280, 601, 600, 390, 320]) {
          await page.setViewportSize({ width, height: 844 });
          const initial = await manager.boundingBox();
          expect(initial?.height).toBeGreaterThanOrEqual(700);
          expect(await manager.locator('.tag-catalog').evaluate(element => element.clientHeight)).toBeGreaterThanOrEqual(280);
          await manager.getByLabel('Search catalog').fill('Sweep tag 53');
          await expect(manager.locator('.tag-catalog-row')).toHaveCount(1);
          expect(await manager.boundingBox()).toEqual(initial);
          await manager.getByLabel('Search catalog').fill('no matching tags');
          await expect(manager.getByText('No tags match your search.')).toBeVisible();
          expect(await manager.boundingBox()).toEqual(initial);
          await manager.getByLabel('Search catalog').fill('');
          const next = manager.getByRole('button', { name: 'Next tags', exact: true });
          await expect(next).toBeInViewport({ ratio: 1 });
          await next.click();
          await expect(manager.locator('.tag-catalog-row')).toHaveCount(4);
          expect(await manager.boundingBox()).toEqual(initial);
          await expect(next).toBeDisabled();
          await manager.getByRole('button', { name: 'Previous tags', exact: true }).click();
          await page.screenshot({ path: testInfo.outputPath(`${theme}-${width}-manager.png`) });
          expect(await manager.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
        }
        // A pending save keeps ownership even when the backdrop is activated.
        let release = () => {};
        const gate = new Promise<void>(resolve => { release = resolve; });
        await page.route('**/api/library/tags', async route => {
          if (route.request().method() !== 'POST') return route.continue();
          await gate;
          await route.continue();
        });
        await manager.getByLabel('New tag name', { exact: true }).fill('A saved tag');
        await manager.getByRole('button', { name: 'Create tag', exact: true }).click();
        try {
          await expect(manager.getByRole('button', { name: 'Close tag manager', exact: true })).toBeDisabled();
          await page.touchscreen.tap(2, 2);
          await expect(manager).toBeVisible();
        } finally { release(); }
        await expect(manager.getByRole('button', { name: 'Rename A saved tag', exact: true })).toBeVisible();
        await page.unroute('**/api/library/tags');
        // Clicking dialog padding or dragging from inside must not dismiss it.
        const bounds = await manager.boundingBox();
        if (!bounds) throw new Error('Missing tag manager');
        await page.mouse.click(bounds.x + 2, bounds.y + 2);
        await expect(manager).toBeVisible();
        await page.mouse.move(bounds.x + 2, bounds.y + 2);
        await page.mouse.down();
        await page.mouse.move(2, 2);
        await page.mouse.up();
        await expect(manager).toBeVisible();
        await page.touchscreen.tap(2, 2);
        await expect(manager).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Manage tags', exact: true })).toBeFocused();

        // The assignment chooser also keeps the short final page from clamping
        // the surrounding editor's scroll position on a phone.
        await page.keyboard.press('Escape');
        await page.getByRole('button', { name: 'New character', exact: true }).click();
        const tags = page.getByRole('group', { name: 'Assign tags', exact: true });
        const next = tags.getByRole('button', { name: 'Next tags', exact: true });
        await next.scrollIntoViewIfNeeded();
        const before = await tags.boundingBox();
        const top = await page.locator('main.library-layout').evaluate(element => element.scrollTop);
        await next.click();
        await expect(tags.getByRole('checkbox')).toHaveCount(5);
        expect((await tags.boundingBox())?.height).toBe(before?.height);
        expect(await page.locator('main.library-layout').evaluate(element => element.scrollTop)).toBe(top);
      });
    }

    engineTest('keeps an empty catalog tall while fitting short viewports', async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 844 });
      await page.goto('/');
      await page.getByLabel('Owner password').fill('browser-synthetic-password');
      await page.getByRole('button', { name: 'Create owner account', exact: true }).click();
      await page.getByRole('button', { name: 'Libraries', exact: true }).click();
      await page.getByRole('button', { name: 'Characters', exact: true }).click();
      await page.getByRole('button', { name: /^Tags/ }).click();
      await page.getByRole('button', { name: 'Manage tags', exact: true }).click();
      const manager = page.getByRole('dialog', { name: 'Manage tags', exact: true });
      await expect(manager.getByText('No tags yet. Create your first tag above.')).toBeVisible();
      expect((await manager.boundingBox())?.height).toBeGreaterThanOrEqual(700);
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 400 });
        const bounds = await manager.boundingBox();
        if (!bounds) throw new Error('Missing tag manager');
        expect(bounds.y).toBeGreaterThanOrEqual(0);
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(400);
        await manager.locator('footer').scrollIntoViewIfNeeded();
        await expect(manager.locator('footer>span')).toBeInViewport({ ratio: 1 });
      }
    });
  });
}
