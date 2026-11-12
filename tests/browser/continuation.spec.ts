import { expect, devices, type Page } from '@playwright/test';
import { themeSchema, appearanceStatusSchema } from '../../src/shared/appearance';
import { chatBehaviorStatusSchema } from '../../src/shared/chat-behavior';
import { continuationInstruction } from '../../src/core/continuation';
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
    await expect(turn.getByRole('status')).toHaveText('Continuation cancelled. The selected reply was kept.');
    expect((await state()).turns[0].variants?.map(item => item.text)).toEqual([original]);
    if (previewedBody) {
      await expect(prose.locator('p')).toHaveText([original]);
      const details = turn.getByText('Inspect unfinished continuation', { exact: true });
      await details.click();
      await expect(turn.getByText('The lantern', { exact: true })).toBeVisible();
      await details.click();
    }
    await advance();

    await mode('reasoning');
    await extend.click();
    await expect(prose.getByRole('status')).toHaveText('Reasoning…');
    await expect(preview).toContainText('Reasoning line 80');
    const saved = await prose.getByText(original, { exact: true }).boundingBox();
    const reason = await preview.boundingBox();
    expect(saved && reason && saved.y + saved.height <= reason.y).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(await page.evaluate(() => innerWidth));
    await page.screenshot({ path: testInfo.outputPath('continuation-reasoning.png') });
    await advance();
    await expect(preview).toContainText('The newest thought');
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
  await expect(turn.getByRole('status')).toHaveText('Continuation cancelled. The selected reply was kept.');
  const savedState = await state();
  expect(savedState.turns[1].variants?.map(item => item.text)).toEqual([original]);
  expect(savedState.generations[0]).toMatchObject({ kind: 'continuation', status: 'cancelled', request: null });
  expect(await calls()).toHaveLength(1);
});
