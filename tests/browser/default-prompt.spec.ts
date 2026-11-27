import { selectLibraryCategory } from './library-card-helpers';
import { expect } from '@playwright/test';
import { test } from './isolated-app';
import { appearanceStatusSchema, themeSchema } from '../../src/shared/appearance';
import { defaultPrompt, markerLabel, type LibrarySnapshot } from '../../src/shared/library';
import { defaultContinuationInstruction } from '../../src/shared/default-prompt';

test.describe('touch prompt reordering', () => {
  const viewport = { width: 390, height: 720 };
  test.use({ viewport, isMobile: true, hasTouch: true });

  test('drags immediately, discards a cancelled drag, and saves the dropped order', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Owner password').fill('browser-synthetic-password');
    await page.getByRole('button', { name: 'Create owner account', exact: true }).click();
    await page.getByRole('button', { name: 'Libraries', exact: true }).click();
    await selectLibraryCategory(page, 'Prompts');
    await page.getByRole('button', { name: 'New prompt', exact: true }).click();
    const first = page.getByRole('region', { name: 'Prompt block 1', exact: true });
    const second = page.getByRole('region', { name: 'Prompt block 2', exact: true });
    const handle = first.getByLabel('Drag block 1', { exact: true });
    const original = first.getByRole('button', { name: 'Pre-history instructions Expand block 1', exact: true });
    await first.evaluate(row => row.scrollIntoView({ block: 'center' }));
    const grip = await handle.boundingBox();
    const icon = await handle.locator('svg').boundingBox();
    const checkbox = await first.getByRole('checkbox').boundingBox();
    const target = await second.boundingBox();
    if (!grip || !icon || !checkbox || !target) throw new Error('Prompt row controls are missing');
    expect(grip.width).toBeCloseTo(48);
    expect(grip.height).toBeCloseTo(48);
    expect(icon.width).toBeCloseTo(24);
    expect(icon.height).toBeCloseTo(24);
    expect(icon.y + icon.height / 2).toBeCloseTo(checkbox.y + checkbox.height / 2, 0);
    const x = grip.x + grip.width - 4;
    const y = grip.y + grip.height / 2;
    const destination = target.y + target.height * .75;
    const client = await page.context().newCDPSession(page);
    const start = (x: number, y: number) => client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    const move = (x: number, y: number) => client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
    await start(x, y);
    await move(x, destination);
    await expect(first).toHaveClass(/dragging/);
    await client.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    await expect(first).not.toHaveClass(/dragging/);
    await expect(original).toBeVisible();
    await handle.tap();
    await expect(original).toBeVisible();

    await start(x, y);
    await move(x, destination);
    await move(viewport.width - 8, destination);
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(first).not.toHaveClass(/dragging/);
    await expect(original).toBeVisible();

    const scroller = page.locator('main.library-layout');
    const scrollTop = await scroller.evaluate(node => node.scrollTop);
    await start(x, y);
    await move(x, viewport.height - 24);
    await expect.poll(() => scroller.evaluate(node => node.scrollTop)).toBeGreaterThan(scrollTop);
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(first.getByRole('button', { name: 'Card system prompt Expand block 1', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Pre-history instructions Expand block [2-9]$/ })).toBeVisible();
    await client.detach();

    await page.getByLabel('Name', { exact: true }).fill('Touch reordered prompt');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Touch reordered prompt' })).toBeVisible();
    const library = await page.request.get('/api/library').then(response => response.json() as Promise<LibrarySnapshot>);
    const saved = library.prompts.find(prompt => prompt.name === 'Touch reordered prompt');
    expect(saved?.blocks[0].name).toBe('Card system prompt');
    expect(saved?.blocks.filter(block => block.name === 'Pre-history instructions')).toHaveLength(1);
  });
});

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
    await selectLibraryCategory(page, 'Prompts');
    await expect(page.getByRole('heading', { name: defaultPrompt.name, exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'New prompt', exact: true }).click();
    const main = page.getByRole('tab', { name: 'Main prompt', exact: true });
    const actionTab = page.getByRole('tab', { name: 'Action instructions', exact: true });
    const blocks = page.getByRole('region', { name: /^Prompt block \d+$/ });
    await expect(main).toHaveAttribute('aria-selected', 'true');
    await expect(blocks).toHaveCount(9);
    const continuation = page.getByRole('textbox', { name: 'Continuation instruction' });
    await expect(continuation).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('main-prompt.png') });

    const first = blocks.first();
    const nameField = first.getByRole('textbox', { name: 'Block name', exact: true });
    const expand = first.getByRole('button', { name: /\bExpand block 1$/ });
    const role = first.getByRole('combobox', { name: 'Role for block 1', exact: true });
    const moveDown = first.getByRole('button', { name: 'Move block 1 down', exact: true });
    const centerY = ({ y, height }: { y: number; height: number }) => y + height / 2;
    const messages = blocks.nth(6);
    const messagesName = messages.getByRole('textbox', { name: 'Block name', exact: true });
    if (width === 390) {
      await expect(expand).toHaveAccessibleName('Pre-history instructions Expand block 1');
      await expect(expand).toHaveAccessibleDescription('system');
      await expect(nameField).toBeHidden();
      await expect(role).toBeHidden();
      await expect(moveDown).toBeHidden();
      await expect(messages.getByRole('button', { name: /^Messages Expand block 7$/ })).toHaveAccessibleDescription('Original roles');
      const summary = await expand.boundingBox();
      const enabled = await first.getByRole('checkbox').boundingBox();
      if (!summary || !enabled) throw new Error('Compact block controls are missing');
      expect(summary.height).toBeGreaterThanOrEqual(44);
      expect(Math.abs(centerY(summary) - centerY(enabled))).toBeLessThan(1);
      const firstTitle = await expand.getByText('Pre-history instructions', { exact: true }).boundingBox();
      const nextTitle = await blocks.nth(1).getByRole('button', { name: /\bExpand block 2$/ })
        .getByText('Card system prompt', { exact: true }).boundingBox();
      if (!firstTitle || !nextTitle) throw new Error('Compact block titles are missing');
      expect(firstTitle.x).toBe(nextTitle.x);
    } else {
      const boxes = await Promise.all([nameField, expand, role, moveDown].map(control => control.boundingBox()));
      const blockName = boxes[0];
      if (!blockName || boxes.some(box => !box)) throw new Error('Wide prompt block controls are missing');
      for (const box of boxes) if (box) expect(Math.abs(centerY(blockName) - centerY(box))).toBeLessThan(1);
      await expect(messagesName).toHaveValue('Messages');
      expect((await messagesName.boundingBox())?.width).toBeCloseTo(blockName.width);
    }
    await first.screenshot({ path: testInfo.outputPath('collapsed-text-block.png') });
    await expect(messages.getByText('Original roles', { exact: true }).filter({ visible: true })).toBeVisible();
    await expect(messages.getByRole('combobox')).toHaveCount(0);
    await messages.screenshot({ path: testInfo.outputPath('collapsed-messages-block.png') });

    await actionTab.click();
    await expect(blocks).toHaveCount(0);
    const instructions = page.getByRole('tabpanel', { name: 'Action instructions', exact: true });
    await expect(instructions.locator('summary')).toHaveText([
      /^Continue\s*Built-in instruction$/,
      /^Impersonate\s*Built-in instruction$/,
      /^Opening scene\s*Built-in instruction$/,
    ]);
    await page.screenshot({ path: testInfo.outputPath('action-instructions.png') });
    await instructions.getByText('Continue', { exact: true }).click();
    await expect(continuation).toHaveValue(defaultContinuationInstruction);
    expect(await continuation.evaluate(field => field.clientHeight >= field.scrollHeight)).toBe(true);
    await continuation.screenshot({ path: testInfo.outputPath('continuation-instruction.png') });
    await main.click();
    const checkInstructions = async () => {
      for (const [position, name] of [[1, 'Pre-history instructions'], [9, 'Post-history instructions']] as const) {
        const block = blocks.nth(position - 1);
        await block.getByRole('button', { name: new RegExp(`\\bExpand block ${position}$`) }).click();
        await expect(block.getByRole('textbox', { name: 'Block name', exact: true })).toHaveValue(name);
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
      ...defaultPrompt.blocks.filter(block => block.kind === 'marker').map(block => ({ ...block, name: markerLabel(block.marker) })),
      expect.objectContaining({ name: 'Post-history instructions', kind: 'text', text: '', role: 'system', enabled: true }),
    ]);
    expect(library.prompts.find(prompt => prompt.id === 'default')).toEqual({ ...defaultPrompt, id: 'default', revision: 0 });
    await saved.getByRole('button', { name: 'Blank starter prompt', exact: true }).click();
    await checkInstructions();
  });
}

