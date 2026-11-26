import { expect, type Page } from '@playwright/test';
import { test } from './isolated-app';
import type { LibrarySnapshot } from '../../src/shared/library';
import type { ChatSnapshot } from '../../src/shared/contracts';
import { themeSchema, appearanceStatusSchema } from '../../src/shared/appearance';
import { readFile } from 'node:fs/promises';
import { selectLibraryCategory } from './library-card-helpers';

async function login(page: Page) {
  const session = await page.request.get('/api/session').then(response => response.json());
  await page.goto('/'); await page.getByLabel('Owner password').fill('browser-synthetic-password');
  await page.getByRole('button',{ name: session.setupRequired ? 'Create owner account' : 'Sign in',exact: true }).click();
  await expect(page.getByRole('button',{ name: 'Settings',exact: true })).toBeVisible();
}
async function headers(page: Page) {
  const response = await page.request.get('/api/session');
  return { Origin: new URL(page.url()).origin,'X-ORE-Epoch': response.headers()['x-ore-epoch'] ?? 'initial' };
}
async function fixture(page: Page,width: number) {
  const initial = await headers(page);
  const wipePreview = await page.request.get('/api/data/wipe-preview').then(response => response.json());
  const wiped = await page.request.post('/api/data/wipe',{ headers: initial,data: { ...wipePreview,requestId: crypto.randomUUID(),overwrite: true } }); expect(wiped.ok(), await wiped.text()).toBe(true); await page.reload();
  const auth = await headers(page), { endpoint } = await page.request.get('/__test/endpoint').then(response => response.json());
  const library: LibrarySnapshot = await page.request.get('/api/library').then(response => response.json());
  const connection = await page.request.post('/api/library',{ headers: auth,data: { kind: 'connections',revision: library.revision,data: { name: `Backup model ${width}`,endpoint,model: 'synthetic',contextWindow: 100000,maxOutputTokens: 1000,customParameters: {} },apiKey: 'synthetic-backup-api-key' } }); expect(connection.ok()).toBe(true);
  const created = await page.request.post('/api/chats',{ headers: auth,data: { title: `Backup story ${width}`,targetInputTokens: 32000,connectionId: (await connection.json()).id,promptId: 'default',characterId: null,personaId: null,contextPresetId: null,lorebookId: null } });
  expect(created.ok()).toBe(true); const { id } = await created.json();
  const snapshot: ChatSnapshot = await page.request.get(`/api/chats/${id}`).then(response => response.json());
  const turns = Array.from({ length: 85 },(_,i) => ({ user: `Backup input ${i+1} · ${'synthetic prose '.repeat(i === 0 ? 1000 : 2)}`,assistant: `Backup response ${i+1}.`,complete: true }));
  const replaced = await page.request.put(`/api/__test/transcripts/${id}`,{ headers: auth,data: { revision: snapshot.revision,turns } }); expect(replaced.ok()).toBe(true);
  return id;
}
async function openChat(page: Page,title: string) {
  await page.getByRole('button',{ name: 'Libraries',exact: true }).click();
  await selectLibraryCategory(page, 'Chats');
  await page.getByRole('article').filter({ has: page.getByRole('heading',{ name: title,exact: true }) }).click();
  await expect(page.getByLabel('Your next turn')).toBeVisible();
}

