import { createServer } from 'node:http';
import { test as isolatedTest } from './isolated-app';
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
  const port = settings.getByLabel('LAN port', { exact: true });
  await expect.poll(async () => lanStatusSchema.parse(await page.request.get('/api/application/lan').then(response => response.json())).settings.automatic).toBe(false);
  const portWrites: number[] = [];
  page.on('request', request => {
    if (request.url().endsWith('/api/application/lan') && request.method() === 'PUT') portWrites.push(request.postDataJSON().port);
  });
  await port.fill('80');
  await expect(port).toHaveValue('80');
  expect(await port.evaluate((input: HTMLInputElement) => input.validity.valid)).toBe(false);
  await port.fill('');
  await port.press('4');
  await port.press('1');
  await port.press('7');
  await port.press('4');
  await expect.poll(async () => lanStatusSchema.parse(await page.request.get('/api/application/lan').then(response => response.json())).settings.port).toBe(4174);
  expect(portWrites).toEqual([4174]);
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
    await expect(settings.getByRole('textbox', { name: 'Hostname address' })).toHaveValue('http://ore-browser.local:4174');
  } finally { releaseStatusRead(); }
  await expect.poll(() => statusReadReleased).toBe(true);
  await expect(settings.getByRole('alert')).toHaveCount(0);
  const status = lanStatusSchema.parse(await page.request.get('/api/application/lan').then(response => response.json()));
  if (status.runtime.state !== 'listening') throw new Error('LAN listener did not start.');
  const lanUrl = status.runtime.url;
  await expect(settings.getByRole('textbox', { name: 'Hostname address' })).toHaveValue(lanUrl);
  await expect(settings.getByRole('textbox', { name: 'Hostname address' })).toHaveAttribute('readonly', '');
  await expect(settings.getByRole('textbox', { name: 'Local IPv4 address', exact: true })).toHaveValue('http://127.0.0.1:4174');
  await expect(settings.getByRole('textbox', { name: 'Local IPv4 address', exact: true })).toHaveAttribute('readonly', '');
  await expect(settings).toContainText('Hostname — recommended');
  await expect(settings).toContainText('try this if the hostname does not work');
  // No routing or header rewriting: browser cookies and Origin belong to the
  // actual numeric URL and the request passes through the LAN listener.
  const numericContext = await browser.newContext();
  try {
    const numeric = await numericContext.newPage();
    await numeric.goto(status.runtime.ipv4Url);
    await numeric.getByLabel('Owner password').fill('browser-synthetic-password');
    await numeric.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(numeric.getByRole('navigation', { name: 'Workspace' })).toBeVisible();
    const created = await numeric.evaluate(async () => {
      const response = await fetch('/api/chats', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        title: 'Direct IPv4 browser story', targetInputTokens: 10000, connectionId: null, promptId: 'default', characterId: null, personaId: null,
      }) });
      return { status: response.status, body: await response.json() };
    });
    expect(created.status).toBe(200);
    const read = await numericContext.request.get(`${status.runtime.ipv4Url}/api/chats/${created.body.id}`);
    expect(read.ok()).toBe(true);
    expect((await read.json()).settings.title).toBe('Direct IPv4 browser story');
  } finally { await numericContext.close(); }
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
    await expect(settings.locator('input[readonly]')).toHaveCount(0);
  }
  expect(lanStatusSchema.parse(await page.request.get('/api/application/lan').then(response => response.json())).runtime.state).toBe('off');
  await settings.getByLabel('Select network automatically').check();
  await expect(settings.getByRole('combobox', { name: 'Local network' })).toHaveCount(0);
  await expect(settings.getByLabel('LAN port', { exact: true })).toHaveCount(0);
  await expect.poll(async () => lanStatusSchema.parse(await page.request.get('/api/application/lan').then(response => response.json())).settings)
    .toEqual({ enabled: false, automatic: true, interfaceId: null, port: 3000 });
  await page.reload();
  await page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(settings.getByLabel('Select network automatically')).toBeChecked();
  await expect(settings.getByLabel('LAN port', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('lan-settings-automatic.png'), fullPage: true });
});


