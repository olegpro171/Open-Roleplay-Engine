import { expect, test } from '@playwright/test';
import type { ChatSnapshot } from '../../src/shared/contracts';
import { lanStatusSchema } from '../../src/shared/lan';

test('enables LAN from Application Settings and uses the app on an insecure phone origin', async ({ page, browser, request }, testInfo) => {
  const session = await request.get('/api/session').then(response => response.json());
  await page.goto('/');
  await page.getByLabel('Owner password').fill('browser-synthetic-password');
  await page.getByRole('button', { name: session.setupRequired ? 'Create owner account' : 'Sign in', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible();
  const command = async (path: string, data: unknown) => {
    const response = await page.request.post(path, { headers: { Origin: 'http://127.0.0.1:4173' }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const { endpoint } = await request.get('/__test/endpoint').then(response => response.json());
  const library = await page.request.get('/api/library').then(response => response.json());
  const connection = await command('/api/library', { revision: library.revision, kind: 'connections', data: { name: 'LAN browser model', endpoint, model: 'synthetic-roleplay', contextWindow: 32000, maxOutputTokens: 1000, customParameters: {} } });
  const chat = await command('/api/chats', { title: 'LAN browser proof', targetInputTokens: 10000, connectionId: connection.id, promptId: 'default', characterId: null, personaId: null });
  await page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('region', { name: 'Phone / LAN access', exact: true });
  await expect(settings.getByLabel('Enable HTTP access from the local network')).not.toBeChecked();
  await expect(settings.getByLabel('Select network automatically')).toBeChecked();
  await expect(settings.getByRole('combobox', { name: 'Local network' })).toHaveCount(0);
  await expect(settings.getByLabel('LAN port', { exact: true })).toHaveCount(0);
  await settings.getByLabel('Select network automatically').uncheck();
  await expect(settings.getByRole('combobox', { name: 'Local network' })).toContainText('browser-fixture');
  await settings.getByLabel('LAN port', { exact: true }).fill('4174');
  let statusReadHeld = false, statusReadReleased = false;
  let releaseStatusRead: () => void = () => {};
  const heldRead = new Promise<void>(resolve => { releaseStatusRead = resolve; });
  await page.route('**/api/application/lan', async route => {
    if (route.request().method() !== 'GET' || statusReadHeld) { await route.continue(); return; }
    statusReadHeld = true;
    await heldRead;
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Obsolete status-read failure' }) });
    statusReadReleased = true;
  });
  try {
    await expect.poll(() => statusReadHeld, { timeout: 8000 }).toBe(true);
    await settings.getByLabel('Enable HTTP access from the local network').check();
    await settings.getByRole('button', { name: 'Save LAN settings', exact: true }).click();
    await expect(settings.getByRole('textbox', { name: 'Phone address' })).toHaveValue('http://ore-browser.local:4174');
  } finally { releaseStatusRead(); }
  await expect.poll(() => statusReadReleased).toBe(true);
  await expect(settings.getByRole('alert')).toHaveCount(0);
  const status = lanStatusSchema.parse(await page.request.get('/api/application/lan').then(response => response.json()));
  if (status.runtime.state !== 'listening') throw new Error('LAN listener did not start.');
  const lanUrl = status.runtime.url;
  await expect(settings.getByRole('textbox', { name: 'Phone address' })).toHaveValue(lanUrl);
  await expect(settings.getByRole('textbox', { name: 'Phone address' })).toHaveAttribute('readonly', '');
  await page.screenshot({ path: testInfo.outputPath('lan-settings-desktop.png'), fullPage: true });
  await page.reload();
  await page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(settings.getByLabel('Enable HTTP access from the local network')).toBeChecked();

  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  // Route a synthetic, genuinely insecure origin to the owned LAN listener.
  // Host/origin admission is tested separately over real sockets in lan.test.ts.
  await context.route('http://ore-phone.invalid/**', async route => {
    const source = new URL(route.request().url());
    if (source.pathname === '/api/events') {
      await route.fulfill({ contentType: 'text/event-stream', body: 'data: {}\n\n' });
      return;
    }
    const headers = await route.request().allHeaders();
    headers.host = new URL(lanUrl).host;
    if (headers.origin) headers.origin = lanUrl;
    const target = `http://127.0.0.1:${new URL(lanUrl).port}`;
    const response = await route.fetch({ url: `${target}${source.pathname}${source.search}`, headers });
    await route.fulfill({ response });
  });
  const phone = await context.newPage();
  try {
    await phone.goto('http://ore-phone.invalid/');
    expect(await phone.evaluate(() => window.isSecureContext)).toBe(false);
    expect(await phone.evaluate(() => typeof crypto.randomUUID)).toBe('undefined');
    await phone.getByLabel('Owner password').fill('browser-synthetic-password');
    await phone.getByRole('button', { name: 'Sign in', exact: true }).click();
    await phone.getByRole('button', { name: 'Libraries', exact: true }).click();
    await phone.getByRole('article').filter({ has: phone.getByRole('heading', { name: 'LAN browser proof', exact: true }) }).click();
    await phone.getByLabel('Your next turn').fill('I open the gate from my phone.');
    await phone.reload();
    await expect(phone.getByLabel('Your next turn')).toHaveValue('I open the gate from my phone.');
    await phone.getByRole('button', { name: 'Send', exact: true }).click();
    const state = () => page.request.get(`/api/chats/${chat.id}`).then(response => response.json() as Promise<ChatSnapshot>);
    await expect.poll(async () => (await state()).turns[0]?.complete).toBe(true);
    await phone.reload();
    await expect(phone.getByRole('article', { name: 'Turn 1', exact: true })).toContainText('The lantern flickers.');
    await phone.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Settings', exact: true }).click();
    const phoneSettings = phone.getByRole('region', { name: 'Phone / LAN access', exact: true });
    await expect(phoneSettings.getByLabel('Enable HTTP access from the local network')).toBeDisabled();
    await expect(phoneSettings).toContainText('Change LAN settings from ORE’s local address');
    expect(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await phone.screenshot({ path: testInfo.outputPath('lan-settings-phone.png'), fullPage: true });
  } finally {
    await context.close();
    await settings.getByLabel('Enable HTTP access from the local network').uncheck();
    await settings.getByRole('button', { name: 'Save LAN settings', exact: true }).click();
    await expect(settings.getByRole('textbox', { name: 'Phone address' })).toHaveCount(0);
  }
  expect(lanStatusSchema.parse(await page.request.get('/api/application/lan').then(response => response.json())).runtime.state).toBe('off');
  await settings.getByLabel('Select network automatically').check();
  await expect(settings.getByRole('combobox', { name: 'Local network' })).toHaveCount(0);
  await expect(settings.getByLabel('LAN port', { exact: true })).toHaveCount(0);
  await settings.getByRole('button', { name: 'Save LAN settings', exact: true }).click();
  await expect.poll(async () => lanStatusSchema.parse(await page.request.get('/api/application/lan').then(response => response.json())).settings)
    .toEqual({ enabled: false, automatic: true, interfaceId: null, port: 3000 });
  await page.reload();
  await page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(settings.getByLabel('Select network automatically')).toBeChecked();
  await expect(settings.getByLabel('LAN port', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('lan-settings-automatic.png'), fullPage: true });
});
