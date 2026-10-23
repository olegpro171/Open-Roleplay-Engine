import { test, expect, type Page } from '@playwright/test';
import type { LibrarySnapshot } from '../../src/shared/library';

async function library(page: Page): Promise<LibrarySnapshot> {
  return page.request.get('/api/library').then(response => response.json());
}
async function choose(page: Page, name: string) {
  await page.getByRole('combobox', { name: 'Character', exact: true }).click();
  await page.getByRole('option', { name, exact: true }).click();
}

for (const width of [1440, 390]) {
  test(`distinguishes same-name characters with local titles through editing and chat selection at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const session = await page.request.get('/api/session').then(response => response.json());
    await page.goto('/');
    await page.getByLabel('Owner password').fill('browser-synthetic-password');
    await page.getByRole('button', { name: session.setupRequired ? 'Create owner account' : 'Sign in', exact: true }).click();
    await page.getByRole('button', { name: 'Libraries', exact: true }).click();
    await page.getByRole('button', { name: 'Characters', exact: true }).click();
    const name = `Title Alice ${width}`;
    const university = `${name} · University version`;
    const medieval = `${name} · Medieval version`;
    const fields = { name, description: '{{char}} at the university.', personality: '', scenario: '', first_mes: 'I am {{char}}.', mes_example: '' };
    const created = await page.request.post('/api/library', {
      headers: { Origin: 'http://127.0.0.1:4173' },
      data: { kind: 'characters', revision: (await library(page)).revision, data: { ...fields, titleComment: 'Medieval version' } },
    });
    expect(created.ok()).toBe(true);
    await expect(page.getByRole('heading', { name: medieval, exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'New character', exact: true }).click();
    await page.getByLabel('Name', { exact: true }).fill(name);
    await page.getByLabel('Title / comment', { exact: true }).fill('University version');
    await page.getByLabel('Character description', { exact: true }).fill(fields.description);
    await page.getByLabel('Greeting', { exact: true }).fill(fields.first_mes);
    await page.getByLabel('Name', { exact: true }).scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('title-editor.png'), fullPage: true });
    await page.route('**/api/library', route => route.request().method() === 'POST'
      ? route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ message: 'Synthetic save rejection.' }) })
      : route.continue());
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Synthetic save rejection.' }).first()).toBeVisible();
    await expect(page.getByLabel('Title / comment', { exact: true })).toHaveValue('University version');
    await page.unroute('**/api/library');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('heading', { name: university, exact: true })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    const search = page.getByRole('searchbox', { name: 'Search characters', exact: true });
    await search.fill('UNIVERSITY VERSION');
    await expect(page.getByRole('article')).toHaveCount(1);
    await expect(page.getByRole('heading', { name: university, exact: true })).toBeVisible();
    await search.fill(name);
    await expect(page.getByRole('article')).toHaveCount(2);
    await page.screenshot({ path: testInfo.outputPath('title-library.png'), fullPage: true });

    await page.getByRole('button', { name: `Edit ${university}`, exact: true }).click();
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue(name);
    await expect(page.getByLabel('Title / comment', { exact: true })).toHaveValue('University version');
    await page.getByLabel('Title / comment', { exact: true }).fill('Unsaved title');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByRole('heading', { name: university, exact: true })).toBeVisible();

    await page.getByRole('button', { name: `Edit ${university}`, exact: true }).click();
    await page.getByLabel('Title / comment', { exact: true }).fill('Local draft');
    const saved = (await library(page)).characters.find(card => card.name === name && card.titleComment === 'University version');
    if (!saved) throw new Error('Missing saved character');
    const { id, revision: _revision, ...data } = saved;
    const changed = await page.request.put(`/api/library/${id}`, {
      headers: { Origin: 'http://127.0.0.1:4173' },
      data: { kind: 'characters', revision: (await library(page)).revision, data: { ...data, titleComment: 'Newer version' } },
    });
    expect(changed.ok()).toBe(true);
    const reconcile = page.getByRole('button', { name: 'Use current text and tags; keep my picture draft', exact: true });
    await expect(reconcile).toBeVisible();
    await expect(page.getByLabel('Title / comment', { exact: true })).toHaveValue('Local draft');
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    await reconcile.click();
    await expect(page.getByLabel('Title / comment', { exact: true })).toHaveValue('Newer version');
    await page.getByLabel('Title / comment', { exact: true }).fill('University version');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('heading', { name: university, exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Chats', exact: true }).click();
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    await page.getByRole('combobox', { name: 'Character', exact: true }).click();
    await expect(page.getByRole('option', { name: university, exact: true })).toBeVisible();
    await expect(page.getByRole('option', { name: medieval, exact: true })).toBeVisible();
    await page.getByRole('option', { name: university, exact: true }).click();
    await page.getByRole('button', { name: 'Create chat', exact: true }).click();
    await expect(page.getByLabel('Chat title')).toHaveValue(`${university} - Roleplay`);
    await expect(page.getByRole('combobox', { name: 'Character', exact: true })).toContainText(university);
    await choose(page, medieval);
    await expect(page.getByRole('combobox', { name: 'Character', exact: true })).toContainText(medieval);
    await choose(page, university);
    await page.getByRole('button', { name: 'Save and return', exact: true }).click();
    await page.getByRole('button', { name: 'Story', exact: true }).click();
    await expect(page.locator('.part.assistant .part-heading strong')).toHaveText(name);
    await expect(page.locator('.part.assistant .prose')).toHaveText(`I am ${name}.`);
    await page.reload();
    await expect(page.locator('.part.assistant .part-heading strong')).toHaveText(name);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('title-story.png'), fullPage: true });

    // Clearing only the metadata leaves Story names and the copied greeting unchanged.
    await page.getByRole('button', { name: 'Libraries', exact: true }).click();
    await page.getByRole('button', { name: 'Characters', exact: true }).click();
    await page.getByRole('button', { name: `Edit ${university}`, exact: true }).click();
    await page.getByLabel('Title / comment', { exact: true }).fill('');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Story', exact: true }).click();
    await expect(page.locator('.part.assistant .part-heading strong')).toHaveText(name);
    await expect(page.locator('.part.assistant .prose')).toHaveText(`I am ${name}.`);
  });
}
