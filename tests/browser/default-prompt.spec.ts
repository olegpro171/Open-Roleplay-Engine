import { expect } from '@playwright/test';
import { test } from './isolated-app';
import { appearanceStatusSchema, themeSchema } from '../../src/shared/appearance';
import { defaultPrompt, type LibrarySnapshot } from '../../src/shared/library';
import { defaultContinuationInstruction } from '../../src/shared/default-prompt';

for (const theme of themeSchema.options) for (const width of [1440, 390]) {
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
    const main = page.getByRole('tab', { name: 'Main prompt', exact: true });
    const actionTab = page.getByRole('tab', { name: 'Action instructions', exact: true });
    const blocks = page.getByRole('region', { name: /^Prompt block \d+$/ });
    await expect(main).toHaveAttribute('aria-selected', 'true');
    await expect(blocks).toHaveCount(9);
    const continuation = page.getByRole('textbox', { name: 'Continuation instruction' });
    await expect(continuation).toHaveCount(0);
    await expect(page.getByText(/^Enabled blocks and markers compose the base prompt/)).toBeHidden();
    await page.screenshot({ path: testInfo.outputPath('main-prompt.png') });
    await actionTab.click();
    await expect(blocks).toHaveCount(0);
    const instructions = page.getByRole('tabpanel', { name: 'Action instructions', exact: true });
    await expect(instructions.getByText('Built-in instruction', { exact: true })).toHaveCount(2);
    await page.screenshot({ path: testInfo.outputPath('action-instructions.png') });
    await instructions.getByText('Continue', { exact: true }).click();
    await expect(continuation).toHaveValue(defaultContinuationInstruction);
    expect(await continuation.evaluate(field => field.clientHeight >= field.scrollHeight)).toBe(true);
    await continuation.screenshot({ path: testInfo.outputPath('continuation-instruction.png') });
    await main.click();
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

test('keeps edits across prompt tabs and reveals invalid blocks before saving', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Owner password').fill('browser-synthetic-password');
  await page.getByRole('button', { name: 'Create owner account', exact: true }).click();
  await page.getByRole('button', { name: 'Libraries', exact: true }).click();
  await page.getByRole('button', { name: 'Prompts', exact: true }).click();
  await page.getByRole('button', { name: 'New prompt', exact: true }).click();
  const main = page.getByRole('tab', { name: 'Main prompt', exact: true });
  const actionTab = page.getByRole('tab', { name: 'Action instructions', exact: true });
  const instructions = page.getByRole('tabpanel', { name: 'Action instructions', exact: true });
  const block = page.getByRole('region', { name: 'Prompt block 1', exact: true });
  const blockName = block.getByRole('textbox', { name: 'Block name', exact: true });
  const blockText = block.getByRole('textbox', { name: 'Block text', exact: true });
  const save = page.getByRole('button', { name: 'Save', exact: true });
  const name = 'Prompt edited across tabs';
  const text = 'Keep the ferry dialogue brief.';
  const openingText = 'Have {{char}} meet {{user}} at the ferry.';
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
  await page.getByText('How prompt assembly works', { exact: true }).click();
  await expect(page.getByText(/^Enabled blocks and markers compose the base prompt/)).toBeVisible();
  await block.getByRole('button', { name: 'Expand block 1', exact: true }).click();
  await blockText.fill(text);
  await blockName.clear();

  await main.press('ArrowRight');
  await expect(actionTab).toBeFocused();
  await expect(actionTab).toHaveAttribute('aria-selected', 'true');
  await expect(block).toBeHidden();
  await instructions.getByText('Opening scene', { exact: true }).click();
  const opening = instructions.getByRole('textbox', { name: 'Opening scene instruction', exact: true });
  await opening.fill(openingText);
  await expect(instructions.getByText('Custom text', { exact: true })).toBeVisible();
  await save.click();
  await expect(main).toHaveAttribute('aria-selected', 'true');
  await expect(blockName).toBeFocused();
  await expect(blockText).toHaveValue(text);
  await blockName.fill('Ferry dialogue');

  await main.press('End');
  await expect(opening).toHaveValue(openingText);
  await instructions.getByText('Opening scene', { exact: true }).click();
  await expect(opening).toHaveCount(0);
  await instructions.getByText('Opening scene', { exact: true }).click();
  await expect(opening).toHaveValue(openingText);
  await instructions.getByText('Continue', { exact: true }).click();
  await instructions.getByRole('textbox', { name: 'Continuation instruction', exact: true }).clear();
  await expect(instructions.getByText('Built-in instruction', { exact: true })).toBeVisible();
  await save.click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  const library = await page.request.get('/api/library').then(response => response.json() as Promise<LibrarySnapshot>);
  const saved = library.prompts.find(prompt => prompt.name === name);
  expect(saved).toMatchObject({ continuationInstruction: '', openingInstruction: openingText });
  expect(saved?.blocks[0]).toMatchObject({ name: 'Ferry dialogue', text });
});
