import { openLibraryActions } from './library-card-helpers';
import { expect, test, type Locator } from '@playwright/test';
import { defaultPrompt, type LibrarySnapshot } from '../../src/shared/library';
import { defaultContextPreset } from '../../src/shared/context';
import { newLorebook } from '../../src/shared/lorebook';

async function bounds(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('Control has no bounds');
  return box;
}

test('library action menus stack controls consistently across categories and viewport changes', async ({ page }, testInfo) => {
  const session = await page.request.get('/api/session').then(response => response.json());
  await page.goto('/');
  await page.getByLabel('Owner password').fill('browser-synthetic-password');
  await page.getByRole('button', { name: session.setupRequired ? 'Create owner account' : 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Libraries', exact: true })).toBeVisible();
  const fixtures = [
    { kind: 'personas', category: 'Personas', data: { description: 'Long preview. '.repeat(30) } },
    { kind: 'characters', category: 'Characters', data: { description: 'Long preview. '.repeat(30), personality: '', scenario: '', first_mes: '', mes_example: '' } },
    { kind: 'lorebooks', category: 'Lorebooks', data: newLorebook() },
    { kind: 'prompts', category: 'Prompts', data: defaultPrompt },
    { kind: 'connections', category: 'Connections', data: { endpoint: 'http://127.0.0.1:9999/v1', model: 'synthetic-model', contextWindow: 10000, maxOutputTokens: 1000, customParameters: {} } },
    { kind: 'contexts', category: 'Context presets', data: defaultContextPreset },
  ];
  for (const fixture of fixtures) {
    const library: LibrarySnapshot = await page.request.get('/api/library').then(response => response.json());
    const response = await page.request.post('/api/library', {
      headers: { Origin: 'http://127.0.0.1:4173' },
      data: { kind: fixture.kind, revision: library.revision, data: { ...fixture.data, name: `Action layout ${fixture.kind} with a long descriptive title` } },
    });
    expect(response.ok(), await response.text()).toBe(true);
  }
  await page.getByRole('button', { name: 'Libraries', exact: true }).click();
  for (const width of [1280, 1024, 820, 800, 600, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    let creationSlot: { x: number; width: number } | undefined;
    for (const fixture of fixtures) {
      await page.getByRole('navigation', { name: 'Library categories' }).getByRole('button', { name: fixture.category, exact: true }).click();
      const panel = page.getByRole('region', { name: fixture.category, exact: true });
      const toolbar = panel.getByRole('group', { name: 'Library actions', exact: true });
      const create = await bounds(toolbar.getByRole('button').first());
      const importControl = await bounds(toolbar.locator('button, label.file-button').nth(1));
      expect(importControl.y).toBe(create.y);
      expect(Math.abs(importControl.width - create.width)).toBeLessThanOrEqual(1);
      if (creationSlot) {
        expect(create.x).toBe(creationSlot.x);
        expect(create.width).toBe(creationSlot.width);
      }
      creationSlot = { x: create.x, width: create.width };
      const card = panel.getByRole('article').filter({ hasText: `Action layout ${fixture.kind} with` });
      await card.scrollIntoViewIfNeeded();
      const title = await bounds(card.getByRole('heading'));
      const titleLineHeight = await card.getByRole('heading').evaluate(element => Number.parseFloat(getComputedStyle(element).lineHeight));
      expect(title.height).toBeLessThanOrEqual(titleLineHeight * 2 + 1);
      const more = await bounds(card.getByRole('button', { name: /^Actions for / }));
      expect(more.height).toBeGreaterThanOrEqual(44);
      expect(Math.abs(more.y - title.y)).toBeLessThanOrEqual(8);
      const menu = await openLibraryActions(page, card);
      const actions = await Promise.all((await menu.getByRole('menuitem').all()).map(bounds));
      expect(actions).toHaveLength(3);
      for (const [index, box] of actions.entries()) {
        expect(box.height).toBeGreaterThanOrEqual(44);
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
        if (index > 0) {
          expect(box.y).toBeGreaterThanOrEqual(actions[index - 1].y + actions[index - 1].height);
          expect(box.x).toBe(actions[0].x);
          expect(box.width).toBe(actions[0].width);
        }
      }
      await page.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);
      expect(await panel.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
      if (['prompts', 'connections', 'contexts'].includes(fixture.kind)) {
        const bookmark = card.getByRole('button', { name: /^Set .* default/ });
        const bookmarkBox = await bounds(bookmark);
        expect(bookmarkBox.y).toBe(more.y);
      }
      if ([1280, 820, 390, 320].includes(width)) await page.screenshot({ path: testInfo.outputPath(`${fixture.kind}-${width}.png`), animations: 'disabled' });
    }
  }

  // Confirm the relocated bookmark still saves, and card actions remain usable
  // from the keyboard after the sticky header has scrolled into position.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('navigation', { name: 'Library categories' }).getByRole('button', { name: 'Prompts', exact: true }).click();
  const prompt = page.getByRole('article').filter({ hasText: 'Action layout prompts with' });
  const bookmark = prompt.getByRole('button', { name: /^Set .* default/ });
  await bookmark.focus();
  await bookmark.press('Space');
  await expect(prompt.getByRole('button', { name: /^Clear .* default/ })).toHaveAttribute('aria-pressed', 'true');
  const defaults = await page.request.get('/api/application/chat-defaults').then(response => response.json());
  const saved: LibrarySnapshot = await page.request.get('/api/library').then(response => response.json());
  expect(defaults.settings.prompts).toBe(saved.prompts.find(item => item.name.startsWith('Action layout prompts with'))?.id);
  await prompt.getByRole('button', { name: /^Clear .* default/ }).click();
  await expect(prompt.getByRole('heading').getByRole('button')).toBeEnabled();
  await prompt.getByRole('heading').getByRole('button').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Action layout prompts with a long descriptive title');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
});

test('creation controls stay reachable while browsing long lists at desktop and phone sizes', async ({ page }, testInfo) => {
  const session = await page.request.get('/api/session').then(response => response.json());
  await page.goto('/');
  await page.getByLabel('Owner password').fill('browser-synthetic-password');
  await page.getByRole('button', { name: session.setupRequired ? 'Create owner account' : 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Libraries', exact: true })).toBeVisible();
  for (let index = 0; index < 10; index++) {
    const library: LibrarySnapshot = await page.request.get('/api/library').then(response => response.json());
    const response = await page.request.post('/api/library', {
      headers: { Origin: 'http://127.0.0.1:4173' },
      data: { kind: 'personas', revision: library.revision, data: { name: `Pinned controls ${index}`, description: 'A synthetic persona.' } },
    });
    expect(response.ok(), await response.text()).toBe(true);
  }
  await page.getByRole('button', { name: 'Libraries', exact: true }).click();
  await page.getByRole('navigation', { name: 'Library categories' }).getByRole('button', { name: 'Personas', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Personas', exact: true });
  await panel.getByRole('searchbox').fill('Pinned controls');
  for (const width of [1280, 820, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const scroller = width > 800 ? panel : page.locator('main.library-layout');
    await scroller.evaluate(node => { node.scrollTop = node.scrollHeight; });
    const create = panel.getByRole('button', { name: 'New persona', exact: true });
    await expect(create).toBeInViewport();
    const firstPosition = await bounds(create);
    await scroller.evaluate(node => { node.scrollTop -= 80; });
    expect(await bounds(create)).toEqual(firstPosition);
    const edit = panel.getByRole('article').last().getByRole('heading').getByRole('button');
    await edit.focus();
    const control = await bounds(edit);
    const header = await bounds(panel.locator('header'));
    expect(control.y).toBeGreaterThanOrEqual(header.y + header.height);
    await page.screenshot({ path: testInfo.outputPath(`scrolled-${width}.png`), animations: 'disabled' });
    await edit.press('Enter');
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Pinned controls 0');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  }
});
