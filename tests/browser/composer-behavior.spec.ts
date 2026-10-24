import { expect, test, devices, type Page } from '@playwright/test';
import { chatBehaviorStatusSchema, type EnterKeyBehavior } from '../../src/shared/chat-behavior';

const headers = { Origin: 'http://127.0.0.1:4173' };
const url = '/api/application/chat-behavior';
async function status(page: Page) {
  return chatBehaviorStatusSchema.parse(await page.request.get(url).then(response => response.json()));
}
async function preference(page: Page, enterKeyBehavior: EnterKeyBehavior) {
  const current = await status(page);
  const response = await page.request.put(url, { headers, data: { revision: current.revision, settings: { enterKeyBehavior } } });
  expect(response.ok(), await response.text()).toBe(true);
}
async function setup(page: Page) {
  const session = await page.request.get('/api/session').then(response => response.json());
  await page.goto('/');
  await page.getByLabel('Owner password').fill('browser-synthetic-password');
  await page.getByRole('button', { name: session.setupRequired ? 'Create owner account' : 'Sign in', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible();
  const initial = await status(page);
  await preference(page, 'ctrl-enter');
  const { endpoint } = await page.request.get('/__test/endpoint').then(response => response.json());
  await page.request.post('/__test/mode', { data: { mode: 'normal' } });
  const library = await page.request.get('/api/library').then(response => response.json());
  const connection = await page.request.post('/api/library', { headers, data: {
    revision: library.revision, kind: 'connections', data: { name: `Keyboard ${test.info().testId}`, endpoint, model: 'synthetic-roleplay', contextWindow: 100_000, maxOutputTokens: 1_000, customParameters: {} },
  } });
  expect(connection.ok()).toBe(true);
  const connectionId = (await connection.json()).id;
  const chat = await page.request.post('/api/chats', { headers, data: {
    title: `Keyboard ${test.info().testId}`, connectionId, characterId: null, personaId: null, promptId: 'default', contextPresetId: null, targetInputTokens: 20_000,
  } });
  expect(chat.ok()).toBe(true);
  const id: string = (await chat.json()).id;
  await page.evaluate(id => localStorage.setItem('roleplay-chat', id), id);
  await page.reload();
  await expect(page.getByLabel('Your next turn')).toBeVisible();
  return { id, initial };
}
async function settings(page: Page) {
  await page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'Chat behavior', exact: true }).click();
  return page.getByRole('region', { name: 'Chat behavior', exact: true });
}
async function story(page: Page) {
  await page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Story', exact: true }).click();
}

