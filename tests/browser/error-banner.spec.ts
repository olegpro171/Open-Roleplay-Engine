import { selectLibraryCategory } from './library-card-helpers';
import { expect, test, type Page } from '@playwright/test';

test.use({ locale: 'en-US' });

async function openPersonaDraft(page: Page, name: string) {
  const session = await page.request.get('/api/session').then(response => response.json());
  await page.goto('/');
  await page.getByLabel('Owner password').fill('browser-synthetic-password');
  await page.getByRole('button', { name: session.setupRequired ? 'Create owner account' : 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: 'Libraries', exact: true }).click();
  await selectLibraryCategory(page, 'Personas');
  await page.getByRole('button', { name: 'New persona', exact: true }).click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
  const editor = page.getByRole('textbox', { name: 'Persona description', exact: true });
  await editor.fill('Keep this unsaved persona draft.');
  return editor;
}

test('warns about a lost server while retaining a rejected action, then recovers independently', async ({ page }) => {
  const editor = await openPersonaDraft(page, 'Keep rejection while offline');
  const rejection = 'Synthetic save rejection requiring a corrected action.';
  const warning = 'Cannot reach the server. Check that it is running.';
  const connected = page.getByRole('img', { name: 'Connected', exact: true });
  await expect(connected).toBeVisible();
  await page.route('**/api/library', route => route.request().method() === 'POST'
    ? route.fulfill({ status: 422, json: { message: rejection } }) : route.continue());
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: rejection })).toBeVisible();

  // Simulate loss of the server rather than an HTTP application rejection.
  const api = '**/api/**';
  await page.route(api, route => route.abort('connectionrefused'));
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  const connectionWarning = page.getByRole('dialog', { name: 'Warning', exact: true });
  await expect(connectionWarning).toContainText(warning);
  await expect(connectionWarning.getByRole('button')).toHaveText(['Dismiss']);
  await expect(page.getByRole('img', { name: 'Reconnecting', exact: true, includeHidden: true })).toBeVisible();
  await expect(page.locator('[role=alert]').filter({ hasText: rejection })).toBeVisible();

  await page.unroute(api);
  await expect(connectionWarning).toHaveCount(0);
  await expect(connected).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: rejection })).toBeVisible();
  await expect(editor).toHaveValue('Keep this unsaved persona draft.');
});

for (const width of [1280, 390]) {
  test(`offers retry for loading and dismiss for a rejected action with the same message at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    const editor = await openPersonaDraft(page, `Failure source ${width}`);
    const message = 'Cannot reach the server. Check that it is running.';
    const banner = page.locator('.error-banner').filter({ hasText: message });
    await page.route('**/api/library?*', route => route.fulfill({ status: 503, json: { message } }));
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(banner.getByRole('button', { name: 'Retry loading', exact: true })).toBeVisible();
    await expect(banner.getByRole('button', { name: 'Dismiss', exact: true })).toBeVisible();
    await expect(editor).toHaveValue('Keep this unsaved persona draft.');

    await page.unroute('**/api/library?*');
    const reload = page.waitForResponse(response => response.url().includes('/api/library?') && response.ok());
    await banner.getByRole('button', { name: 'Retry loading', exact: true }).click();
    await reload;
    await expect(banner).toHaveCount(0);
    await expect(editor).toHaveValue('Keep this unsaved persona draft.');

    await page.route('**/api/library', route => route.request().method() === 'POST'
      ? route.fulfill({ status: 422, json: { message } }) : route.continue());
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
    await expect(banner.getByRole('button')).toHaveCount(1);
    await expect(banner.getByRole('button', { name: 'Dismiss', exact: true })).toBeVisible();
    await expect(editor).toHaveValue('Keep this unsaved persona draft.');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('rejected-action.png') });
    await banner.getByRole('button', { name: 'Dismiss', exact: true }).click();
    await expect(banner).toHaveCount(0);
    await expect(editor).toHaveValue('Keep this unsaved persona draft.');
    await page.unroute('**/api/library');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(editor).toHaveCount(0);
    await expect(page.getByRole('heading', { name: `Failure source ${width}`, exact: true })).toBeVisible();
  });

  test(`retains the rejected action when background loading fails or reconnects at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const editor = await openPersonaDraft(page, `Retained rejection ${width}`);
    const message = 'Synthetic save rejection requiring a corrected action.';
    await page.route('**/api/library', route => route.request().method() === 'POST'
      ? route.fulfill({ status: 422, json: { message } }) : route.continue());
    await page.route('**/api/library?*', route => route.fulfill({ status: 503, json: { message: 'Synthetic background loading failure.' } }));
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
    const banner = page.locator('.error-banner');
    await expect(banner.locator('span')).toHaveText(message);
    await expect(banner.getByRole('button')).toHaveCount(1);
    await expect(banner.getByRole('button', { name: 'Dismiss', exact: true })).toBeVisible();
    await expect(editor).toHaveValue('Keep this unsaved persona draft.');

    await page.unroute('**/api/library?*');
    const recovered = page.waitForResponse(response => response.url().includes('/api/library?') && response.ok());
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await recovered;
    await expect(banner.locator('span')).toHaveText(message);
    await banner.getByRole('button', { name: 'Dismiss', exact: true }).click();
    await expect(banner).toHaveCount(0);
    await expect(editor).toHaveValue('Keep this unsaved persona draft.');
  });
}

