import { devices, expect, test, type Page } from '@playwright/test';
import { openChatTool } from './chat-tools';
import type { ChatSnapshot } from '../../src/shared/contracts';
import type { LibrarySnapshot } from '../../src/shared/library';

async function setup(page: Page, targetInputTokens = 20_000) {
  const session = await page.request.get('/api/session').then(response => response.json());
  await page.goto('/');
  await page.getByLabel('Owner password').waitFor();
  await page.screenshot({ path: test.info().outputPath('login.png') });
  await page.getByLabel('Owner password').fill('browser-synthetic-password');
  await page.getByRole('button', { name: session.setupRequired ? 'Create owner account' : 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Libraries', exact: true })).toBeVisible();
  const post = async (url: string, data: unknown, method = 'POST') => {
    const response = await page.request.fetch(url, { method, headers: { Origin: 'http://127.0.0.1:4173' }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const { endpoint } = await page.request.get('/__test/endpoint').then(response => response.json());
  const library: LibrarySnapshot = await page.request.get('/api/library').then(response => response.json());
  const connection = await post('/api/library', { kind: 'connections', revision: library.revision, data: {
    name: 'Sweep mock', endpoint, model: 'synthetic-roleplay', contextWindow: 100_000, maxOutputTokens: 1000, customParameters: {},
  } });
  const chat = await post('/api/chats', { title: `Sweep ${test.info().testId}`, connectionId: connection.id,
    promptId: 'default', characterId: null, personaId: null, contextPresetId: 'default-context', targetInputTokens });
  let snapshot: ChatSnapshot = await page.request.get(`/api/chats/${chat.id}`).then(response => response.json());
  // One long completed turn makes its input editor start well above the controls.
  await post(`/api/chats/${chat.id}/history`, { revision: snapshot.revision, turns: [{ complete: true,
    user: 'The traveller enters the tower.\n'.repeat(15), assistant: 'The keeper describes the distant mountains.\n'.repeat(60),
  }] }, 'PUT');
  snapshot = await page.request.get(`/api/chats/${chat.id}`).then(response => response.json());
  await page.evaluate(id => localStorage.setItem('roleplay-chat', id), chat.id);
  await page.reload();
  await expect(page.getByLabel('Your next turn')).toBeVisible();
  return snapshot;
}

for (const width of [1440, 390]) test(`next request updates automatically and retries failed previews at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 });
  await setup(page, 300);
  await openChatTool(page, 'Request inspector');
  await expect(page.getByRole('status').filter({ hasText: 'The estimated input exceeds your target.' })).toBeVisible();
  await page.route('**/preview', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Preview temporarily unavailable.' }) }));
  await page.getByRole('button', { name: 'Story', exact: true }).click();
  await page.getByLabel('Your next turn').fill('A new unsent turn.');
  await openChatTool(page, 'Request inspector');
  await expect(page.getByRole('combobox', { name: 'Inspect request', exact: true })).toHaveText('Next request');
  await expect(page.getByRole('status').filter({ hasText: 'Preview temporarily unavailable.' })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('preview-error.png') });
  await page.unroute('**/preview');
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/preview', async route => {
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response });
  });
  const refreshed = page.waitForResponse(response => response.url().endsWith('/preview') && response.ok());
  try {
    await page.getByRole('button', { name: 'Retry preview', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Retry preview', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Prompt peek', exact: true })).toBeDisabled();
  } finally { release(); }
  const response = await refreshed;
  const result = await response.json();
  expect(result.body.messages.at(-1).content).toBe('A new unsent turn.');
  await expect(page.getByRole('button', { name: 'Retry preview', exact: true })).toHaveCount(0);
  await expect(page.getByText('Preview temporarily unavailable.', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Prompt peek', exact: true })).toBeEnabled();
  await page.screenshot({ path: test.info().outputPath('next-request.png') });
  await page.getByRole('button', { name: 'Review memory', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Make room for the next chapter' })).toBeVisible();
});

for (const width of [1440, 390]) test(`turn editors reveal their start and allow scrolling to their end at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 });
  const before = await setup(page);
  const turn = page.getByRole('article', { name: 'Turn 1', exact: true });
  for (const [action, label] of [['Edit input', 'Edit user text'], ['Edit response', 'Edit assistant text']]) {
    await turn.getByRole('button', { name: action, exact: true }).click();
    const editor = page.getByRole('textbox', { name: label, exact: true });
    await expect.poll(() => editor.evaluate(field => {
      const transcript = field.closest('.transcript');
      if (!transcript) return false;
      return field.getBoundingClientRect().top >= transcript.getBoundingClientRect().top - 1
        && field.getBoundingClientRect().top < transcript.getBoundingClientRect().bottom - 50;
    })).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`${action}-start.png`) });
    await editor.fill('Unsaved edited line.\n'.repeat(100));
    if (action === 'Edit response') {
      // A real wheel scroll must reach the last response editor's end.
      const transcript = page.locator('.transcript');
      await transcript.hover({ position: { x: 10, y: 100 } });
      await page.mouse.wheel(0, 20_000);
      await expect(page.getByRole('button', { name: 'Save edit', exact: true })).toBeInViewport();
      await page.screenshot({ path: test.info().outputPath('response-editor-end.png') });
    }
    await page.getByRole('button', { name: 'Cancel edit', exact: true }).click();
  }
  const saved: ChatSnapshot = await page.request.get(`/api/chats/${before.id}`).then(response => response.json());
  expect(saved.turns).toEqual(before.turns);
});

test('individual timeline turns have immediate hints and the context shortcut opens the saved preset', async ({ page }) => {
  const snapshot = await setup(page);
  await openChatTool(page, 'Inspect memory');
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.getByRole('button', { name: 'Edit context preset', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath(`context-preset-shortcut-${width}.png`) });
  }
  await page.locator('.turn-tick').first().hover();
  await expect(page.getByRole('tooltip')).toContainText('Turn 1');
  await page.screenshot({ path: test.info().outputPath('memory-tooltip.png') });
  await page.getByLabel('Input target', { exact: true }).fill('21000');
  await expect(page.getByRole('button', { name: 'Edit context preset', exact: true })).toBeDisabled();
  await page.getByLabel('Input target', { exact: true }).fill(String(snapshot.settings.targetInputTokens));
  await page.getByRole('button', { name: 'Edit context preset', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue(snapshot.context.preset?.name ?? '');
  await expect(page.getByLabel('Minimum verbatim turns', { exact: true })).toBeVisible();
});

test.describe('iPhone turn editing', () => {
  const device = devices['iPhone 13'];
  test.use({ userAgent: device.userAgent, viewport: device.viewport, isMobile: device.isMobile,
    hasTouch: device.hasTouch, deviceScaleFactor: device.deviceScaleFactor });
  test('touch scrolling reaches the last response editor controls', async ({ page }) => {
    await setup(page);
    await page.getByRole('button', { name: 'Edit response', exact: true }).click();
    const scroller = page.locator('.transcript');
    await scroller.evaluate(node => { node.scrollTop = node.scrollHeight - node.clientHeight - 160; });
    const bounds = await scroller.boundingBox();
    if (!bounds) throw new Error('Transcript must be visible');
    const session = await page.context().newCDPSession(page);
    try {
      const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height - 50;
      await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      for (let step = 1; step <= 8; step++) await session.send('Input.dispatchTouchEvent', {
        type: 'touchMove', touchPoints: [{ x, y: y - step * 25 }],
      });
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await expect(page.getByRole('button', { name: 'Save edit', exact: true })).toBeInViewport();
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
    } finally { await session.detach(); }
  });
});