for (const width of [1440, 390]) test(`saves keyboard modes, retains failed drafts, and shares committed behavior at ${width}px`, async ({ page, context }, testInfo) => {
  await page.setViewportSize({ width, height: 900 });
  const { id, initial } = await setup(page);
  const composer = page.getByLabel('Your next turn');
  const send = page.getByRole('button', { name: 'Send', exact: true });
  const region = await settings(page);
  try {
    await expect(region.getByRole('radio', { name: /^Send with Ctrl/ })).toBeChecked();
    await expect(region.getByText('Physical keyboard only', { exact: true })).toBeVisible();
    await page.route(`**${url}`, route => route.request().method() === 'PUT'
      ? route.fulfill({ status: 500, json: { message: 'Synthetic behavior save failure.' } }) : route.continue());
    await region.getByRole('radio', { name: /^Use Send button only/ }).check();
    await expect(region.getByRole('alert')).toContainText('Your changes are retained. Synthetic behavior save failure.');
    await expect(region.getByRole('radio', { name: /^Use Send button only/ })).toBeChecked();
    expect((await status(page)).settings.enterKeyBehavior).toBe('ctrl-enter');
    await page.unroute(`**${url}`);
    await region.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect.poll(async () => (await status(page)).settings.enterKeyBehavior).toBe('button-only');
    await page.screenshot({ path: testInfo.outputPath('chat-behavior.png') });
    expect(await region.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await story(page);
    await composer.fill('Button only');
    await composer.press('Enter');
    await expect(composer).toHaveValue('Button only\n');
    await composer.press('Control+Enter');
    await composer.press('Meta+Enter');
    expect((await page.request.get(`/api/chats/${id}`).then(r => r.json())).turns).toHaveLength(0);
    await composer.fill('Keep this unsent draft.');

    await settings(page);
    // A competing save is reconciled automatically before the selected mode commits.
    await preference(page, 'ctrl-enter');
    await region.getByRole('radio', { name: /^Send with Enter/ }).check();
    await expect.poll(async () => (await status(page)).settings.enterKeyBehavior).toBe('enter');
    await story(page);
    await expect(composer).toHaveValue('Keep this unsent draft.');
    await expect(send).toHaveAttribute('title', 'Send (Enter)');
    await composer.evaluate((field: HTMLTextAreaElement) => field.setSelectionRange(field.value.length, field.value.length));
    await composer.press('Shift+Enter');
    await expect(composer).toHaveValue('Keep this unsent draft.\n');
    // Synthetic IME and held-key events exercise the real composer handler.
    for (const event of [{ isComposing: true }, { keyCode: 229 }, { repeat: true }]) {
      await composer.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', ...event });
    }
    expect((await page.request.get(`/api/chats/${id}`).then(r => r.json())).turns).toHaveLength(0);
    await composer.press('Enter');
    await expect(composer).toHaveValue('');
    await expect(send).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Regenerate response', exact: true })).toBeEnabled();
    const saved = await page.request.get(`/api/chats/${id}`).then(r => r.json());
    expect(saved.turns).toHaveLength(1);
    expect(saved.turns[0].user.text).toBe('Keep this unsent draft.');
    // Turn editors remain multiline and do not submit through this preference.
    await page.getByRole('button', { name: 'Edit input', exact: true }).click();
    const editor = page.getByLabel('Edit user text');
    await editor.fill('Edited');
    await editor.press('Enter');
    await expect(editor).toHaveValue('Edited\n');
    await page.getByRole('button', { name: 'Cancel edit', exact: true }).click();

    await settings(page);
    await region.getByRole('radio', { name: /^Send with Ctrl/ }).check();
    await expect.poll(async () => (await status(page)).settings.enterKeyBehavior).toBe('ctrl-enter');
    await story(page);
    await page.reload();
    await expect(send).toHaveAttribute('title', /^Send \(Ctrl(?: \/ ⌘)? \+ Enter\)$/);
    await composer.fill('Ctrl sends this.');
    await composer.press('Enter');
    await expect(composer).toHaveValue('Ctrl sends this.\n');
    await page.request.post('/__test/mode', { data: { mode: 'hold' } });
    await composer.evaluate(field => {
      for (let press = 0; press < 2; press++) field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
    });
    await expect(composer).toHaveValue('');
    await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
    await composer.fill('Keep next message.');
    await composer.press('Control+Enter');
    await composer.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', ctrlKey: true, repeat: true });
    await page.request.post('/__test/finish');
    await expect(page.getByRole('button', { name: 'Regenerate response', exact: true })).toBeEnabled();
    await expect(composer).toHaveValue('Keep next message.');
    expect((await page.request.get(`/api/chats/${id}`).then(r => r.json())).turns).toHaveLength(2);

    // A lost send response retains exact text; explicit shortcut retry recovers it.
    await page.request.post('/__test/mode', { data: { mode: 'normal' } });
    await page.route(`**/api/chats/${id}/turns`, route => route.abort('connectionrefused'));
    await composer.press('Control+Enter');
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(send).toBeEnabled();
    await expect(composer).toHaveValue('Keep next message.');
    await page.unroute(`**/api/chats/${id}/turns`);
    await composer.press('Control+Enter');
    await expect(composer).toHaveValue('');
    await expect(page.getByRole('button', { name: 'Regenerate response', exact: true })).toBeEnabled();

    if (await page.evaluate(() => /Mac/.test(navigator.platform))) {
      await composer.fill('Command sends on Mac too.');
      await composer.press('Meta+Enter');
      await expect(composer).toHaveValue('');
      await expect(page.getByRole('button', { name: 'Regenerate response', exact: true })).toBeEnabled();
      expect((await page.request.get(`/api/chats/${id}`).then(r => r.json())).turns).toHaveLength(4);
    }

    const observer = await context.newPage();
    await observer.goto('/');
    await expect(observer.getByLabel('Your next turn')).toBeVisible();
    await preference(page, 'button-only');
    await expect(observer.getByRole('button', { name: 'Send', exact: true })).toHaveAttribute('title', 'Send');
    await observer.close();
    await preference(page, 'enter');
    await page.route(`**${url}`, route => route.request().method() === 'GET'
      ? route.fulfill({ status: 500, json: { message: 'Synthetic behavior load failure.' } }) : route.continue());
    await page.reload();
    await expect(page.getByRole('alert')).toContainText('Sending shortcuts are disabled');
    await composer.fill('Recover settings safely.');
    await composer.press('Enter');
    await expect(composer).toHaveValue('Recover settings safely.\n');
    await expect(send).toHaveAttribute('title', 'Send');
    await page.unroute(`**${url}`);
    await page.getByRole('button', { name: 'Retry chat behavior', exact: true }).click();
    await expect(send).toHaveAttribute('title', 'Send (Enter)');
  } finally {
    await page.unroute(`**${url}`);
    await page.unroute(`**/api/chats/${id}/turns`);
    await page.request.post('/__test/finish');
    await page.request.post('/__test/mode', { data: { mode: 'normal' } });
    await preference(page, initial.settings.enterKeyBehavior);
  }
});

for (const platform of ['iPhone', 'Android', 'iPad desktop mode'] as const) test.describe(platform, () => {
  const device = platform === 'iPhone' ? devices['iPhone 13'] : platform === 'Android' ? devices['Pixel 7'] : devices['Desktop Safari'];
  test.use({ userAgent: device.userAgent, viewport: device.viewport, isMobile: device.isMobile, hasTouch: device.hasTouch });
  test('Return remains a newline even with Enter-to-send selected', async ({ page }) => {
    if (platform === 'iPad desktop mode') await page.addInitScript(() => {
      Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' });
      Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5 });
    });
    const { id, initial } = await setup(page);
    try {
      await preference(page, 'enter');
      await page.reload();
      const composer = page.getByLabel('Your next turn');
      const send = page.getByRole('button', { name: 'Send', exact: true });
      await expect(send).toHaveAttribute('title', 'Send');
      await expect(composer).toHaveAttribute('enterkeyhint', 'enter');
      await composer.fill('A phone paragraph.');
      await composer.press('Enter');
      await expect(composer).toHaveValue('A phone paragraph.\n');
      await composer.dispatchEvent('beforeinput', { inputType: 'insertLineBreak' });
      expect((await page.request.get(`/api/chats/${id}`).then(r => r.json())).turns).toHaveLength(0);
      await send.click();
      await expect(composer).toHaveValue('');
      await expect(page.getByRole('button', { name: 'Regenerate response', exact: true })).toBeEnabled();
    } finally { await preference(page, initial.settings.enterKeyBehavior); }
  });
});