test('reports browser offline immediately while an existing event stream is still open', async ({ page }) => {
  const editor = await openPersonaDraft(page, 'Keep draft during network loss');
  await expect(page.getByRole('img', { name: 'Connected', exact: true })).toBeVisible();
  const api = '**/api/**';
  await page.route(api, route => route.abort('internetdisconnected'));
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  const warning = page.getByRole('dialog', { name: 'Warning', exact: true });
  await expect(warning).toContainText('Cannot reach the server. Check that it is running.');
  await warning.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(warning).toHaveCount(0);
  await expect(editor).toHaveValue('Keep this unsaved persona draft.');
  await page.unroute(api);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.getByRole('img', { name: 'Connected', exact: true })).toBeVisible();
  await expect(warning).toHaveCount(0);
});

test('detects a silent LAN outage while idle and replaces the stalled stream', async ({ page }) => {
  test.setTimeout(45_000);
  // Model a socket which opened successfully and never reports an error or delivers another byte.
  await page.addInitScript(() => {
    const NativeSource = window.EventSource;
    window.EventSource = class extends NativeSource {
      constructor(url: string | URL) {
        super(url);
        this.addEventListener('heartbeat', event => event.stopImmediatePropagation());
      }
    };
  });
  const editor = await openPersonaDraft(page, 'Sleeping host');
  const connected = page.getByRole('img', { name: 'Connected', exact: true });
  await expect(connected).toBeVisible();
  const api = '**/api/**';
  await page.route(api, route => route.abort('connectionrefused'));
  const warning = page.getByRole('dialog', { name: 'Warning', exact: true });
  await expect(warning).toContainText('Cannot reach the server', { timeout: 32_000 });
  await warning.getByRole('button', { name: 'Dismiss' }).click();
  await expect(editor).toBeEditable();
  await page.unroute(api);
  await expect(connected).toBeVisible({ timeout: 10_000 });
  await expect(editor).toHaveValue('Keep this unsaved persona draft.');
});

test('reports an unanswered session check on startup and recovers without reloading', async ({ page }) => {
  await page.route('**/api/session', () => {});
  await page.goto('/');
  const warning = page.getByRole('dialog', { name: 'Warning', exact: true });
  await expect(warning).toContainText('Cannot reach the server', { timeout: 10_000 });
  await page.unroute('**/api/session');
  await expect(page.getByLabel('Owner password')).toBeVisible();
  await expect(warning).toHaveCount(0);
});

test('checks a restored page even when the browser still reports Wi-Fi', async ({ page }) => {
  const editor = await openPersonaDraft(page, 'Resumed phone');
  await page.route('**/api/session', () => {});
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  const warning = page.getByRole('dialog', { name: 'Warning', exact: true });
  await expect(warning).toContainText('Cannot reach the server', { timeout: 9_000 });
  await page.unroute('**/api/session');
  await expect(warning).toHaveCount(0);
  await expect(editor).toHaveValue('Keep this unsaved persona draft.');
});

async function controlWorkspaceTimeouts(page: Page) {
  // Abort the real browser fetch on demand while leaving session and observer timing alone.
  await page.addInitScript(() => {
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    let workspaceDeadline: AbortController | undefined;
    AbortSignal.timeout = milliseconds => {
      if (milliseconds !== 15_000) return timeout(milliseconds);
      workspaceDeadline = new AbortController();
      return workspaceDeadline.signal;
    };
    document.addEventListener('expire-workspace-read', () => {
      workspaceDeadline?.abort(new DOMException('Synthetic workspace timeout', 'TimeoutError'));
    });
  });
}

