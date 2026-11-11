import { expect, test, type Page } from '@playwright/test';

async function openPersonaDraft(page: Page, name: string) {
  const session = await page.request.get('/api/session').then(response => response.json());
  await page.goto('/');
  await page.getByLabel('Owner password').fill('browser-synthetic-password');
  await page.getByRole('button', { name: session.setupRequired ? 'Create owner account' : 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: 'Libraries', exact: true }).click();
  await page.getByRole('navigation', { name: 'Library categories' }).getByRole('button', { name: 'Personas', exact: true }).click();
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
  const connectionBanner = page.getByRole('alert').filter({ hasText: warning });
  await expect(connectionBanner.getByRole('button', { name: 'Retry loading' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Reconnecting', exact: true })).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: rejection })).toBeVisible();

  await page.unroute(api);
  await expect(connectionBanner).toHaveCount(0);
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
  const warning = page.getByRole('alert').filter({ hasText: 'Cannot reach the server. Check that it is running.' });
  await expect(warning).toBeVisible();
  await expect(editor).toHaveValue('Keep this unsaved persona draft.');
  await warning.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(warning).toHaveCount(0);
  await page.unroute(api);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.getByRole('img', { name: 'Connected', exact: true })).toBeVisible();
  await expect(warning).toHaveCount(0);
});
