import { expect } from '@playwright/test';
import { test } from './isolated-app';
import { appearanceStatusSchema } from '../../src/shared/appearance';
import { defaultPrompt, type LibrarySnapshot } from '../../src/shared/library';

for (const theme of ['dark', 'light', 'midnight-black'] as const) for (const width of [1440, 390]) {
  test(`new prompts start with blank instructions in ${theme} at ${width}px`, async ({ page, browserApp }, testInfo) => {
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
    const blocks = page.getByRole('region', { name: /^Prompt block \d+$/ });
    await expect(blocks).toHaveCount(9);
    const checkInstructions = async () => {
      for (const [position, name] of [[1, 'Pre-history instructions'], [9, 'Post-history instructions']] as const) {
        const block = blocks.nth(position - 1);
        await expect(block.getByLabel('Block name', { exact: true })).toHaveValue(name);
        await block.getByRole('button', { name: `Expand block ${position}`, exact: true }).click();
        await expect(block.getByRole('textbox', { name: 'Block text', exact: true })).toHaveValue('');
      }
    };
    await checkInstructions();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    for (const [position, name] of [[1, 'pre'], [9, 'post']] as const) {
      await blocks.nth(position - 1).screenshot({ path: testInfo.outputPath(`${name}-history-block.png`) });
    }
    await page.getByLabel('Name', { exact: true }).fill('Blank starter prompt');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    const saved = page.getByRole('heading', { name: 'Blank starter prompt', exact: true });
    await expect(saved).toBeVisible();
    const library = await page.request.get('/api/library').then(response => response.json() as Promise<LibrarySnapshot>);
    expect(library.prompts.find(prompt => prompt.name === 'Blank starter prompt')?.blocks).toEqual([
      expect.objectContaining({ name: 'Pre-history instructions', kind: 'text', text: '', role: 'system', enabled: true }),
      ...defaultPrompt.blocks.filter(block => block.kind === 'marker'),
      expect.objectContaining({ name: 'Post-history instructions', kind: 'text', text: '', role: 'system', enabled: true }),
    ]);
    expect(library.prompts.find(prompt => prompt.id === 'default')).toEqual({ ...defaultPrompt, id: 'default', revision: 0 });
    await saved.getByRole('button', { name: 'Blank starter prompt', exact: true }).click();
    await checkInstructions();
  });
}
