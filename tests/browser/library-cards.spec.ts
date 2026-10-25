import { expect, test } from '@playwright/test';
import type { LibrarySnapshot } from '../../src/shared/library';
import { openLibraryActions } from './library-card-helpers';

test('multiline library previews occupy at most five lines without changing saved text', async ({ page }) => {
  const session = await page.request.get('/api/session').then(response => response.json());
  await page.goto('/');
  await page.getByLabel('Owner password').fill('browser-synthetic-password');
  await page.getByRole('button', { name: session.setupRequired ? 'Create owner account' : 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Libraries', exact: true })).toBeVisible();
  const description = Array.from({ length: 10 }, () => 'x').join('\n');
  const library: LibrarySnapshot = await page.request.get('/api/library').then(response => response.json());
  const response = await page.request.post('/api/library', {
    headers: { Origin: 'http://127.0.0.1:4173' },
    data: { kind: 'personas', revision: library.revision, data: { name: 'Ten short lines', description } },
  });
  expect(response.ok(), await response.text()).toBe(true);
  await page.getByRole('button', { name: 'Libraries', exact: true }).click();
  await page.getByRole('navigation', { name: 'Library categories' }).getByRole('button', { name: 'Personas', exact: true }).click();
  const card = page.getByRole('article').filter({ hasText: 'Ten short lines' });
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    const metrics = await card.locator('.library-card-description').first().evaluate(element => ({
      height: element.getBoundingClientRect().height,
      lineHeight: Number.parseFloat(getComputedStyle(element.querySelector('p') ?? element).lineHeight),
      contentHeight: element.scrollHeight,
    }));
    expect(metrics.height).toBeLessThanOrEqual(metrics.lineHeight * 5 + 1);
    expect(metrics.contentHeight).toBeGreaterThan(metrics.height);
  }
  const saved: LibrarySnapshot = await page.request.get('/api/library').then(response => response.json());
  expect(saved.personas.find(item => item.name === 'Ten short lines')?.description).toBe(description);
});

test('card surfaces open editors and floating actions flip, dismiss, and retain keyboard access', async ({ page }, testInfo) => {
  const session = await page.request.get('/api/session').then(response => response.json());
  await page.goto('/');
  await page.getByLabel('Owner password').fill('browser-synthetic-password');
  await page.getByRole('button', { name: session.setupRequired ? 'Create owner account' : 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Libraries', exact: true })).toBeVisible();
  for (let index = 0; index < 14; index++) {
    const library: LibrarySnapshot = await page.request.get('/api/library').then(response => response.json());
    const response = await page.request.post('/api/library', {
      headers: { Origin: 'http://127.0.0.1:4173' },
      data: { kind: 'personas', revision: library.revision, data: { name: `Floating actions ${index}`, description: 'A library preview.\n'.repeat(10) } },
    });
    expect(response.ok(), await response.text()).toBe(true);
  }
  await page.getByRole('button', { name: 'Libraries', exact: true }).click();
  await page.getByRole('navigation', { name: 'Library categories' }).getByRole('button', { name: 'Personas', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Personas', exact: true });
  const card = panel.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Floating actions 6', exact: true }) });
  const more = card.getByRole('button', { name: 'Actions for Floating actions 6', exact: true });
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const scroller = width > 800 ? panel : page.locator('main.library-layout');
    await card.scrollIntoViewIfNeeded();
    for (const placement of ['below', 'above']) {
      const header = await panel.locator('header').boundingBox();
      const desired = placement === 'above' ? 820 : (header?.y ?? 0) + (header?.height ?? 0) + 30;
      const rect = await more.boundingBox();
      if (!rect) throw new Error('Missing action trigger');
      await scroller.evaluate((node, delta) => { node.scrollTop += delta; }, rect.y - desired);
      const menu = await openLibraryActions(page, card);
      const anchor = await more.boundingBox();
      const popup = await menu.boundingBox();
      if (!anchor || !popup) throw new Error('Missing menu bounds');
      if (placement === 'above') expect(popup.y + popup.height).toBeLessThan(anchor.y);
      else expect(popup.y).toBeGreaterThan(anchor.y + anchor.height);
      await expect(menu.getByRole('menuitem', { name: 'Duplicate', exact: true })).toBeFocused();
      await page.keyboard.press('ArrowDown');
      await expect(menu.getByRole('menuitem', { name: 'Export', exact: true })).toBeFocused();
      await page.keyboard.press('End');
      await expect(menu.getByRole('menuitem', { name: 'Delete', exact: true })).toBeFocused();
      await page.screenshot({ path: testInfo.outputPath(`menu-${placement}-${width}.png`) });
      await page.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);
      await expect(more).toBeFocused();
    }
    await more.press('Space');
    await expect(page.getByRole('menu')).toBeVisible();
    await scroller.evaluate(node => { node.scrollTop += 20; });
    await expect(page.getByRole('menu')).toHaveCount(0);
    await openLibraryActions(page, card);
    await page.mouse.wheel(0, -30);
    await expect(page.getByRole('menu')).toHaveCount(0);
    await openLibraryActions(page, card);
    await page.getByRole('searchbox', { name: 'Search personas', exact: true }).click();
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(card).toBeVisible();
    // Click actual preview text, including its masked stacking layer.
    const cardBox = await card.boundingBox();
    const previewBox = await card.locator('.library-card-description').boundingBox();
    if (!cardBox || !previewBox) throw new Error('Missing card preview bounds');
    await card.click({ position: { x: previewBox.x - cardBox.x + 4, y: previewBox.y - cardBox.y + 8 } });
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Floating actions 6');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await card.getByRole('heading').getByRole('button').press('Enter');
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Floating actions 6');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  }
});
