import { expect, devices, type Page } from '@playwright/test';
import { themeSchema, appearanceStatusSchema } from '../../src/shared/appearance';
import { chatBehaviorStatusSchema } from '../../src/shared/chat-behavior';
import { defaultContinuationInstruction as continuationInstruction } from '../../src/shared/default-prompt';
import type { ChatSnapshot, RequestBody } from '../../src/shared/contracts';
import { defaultContextPreset } from '../../src/shared/context';
import { test } from './isolated-app';
import { openChatTool } from './chat-tools';
import { compactPrompt } from '../support/compact-prompt';

const original = 'The keeper opens the window.';
const reply = 'The lantern flickers. 🕯';

async function setup(page: Page, theme: typeof themeSchema.options[number], withMemory = false) {
  await page.goto('/');
  await page.getByLabel('Owner password').fill('browser-synthetic-password');
  await page.getByRole('button', { name: 'Create owner account', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible();
  const headers = { Origin: new URL(page.url()).origin };
  const read = async (path: string) => page.request.get(path).then(response => response.json());
  const write = async (path: string, data: unknown, method: 'post' | 'put' = 'post') => {
    const response = await page.request[method](path, { headers, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const appearance = appearanceStatusSchema.parse(await read('/api/application/appearance'));
  await write('/api/application/appearance', {
    revision: appearance.revision, settings: { ...appearance.settings, theme, showReasoningDuringGeneration: true },
  }, 'put');
  const behavior = chatBehaviorStatusSchema.parse(await read('/api/application/chat-behavior'));
  await write('/api/application/chat-behavior', { revision: behavior.revision, settings: { enterKeyBehavior: 'ctrl-enter' } }, 'put');
  const { endpoint } = await read('/__test/endpoint');
  const { revision } = await read('/api/library');
  const connection = await write('/api/library', { revision, kind: 'connections', data: {
    name: 'Continuation connection', endpoint, model: 'synthetic-roleplay', contextWindow: 100_000, maxOutputTokens: 1_000, customParameters: {},
  } });
  const addLibraryRecord = async (kind: string, data: unknown) => write('/api/library', {
    revision: (await read('/api/library')).revision, kind, data,
  });
  const promptId = withMemory ? (await addLibraryRecord('prompts', { ...compactPrompt, name: 'Compact story prompt' })).id : 'default';
  const contextPresetId = withMemory ? (await addLibraryRecord('contexts', {
    ...defaultContextPreset, name: 'Compact context', minTail: 0, batchSize: 1,
  })).id : null;
  const chat = await write('/api/chats', { title: 'Continue the scene', connectionId: connection.id, promptId,
    characterId: null, personaId: null, contextPresetId, targetInputTokens: withMemory ? 260 : 20_000 });
  const state = (): Promise<ChatSnapshot> => read(`/api/chats/${chat.id}`);
  const earlier = { user: 'I count the candles.', assistant: 'The keeper recounts the candles in the hall. '.repeat(120), complete: true };
  await write(`/api/__test/transcripts/${chat.id}`, {
    revision: (await state()).revision, turns: [...(withMemory ? [earlier] : []), { user: '', assistant: original, complete: true }],
  }, 'put');
  await page.evaluate(id => localStorage.setItem('roleplay-chat', id), chat.id);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  return { state, calls: (): Promise<{ body: RequestBody }[]> => read('/__test/requests'),
    mode: (mode: string) => write('/__test/mode', { mode }), advance: () => write('/__test/finish', {}) };
}

for (const device of ['desktop', 'phone'] as const) test.describe(device, () => {
  if (device === 'phone') {
    const { userAgent, viewport, isMobile, hasTouch } = devices['iPhone 13'];
    test.use({ userAgent, viewport, isMobile, hasTouch });
  }
  for (const theme of themeSchema.options) test(`continues a greeting in ${theme}`, async ({ page }, testInfo) => {
    const { state, calls, mode, advance } = await setup(page, theme);
    const composer = page.getByRole('textbox', { name: 'Your next turn', exact: true });
    const extend = page.getByRole('button', { name: 'Continue', exact: true });
    const send = page.getByRole('button', { name: 'Send', exact: true });
    const turn = page.getByRole('article', { name: 'Turn 1', exact: true });
    const prose = turn.locator('.part.assistant > .prose');
    const preview = turn.getByLabel('Latest model reasoning');
    const cancel = turn.getByRole('button', { name: 'Cancel', exact: true });

    await expect(extend).toBeEnabled();
    await expect(extend.locator('svg')).toHaveCSS('transform', 'matrix(1, 0, 0, 1, -0.25, 0)');
    await composer.fill('A new turn.');
    await expect(send.locator('.send-icon')).toHaveCSS('transform', 'matrix(1, 0, 0, 1, -0.8, 0.8)');
    await composer.fill('   ');
    await expect(extend).toBeEnabled();

    let previewedBody: RequestBody | undefined;
    if (theme === 'dark' && device === 'desktop') {
      await openChatTool(page, 'Request inspector');
      await page.getByText('Endpoint and request body', { exact: true }).click();
      const body = page.getByTestId('request-body');
      await expect(body).toContainText(continuationInstruction);
      previewedBody = JSON.parse(await body.innerText());
      await page.getByRole('button', { name: 'Story', exact: true }).click();
    }

    await mode('hold-first-token');
    if (device === 'desktop') await composer.press('Control+Enter');
    else await extend.tap();
    await expect(prose.getByText(original, { exact: true })).toBeVisible();
    await expect(prose.getByRole('status')).toHaveText('Connecting…');
    await expect(extend).toBeDisabled();
    await expect(cancel).toBeEnabled();
    await expect.poll(calls).toHaveLength(1);
    if (previewedBody) expect((await calls())[0].body).toEqual(previewedBody);
    if (previewedBody) {
      await advance();
      await expect(prose.locator('p')).toHaveText([original, 'The lantern']);
    }
    await cancel.click();
    await expect(extend).toBeEnabled();
    await expect(turn.getByRole('status')).toHaveCount(0);
    const cancelled = await state();
    expect(cancelled.turns[0].variants?.map(item => item.text)).toEqual([original]);
    expect(cancelled.generations[0]).toMatchObject({ status: 'cancelled', partialText: '' });
    await expect(turn.getByText('Inspect unfinished continuation', { exact: true })).toHaveCount(0);
    if (previewedBody) {
      await expect(prose.locator('p')).toHaveText([original]);
      await page.reload();
      await expect(prose.locator('p')).toHaveText([original]);
      await expect(turn.getByText('Inspect unfinished continuation', { exact: true })).toHaveCount(0);
    }
    await advance();

    await mode('reasoning');
    await extend.click();
    await expect(prose.getByRole('status')).toHaveText('Reasoning…');
    await expect(preview).toContainText('Reasoning line 80');
    const saved = await prose.getByText(original, { exact: true }).boundingBox();
    const reason = await preview.boundingBox();
    const tail = preview.locator('.reasoning-tail > span');
    await expect.poll(() => tail.textContent()).toMatch(/quiet tower\.$/);
    expect(saved && reason && saved.y + saved.height <= reason.y).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(await page.evaluate(() => innerWidth));
    await page.screenshot({ path: testInfo.outputPath('continuation-reasoning.png') });
    await advance();
    await expect(preview).toContainText('The newest thought');
    await expect.poll(() => tail.textContent()).toMatch(/grounded in the scene\.$/);
    expect((await preview.boundingBox())?.height).toBe(reason?.height);
    await advance();
    await expect(prose.locator('p')).toHaveText([original, 'The lantern']);
    await expect(preview).toHaveCount(0);
    expect((await state()).turns[0].assistant.text).toBe(original);
    await advance();
    await expect(prose.locator('p')).toHaveText([original, reply]);
    await expect(turn.getByRole('textbox', { name: 'Response version', exact: true })).toHaveValue('2');
    const after = await state();
    expect(after.turns).toHaveLength(1);
    expect(after.turns[0].assistant.text).toBe(`${original}\n\n${reply}`);
    expect(after.generations[0]).toMatchObject({ kind: 'continuation', status: 'succeeded' });
    await page.screenshot({ path: testInfo.outputPath('continuation-saved.png') });
  });
});

test('Escape discards both turn edit drafts without changing the saved turn', async ({ page }) => {
  const { state } = await setup(page, 'dark');
  const before = (await state()).turns[0];
  const turn = page.getByRole('article', { name: 'Turn 1', exact: true });
  await turn.getByRole('button', { name: 'Edit response', exact: true }).click();
  const response = turn.getByLabel('Edit assistant text');
  await response.fill('Unsaved replacement.');
  await response.dispatchEvent('keydown', { key: 'Escape', bubbles: true, isComposing: true });
  await expect(response).toHaveValue('Unsaved replacement.');
  await response.press('Escape');
  await expect(response).toHaveCount(0);
  await expect(turn.getByText(original, { exact: true })).toBeVisible();
  // A greeting has no visible input yet. First save an ordinary turn to exercise both controls.
  await page.getByRole('textbox', { name: 'Your next turn' }).fill('I look at the window.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const next = page.getByRole('article', { name: 'Turn 2', exact: true });
  await expect(next.getByText(reply, { exact: true })).toBeVisible();
  await next.getByRole('button', { name: 'Edit input', exact: true }).click();
  await next.getByLabel('Edit user text').fill('Unsaved input.');
  await next.getByRole('button', { name: 'Save edit', exact: true }).focus();
  await page.keyboard.press('Escape');
  await expect(next.getByLabel('Edit user text')).toHaveCount(0);
  await expect(next.getByText('I look at the window.', { exact: true })).toBeVisible();
  const after = (await state()).turns;
  expect(after[0]).toEqual(before);
  expect(after[1].user.text).toBe('I look at the window.');
});

test('turn edit recovery blocks composer submission until the edit is closed', async ({ page, context }) => {
  const { state, calls } = await setup(page, 'dark');
  const composer = page.getByRole('textbox', { name: 'Your next turn', exact: true });
  const send = page.getByRole('button', { name: 'Send', exact: true });
  const extend = page.getByRole('button', { name: 'Continue', exact: true });
  const turn = page.getByRole('article', { name: 'Turn 2', exact: true });
  const editText = 'Unsaved prose from the removed turn.';
  const nextText = 'I open the shutters.';

  await composer.fill('I approach the window.');
  await send.click();
  await expect(extend).toBeEnabled();
  await turn.getByRole('button', { name: 'Edit response', exact: true }).click();
  await turn.getByLabel('Edit assistant text').fill(editText);

  const otherTab = await context.newPage();
  await otherTab.goto('/');
  await otherTab.getByRole('article', { name: 'Turn 2', exact: true })
    .getByRole('button', { name: 'More turn actions', exact: true }).click();
  await otherTab.getByRole('menuitem', { name: 'Delete turn', exact: true }).click();
  await otherTab.getByRole('dialog').getByRole('button', { name: 'Delete turn', exact: true }).click();
  await expect(otherTab.getByRole('article', { name: 'Turn 2', exact: true })).toHaveCount(0);
  await otherTab.close();

  const recovered = page.getByRole('textbox', { name: 'Unsaved turn edit', exact: true });
  await expect(recovered).toHaveValue(editText);
  await expect(extend).toBeDisabled();
  await composer.fill(nextText);
  await expect(send).toBeDisabled();
  await composer.press('Control+Enter');
  await expect(composer).toHaveValue(nextText);
  await expect(recovered).toHaveValue(editText);
  expect((await state()).turns.map(item => item.assistant.text)).toEqual([original]);
  expect(await calls()).toHaveLength(1);

  await page.getByRole('button', { name: 'Close edit', exact: true }).click();
  await expect(recovered).toHaveCount(0);
  await expect(composer).toHaveValue(nextText);
  await expect(send).toBeEnabled();
  await composer.fill('');
  await expect(extend).toBeEnabled();
  await composer.fill(nextText);
  await send.click();
  await expect(turn.getByText(reply, { exact: true })).toBeVisible();
  expect((await state()).turns[1].user.text).toBe(nextText);
  expect(await calls()).toHaveLength(2);
});

test('a saved prompt controls future continuation previews and requests', async ({ page }) => {
  const { state, calls } = await setup(page, 'dark');
  const openPrompt = async () => {
    await page.getByRole('button', { name: 'Libraries', exact: true }).click();
    await page.getByRole('button', { name: 'Prompts', exact: true }).click();
    await page.getByRole('button', { name: 'Default prompt', exact: true }).click();
  };
  const setting = page.getByRole('textbox', { name: 'Continuation instruction' });
  const custom = '  Move {{char}} to the doorway. Wait for {{user}}.  ';
  const outgoing = { role: 'user', content: '  Move Character to the doorway. Wait for You.  ' };
  await openPrompt();
  await expect(setting).toHaveValue(continuationInstruction);
  await setting.fill(custom);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(setting).toHaveCount(0);
  await page.reload();
  await openPrompt();
  await expect(setting).toHaveValue(custom);
  await page.getByRole('button', { name: 'Story', exact: true }).click();
  await openChatTool(page, 'Request inspector');
  await page.getByText('Endpoint and request body', { exact: true }).click();
  const body = page.getByTestId('request-body');
  await expect(body).toContainText('Move Character to the doorway. Wait for You.');
  const preview: RequestBody = JSON.parse(await body.innerText());
  expect(preview.messages).toContainEqual(outgoing);
  expect(preview.messages).not.toContainEqual({ role: 'user', content: continuationInstruction });
  await page.getByRole('button', { name: 'Story', exact: true }).click();
  const extend = page.getByRole('button', { name: 'Continue', exact: true });
  await extend.click();
  await expect.poll(async () => (await state()).generations[0]?.status).toBe('succeeded');
  const first = (await state()).generations[0];
  expect((await calls())[0].body).toEqual(preview);
  expect(first.request?.body).toEqual(preview);
  await page.getByRole('textbox', { name: 'Your next turn' }).fill('I open the door.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(calls).toHaveLength(2);
  await expect(extend).toBeEnabled();
  expect((await calls())[1].body.messages).not.toContainEqual(outgoing);

  await openPrompt();
  await setting.clear();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(setting).toHaveCount(0);
  await page.getByRole('button', { name: 'Story', exact: true }).click();
  await extend.click();
  await expect.poll(calls).toHaveLength(3);
  expect((await calls())[2].body.messages).toContainEqual({ role: 'user', content: continuationInstruction });
  expect((await state()).generations.find(generation => generation.id === first.id)?.request?.body).toEqual(preview);
});

test('replays the same continuation after losing its acknowledgement and reloading', async ({ page }) => {
  const { state, calls } = await setup(page, 'dark');
  const extend = page.getByRole('button', { name: 'Continue', exact: true });
  const path = '**/api/chats/*/turns/*/continue';
  let accepted = false;
  await page.route(path, async route => {
    const response = await route.fetch();
    accepted = response.status() === 202;
    await route.abort('failed');
  });
  await extend.click();
  await expect.poll(async () => (await state()).generations[0]?.status).toBe('succeeded');
  await expect(page.getByRole('alert')).toBeVisible();
  expect(accepted).toBe(true);
  await page.unroute(path);
  await page.reload();
  await extend.click();
  await expect(extend).toBeEnabled();
  expect(await calls()).toHaveLength(1);
  expect((await state()).turns[0].variants?.map(item => item.text)).toEqual([original, `${original}\n\n${reply}`]);
  await extend.click();
  await expect.poll(calls).toHaveLength(2);
});

test('shows memory preparation beneath the reply and stops before the story request', async ({ page }, testInfo) => {
  const { state, calls, mode } = await setup(page, 'dark', true);
  await mode('hold');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  const turn = page.getByRole('article', { name: 'Turn 2', exact: true });
  const prose = turn.locator('.part.assistant > .prose');
  await expect(prose.getByRole('status')).toHaveText('Preparing memory…');
  const saved = await prose.getByText(original, { exact: true }).boundingBox();
  const status = await prose.getByRole('status').boundingBox();
  expect(saved && status && saved.y + saved.height <= status.y).toBe(true);
  await expect.poll(calls).toHaveLength(1);
  expect(JSON.stringify((await calls())[0].body)).not.toContain(continuationInstruction);
  await page.screenshot({ path: testInfo.outputPath('continuation-preparing.png') });
  await turn.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled();
  await expect(turn.getByRole('status')).toHaveCount(0);
  const savedState = await state();
  expect(savedState.turns[1].variants?.map(item => item.text)).toEqual([original]);
  expect(savedState.generations[0]).toMatchObject({ kind: 'continuation', status: 'cancelled', request: null });
  expect(await calls()).toHaveLength(1);
});
