import { expect } from '@playwright/test';
import { test } from './isolated-app';
import type { LibrarySnapshot } from '../../src/shared/library';
import { appearanceStatusSchema } from '../../src/shared/appearance';

for (const theme of ['dark', 'light', 'midnight-black'] as const) {
  test(`character tag menu overlays the list and stays usable while scrolling in ${theme}`, async ({ page, browserApp }, testInfo) => {
    await page.goto('/');
    await page.getByLabel('Owner password').fill('browser-synthetic-password');
    await page.getByRole('button', { name: 'Create owner account', exact: true }).click();
    await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible();
    const headers = { Origin: browserApp.url };
    const appearance = appearanceStatusSchema.parse(await page.request.get('/api/application/appearance').then(response => response.json()));
    const saved = await page.request.put('/api/application/appearance', { headers, data: { revision: appearance.revision, settings: { ...appearance.settings, theme } } });
    expect(saved.ok()).toBe(true);
    const readLibrary = (): Promise<LibrarySnapshot> => page.request.get('/api/library').then(response => response.json());
    for (let index = 0; index < 54; index++) {
      const response = await page.request.post('/api/library/tags', { headers, data: { revision: (await readLibrary()).revision, name: `Layout tag ${String(index).padStart(2, '0')}` } });
      expect(response.ok()).toBe(true);
    }
    const tagIds = (await readLibrary()).tags.map(tag => tag.id);
    for (let index = 0; index < 12; index++) {
      const response = await page.request.post('/api/library', { headers, data: {
        revision: (await readLibrary()).revision, kind: 'characters', tagIds,
        data: { name: `Layout character ${index}`, description: 'A saved character for tag menu layout checks.', personality: '', scenario: '', first_mes: '', mes_example: '' },
      } });
      expect(response.ok()).toBe(true);
    }
    await page.getByRole('button', { name: 'Libraries', exact: true }).click();
    await page.getByRole('button', { name: 'Characters', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(page.getByRole('article')).toHaveCount(12);

    const trigger = page.getByRole('button', { name: /^Tags/ });
    const panel = page.locator('.tag-filter-panel');
    const filter = page.getByRole('group', { name: 'Filter characters by tags', exact: true });
    const next = filter.getByRole('button', { name: 'Next tags', exact: true });
    const previous = filter.getByRole('button', { name: 'Previous tags', exact: true });
    for (const width of [1280, 820, 800, 600, 390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      const scroller = page.locator(width > 800 ? '.library-panel' : 'main.library-layout');
      await scroller.evaluate(element => { element.scrollTop = 0; });
      const search = await page.getByRole('searchbox', { name: 'Search characters', exact: true }).boundingBox();
      const button = await trigger.boundingBox();
      if (!search || !button) throw new Error('Missing search or tag trigger');
      expect(Math.abs(button.y + button.height / 2 - search.y - search.height / 2)).toBeLessThanOrEqual(1);
      expect(search.width).toBeGreaterThan(140);
      const before = await page.locator('.character-list').boundingBox();
      const scrollHeight = await scroller.evaluate(element => element.scrollHeight);
      await trigger.click();
      await expect(filter.getByRole('searchbox', { name: 'Search tags', exact: true })).toHaveAttribute('placeholder', 'Search tags');
      expect((await page.locator('.character-list').boundingBox())?.y).toBe(before?.y);
      expect(await scroller.evaluate(element => element.scrollHeight)).toBe(scrollHeight);
      await expect(previous).toBeDisabled();
      await expect(next).toBeEnabled();
      await panel.evaluate(element => { element.scrollTop = element.scrollHeight; });
      await expect(next).toBeInViewport({ ratio: 1 });
      const fullPage = await panel.boundingBox();
      await next.click();
      await expect(filter.getByRole('checkbox')).toHaveCount(4);
      expect(await panel.boundingBox()).toEqual(fullPage);
      await expect(next).toBeDisabled();
      await expect(previous).toBeEnabled();
      await filter.getByRole('checkbox').first().check();
      await previous.click();
      await expect(filter.getByRole('checkbox')).toHaveCount(50);
      await next.click();
      await expect(filter.getByRole('checkbox').first()).toBeChecked();
      await filter.getByRole('searchbox').fill('Layout tag');
      await expect(filter.getByRole('checkbox')).toHaveCount(50);
      expect(await filter.locator('.tag-options').evaluate(element => element.clientHeight)).toBeGreaterThan(300);
      await filter.getByRole('searchbox').fill('Layout tag 53');
      await expect(filter.getByRole('checkbox')).toHaveCount(1);
      await page.setViewportSize({ width, height: 500 });
      await expect(panel.getByRole('button', { name: 'Manage tags', exact: true })).toBeInViewport({ ratio: 1 });
      expect(await panel.evaluate(element => element.scrollHeight <= element.clientHeight + 1)).toBe(true);
      await page.setViewportSize({ width, height: 844 });
      await page.keyboard.press('Escape');
      await expect(trigger).toBeFocused();
      await expect(panel).toHaveCount(0);
      await page.getByRole('button', { name: /^Remove Layout tag/ }).click();

      if (width > 800) {
        await scroller.evaluate(element => { element.scrollTop = 0; });
        await trigger.click();
        const area = await scroller.boundingBox();
        const popup = await panel.boundingBox();
        if (!area || !popup) throw new Error('Missing scroll owner or tag popup');
        const x = area.x + 24, y = area.y + area.height - 30;
        expect(x).toBeLessThan(popup.x);
        await page.mouse.move(x, y);
        await page.mouse.wheel(0, 420);
        await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBe(420);
        await expect(panel).toBeVisible();
        await expect(trigger).toHaveAttribute('aria-expanded', 'true');

        const options = filter.locator('.tag-options');
        const bounds = await options.boundingBox();
        if (!bounds) throw new Error('Missing scrollable tags');
        const before = await scroller.evaluate(element => element.scrollTop);
        await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
        await page.mouse.wheel(0, 220);
        await expect.poll(() => options.evaluate(element => element.scrollTop)).toBeGreaterThan(100);
        expect(await scroller.evaluate(element => element.scrollTop)).toBe(before);
        await page.mouse.click(5, 5);
        await expect(panel).toHaveCount(0);
      }

      await scroller.evaluate(element => { element.scrollTop = 650; });
      await expect(trigger).toBeInViewport({ ratio: 1 });
      await trigger.click();
      await panel.evaluate(element => { element.scrollTop = element.scrollHeight; });
      await expect(next).toBeInViewport({ ratio: 1 });
      const popup = await panel.boundingBox();
      const list = await page.locator('.character-list').boundingBox();
      if (!popup || !list) throw new Error('Missing tag panel or character list');
      expect(popup.x).toBeGreaterThanOrEqual(0);
      expect(popup.x + popup.width).toBeLessThanOrEqual(width);
      expect(popup.y + popup.height).toBeLessThanOrEqual(844);
      expect(popup.height).toBeGreaterThanOrEqual(Math.min(580, 844 - popup.y - 12));
      expect(await filter.locator('.tag-options').evaluate(element => element.clientHeight)).toBeGreaterThan(300);
      await expect(panel.getByRole('button', { name: 'Manage tags', exact: true })).toBeInViewport({ ratio: 1 });
      expect(popup.y).toBeLessThan(list.y + list.height);
      expect(popup.y + popup.height).toBeGreaterThan(list.y);
      const back = await previous.boundingBox();
      const forward = await next.boundingBox();
      const counter = await filter.getByText('1 / 2', { exact: true }).boundingBox();
      if (!back || !forward || !counter) throw new Error('Missing tag pagination');
      expect(back.width).toBeLessThanOrEqual(44);
      expect(forward.width).toBeLessThanOrEqual(44);
      expect(Math.abs(counter.x + counter.width / 2 - popup.x - popup.width / 2)).toBeLessThanOrEqual(1);
      await page.screenshot({ path: testInfo.outputPath(`${theme}-${width}-tags.png`) });
      await page.keyboard.press('Escape');
      await expect(trigger).toBeFocused();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }

    // A short result list must not constrain the mobile popup to the space
    // beneath its trigger, even when the category navigation is still visible.
    for (const width of [390, 320, 800]) {
      await page.setViewportSize({ width, height: 844 });
      await page.getByRole('searchbox', { name: 'Search characters', exact: true }).fill('Layout character 11');
      await expect(page.getByRole('article')).toHaveCount(1);
      await page.locator('main.library-layout').evaluate(element => { element.scrollTop = 0; });
      await trigger.click();
      const popup = await panel.boundingBox();
      const header = await page.locator('.topbar').boundingBox();
      const button = await trigger.boundingBox();
      if (!popup || !header || !button) throw new Error('Missing mobile popup, header or trigger');
      expect(popup.y).toBeCloseTo(header.y + header.height + 12, 0);
      expect(popup.x + popup.width).toBeCloseTo(width - 12, 0);
      expect(popup.y).toBeLessThan(button.y);
      expect(await panel.evaluate(element => element.scrollHeight <= element.clientHeight + 1)).toBe(true);
      const close = panel.getByRole('button', { name: 'Close tag filters', exact: true });
      await expect(close).toBeInViewport({ ratio: 1 });
      await expect(next).toBeInViewport({ ratio: 1 });
      await page.screenshot({ path: testInfo.outputPath(`${theme}-${width}-short-list.png`) });
      await page.setViewportSize({ width, height: 500 });
      await expect(close).toBeInViewport({ ratio: 1 });
      await expect(next).toBeInViewport({ ratio: 1 });
      await expect(panel.getByRole('button', { name: 'Manage tags', exact: true })).toBeInViewport({ ratio: 1 });
      expect(await panel.evaluate(element => element.scrollHeight <= element.clientHeight + 1)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`${theme}-${width}-short-viewport.png`) });
      await page.setViewportSize({ width, height: 844 });
      await close.click();
      await expect(panel).toHaveCount(0);
      await expect(trigger).toBeFocused();
      await trigger.click();
      await page.keyboard.press('Tab');
      await expect(filter.getByRole('searchbox')).toBeFocused();
      await page.keyboard.press('Shift+Tab');
      await expect(trigger).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(filter.getByRole('searchbox')).toBeFocused();
      await filter.getByRole('searchbox').fill('Layout tag 53');
      await expect(filter.getByRole('checkbox')).toHaveCount(1);
      await page.setViewportSize({ width: 801, height: 844 });
      await expect(filter.getByRole('searchbox')).toHaveValue('Layout tag 53');
      await expect(panel.getByRole('button', { name: 'Close tag filters', exact: true })).toBeHidden();
      await page.setViewportSize({ width, height: 844 });
      await expect(filter.getByRole('searchbox')).toHaveValue('Layout tag 53');
      await page.mouse.click(5, 5);
      await expect(panel).toHaveCount(0);
    }
  });
}
