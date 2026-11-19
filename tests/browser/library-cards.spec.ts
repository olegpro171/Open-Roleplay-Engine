import { expect, type Locator, type Page } from '@playwright/test';
import type { LibrarySnapshot } from '../../src/shared/library';
import { newLorebook, newLoreEntry } from '../../src/shared/lorebook';
import { test } from './appearance-test';
import { openLibraryActions } from './library-card-helpers';

async function login(page: Page) {
  const session = await page.request.get('/api/session').then(response => response.json());
  await page.goto('/');
  await page.getByLabel('Owner password').fill('browser-synthetic-password');
  await page.getByRole('button', { name: session.setupRequired ? 'Create owner account' : 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Libraries', exact: true })).toBeVisible();
}

test('Persona and Character cards share a preview layout with room for a full-width Persona description', async ({ page }) => {
  await login(page);
  const description = Array.from({ length: 10 }, () => 'x').join('\n');
  for (const [kind, data] of [
    ['characters', { name: 'The guide', description, personality: '', scenario: '', first_mes: '', mes_example: '' }],
    ['personas', { name: 'The guest', description }],
  ] as const) {
    const library: LibrarySnapshot = await page.request.get('/api/library').then(response => response.json());
    const response = await page.request.post('/api/library', {
      headers: { Origin: 'http://127.0.0.1:4173' },
      data: { kind, revision: library.revision, data },
    });
    expect(response.ok(), await response.text()).toBe(true);
  }
  await page.getByRole('button', { name: 'Libraries', exact: true }).click();
  const categories = page.getByRole('navigation', { name: 'Library categories' });
  const card = (name: string) => page.getByRole('article').filter({ has: page.getByRole('heading', { name, exact: true }) });
  const measure = (record: Locator) => record.evaluate(element => {
    const body = element.querySelector('.library-card-body');
    const title = element.querySelector('h2');
    const preview = element.querySelector('.library-card-description');
    const picture = element.querySelector('.picture-square');
    if (!body || !title || !preview) throw new Error('Missing participant preview');
    const bounds = preview.getBoundingClientRect();
    return {
      style: {
        height: element.getBoundingClientRect().height,
        radius: getComputedStyle(element).borderRadius,
        padding: getComputedStyle(body).padding,
        titleSize: getComputedStyle(title).fontSize,
        descriptionLineHeight: getComputedStyle(preview).lineHeight,
        previewHeight: bounds.height,
      },
      width: bounds.width,
      pictureWidth: picture?.getBoundingClientRect().width ?? 0,
      clipped: preview.scrollHeight > preview.clientHeight,
    };
  });
  for (const width of [1280, 875, 874, 801, 800, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await categories.getByRole('button', { name: 'Characters', exact: true }).click();
    const character = await measure(card('The guide'));
    await categories.getByRole('button', { name: 'Personas', exact: true }).click();
    const persona = await measure(card('The guest'));
    expect(persona.style).toEqual(character.style);
    expect(character.pictureWidth).toBeGreaterThan(0);
    expect(persona.pictureWidth).toBe(0);
    expect(persona.width - character.width).toBeGreaterThanOrEqual(character.pictureWidth);
    expect(persona.clipped).toBe(true);
  }
  const saved: LibrarySnapshot = await page.request.get('/api/library').then(response => response.json());
  expect(saved.personas.find(item => item.name === 'The guest')?.description).toBe(description);
});

test('lorebook cards keep counts and actions visible beside clipped descriptions', async ({ page, setAppearance }, testInfo) => {
  await login(page);
  const entry = { ...newLoreEntry('active'), name: 'Harbor bell', content: 'The harbor bell is bronze.', keys: ['bell'] };
  for (const data of [
    { ...newLorebook(), name: 'Card preview notebook', entries: [] },
    { ...newLorebook(), name: 'Card preview registry', entries: [entry] },
    { ...newLorebook(), name: 'Card preview almanac', entries: [entry, { ...entry, id: 'inactive', enabled: false }],
      description: 'The harbor district includes warehouses, guild halls, and the old ferry steps.\n'.repeat(8) },
  ]) {
    const library: LibrarySnapshot = await page.request.get('/api/library').then(response => response.json());
    const response = await page.request.post('/api/library', {
      headers: { Origin: 'http://127.0.0.1:4173' },
      data: { kind: 'lorebooks', revision: library.revision, data },
    });
    expect(response.ok(), await response.text()).toBe(true);
  }
  await page.getByRole('button', { name: 'Libraries', exact: true }).click();
  await page.getByRole('button', { name: 'Lorebooks', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Search lorebooks', exact: true }).fill('Card preview');
  const panel = page.getByRole('region', { name: 'Lorebooks', exact: true });
  const card = (name: string) => panel.getByRole('article').filter({ has: page.getByRole('heading', { name, exact: true }) });
  const almanac = card('Card preview almanac');
  const notebook = card('Card preview notebook');
  const enabled = almanac.getByText('1 of 2 enabled', { exact: true });
  await expect(card('Card preview registry').getByText('1 entry', { exact: true })).toBeVisible();
  await expect(notebook.getByText('0 entries', { exact: true })).toBeVisible();
  for (const theme of ['dark', 'light', 'midnight-black'] as const) {
    await setAppearance({ theme });
    for (const width of [1280, 801, 800, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(enabled).toBeVisible();
      const shortCard = await notebook.boundingBox();
      const more = await notebook.getByRole('button', { name: 'Actions for Card preview notebook', exact: true }).boundingBox();
      const description = await almanac.locator('.library-card-description').boundingBox();
      const count = await enabled.boundingBox();
      if (!shortCard || !more || !description || !count) throw new Error('Missing card content');
      expect(more.height).toBeGreaterThanOrEqual(44);
      expect(more.y).toBeGreaterThan(shortCard.y);
      expect(more.y + more.height).toBeLessThan(shortCard.y + shortCard.height);
      expect(count.y).toBeGreaterThanOrEqual(description.y + description.height);
      if (width === 1280 || width === 390) {
        await page.screenshot({ path: testInfo.outputPath(`lorebook-cards-${theme}-${width}.png`) });
      }
    }
  }
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Language', exact: true }).click();
  await page.getByRole('combobox', { name: 'Interface language', exact: true }).click();
  await page.getByRole('option', { name: 'Русский', exact: true }).click();
  await page.getByRole('button', { name: 'Библиотека', exact: true }).click();
  await expect(page.getByRole('article').filter({ hasText: 'Card preview almanac' })).toContainText('Включено: 1 из 2');
  await expect(page.getByRole('article').filter({ hasText: 'Card preview registry' })).toContainText('1 запись');
  await expect(page.getByRole('article').filter({ hasText: 'Card preview notebook' })).toContainText('0 записей');
});

test('card surfaces open editors and floating actions flip, dismiss, and retain keyboard access', async ({ page }, testInfo) => {
  await login(page);
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
      await expect(more).not.toBeFocused();
    }
    await more.press('Space');
    await expect(page.getByRole('menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(more).toBeFocused();
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
    // Clicking the clipped preview text should still open the editor.
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