test('block layout follows the editor pane and editable names follow the form typography', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Owner password').fill('browser-synthetic-password');
  await page.getByRole('button', { name: 'Create owner account', exact: true }).click();
  await page.getByRole('button', { name: 'Libraries', exact: true }).click();
  await selectLibraryCategory(page, 'Prompts');
  await page.getByRole('button', { name: 'New prompt', exact: true }).click();
  const firstBlock = page.getByRole('region', { name: 'Prompt block 1', exact: true });
  const blockName = firstBlock.getByRole('textbox', { name: 'Block name', exact: true });

  for (const [width, compact] of [[390, true], [696, true], [697, false], [800, false], [801, true], [1014, true], [1015, false]] as const) {
    await page.setViewportSize({ width, height: 900 });
    const expand = firstBlock.getByRole('button', { name: /\bExpand block 1$/ });
    await expect(expand, `Block controls at ${width}px`).toHaveAccessibleName(compact ? 'Pre-history instructions Expand block 1' : 'Expand block 1');
    if (compact) await expect(blockName).toBeHidden();
    else await expect(blockName).toBeVisible();
    if (width === 801) await expect(page.getByRole('listbox', { name: 'Role for block 1' })).toHaveCount(0);
    await expand.click();
    const fieldSize = await firstBlock.getByRole('textbox', { name: 'Block text', exact: true }).evaluate(field => getComputedStyle(field).fontSize);
    await expect(blockName, `Block name font size at ${width}px`).toHaveCSS('font-size', fieldSize);
    await firstBlock.getByRole('button', { name: /\bCollapse block 1$/ }).click();
    if (width === 800) {
      await firstBlock.getByRole('combobox', { name: 'Role for block 1' }).click();
      await expect(page.getByRole('listbox', { name: 'Role for block 1' })).toBeVisible();
    }
  }
});