async function freeLanPort() {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing LAN test port');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

for (const theme of ['dark', 'light', 'midnight-black'] as const) for (const width of [1440, 390]) {
  isolatedTest(`LAN addresses, hostname failure and mounted languages in ${theme} at ${width}px`, async ({ page, browserApp }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/');
    await page.getByLabel('Owner password').fill('browser-synthetic-password');
    await page.getByRole('button', { name: 'Create owner account', exact: true }).click();
    await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible();
    const headers = { Origin: browserApp.url };
    const read = async () => lanStatusSchema.parse(await page.request.get('/api/application/lan').then(response => response.json()));
    const appearance = await page.request.get('/api/application/appearance').then(response => response.json());
    const themed = await page.request.put('/api/application/appearance', { headers, data: { revision: appearance.revision, settings: { ...appearance.settings, theme } } });
    expect(themed.ok()).toBe(true);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const port = await freeLanPort();
    browserApp.setLanHostname('ore-' + 'w'.repeat(59));
    const save = async (enabled: boolean, activePort = port) => {
      const before = await read();
      const response = await page.request.put('/api/application/lan', { headers, data: { revision: before.revision, enabled, automatic: false, interfaceId: before.interfaces[0].id, port: activePort } });
      expect(response.ok(), await response.text()).toBe(true);
    };
    await save(true);
    try {
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'Phone / LAN access', exact: true }).click();
      const settings = page.locator('.lan-settings');
      await expect(settings.getByRole('textbox', { name: 'Hostname address', exact: true })).toHaveValue(`http://ore-${'w'.repeat(59)}.local:${port}`);
      await expect(settings.getByRole('textbox', { name: 'Local IPv4 address', exact: true })).toHaveValue(`http://127.0.0.1:${port}`);
      await expect(settings).toContainText('Hostname — recommended');
      await expect(settings).toContainText('try this if the hostname does not work');
      await settings.getByRole('textbox', { name: 'Hostname address', exact: true }).focus();
      await expect(settings.getByRole('textbox', { name: 'Hostname address', exact: true })).toBeFocused();
      expect(await settings.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await settings.screenshot({ path: testInfo.outputPath('addresses-en.png') });
      const language = page.getByRole('combobox', { name: 'Interface language', exact: true });
      await page.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'Language', exact: true }).click();
      await language.click();
      await page.getByRole('option', { name: 'Русский', exact: true }).click();
      await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
      await page.getByRole('navigation', { name: 'Разделы настроек' }).getByRole('button', { name: 'Телефон / локальная сеть', exact: true }).click();
      await expect(settings.getByRole('textbox', { name: 'Адрес по имени компьютера', exact: true })).toHaveValue(`http://ore-${'w'.repeat(59)}.local:${port}`);
      await expect(settings).toContainText('Имя компьютера — рекомендуется');
      await expect(settings).toContainText('попробуйте, если имя компьютера не работает');
      await settings.getByRole('textbox', { name: 'Адрес локального IPv4', exact: true }).focus();
      expect(await settings.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await settings.screenshot({ path: testInfo.outputPath('addresses-ru.png') });
      // A real rebind changes metadata. Polling must show IP-only service and
      // remove the old hostname without requiring a page reload.
      browserApp.setLanHostname(null);
      const fallbackPort = await freeLanPort();
      await save(true, fallbackPort);
      await expect(settings.getByRole('textbox', { name: 'Адрес локального IPv4', exact: true })).toHaveValue(`http://127.0.0.1:${fallbackPort}`, { timeout: 8000 });
      await expect(settings.getByRole('textbox', { name: 'Адрес по имени компьютера', exact: true })).toHaveCount(0);
      await expect(settings.getByRole('status')).toContainText('Не удалось прочитать локальное имя компьютера');
      await expect(settings.getByRole('alert')).toHaveCount(0);
      await settings.screenshot({ path: testInfo.outputPath('hostname-unavailable-ru.png') });
      await page.getByRole('navigation', { name: 'Разделы настроек' }).getByRole('button', { name: 'Язык', exact: true }).click();
      await page.getByRole('combobox', { name: 'Язык интерфейса', exact: true }).click();
      await page.getByRole('option', { name: 'English', exact: true }).click();
      await page.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'Phone / LAN access', exact: true }).click();
      await expect(settings.getByRole('status')).toContainText('The computer’s local hostname could not be read');
      await expect(settings.getByRole('textbox', { name: 'Local IPv4 address', exact: true })).toHaveValue(`http://127.0.0.1:${fallbackPort}`);
      await page.reload();
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'Phone / LAN access', exact: true }).click();
      await expect(settings.getByRole('textbox', { name: 'Local IPv4 address', exact: true })).toHaveValue(`http://127.0.0.1:${fallbackPort}`);
      await save(false);
      await expect(settings.locator('input[readonly]')).toHaveCount(0, { timeout: 8000 });
      const off = await read();
      await page.route('**/api/application/lan', route => route.fulfill({ json: { ...off, runtime: { state: 'unavailable', message: 'Synthetic unavailable transport' } } }));
      await expect(settings.getByRole('alert')).toContainText('Synthetic unavailable transport', { timeout: 8000 });
      await expect(settings.locator('input[readonly]')).toHaveCount(0);
      await settings.screenshot({ path: testInfo.outputPath('transport-unavailable-en.png') });
    } finally { await save(false); }
  });
}