const expireWorkspaceRead = (page: Page) => page.evaluate(() => document.dispatchEvent(new Event('expire-workspace-read')));
const returnToPage = (page: Page) => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
const libraryRead = '**/api/library?*';
const notifyLibraryActivity = (page: Page) => page.request.post('/__test/change', {
  data: { kind: 'chat', chatId: 'other-branch', detail: 'state' },
});

test('uses the queued resume refresh after an in-flight read stalls', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await controlWorkspaceTimeouts(page);
  const editor = await openPersonaDraft(page, 'Queued resume');
  let reads = 0;
  await page.route(libraryRead, route => {
    reads++;
    if (reads > 1) return route.continue();
  });
  await notifyLibraryActivity(page);
  await expect.poll(() => reads).toBe(1);
  await returnToPage(page);
  const recovered = page.waitForResponse(response => /\/api\/chats\/[^/]+\/story\?/.test(response.url()) && response.ok());
  await expireWorkspaceRead(page);
  await recovered;
  await expect(page.getByRole('alert').filter({ hasText: 'Loading timed out.' })).toHaveCount(0);
  await expect(editor).toHaveValue('Keep this unsaved persona draft.');
  expect(reads).toBe(2);
});

test('retries a stalled Story read after restoring the page', async ({ page }) => {
  await controlWorkspaceTimeouts(page);
  const editor = await openPersonaDraft(page, 'Restored Story');
  let reads = 0;
  const storyRead = /\/api\/chats\/[^/]+\/story\?/;
  await page.route(storyRead, route => {
    reads++;
    if (reads > 1) return route.continue();
  });
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await expect.poll(() => reads).toBe(1);
  const recovered = page.waitForResponse(response => storyRead.test(response.url()) && response.ok(), { timeout: 5_000 });
  await expireWorkspaceRead(page);
  await recovered;
  await expect(page.getByRole('alert').filter({ hasText: 'Loading timed out.' })).toHaveCount(0);
  await expect(editor).toHaveValue('Keep this unsaved persona draft.');
  expect(reads).toBe(2);
});

test('offers manual retry after the resume read and its retry both stall', async ({ page }) => {
  await controlWorkspaceTimeouts(page);
  const editor = await openPersonaDraft(page, 'Slow library');
  let reads = 0;
  await page.route(libraryRead, () => { reads++; });
  await returnToPage(page);
  await expect.poll(() => reads).toBe(1);
  await expireWorkspaceRead(page);
  await expect.poll(() => reads).toBe(2);
  const banner = page.getByRole('alert').filter({ hasText: 'Loading timed out.' });
  await expect(banner).toHaveCount(0);
  await expireWorkspaceRead(page);
  const retry = banner.getByRole('button', { name: 'Retry loading', exact: true });
  await expect(retry).toBeVisible();
  await expect(banner.getByRole('button', { name: 'Dismiss', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Warning' })).toHaveCount(0);
  expect(reads).toBe(2);
  await page.unroute(libraryRead);
  const recovered = page.waitForResponse(response => response.url().includes('/api/library?') && response.ok());
  await retry.click();
  await recovered;
  await expect(banner).toHaveCount(0);
  await expect(editor).toHaveValue('Keep this unsaved persona draft.');
});

test('clears a workspace timeout when the affected data later loads', async ({ page }) => {
  await controlWorkspaceTimeouts(page);
  const editor = await openPersonaDraft(page, 'Automatic recovery');
  const stalled = page.waitForRequest(libraryRead);
  await page.route(libraryRead, () => {});
  await notifyLibraryActivity(page);
  await stalled;
  await expireWorkspaceRead(page);
  const banner = page.getByRole('alert').filter({ hasText: 'Loading timed out.' });
  await expect(banner).toBeVisible();

  const settingsRead = page.waitForResponse(response => response.url().endsWith('/api/application/appearance') && response.ok());
  await page.request.post('/__test/change', { data: { kind: 'settings', setting: 'appearance' } });
  await settingsRead;
  await expect(banner).toBeVisible();

  await page.unroute(libraryRead);
  await notifyLibraryActivity(page);
  await expect(banner).toHaveCount(0);
  await expect(editor).toHaveValue('Keep this unsaved persona draft.');
});
