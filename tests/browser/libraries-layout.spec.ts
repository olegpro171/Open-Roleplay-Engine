import { expect, test, type Page } from '@playwright/test';
import type { LibrarySnapshot } from '../../src/shared/library';

async function login(page: Page) {
  const session = await page.request.get('/api/session').then(response => response.json());
  await page.goto('/');
  await page.getByLabel('Owner password').fill('browser-synthetic-password');
  await page.getByRole('button', { name: session.setupRequired ? 'Create owner account' : 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: 'Libraries', exact: true }).click();
}

async function library(page: Page): Promise<LibrarySnapshot> {
  return page.request.get('/api/library').then(response => response.json());
}

test('keeps vertical library navigation beside a scrolling list and preserves failed editing drafts', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await login(page);
  const categories = page.getByRole('navigation', { name: 'Library categories' });
  const names = ['Chats', 'Personas', 'Characters', 'Lorebooks', 'Prompts', 'Connections', 'Context presets'];
  const actions = ['New chat', 'New persona', 'New character', 'New lorebook', 'New prompt', 'New Connection', 'New context preset'];
  const positions = await categories.getByRole('button').evaluateAll(buttons => buttons.map(button => {
    const { x, y, width, height } = button.getBoundingClientRect();
    return { x, y, width, height };
  }));
  expect(positions).toHaveLength(names.length);
  for (let index = 1; index < positions.length; index++) {
    expect(positions[index].x).toBe(positions[0].x);
    expect(positions[index].y).toBeGreaterThanOrEqual(positions[index - 1].y + positions[index - 1].height);
  }
  for (const [index, name] of names.entries()) {
    const category = categories.getByRole('button', { name, exact: true });
    await category.focus();
    await category.press('Enter');
    await expect(category).toHaveAttribute('aria-pressed', 'true');
    const content = page.getByRole('region', { name, exact: true });
    await expect(content.getByRole('heading', { level: 1, name, exact: true })).toBeVisible();
    await expect(content.getByRole('button', { name: actions[index], exact: true })).toBeVisible();
    await expect(categories.locator('[aria-pressed=true]')).toHaveCount(1);
  }
  await categories.getByRole('button', { name: 'Personas', exact: true }).click();
  await page.getByRole('button', { name: 'New persona', exact: true }).click();
  const content = page.getByRole('region', { name: 'Personas', exact: true });
  await content.getByLabel('Name', { exact: true }).fill('Library layout persona');
  await content.getByLabel('Persona description').fill('A patient observatory keeper.');
  await page.route('**/api/library', route => route.request().method() === 'POST'
    ? route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ message: 'Synthetic library save conflict' }) })
    : route.continue());
  await content.getByRole('button', { name: 'Save persona', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Synthetic library save conflict');
  await expect(content.getByLabel('Name', { exact: true })).toHaveValue('Library layout persona');
  await expect(content.getByLabel('Persona description')).toHaveValue('A patient observatory keeper.');
  expect((await library(page)).personas.some(persona => persona.name === 'Library layout persona')).toBe(false);
  await page.unroute('**/api/library');
  await content.getByRole('button', { name: 'Save persona', exact: true }).click();
  await expect(content.getByRole('heading', { name: 'Library layout persona', exact: true })).toBeVisible();
  expect((await library(page)).personas.find(persona => persona.name === 'Library layout persona')?.description).toBe('A patient observatory keeper.');

  for (let index = 0; index < 12; index++) {
    for (const kind of ['personas', 'characters']) {
      const response = await page.request.post('/api/library', {
        headers: { Origin: 'http://127.0.0.1:4173' },
        data: {
          revision: (await library(page)).revision,
          kind,
          data: {
            name: `Scrolling layout ${kind} ${index}`,
            description: 'A synthetic library entry.',
            ...(kind === 'characters' ? { personality: '', scenario: '', first_mes: '', mes_example: '' } : {}),
          },
        },
      });
      expect(response.ok(), await response.text()).toBe(true);
    }
  }
  await page.reload();
  await page.getByRole('button', { name: 'Libraries', exact: true }).click();
  await categories.getByRole('button', { name: 'Personas', exact: true }).click();
  const panel = await content.boundingBox(), navigation = await categories.boundingBox();
  if (!panel || !navigation) throw new Error('Missing library workspace');
  expect(panel.x).toBeGreaterThanOrEqual(navigation.x + navigation.width);
  expect(panel.width).toBeGreaterThan(navigation.width * 2);
  await page.screenshot({ path: testInfo.outputPath('libraries-desktop.png'), animations: 'disabled' });
  await content.getByRole('article').last().scrollIntoViewIfNeeded();
  await expect(categories.getByRole('button', { name: 'Chats', exact: true })).toBeInViewport();
  await expect(categories.getByRole('button', { name: 'Context presets', exact: true })).toBeInViewport();
  await categories.getByRole('button', { name: 'Characters', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Characters', exact: true }).getByRole('heading', { level: 1, name: 'Characters', exact: true })).toBeInViewport();
  await categories.getByRole('button', { name: 'Chats', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Chats', exact: true }).getByRole('button', { name: 'New chat', exact: true })).toBeVisible();
});

test('keeps every category and the library editors usable on narrow screens', async ({ page }, testInfo) => {
  await login(page);
  const categories = page.getByRole('navigation', { name: 'Library categories' });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    for (const name of ['Chats', 'Personas', 'Characters', 'Lorebooks', 'Prompts', 'Connections', 'Context presets']) {
      await categories.getByRole('button', { name, exact: true }).click();
      await expect(page.getByRole('region', { name, exact: true }).getByRole('heading', { level: 1, name, exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await categories.getByRole('button', { name: 'Personas', exact: true }).click();
    const content = page.getByRole('region', { name: 'Personas', exact: true });
    const panel = await content.boundingBox(), navigation = await categories.boundingBox();
    if (!panel || !navigation) throw new Error('Missing mobile library workspace');
    expect(panel.y).toBeGreaterThanOrEqual(navigation.y + navigation.height);
    await page.screenshot({ path: testInfo.outputPath(`libraries-phone-${width}.png`), animations: 'disabled' });
    await content.getByRole('button', { name: 'New persona', exact: true }).click();
    await content.getByLabel('Name', { exact: true }).fill('Unsaved phone persona');
    await content.getByLabel('Persona description').fill('A recoverable editing draft.');
    await content.getByRole('button', { name: 'Save persona', exact: true }).scrollIntoViewIfNeeded();
    await expect(content.getByRole('button', { name: 'Save persona', exact: true })).toBeInViewport();
    expect(await content.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await content.getByRole('button', { name: 'Close editor', exact: true }).click();
  }
});

test('fits library editors within their forms at desktop and phone widths', async ({ page }, testInfo) => {
  await login(page);
  const categories = page.getByRole('navigation', { name: 'Library categories' });
  for (const width of [1024, 820, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [name, action] of [['Prompts', 'New prompt'], ['Connections', 'New Connection'], ['Context presets', 'New context preset'], ['Characters', 'New character'], ['Lorebooks', 'New lorebook']]) {
      await categories.getByRole('button', { name, exact: true }).click();
      const content = page.getByRole('region', { name, exact: true });
      await content.getByRole('button', { name: action, exact: true }).click();
      await expect(content.getByLabel(name === 'Lorebooks' ? 'Book name' : 'Name', { exact: true })).toBeVisible();
      expect(await content.evaluate(element => element.scrollWidth <= element.clientWidth), `${name} editor at ${width}px`).toBe(true);
      expect(await content.locator('form').evaluate(element => element.scrollWidth <= element.clientWidth), `${name} form at ${width}px`).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`libraries-${name}-${width}.png`), animations: 'disabled' });
      await content.getByRole('button', { name: 'Close editor', exact: true }).click();
    }
  }
});
