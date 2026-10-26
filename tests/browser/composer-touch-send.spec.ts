import { devices, expect, type Page } from '@playwright/test';
import { appearanceStatusSchema, type Theme } from '../../src/shared/appearance';
import { test } from './isolated-app';

async function setup(page: Page, origin: string, theme: Theme) {
  await page.addInitScript(() => {
    const viewport = window.visualViewport;
    if (!viewport) throw new Error('Visual viewport is required for this test');
    let loss = 0;
    Object.defineProperty(viewport, 'height', { get: () => window.innerHeight - loss });
    Object.defineProperty(viewport, 'scale', { get: () => 1 });
    window.addEventListener('test-keyboard-loss', event => {
      if (!(event instanceof CustomEvent)) return;
      loss = event.detail;
      viewport.dispatchEvent(new Event('resize'));
    });
  });
  await page.goto('/');
  await page.getByLabel('Owner password').fill('browser-synthetic-password');
  await page.getByRole('button', { name: 'Create owner account', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible();
  const headers = { Origin: origin };
  const appearance = appearanceStatusSchema.parse(await page.request.get('/api/application/appearance').then(r => r.json()));
  const changed = await page.request.put('/api/application/appearance', { headers, data: {
    revision: appearance.revision, settings: { ...appearance.settings, theme },
  } });
  expect(changed.ok()).toBe(true);
  const { endpoint } = await page.request.get('/__test/endpoint').then(r => r.json());
  const library = await page.request.get('/api/library').then(r => r.json());
  const connection = await page.request.post('/api/library', { headers, data: {
    revision: library.revision, kind: 'connections', data: {
      name: 'Touch test model', endpoint, model: 'synthetic-roleplay', contextWindow: 100_000, maxOutputTokens: 1_000, customParameters: {},
    },
  } });
  expect(connection.ok()).toBe(true);
  const { id: connectionId } = await connection.json();
  const created = await page.request.post('/api/chats', { headers, data: {
    title: 'Touch test story', connectionId, promptId: 'default', targetInputTokens: 20_000,
    characterId: null, personaId: null, contextPresetId: null,
  } });
  expect(created.ok()).toBe(true);
  const { id }: { id: string } = await created.json();
  await page.evaluate(id => localStorage.setItem('roleplay-chat', id), id);
  await page.reload();
  await expect(page.getByLabel('Your next turn')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  return id;
}

const device = devices['iPhone 13'];
test.use({ userAgent: device.userAgent, viewport: device.viewport, isMobile: true, hasTouch: true, locale: 'en-US' });

for (const theme of ['dark', 'light', 'midnight-black'] as const) {
  test(`keyboard-open taps submit once and preserve recovery in ${theme}`, async ({ page, browserApp, browserName }, testInfo) => {
    const id = await setup(page, browserApp.url, theme);
    const input = page.getByLabel('Your next turn');
    const send = page.getByRole('button', { name: 'Send', exact: true });
    const commands: string[] = [];
    page.on('request', request => {
      if (request.method() === 'POST' && request.url() === `${browserApp.url}/api/chats/${id}/turns`) commands.push(request.postData() ?? '');
    });
    const openKeyboard = async (draft: string) => {
      await input.fill(draft);
      await input.focus();
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('test-keyboard-loss', { detail: 300 })));
      await expect(page.locator('.composer')).toHaveAttribute('data-keyboard-visible', 'true');
      await expect(send).toBeEnabled();
    };
    const point = async (fraction: number) => {
      const bounds = await send.boundingBox();
      if (!bounds) throw new Error('Send must be visible');
      return { x: bounds.x + bounds.width * fraction, y: bounds.y + bounds.height * fraction };
    };
    const tap = async (fraction: number) => {
      const { x, y } = await point(fraction);
      await page.touchscreen.tap(x, y);
    };

    await openKeyboard('I open the tower door.');
    await page.screenshot({ path: testInfo.outputPath('phone-keyboard-open.png') });
    // A press alone must neither submit nor move Send before the release.
    const originalBounds = await send.boundingBox();
    const center = await point(.5);
    await page.mouse.move(center.x, center.y);
    await page.mouse.down();
    await expect(input).toBeFocused();
    expect(await send.boundingBox()).toEqual(originalBounds);
    expect(commands).toHaveLength(0);
    await page.mouse.move(20, 160);
    await page.mouse.up();
    expect(commands).toHaveLength(0);
    await expect(input).toHaveValue('I open the tower door.');

    await tap(.5);
    await expect(input).toHaveValue('');
    await expect(page.getByRole('button', { name: 'Regenerate response', exact: true })).toBeEnabled();
    expect(commands).toHaveLength(1);
    const saved: unknown = await page.request.get(`/api/chats/${id}`).then(r => r.json());
    expect(saved).toMatchObject({ turns: [{ user: { text: 'I open the tower door.' }, complete: true }] });
    await expect.poll(async () => page.request.get('/__test/requests').then(r => r.json())).toHaveLength(1);

    // Challenge the same hit-target failure away from the center, including a failed save and explicit retry.
    await openKeyboard('I wait by the lantern.');
    await page.route(`**/api/chats/${id}/turns`, route => route.fulfill({ status: 503, json: { message: 'Synthetic send failure.' } }));
    await tap(.7);
    await expect(page.getByRole('alert')).toContainText('Synthetic send failure.');
    await expect(send).toBeEnabled();
    await expect(input).toHaveValue('I wait by the lantern.');
    await page.screenshot({ path: testInfo.outputPath('phone-send-failed.png') });
    expect(commands).toHaveLength(2);
    await expect.poll(async () => page.request.get('/__test/requests').then(r => r.json())).toHaveLength(1);
    await page.unroute(`**/api/chats/${id}/turns`);
    await page.request.post('/__test/mode', { data: { mode: 'hold' } });
    await openKeyboard('I wait by the lantern.');
    await tap(.7);
    await expect(input).toHaveValue('');
    await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeEnabled();
    await expect(input).toBeEditable();
    await input.fill('Keep the next draft.');
    await input.focus();
    await expect(send).toBeDisabled();
    await page.screenshot({ path: testInfo.outputPath('phone-send-blocked.png') });
    await tap(.5);
    expect(commands).toHaveLength(3);
    await expect(input).toHaveValue('Keep the next draft.');
    await expect.poll(async () => page.request.get('/__test/requests').then(r => r.json())).toHaveLength(2);
    await page.request.post('/__test/finish');
    await expect(page.getByRole('button', { name: 'Regenerate response', exact: true })).toBeEnabled();

    // Explicit keyboard focus and native button activation remain available.
    await page.request.post('/__test/mode', { data: { mode: 'normal' } });
    // WebKit's default Tab traversal skips buttons; Option+Tab includes them.
    await input.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab');
    await expect(send).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath('phone-keyboard-focused-send.png') });
    await send.press('Space');
    await expect(input).toHaveValue('');
    await expect(page.getByRole('button', { name: 'Regenerate response', exact: true })).toBeEnabled();
    expect(commands).toHaveLength(4);
    const final: unknown = await page.request.get(`/api/chats/${id}`).then(r => r.json());
    expect(final).toMatchObject({ turns: [
      { user: { text: 'I open the tower door.' }, complete: true },
      { user: { text: 'I wait by the lantern.' }, complete: true },
      { user: { text: 'Keep the next draft.' }, complete: true },
    ] });
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('test-keyboard-loss', { detail: 0 })));
    await page.setViewportSize({ width: 1100, height: 900 });
    await input.fill('Unsent wide-screen draft.');
    await expect(send).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath('wide-composer.png') });
  });
}
