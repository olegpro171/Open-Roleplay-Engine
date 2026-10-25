import { openLibraryActions } from './library-card-helpers';
import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { LibrarySnapshot } from '../../src/shared/library';

async function login(page: Page) {
  const session = await page.request.get('/api/session').then(response => response.json());
  await page.goto('/');
  await page.getByLabel('Owner password').fill('browser-synthetic-password');
  await page.getByRole('button', { name: session.setupRequired ? 'Create owner account' : 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
}
async function fixture(page: Page, name: string) {
  const library: LibrarySnapshot = await page.request.get('/api/library').then(response => response.json());
  const session = await page.request.get('/api/session');
  const result = await page.request.post('/api/library', {
    headers: { Origin: 'http://127.0.0.1:4173', 'X-ORE-Epoch': session.headers()['x-ore-epoch'] ?? 'initial' },
    data: { kind: 'connections', revision: library.revision,
      data: { name, endpoint: 'http://localhost:9999/v1', model: 'synthetic-export-model', contextWindow: 64000, maxOutputTokens: 1234, requestUsage: false, customParameters: { temperature: 0.8 } },
      apiKey: 'synthetic-profile-export-secret',
    },
  });
  expect(result.ok()).toBe(true);
  await page.getByRole('button', { name: 'Libraries', exact: true }).click();
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  return (await result.json()).id as string;
}
async function library(page: Page): Promise<LibrarySnapshot> {
  return page.request.get('/api/library').then(response => response.json());
}

for (const width of [1440, 390]) test(`Connection export/import with optional key and password retry at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 844 });
  await login(page);
  for (const includeApiKey of [false, true]) {
    const name = `Portable Connection ${width} key ${includeApiKey}`;
    const originalId = await fixture(page, name);
    const original = (await library(page)).connections.find(item => item.id === originalId);
    if (!original) throw new Error('Missing synthetic Connection');
    const row = page.getByRole('article').filter({ has: page.getByRole('heading', { name, exact: true }) }).first();
    await (await openLibraryActions(page, row)).getByRole('menuitem', { name: 'Export...', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Export Connection', exact: true });
    await expect(dialog.getByRole('heading', { level: 2 })).toBeFocused();
    await expect(dialog.getByLabel('Include API key')).not.toBeChecked();
    await expect(dialog.getByText(/This file will contain/)).toHaveCount(0);
    const password = includeApiKey ? '  Пароль 🔑 exact  ' : '';
    if (includeApiKey) {
      await dialog.getByLabel('Include API key').check();
      await expect(dialog.getByRole('alert')).toContainText('anyone with ORE can extract the key');
      await dialog.getByLabel('File password (optional)', { exact: true }).fill(password);
      await page.screenshot({ path: testInfo.outputPath('export-key-warning.png') });
    }
    const downloading = page.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    const download = await downloading;
    expect(download.url()).toMatch(/^http:\/\/127\.0\.0\.1:4173\/api\/downloads\/[0-9a-f]{64}$/);
    const path = await download.path();
    if (!path) throw new Error('Missing downloaded profile');
    expect(download.suggestedFilename()).toMatch(/\.oreconnection$/);
    const bytes = await readFile(path);
    expect(await download.failure()).toBeNull();
    expect(bytes.includes(Buffer.from('synthetic-profile-export-secret'))).toBe(false);
    await expect(dialog).toHaveCount(0);
    const before = await library(page);
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Import Connection...', exact: true }).click();
    if (width > 800) await page.getByRole('button', { name: 'Drop file here or click to browse', exact: true }).click();
    await (await chooser).setFiles({ name: download.suggestedFilename(), mimeType: 'application/octet-stream', buffer: bytes });
    const importing = page.getByRole('dialog', { name: 'Import Connection', exact: true });
    await expect(importing.getByLabel('File password (if set)', { exact: true })).toHaveValue('');
    await importing.getByLabel('File password (if set)', { exact: true }).fill('wrong');
    await importing.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(importing.getByRole('alert')).toContainText('Check the password and try again');
    await expect(importing.getByLabel('File password (if set)', { exact: true })).toHaveValue('wrong');
    expect((await library(page)).connections).toEqual(before.connections);
    await page.screenshot({ path: testInfo.outputPath(`import-retry-${includeApiKey}.png`) });
    await importing.getByLabel('File password (if set)', { exact: true }).fill(password);
    await importing.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(importing).toHaveCount(0);
    await expect(page.getByRole('heading', { name, exact: true })).toHaveCount(2);
    const after = await library(page);
    const imported = after.connections.find(item => !before.connections.some(previous => previous.id === item.id));
    expect(imported).toEqual({ ...original, id: imported?.id, revision: 0, hasApiKey: includeApiKey });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

test('Connection dialogs cancel without requests, clear secrets, and block duplicate pending submissions', async ({ page }) => {
  await login(page);
  const name = 'Connection dialog controls';
  await fixture(page, name);
  const row = page.getByRole('article').filter({ has: page.getByRole('heading', { name, exact: true }) });
  const trigger = row.getByRole('button', { name: /^Actions for / });
  let requests = 0;
  page.on('request', request => { if (/\/connections\/[^/]+\/export$/.test(request.url())) requests++; });
  await (await openLibraryActions(page, row)).getByRole('menuitem', { name: 'Export...', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('File password (optional)', { exact: true }).fill('discard password');
  await dialog.getByLabel('Include API key').check();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(requests).toBe(0);
  await (await openLibraryActions(page, row)).getByRole('menuitem', { name: 'Export...', exact: true }).click();
  await expect(dialog.getByLabel('File password (optional)', { exact: true })).toHaveValue('');
  await expect(dialog.getByLabel('Include API key')).not.toBeChecked();
  let release: (() => void) | undefined;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/library/connections/*/export', async route => {
    await pending;
    await route.fulfill({ status: 429, json: { message: 'Synthetic busy error. Retry.' } });
  });
  await dialog.getByLabel('File password (optional)', { exact: true }).fill('retained on error');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await dialog.locator('form').dispatchEvent('submit');
  release?.();
  await expect(dialog.getByRole('alert')).toContainText('Synthetic busy error');
  await expect(dialog.getByLabel('File password (optional)', { exact: true })).toHaveValue('retained on error');
  expect(requests).toBe(1);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});
