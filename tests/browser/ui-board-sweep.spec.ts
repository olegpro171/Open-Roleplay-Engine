import { test, expect, type Page } from '@playwright/test';
import type { ChatSnapshot } from '../../src/shared/contracts';
import type { LibrarySnapshot } from '../../src/shared/library';
import { openChatTool } from './chat-tools';

async function setup(page: Page) {
  const session = await page.request.get('/api/session').then(response => response.json());
  await page.goto('/');
  await page.getByLabel('Owner password').fill('browser-synthetic-password');
  await page.getByRole('button', { name: session.setupRequired ? 'Create owner account' : 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Libraries', exact: true })).toBeVisible();
  const { endpoint } = await page.request.get('/__test/endpoint').then(response => response.json());
  const library: LibrarySnapshot = await page.request.get('/api/library').then(response => response.json());
  const connection = await command(page, '/api/library', { revision: library.revision, kind: 'connections', data: {
    name: 'Sweep model', endpoint, model: 'synthetic-roleplay', contextWindow: 100_000, maxOutputTokens: 1000, customParameters: {},
  } });
  const { id }: { id: string } = await command(page, '/api/chats', { title: `Sweep ${test.info().testId}`, targetInputTokens: 20_000,
    connectionId: connection.id, promptId: 'default', characterId: null, personaId: null });
  await page.evaluate(id => localStorage.setItem('roleplay-chat', id), id);
  await page.reload();
  await expect(page.getByLabel('Your next turn')).toBeVisible();
  return id;
}

async function command(page: Page, url: string, data: unknown, method = 'POST') {
  const response = await page.request.fetch(url, { method, headers: { Origin: 'http://127.0.0.1:4173' }, data });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

test('saving chat settings after a local history import preserves edits and still rejects remote changes', async ({ page }) => {
  const id = await setup(page);
  await openChatTool(page, 'Chat settings');
  await page.getByLabel('Chat title', { exact: true }).fill('Edited before import');
  await page.getByLabel('Chat JSONL file').setInputFiles({ name: 'synthetic.jsonl', mimeType: 'application/octet-stream',
    buffer: Buffer.from(JSON.stringify({ is_user: false, mes: 'An imported opening.' }) + '\n') });
  await page.getByRole('button', { name: 'Replace all messages', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Replace all messages', exact: true })).toHaveCount(0);
  const save = page.getByRole('button', { name: 'Save and return', exact: true });
  await expect(save).toBeEnabled();
  await expect(page.getByLabel('Chat title', { exact: true })).toHaveValue('Edited before import');
  await save.click();
  await expect(page.getByLabel('Your next turn')).toBeVisible();
  const saved: ChatSnapshot = await page.request.get(`/api/chats/${id}`).then(response => response.json());
  expect(saved.settings.title).toBe('Edited before import');
  expect(saved.turns[0].assistant.text).toBe('An imported opening.');
  await openChatTool(page, 'Chat settings');
  await page.getByLabel('Chat title', { exact: true }).fill('Uncommitted local title');
  await command(page, `/api/chats/${id}/history`, { revision: saved.revision,
    turns: [{ user: '', assistant: 'Remote replacement', complete: true }] }, 'PUT');
  await expect(save).toBeDisabled();
  await expect(page.getByLabel('Chat title', { exact: true })).toHaveValue('Uncommitted local title');
});

test('drafting during generation retains the next message through completion, cancellation and reload', async ({ page }) => {
  const id = await setup(page);
  const composer = page.getByLabel('Your next turn');
  const send = page.getByRole('button', { name: 'Send', exact: true });
  try {
    await page.request.post('/__test/mode', { data: { mode: 'hold' } });
    await composer.fill('The first input.');
    await send.click();
    await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
    await expect(composer).toBeEnabled();
    await composer.fill('The next draft.');
    await expect(send).toBeDisabled();
    await composer.press('Enter');
    const during: ChatSnapshot = await page.request.get(`/api/chats/${id}`).then(response => response.json());
    expect(during.turns).toHaveLength(1);
    await page.request.post('/__test/finish', { data: {} });
    await expect(send).toBeEnabled();
    await expect(composer).toHaveValue('The next draft.\n');
    await page.reload();
    await expect(composer).toHaveValue('The next draft.\n');
    await send.click();
    await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
    await composer.fill('Keep after cancellation');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Retry response', exact: true })).toBeVisible();
    await expect(composer).toBeEnabled();
    await expect(send).toBeDisabled();
    await page.reload();
    await expect(composer).toHaveValue('Keep after cancellation');
  } finally {
    await page.request.post('/__test/finish', { data: {} });
    await page.request.post('/__test/mode', { data: { mode: 'normal' } });
  }
});

for (const width of [1280, 390]) test(`right arrow regenerates, reserves a version and keeps reasoning in place at ${width}px`, async ({ page, browser }, testInfo) => {
  await page.setViewportSize({ width, height: 844 });
  const id = await setup(page);
  const state = (): Promise<ChatSnapshot> => page.request.get(`/api/chats/${id}`).then(response => response.json());
  const composer = page.getByLabel('Your next turn');
  const send = page.getByRole('button', { name: 'Send', exact: true });
  await page.request.post('/__test/mode', { data: { mode: 'normal' } });
  await composer.fill('Enter the tower.');
  await send.click();
  const turn = page.getByRole('article', { name: 'Turn 1', exact: true });
  const next = turn.getByRole('button', { name: 'Next response', exact: true });
  const version = turn.getByRole('textbox', { name: 'Response version', exact: true });
  await expect(version).toBeEnabled();
  const original = (await state()).turns[0].assistant.variantId;
  const reasoningUrl = `**/api/chats/${id}/generations/*/reasoning`;
  try {
    await page.request.post('/__test/mode', { data: { mode: 'reasoning' } });
    await expect(next).toHaveAttribute('title', 'Regenerate response');
    await next.click();
    await expect(version).toHaveValue('2');
    await expect(version).toBeDisabled();
    await expect(turn.getByLabel('2 response versions', { exact: true })).toHaveText('/ 2');
    expect((await state()).turns[0].variants).toHaveLength(1);
    await page.route(reasoningUrl, route => route.fulfill({ json: { text: 'First thought.' } }));
    await turn.getByRole('button', { name: 'Show reasoning', exact: true }).click();
    const popup = page.getByRole('dialog', { name: 'Model reasoning', exact: true });
    const stream = popup.getByLabel('Model reasoning stream', { exact: true });
    await expect(stream).toHaveText('First thought.');
    const initial = await popup.boundingBox();
    await page.unroute(reasoningUrl);
    await page.request.post('/__test/finish', { data: {} });
    await expect(stream).toContainText('The newest thought');
    expect(await popup.boundingBox()).toEqual(initial);
    await page.screenshot({ path: testInfo.outputPath(`fixed-reasoning-${width}.png`) });
    await popup.press('Escape');
    await turn.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(version).toHaveValue('1');
    await expect(turn.getByLabel('1 response versions', { exact: true })).toHaveText('/ 1');
    expect((await state()).turns[0].assistant.variantId).toBe(original);

    await page.request.post('/__test/mode', { data: { mode: 'hold-first-token' } });
    await next.click();
    await expect(version).toHaveValue('2');
    await page.reload();
    await expect(version).toHaveValue('2');
    await page.request.post('/__test/finish', { data: {} });
    await expect(turn.locator('.part.assistant > .prose')).toHaveText('The lantern');
    await page.request.post('/__test/finish', { data: {} });
    await expect(version).toBeEnabled();
    expect((await state()).turns[0].variants).toHaveLength(2);
    const attempts = (await state()).generations.length;
    await turn.getByRole('button', { name: 'Previous response', exact: true }).click();
    await expect(version).toHaveValue('1');
    await next.click();
    await expect(version).toHaveValue('2');
    expect((await state()).generations).toHaveLength(attempts);

    await page.request.post('/__test/mode', { data: { mode: 'broken' } });
    await next.click();
    await expect.poll(async () => (await state()).generations[0].status).toBe('failed');
    await expect(version).toHaveValue('2');
    expect((await state()).turns[0].variants).toHaveLength(2);
    await page.request.post('/__test/mode', { data: { mode: 'normal' } });
    await composer.fill('A later turn.');
    await send.click();
    await expect(page.getByRole('article', { name: 'Turn 2', exact: true }).getByRole('textbox', { name: 'Response version', exact: true })).toBeEnabled();
    await expect(next).toBeDisabled();
    // A wide landscape phone still gets a readable input size without focus zoom.
    const phone = await browser.newContext({ storageState: await page.context().storageState(),
      viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true });
    try {
      const landscape = await phone.newPage();
      await landscape.goto('/');
      await expect(landscape.getByLabel('Your next turn')).toHaveCSS('font-size', '16px');
      await landscape.getByLabel('Your next turn').focus();
    } finally { await phone.close(); }
  } finally {
    await page.request.post('/__test/finish', { data: {} });
    await page.request.post('/__test/mode', { data: { mode: 'normal' } });
  }
});
