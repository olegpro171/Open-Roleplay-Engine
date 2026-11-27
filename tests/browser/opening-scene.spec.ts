import { defaultPrompt } from '../../src/shared/library';
import { expect } from '@playwright/test';
import { themeSchema } from '../../src/shared/appearance';
import { setupScene as setup } from './scene-fixture';
import type { RequestBody } from '../../src/shared/contracts';
import { test } from './isolated-app';
import { openChatTool } from './chat-tools';
import { selectLibraryCategory } from './library-card-helpers';

const reply = 'The lantern flickers. 🕯';
const original = 'Mira waits by the dock.';

test('previews an opening, recovers from HTTP 400 and preserves the next draft', async ({ page }) => {
  const { state, calls, setMode } = await setup(page);
  const story = page.getByRole('button', { name: 'Story', exact: true });
  const open = page.getByRole('button', { name: 'generate an opening', exact: true });
  const composer = page.getByRole('textbox', { name: 'Your next turn' });
  await expect(open).toBeEnabled();
  await openChatTool(page, 'Request inspector');
  await page.getByText('Endpoint and request body', { exact: true }).click();
  const body = page.getByTestId('request-body');
  await expect(body).toBeVisible();
  const preview: RequestBody = JSON.parse(await body.innerText());
  expect(preview.messages.filter(part => part.role === 'user')).toEqual([{ role: 'user', content: defaultPrompt.openingInstruction }]);
  expect(await calls()).toEqual([]);

  await story.click();
  await composer.fill('Keep this as my reply to the opening.');
  await setMode(400);
  await open.focus();
  await page.keyboard.press('Enter');
  const turn = page.getByRole('article', { name: 'Turn 1', exact: true });
  const retry = page.getByRole('button', { name: 'Retry response', exact: true });
  await expect(retry).toBeVisible();
  await expect(page.getByText(/The provider could not accept the request \(HTTP 400\)/)).toBeVisible();
  await expect(open).toHaveCount(0);
  await expect(turn.getByRole('button', { name: 'Edit input', exact: true })).toHaveCount(0);
  const pending = (await state()).turns[0];
  expect(pending).toMatchObject({ complete: false, user: { text: '' }, assistant: { text: '' } });
  expect((await calls())[0].body).toEqual(preview);
  await page.reload();
  await expect(composer).toHaveValue('Keep this as my reply to the opening.');
  await setMode('normal');
  await retry.click();
  await expect(turn.getByText(reply, { exact: true })).toBeVisible();
  await expect(retry).toHaveCount(0);
  await expect(composer).toHaveValue('Keep this as my reply to the opening.');
  const saved = await state();
  expect(saved.turns).toHaveLength(1);
  expect(saved.turns[0]).toMatchObject({ id: pending.id, complete: true, user: { text: '' }, assistant: { text: reply } });
  expect(saved.generations[0].request?.body).toEqual(preview);
  expect((await calls()).map(call => call.body)).toEqual([preview, preview]);
});

test('edits the opening instruction and regenerates a greeting without losing it', async ({ page }, testInfo) => {
  const { state, calls, setTheme } = await setup(page, original);
  const openPrompt = async () => {
    await page.getByRole('button', { name: 'Libraries', exact: true }).click();
    await selectLibraryCategory(page, 'Prompts');
    await page.getByRole('button', { name: defaultPrompt.name, exact: true }).click();
    await page.getByRole('tab', { name: 'Action instructions', exact: true }).click();
    await page.getByRole('tabpanel', { name: 'Action instructions', exact: true }).getByText('Opening scene', { exact: true }).click();
  };
  const setting = page.getByRole('textbox', { name: 'Opening scene instruction', exact: true });
  for (const theme of themeSchema.options) {
    await setTheme(theme);
    await openPrompt();
    await expect(setting).toHaveValue(defaultPrompt.openingInstruction ?? '');
    for (const width of [1440, 801, 800, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await setting.scrollIntoViewIfNeeded();
      await expect(setting).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (width === 1440 || width === 390) {
        await page.screenshot({ path: testInfo.outputPath(`opening-editor-${theme}-${width}.png`) });
      }
    }
  }
  const custom = 'Open with {{char}} addressing {{user}} about the delayed ferry.';
  await setting.fill(custom);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(setting).toHaveCount(0);
  await page.reload();
  await openPrompt();
  await expect(setting).toHaveValue(custom);
  await page.getByRole('button', { name: 'Story', exact: true }).click();

  const turn = page.getByRole('article', { name: 'Turn 1', exact: true });
  await expect(turn.getByText(original, { exact: true })).toBeVisible();
  await turn.getByRole('button', { name: 'Regenerate', exact: true }).click();
  await expect(turn.getByText(reply, { exact: true })).toBeVisible();
  const [call] = await calls();
  expect(call.body.messages.filter(part => part.role !== 'system')).toEqual([
    { role: 'user', content: 'Open with Mira addressing You about the delayed ferry.' },
  ]);
  const saved = await state();
  expect(saved.turns[0].variants?.map(variant => variant.text)).toEqual([original, reply]);
  expect(saved.generations[0].request?.body).toEqual(call.body);
  await turn.getByRole('button', { name: 'Previous response', exact: true }).click();
  await expect(turn.getByText(original, { exact: true })).toBeVisible();
});
