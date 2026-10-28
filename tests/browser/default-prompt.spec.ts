import { expect } from '@playwright/test';
import { test } from './isolated-app';
import { appearanceStatusSchema } from '../../src/shared/appearance';
import { defaultPrompt, type LibrarySnapshot } from '../../src/shared/library';

for (const theme of ['dark', 'light', 'midnight-black'] as const) for (const width of [1440, 390]) {
  test(`factory prompt copies preserve supplied content in ${theme} at ${width}px`, async ({ page, browserApp }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await page.getByLabel('Owner password').fill('browser-synthetic-password');
    await page.getByRole('button', { name: 'Create owner account', exact: true }).click();
    await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible();
    const appearance = appearanceStatusSchema.parse(await page.request.get('/api/application/appearance').then(response => response.json()));
    const savedTheme = await page.request.put('/api/application/appearance', { headers: { Origin: browserApp.url }, data: { revision: appearance.revision, settings: { ...appearance.settings, theme } } });
    expect(savedTheme.ok(), await savedTheme.text()).toBe(true);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.getByRole('button', { name: 'Libraries', exact: true }).click();
    await page.getByRole('button', { name: 'Prompts', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Default prompt', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'New prompt', exact: true }).click();
    await expect(page.locator('.prompt-block')).toHaveCount(11);
    await page.getByRole('button', { name: 'Expand block 11', exact: true }).click();
    const ending = defaultPrompt.blocks.at(-1);
    if (ending?.kind !== 'text') throw new Error('Missing response instructions.');
    await expect(page.getByRole('textbox', { name: 'Block text', exact: true })).toHaveValue(ending.text);
    await page.getByRole('textbox', { name: 'Block text', exact: true }).scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('factory-prompt-editor.png'), fullPage: true });
    await page.getByLabel('Name', { exact: true }).fill('Independent factory copy');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Independent factory copy', exact: true })).toBeVisible();
    const library = await page.request.get('/api/library').then(response => response.json() as Promise<LibrarySnapshot>);
    expect(library.prompts.find(prompt => prompt.name === 'Independent factory copy')?.blocks).toEqual(defaultPrompt.blocks);
    expect(library.prompts.find(prompt => prompt.id === 'default')).toEqual({ ...defaultPrompt, id: 'default', revision: 0 });
  });
}