test('backup dialogs cancel without requests and clear transient passwords', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const save = page.getByRole('button', { name: 'Save...', exact: true });
  let requests = 0;
  page.on('request', request => { if (/\/api\/data\/(backup|stages)$/.test(request.url())) requests++; });
  await save.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { level: 2 })).toBeFocused();
  await expect(dialog.getByLabel('Confirm backup password', { exact: true })).toBeVisible();
  await dialog.getByLabel('Backup password (optional)', { exact: true }).fill('discard me');
  await page.mouse.click(2, 2);
  await expect(dialog).toHaveCount(0);
  await expect(save).toBeFocused();
  await save.click();
  await expect(dialog.getByLabel('Backup password (optional)', { exact: true })).toHaveValue('');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: 'Select file...', exact: true }).click();
  const chooser = page.waitForEvent('filechooser');
  await dialog.getByRole('button', { name: 'Drop file here or click to browse', exact: true }).click();
  await (await chooser).setFiles({ name: 'cancel.sqlite', mimeType: 'application/octet-stream', buffer: Buffer.alloc(100) });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Backup password (if set)', { exact: true }).fill('discard import password');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByLabel('Select file...', { exact: true }).setInputFiles({ name: 'cancel.sqlite', mimeType: 'application/octet-stream', buffer: Buffer.alloc(100) });
  await expect(dialog.getByLabel('Backup password (if set)', { exact: true })).toHaveValue('');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(requests).toBe(0);
});

test('pending backup saving and opening show progress and prevent dismissal', async ({ page }, testInfo) => {
  await login(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog');
  async function inspectMeter(view: string, overallName: string, phaseName: string) {
    for (const theme of themeSchema.options) {
      const path = '/api/application/appearance';
      const current = appearanceStatusSchema.parse(await page.request.get(path).then(response => response.json()));
      expect((await page.request.put(path, { headers: await headers(page), data: { revision: current.revision, settings: { ...current.settings, theme } } })).ok()).toBe(true);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 844 });
        await expect(dialog.getByRole('progressbar', { name: overallName })).toBeInViewport();
        await expect(dialog.getByRole('progressbar', { name: phaseName })).toBeInViewport();
        expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
        await dialog.screenshot({ path: testInfo.outputPath(`${view}-progress-${theme}-${width}.png`) });
      }
    }
  }
  let progress: { phase: string; done: number; total: number } | null = null;
  await page.route('**/api/data/backup-progress/*', route => route.fulfill({ json: { progress } }));
  let releaseSave: (() => void) | undefined;
  const saveResponse = new Promise<void>(resolve => { releaseSave = resolve; });
  await page.route('**/api/data/backup', async route => {
    await saveResponse;
    await route.fulfill({ status: 429, json: { message: 'Synthetic backup preparation failure' } });
  });
  await page.getByRole('button', { name: 'Save...', exact: true }).click();
  const saving = page.getByRole('dialog');
  await saving.getByRole('button', { name: 'Save', exact: true }).click();
  try {
    await expect(saving.getByRole('progressbar', { name: 'Preparing backup file…' })).toBeVisible();
    progress = { phase: 'encrypt', done: 41, total: 100 };
    await expect(saving.getByRole('progressbar', { name: 'Encrypting backup…' })).toHaveAttribute('aria-valuenow', '41');
    await expect(saving.getByText('41%')).toBeVisible();
    const overall = saving.getByRole('progressbar', { name: 'Progress' });
    await expect(overall).toHaveAttribute('aria-valuetext', 'Step 5 of 5');
    await expect(saving.getByRole('listitem')).toHaveCount(0);
    // A fixed measurement must paint identically at rest, under the pointer and during a press.
    for (const bar of [overall, saving.getByRole('progressbar', { name: 'Encrypting backup…' })]) {
      const box = await bar.boundingBox();
      if (!box) throw new Error('Missing progress indicator');
      await page.mouse.move(0, 0);
      const resting = await bar.screenshot({ animations: 'disabled' });
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      expect(await bar.screenshot({ animations: 'disabled' })).toEqual(resting);
      await page.mouse.down();
      try { expect(await bar.screenshot({ animations: 'disabled' })).toEqual(resting); }
      finally { await page.mouse.up(); }
    }
    await inspectMeter('save', 'Progress', 'Encrypting backup…');
    await page.keyboard.press('Escape');
    await expect(saving).toBeVisible();
  } finally { releaseSave?.(); }
  await expect(saving.getByRole('alert')).toContainText('Synthetic backup preparation failure');
  await saving.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'Language', exact: true }).click();
  await page.getByRole('combobox', { name: 'Interface language', exact: true }).click();
  await page.getByRole('option', { name: 'Русский', exact: true }).click();
  progress = null;
  let release: (() => void) | undefined;
  const response = new Promise<void>(resolve => { release = resolve; });
  let attempts = 0;
  await page.route('**/api/data/stages', async route => {
    attempts++;
    await response;
    await route.fulfill({ status: 422, json: { message: 'Synthetic opening failure' } });
  });
  await page.getByLabel('Выбрать файл…', { exact: true }).setInputFiles({ name: 'pending.sqlite', mimeType: 'application/octet-stream', buffer: Buffer.alloc(100) });
  const submit = dialog.getByRole('button', { name: 'Проверить копию', exact: true });
  await submit.click();
  await expect.poll(() => attempts).toBe(1);
  await expect(submit).toBeDisabled();
  // The route is held before the browser can send the body.
  await expect(dialog.getByRole('progressbar', { name: 'Загружаем копию…' })).toHaveAttribute('aria-valuenow', '0');
  progress = { phase: 'validate', done: 2, total: 5 };
  await expect(dialog.getByRole('progressbar', { name: 'Проверяем сохранённые записи…' })).toHaveAttribute('aria-valuenow', '40');
  await expect(dialog.getByText(/40\s*%/)).toBeVisible();
  const overview = dialog.getByRole('progressbar', { name: 'Прогресс' });
  await expect(overview).toHaveAttribute('aria-valuetext', 'Шаг 5 из 10');
  progress = { phase: 'validateClean', done: 1, total: 5 };
  await expect(overview).toHaveAttribute('aria-valuetext', 'Шаг 7 из 10');
  progress = { phase: 'validateMerged', done: 1, total: 7 };
  await expect(overview).toHaveAttribute('aria-valuetext', 'Шаг 9 из 10');
  await expect(dialog.getByRole('progressbar', { name: 'Проверяем объединённые записи…' })).toHaveAttribute('aria-valuenow', '14');
  await inspectMeter('preview', 'Прогресс', 'Проверяем объединённые записи…');
  await expect(dialog.getByRole('button', { name: 'Отмена', exact: true })).toBeDisabled();
  await page.mouse.click(2, 2);
  await expect(dialog).toBeVisible();
  await dialog.locator('form').dispatchEvent('submit');
  release?.();
  await expect(dialog.getByRole('alert')).toContainText('Synthetic opening failure');
  expect(attempts).toBe(1);
  await dialog.getByRole('button', { name: 'Отмена', exact: true }).click();
});