for (const width of [1440, 320]) test(`keeps edits across prompt tabs and reveals invalid blocks before saving at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto('/');
  await page.getByLabel('Owner password').fill('browser-synthetic-password');
  await page.getByRole('button', { name: 'Create owner account', exact: true }).click();
  await page.getByRole('button', { name: 'Libraries', exact: true }).click();
  await selectLibraryCategory(page, 'Prompts');
  await page.getByRole('button', { name: 'New prompt', exact: true }).click();
  const main = page.getByRole('tab', { name: 'Main prompt', exact: true });
  const actionTab = page.getByRole('tab', { name: 'Action instructions', exact: true });
  const instructions = page.getByRole('tabpanel', { name: 'Action instructions', exact: true });
  const block = page.getByRole('region', { name: 'Prompt block 1', exact: true });
  const blockName = block.getByRole('textbox', { name: 'Block name', exact: true });
  const blockText = block.getByRole('textbox', { name: 'Block text', exact: true });
  const blockRole = block.getByRole('combobox', { name: 'Role for block 1', exact: true });
  const save = page.getByRole('button', { name: 'Save', exact: true });
  const name = 'Prompt edited across tabs';
  const text = 'Keep the ferry dialogue brief.';
  const openingText = 'Have {{char}} meet {{user}} at the ferry.';
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
  const expand = block.getByRole('button', { name: /\bExpand block 1$/ });
  await expand.press('Enter');
  await blockText.fill(text);
  await blockName.clear();
  if (width === 320) {
    await block.getByRole('button', { name: /\bCollapse block 1$/ }).click();
    await expect(blockName).toBeHidden();
  }

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
  await blockRole.press('ArrowDown');
  await blockRole.press('End');
  await blockRole.press('Enter');
  await expect(blockRole).toHaveText('assistant');
  if (width === 320) {
    const moveDown = block.getByRole('button', { name: 'Move block 1 down', exact: true });
    const box = await moveDown.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
    await moveDown.click();
    const moved = page.getByRole('region', { name: 'Prompt block 2', exact: true });
    await expect(moved.getByRole('textbox', { name: 'Block text', exact: true })).toHaveValue(text);
    await moved.getByRole('button', { name: 'Ferry dialogue Collapse block 2', exact: true }).click();
    await moved.getByRole('checkbox').uncheck();
    const summary = moved.getByRole('button', { name: 'Ferry dialogue Expand block 2', exact: true });
    await expect(summary).toHaveAccessibleDescription('assistant');
    await expect(summary).toHaveAttribute('aria-expanded', 'false');

    const last = page.getByRole('region', { name: 'Prompt block 9', exact: true });
    await last.getByRole('button', { name: 'Post-history instructions Expand block 9', exact: true }).click();
    await last.getByRole('button', { name: 'Remove block 9', exact: true }).click();
    await expect(last).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }

  await main.press('End');
  await expect(opening).toHaveValue(openingText);
  await instructions.getByText('Opening scene', { exact: true }).click();
  await expect(opening).toHaveCount(0);
  await instructions.getByText('Opening scene', { exact: true }).click();
  await expect(opening).toHaveValue(openingText);
  const continueInstruction = instructions.locator('summary').filter({ has: page.getByText('Continue', { exact: true }) });
  await continueInstruction.click();
  await instructions.getByRole('textbox', { name: 'Continuation instruction', exact: true }).clear();
  await expect(continueInstruction.getByText('Built-in instruction', { exact: true })).toBeVisible();
  await save.click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  const library = await page.request.get('/api/library').then(response => response.json() as Promise<LibrarySnapshot>);
  const saved = library.prompts.find(prompt => prompt.name === name);
  expect(saved).toMatchObject({ continuationInstruction: '', openingInstruction: openingText });
  expect(saved?.blocks[width === 320 ? 1 : 0]).toMatchObject({ name: 'Ferry dialogue', role: 'assistant', text, enabled: width !== 320 });
  expect(saved?.blocks).toHaveLength(width === 320 ? 8 : 9);
});
