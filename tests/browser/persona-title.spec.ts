import { expect, test, type Page } from '@playwright/test';
import type { LibrarySnapshot } from '../../src/shared/library';

async function library(page: Page): Promise<LibrarySnapshot> {
  return page.request.get('/api/library').then(response => response.json());
}

for (const width of [1440, 390]) {
  test(`distinguishes same-name personas with local titles at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const session = await page.request.get('/api/session').then(response => response.json());
    const { endpoint } = await page.request.get('/__test/endpoint').then(response => response.json());
    await page.goto('/');
    await page.getByLabel('Owner password').fill('browser-synthetic-password');
    await page.getByRole('button', { name: session.setupRequired ? 'Create owner account' : 'Sign in', exact: true }).click();
    await page.getByRole('button', { name: 'Libraries', exact: true }).click();
    const name = `Persona Alex ${width}`;
    const university = `${name} · University version`;
    const medieval = `${name} · Medieval version`;
    const created = await page.request.post('/api/library', {
      headers: { Origin: 'http://127.0.0.1:4173' },
      data: { kind: 'personas', revision: (await library(page)).revision, data: { name, description: 'Another timeline.', titleComment: 'Medieval version' } },
    });
    expect(created.ok(), await created.text()).toBe(true);
    const connection = await page.request.post('/api/library', {
      headers: { Origin: 'http://127.0.0.1:4173' },
      data: { kind: 'connections', revision: (await library(page)).revision, data: { name: `Persona mock ${width}`, endpoint, model: 'mock', contextWindow: 100_000, maxOutputTokens: 100, customParameters: {} } },
    });
    expect(connection.ok(), await connection.text()).toBe(true);
    await page.getByRole('button', { name: 'Personas', exact: true }).click();
    await expect(page.getByRole('heading', { name: medieval, exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'New persona', exact: true }).click();
    await page.getByLabel('Name', { exact: true }).fill(name);
    await page.getByLabel('Title / comment', { exact: true }).fill('University version');
    await page.getByLabel('Persona description').fill('A traveller named {{user}}.');
    const nameBounds = await page.getByLabel('Name', { exact: true }).boundingBox();
    const titleBounds = await page.getByLabel('Title / comment', { exact: true }).boundingBox();
    if (!nameBounds || !titleBounds) throw new Error('Missing persona identity fields');
    if (width > 800) expect(titleBounds.y).toBe(nameBounds.y);
    else expect(titleBounds.y).toBeGreaterThan(nameBounds.y);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.route('**/api/library', route => route.request().method() === 'POST'
      ? route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ message: 'Synthetic save rejection.' }) })
      : route.continue(), { times: 1 });
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Synthetic save rejection.');
    await expect(page.getByLabel('Title / comment', { exact: true })).toHaveValue('University version');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('heading', { name: university, exact: true })).toBeVisible();
    const search = page.getByRole('searchbox', { name: 'Search personas', exact: true });
    await search.fill('UNIVERSITY VERSION');
    await expect(page.getByRole('article')).toHaveCount(1);
    await search.fill(name);
    await expect(page.getByRole('article')).toHaveCount(2);
    await page.getByRole('article').filter({ has: page.getByRole('heading', { name: university, exact: true }) }).getByRole('heading').getByRole('button').click();
    await page.getByLabel('Title / comment', { exact: true }).fill('Unsaved draft');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByRole('heading', { name: university, exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Chats', exact: true }).click();
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    await page.getByRole('combobox', { name: 'Persona', exact: true }).click();
    await expect(page.getByRole('option', { name: university, exact: true })).toBeVisible();
    await expect(page.getByRole('option', { name: medieval, exact: true })).toBeVisible();
    await page.getByRole('option', { name: university, exact: true }).click();
    await page.getByRole('button', { name: 'Create chat', exact: true }).click();
    await expect(page.getByRole('combobox', { name: 'Persona', exact: true })).toContainText(university);
    await page.getByRole('combobox', { name: 'Connection', exact: true }).click();
    await page.getByRole('option', { name: `Persona mock ${width}`, exact: true }).click();
    await page.getByRole('button', { name: 'Save and return', exact: true }).click();
    await page.getByLabel('Your next turn').fill('Hello.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.part.user .part-heading strong')).toHaveText(name);
    await expect(page.getByLabel('Your next turn')).toBeEnabled();
    await page.reload();
    await expect(page.locator('.part.user .part-heading strong')).toHaveText(name);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    await page.getByRole('button', { name: 'Libraries', exact: true }).click();
    await page.getByRole('button', { name: 'Personas', exact: true }).click();
    await page.getByRole('article').filter({ has: page.getByRole('heading', { name: university, exact: true }) }).getByRole('heading').getByRole('button').click();
    await page.getByLabel('Title / comment', { exact: true }).fill('');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Story', exact: true }).click();
    await expect(page.locator('.part.user .part-heading strong')).toHaveText(name);
  });
}