for (const width of [1440,390]) test(`password-protected backup, validation and retry at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 700 }); await login(page);
  const chatId = await fixture(page, width);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const password = '  Пароль 🔑 for synthetic backup  ';
  await page.getByRole('button', { name: 'Save...', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { level: 2 })).toBeFocused();
  await expect(dialog.getByLabel('Confirm backup password', { exact: true })).toBeVisible();
  const exportPassword = page.getByLabel('Backup password (optional)', { exact: true });
  await exportPassword.fill(password);
  const confirmation = page.getByLabel('Confirm backup password', { exact: true });
  await confirmation.fill('different password');
  await page.getByRole('heading', { name: 'Data backup', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('protected-backup-password-fields.png'), fullPage: true });
  let exports = 0;
  page.on('request', request => { if (request.url().endsWith('/api/data/backup')) exports++; });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('The backup passwords do not match.');
  expect(exports).toBe(0);
  await confirmation.fill(password);
  await page.route('**/api/data/backup', route => route.fulfill({ status: 429, json: { message: 'Other files are being protected or opened. Wait for them to finish and try again.', localized: { key: 'errors.protected_file_busy', fallback: 'Other files are being protected or opened. Wait for them to finish and try again.' } } }), { times: 1 });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Wait for them to finish');
  await expect(exportPassword).toHaveValue(password); await expect(confirmation).toHaveValue(password);
  expect(exports).toBe(1);
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const download = await downloadEvent, path = await download.path();
  expect(new URL(download.url()).origin).toBe(new URL(page.url()).origin);
  expect(new URL(download.url()).pathname).toMatch(/^\/api\/downloads\/[0-9a-f]{64}$/);
  if (!path) throw new Error('Missing synthetic encrypted backup');
  expect(download.suggestedFilename()).toMatch(/\.orebackup$/);
  const buffer = await readFile(path);
  expect(await download.failure()).toBeNull();
  expect(buffer.includes(Buffer.from('synthetic-backup-api-key'))).toBe(false);
  await expect(dialog).toHaveCount(0);
  const importPassword = page.getByLabel('Backup password (if set)', { exact: true });
  await page.getByLabel('Select file...', { exact: true }).setInputFiles({ name: 'protected.orebackup', mimeType: 'application/octet-stream', buffer });
  await importPassword.fill('wrong password');
  await dialog.getByRole('button', { name: 'Review backup', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Check the password');
  await expect(dialog.getByRole('alert')).toBeInViewport();
  await expect(dialog.getByRole('alert')).toContainText('try again');
  await page.screenshot({ path: testInfo.outputPath('backup-password-retry.png') });
  await expect(importPassword).toHaveValue('wrong password');
  await expect(page.getByRole('heading', { name: 'Import review', exact: true })).toHaveCount(0);
  expect((await page.request.get(`/api/chats/${chatId}`).then(response => response.json())).turns).toHaveLength(85);
  await importPassword.fill(password);
  await dialog.getByRole('button', { name: 'Review backup', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Import review', exact: true })).toBeVisible();
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('protected-backup.png'), fullPage: true });
  await page.getByRole('button', { name: 'Cancel inspection', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Import review', exact: true })).toHaveCount(0);
});

for (const width of [1440,390]) test(`invalid backup details and recovery at ${width}px`,async ({ page },testInfo) => {
  await page.setViewportSize({ width,height: 950 }); await login(page);
  await page.getByRole('button',{ name: 'Settings',exact: true }).click();
  const input = page.getByLabel('Select file...', { exact: true });
  const submit = async () => page.getByRole('dialog').getByRole('button', { name: 'Review backup', exact: true }).click();
  await input.setInputFiles({ name: 'invalid.sqlite',mimeType: 'application/octet-stream',buffer: Buffer.alloc(100) });
  await submit();
  const alert = page.getByRole('alert').filter({ hasText: 'This file is not a valid ORE backup.' });
  await expect(alert).toBeVisible();
  await expect(alert.locator('pre')).toBeHidden();
  await alert.locator('summary').click();
  await expect(alert.locator('pre')).toHaveText('File does not have the SQLite 3 header signature.');
  await expect(page.locator('body')).toHaveJSProperty('scrollWidth',width);
  await page.screenshot({ path: testInfo.outputPath('backup-error-details.png') });
  await alert.locator('summary').focus(); await page.keyboard.press('Enter');
  await expect(alert.locator('pre')).toBeHidden();
  // A new failed attempt starts collapsed and replaces the previous diagnostic.
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await input.setInputFiles({ name: 'empty.sqlite',mimeType: 'application/octet-stream',buffer: Buffer.alloc(0) });
  await submit();
  await expect(alert.locator('pre')).toHaveText('File is shorter than a SQLite database header (100 bytes).');
  await expect(alert.locator('pre')).toBeHidden();
  const backup = await page.request.post('/api/data/backup', { headers: await headers(page), data: { password: '' } }); expect(backup.ok()).toBe(true);
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await input.setInputFiles({ name: 'valid.sqlite',mimeType: 'application/octet-stream',buffer: await backup.body() });
  await submit();
  await expect(page.getByRole('heading',{ name: 'Import review',exact: true })).toBeVisible();
  await expect(alert).toHaveCount(0);
  await page.getByRole('button',{ name: 'Cancel inspection',exact: true }).click();
  await expect(page.getByRole('heading',{ name: 'Import review',exact: true })).toHaveCount(0);
});

for (const width of [1440,390]) test(`backup inspection, cancel, overwrite retry, wipe and second-tab recovery at ${width}px`,async ({ page,context }) => {
  await page.setViewportSize({ width,height: 950 }); await login(page); const chatId = await fixture(page,width);
  await openChat(page,`Backup story ${width}`);
  const other = await context.newPage(); await other.goto('/'); await openChat(other,`Backup story ${width}`);
  const turn = other.getByRole('article',{ name: 'Turn 85',exact: true });
  await turn.getByRole('button',{ name: 'Edit response',exact: true }).click(); await other.getByLabel('Edit assistant text').fill('Recoverable stale editor text');
  const saveEdit = turn.getByRole('button',{ name: 'Save edit',exact: true });
  await expect(saveEdit).toBeEnabled();
  await other.getByLabel('Your next turn').fill('Recoverable browser draft');
  await page.getByRole('button',{ name: 'Settings',exact: true }).click();
  await expect(page.getByText(/Backups include saved stories/)).toBeVisible();
  await page.getByRole('button', { name: 'Save...', exact: true }).click();
  const downloadEvent = page.waitForEvent('download'); await page.getByRole('dialog').getByRole('button',{ name: 'Save',exact: true }).click();
  const download = await downloadEvent, path = await download.path(); if (!path) throw new Error('Missing backup download');
  expect(download.suggestedFilename()).toMatch(/^ORE-backup-.*\.orebackup$/);
  const buffer = await readFile(path); expect(buffer.subarray(0,8).toString()).toBe('OREENC\r\n'); expect(buffer.includes(Buffer.from('synthetic-backup-api-key'))).toBe(false);
  const upload = async () => {
    await page.getByLabel('Select file...', { exact: true }).setInputFiles({ name: 'ORE-backup.orebackup', mimeType: 'application/octet-stream', buffer });
    await page.getByRole('dialog').getByRole('button', { name: 'Review backup', exact: true }).click();
  };
  await upload(); await expect(page.getByRole('heading',{ name: 'Import review',exact: true })).toBeVisible();
  const categories = page.getByRole('navigation', { name: 'Settings categories' });
  await categories.getByRole('button', { name: 'Wipe application data', exact: true }).click();
  await categories.getByRole('button', { name: 'Data backup', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Import review', exact: true })).toHaveCount(1);
  await page.locator('.settings-panel').evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: `test-results/backups-overview-${width}.png`,fullPage: true });
  const requests: string[] = [];
  page.on('request',request => { if (request.url().includes('/records/')) requests.push(request.url()); });
  await expect(page.locator('.backup-tree')).toBeHidden();
  expect(requests).toHaveLength(0);
  await page.getByText('Browse backup contents', { exact: true }).click();
  const turns = page.locator('.backup-tree > details').filter({ has: page.locator('summary').filter({ hasText: /^Turns and parts$/ }) });
  await turns.locator('> summary').click(); await expect(turns.locator('.backup-record')).toHaveCount(40);
  const leaf = turns.locator('.backup-record').filter({ has: page.locator('summary').filter({ hasText: /^Turn 1$/ }) });
  await leaf.locator('> summary').click(); await expect(leaf.locator('pre')).toContainText('Backup input 1');
  await expect(leaf.getByRole('button',{ name: 'Next text',exact: true })).toBeEnabled();
  expect(requests.filter(url => /records\/turns\/[0-9]+\?/.test(url))).toHaveLength(1);
  await leaf.getByRole('button',{ name: 'Next text',exact: true }).click(); await expect(leaf.getByText(/8193–/)).toBeVisible();
  await turns.getByRole('button',{ name: 'Next records',exact: true }).click(); await expect(turns.locator('.backup-record').first().locator('> summary')).toHaveText('Turn 41');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `test-results/backups-inspection-${width}.png`,fullPage: true });
  await page.getByRole('button',{ name: 'Import entire backup',exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Overwrite overlapping records?'); await page.getByRole('dialog').getByRole('button',{ name: 'Cancel',exact: true }).click();
  expect((await page.request.get(`/api/chats/${chatId}`).then(response => response.json())).turns).toHaveLength(85);
  await page.getByRole('button',{ name: 'Cancel inspection',exact: true }).click(); await expect(page.getByRole('heading',{ name: 'Import review',exact: true })).toHaveCount(0);
  await upload(); await expect(page.getByRole('heading',{ name: 'Import review',exact: true })).toBeVisible();
  let releaseImport: (() => void) | undefined;
  const heldImport = new Promise<void>(resolve => { releaseImport = resolve; });
  await page.route('**/api/data/stages/*/import', async route => {
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    await heldImport;
    await route.abort('failed');
  }, { times: 1 });
  await page.getByRole('button',{ name: 'Import entire backup',exact: true }).click(); await page.getByRole('dialog').getByRole('button',{ name: 'Overwrite and import',exact: true }).click();
  const importing = page.getByRole('dialog', { name: 'Import entire backup', exact: true });
  try {
    await expect(importing.getByRole('progressbar', { name: 'Importing saved data…' })).toBeVisible();
    await expect(importing.getByRole('progressbar', { name: 'Progress' })).toHaveAttribute('aria-valuetext', 'Step 10 of 10');
    await page.keyboard.press('Escape');
    await expect(importing).toBeVisible();
  } finally { releaseImport?.(); }
  await expect(importing.getByRole('alert')).toBeVisible();
  await importing.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('button',{ name: 'Retry data command',exact: true })).toBeVisible();
  await expect(other.getByRole('alert').filter({ hasText: 'Application data was imported or wiped in another tab' })).toBeVisible();
  await expect(saveEdit).toBeDisabled();
  await expect(other.getByLabel('Edit assistant text')).toHaveValue('Recoverable stale editor text');
  await page.reload(); await page.getByRole('button',{ name: 'Settings',exact: true }).click();
  await page.getByRole('button',{ name: 'Retry data command',exact: true }).click(); await expect(page.getByRole('button',{ name: 'Retry data command',exact: true })).toHaveCount(0);
  const restored = await page.request.get(`/api/chats/${chatId}`).then(response => response.json()); expect(restored.turns[84].assistant.text).toBe('Backup response 85.');
  await other.getByRole('button',{ name: 'Reload current data',exact: true }).click(); await expect(other.getByLabel('Your next turn')).toHaveValue('Recoverable browser draft');
  await expect(other.getByRole('button',{ name: 'Use recovered draft',exact: true })).toBeVisible(); await other.getByRole('button',{ name: 'Use recovered draft',exact: true }).click(); await expect(other.getByRole('button',{ name: 'Use recovered draft',exact: true })).toHaveCount(0); await other.close();
  await page.getByRole('button',{ name: 'Settings',exact: true }).click(); await page.getByRole('region',{ name: 'Wipe application data',exact: true }).getByRole('button',{ name: 'Wipe application data',exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Your local owner login'); await page.getByRole('dialog').getByRole('button',{ name: 'Wipe application data',exact: true }).click();
  await expect.poll(async () => (await page.request.get('/api/library').then(response => response.json())).chats.length).toBe(0);
  await expect(page.getByRole('button',{ name: 'Libraries',exact: true })).toBeVisible();
  await page.getByRole('button',{ name: 'Settings',exact: true }).click(); await upload(); await expect(page.getByRole('heading',{ name: 'Import review',exact: true })).toBeVisible();
  await page.getByRole('button',{ name: 'Import entire backup',exact: true }).click(); await page.getByRole('dialog').getByRole('button',{ name: 'Overwrite and import',exact: true }).click();
  await expect.poll(async () => (await page.request.get(`/api/chats/${chatId}`).then(response => response.json())).turns.length).toBe(85);
  await openChat(page,`Backup story ${width}`); await expect(page.getByRole('article',{ name: 'Turn 85',exact: true })).toContainText('Backup response 85.');
});

test('large backup shows transfer progress, then a bounded review across themes', async ({ page, context }, testInfo) => {
  test.setTimeout(90_000);
  await login(page);
  const auth = await headers(page);
  const chat: ChatSnapshot = await page.request.get('/api/chats/main').then(response => response.json());
  const turns = Array.from({ length: 256 }, (_, i) => ({
    user: `Input ${i}`, assistant: 'A synthetic passage. '.repeat(1000), complete: true,
  }));
  const seeded = await page.request.put('/api/__test/transcripts/main', { headers: auth, data: { revision: chat.revision, turns } });
  expect(seeded.ok(), await seeded.text()).toBe(true);
  for (let index = 0; index < 42; index++) {
    const library: LibrarySnapshot = await page.request.get('/api/library').then(response => response.json());
    const tag = await page.request.post('/api/library/tags', { headers: auth, data: { revision: library.revision, name: `Archive tag ${index + 1}` } });
    expect(tag.ok()).toBe(true);
  }
  const response = await page.request.post('/api/data/backup', { headers: auth, data: { password: '' } });
  expect(response.ok()).toBe(true);
  const buffer = await response.body();
  expect(buffer.length).toBeGreaterThan(10_000_000);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const fileName = 'Long-running campaign archive.orebackup';
  await page.getByLabel('Select file...', { exact: true }).setInputFiles({ name: fileName, mimeType: 'application/octet-stream', buffer });
  const dialog = page.getByRole('dialog');
  const network = await context.newCDPSession(page);
  await network.send('Network.enable');
  await network.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: 2_000_000 });
  // The local server may finish validation between two Playwright assertions.
  // Observe the rendered states through dialog closure, including short-lived ones.
  const phases = dialog.evaluate(node => new Promise(resolve => {
    let transferred = false, checked = false, serverProgress = false;
    const observer = new MutationObserver(() => {
      const bar = node.querySelector('[role="progressbar"][aria-labelledby]');
      const value = bar?.getAttribute('aria-valuenow');
      const label = node.querySelector('[role="status"]')?.textContent;
      if (label === 'Uploading backup…' && value != null && Number(value) > 0 && Number(value) < 100) transferred = true;
      if (label === 'Checking backup contents…' && bar && value == null) checked = true;
      if (label !== 'Uploading backup…' && value != null) serverProgress = true;
      if (!node.isConnected) {
        observer.disconnect();
        resolve({ transferred, checked, serverProgress });
      }
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  }));
  await dialog.getByRole('button', { name: 'Review backup' }).click();
  await expect(dialog).toHaveCount(0, { timeout: 30_000 });
  expect(await phases).toEqual({ transferred: true, checked: true, serverProgress: true });
  await network.detach();
  const review = page.getByRole('region', { name: 'Import review', exact: true });
  await expect(review.getByRole('heading', { name: 'Import review' })).toBeFocused();
  await expect(review).toContainText(fileName);
  const recordList = review.getByRole('region', { name: 'Changes by record' });
  await expect(recordList).toBeHidden();
  await review.getByText('Changes by record', { exact: true }).click();
  await expect(recordList.getByText('Archive tag 1', { exact: true })).toBeVisible();
  const firstPagePosition = await recordList.boundingBox();
  let releasePage = () => {};
  const heldPage = new Promise<void>(resolve => { releasePage = resolve; });
  await page.route('**/api/data/stages/*?view=captured&offset=40', async route => {
    await heldPage;
    await route.continue();
  }, { times: 1 });
  await review.getByRole('button', { name: 'Next review page' }).click();
  try {
    await expect(review.getByRole('button', { name: 'Next review page' })).toBeDisabled();
    await expect(recordList.getByText('Archive tag 1', { exact: true })).toBeVisible();
    expect(await recordList.boundingBox()).toEqual(firstPagePosition);
  } finally { releasePage(); }
  await expect(recordList.getByText('Archive tag 42', { exact: true })).toBeVisible();
  await expect(recordList.getByText('Archive tag 1', { exact: true })).toHaveCount(0);
  await expect(review.getByRole('button', { name: 'Next review page' })).toBeDisabled();
  expect(await recordList.boundingBox()).toEqual(firstPagePosition);
  await review.getByRole('button', { name: 'Previous review page' }).click();
  await expect(recordList.getByText('Archive tag 1', { exact: true })).toBeVisible();
  await review.getByRole('button', { name: 'Next review page' }).click();
  await expect(recordList.getByText('Archive tag 42', { exact: true })).toBeVisible();
  await review.getByRole('button', { name: 'Refresh review' }).click();
  await expect(recordList.getByText('Archive tag 1', { exact: true })).toBeVisible();
  await review.getByText('Changes by record', { exact: true }).click();
  for (const theme of themeSchema.options) {
    const path = '/api/application/appearance';
    const current = appearanceStatusSchema.parse(await page.request.get(path).then(result => result.json()));
    expect((await page.request.put(path, { headers: auth, data: { revision: current.revision, settings: { ...current.settings, theme } } })).ok()).toBe(true);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    for (const width of [1280, 801, 800, 390]) {
      await page.setViewportSize({ width, height: 844 });
      expect(await review.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
      await review.screenshot({ path: testInfo.outputPath(`review-${theme}-${width}.png`) });
      if (width === 1280 || width === 390) {
        await page.getByRole('button', { name: 'Save...', exact: true }).click();
        await expect(dialog.getByLabel('Confirm backup password')).toBeInViewport();
        await dialog.screenshot({ path: testInfo.outputPath(`export-${theme}-${width}.png`) });
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await page.getByLabel('Select file...', { exact: true }).setInputFiles({
          name: 'Another campaign archive.orebackup', mimeType: 'application/octet-stream', buffer: Buffer.alloc(100),
        });
        await expect(dialog.getByRole('button', { name: 'Review backup' })).toBeInViewport();
        await dialog.screenshot({ path: testInfo.outputPath(`import-${theme}-${width}.png`) });
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await expect(review).toContainText(fileName);
      }
    }
  }
  await page.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'Language', exact: true }).click();
  await page.getByRole('combobox', { name: 'Interface language', exact: true }).click();
  await page.getByRole('option', { name: 'Русский', exact: true }).click();
  const translated = page.getByRole('region', { name: 'Проверка импорта' });
  await translated.getByText('Содержимое копии', { exact: true }).click();
  await expect(translated.getByText('Ходы и сообщения', { exact: true })).toBeVisible();
  await expect(translated).toContainText(fileName);
  expect(await translated.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
});

test('an interrupted import can retry the same staged file after leaving Settings', async ({ page }) => {
  await login(page);
  const backup = await page.request.post('/api/data/backup', { headers: await headers(page), data: { password: '' } });
  expect(backup.ok()).toBe(true);
  const settings = page.getByRole('button', { name: 'Settings', exact: true });
  await settings.click();
  await page.getByLabel('Select file...', { exact: true }).setInputFiles({
    name: 'recoverable.orebackup', mimeType: 'application/octet-stream', buffer: await backup.body(),
  });
  await page.getByRole('button', { name: 'Review backup' }).click();
  await page.route('**/api/data/stages/*/import', route => route.abort('failed'), { times: 1 });
  await page.getByRole('button', { name: 'Import entire backup' }).click();
  await page.getByRole('button', { name: 'Overwrite and import' }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Import review' }).getByRole('button', { name: 'Retry data command' })).toBeVisible();
  await page.getByRole('button', { name: 'Libraries', exact: true }).click();
  await settings.click();
  const retried = page.waitForResponse(result => result.url().endsWith('/import') && result.request().method() === 'POST');
  await page.getByRole('button', { name: 'Retry data command' }).click();
  expect((await retried).ok()).toBe(true);
  await expect(page.getByRole('button', { name: 'Retry data command' })).toHaveCount(0);
});
