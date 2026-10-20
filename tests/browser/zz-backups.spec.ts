import { test, expect, type Page } from '@playwright/test';
import type { LibrarySnapshot } from '../../src/shared/library';
import type { ChatSnapshot } from '../../src/shared/contracts';
import type { BackupReview } from '../../src/shared/backups';
import { readFile } from 'node:fs/promises';

async function login(page: Page) {
  const session = await page.request.get('/api/session').then(response => response.json());
  await page.goto('/'); await page.getByLabel('Owner password').fill('browser-synthetic-password');
  await page.getByRole('button',{ name: session.setupRequired ? 'Create owner account' : 'Sign in',exact: true }).click();
  await expect(page.getByRole('button',{ name: 'Settings',exact: true })).toBeVisible();
}
async function headers(page: Page) {
  const response = await page.request.get('/api/session');
  return { Origin: 'http://127.0.0.1:4173','X-ORE-Epoch': response.headers()['x-ore-epoch'] ?? 'initial' };
}
async function fixture(page: Page,width: number) {
  const initial = await headers(page);
  const wipePreview = await page.request.get('/api/data/wipe-preview').then(response => response.json());
  const wiped = await page.request.post('/api/data/wipe',{ headers: initial,data: { ...wipePreview,requestId: crypto.randomUUID(),overwrite: true } }); expect(wiped.ok()).toBe(true); await page.reload();
  const auth = await headers(page), { endpoint } = await page.request.get('/__test/endpoint').then(response => response.json());
  const library: LibrarySnapshot = await page.request.get('/api/library').then(response => response.json());
  const connection = await page.request.post('/api/library',{ headers: auth,data: { kind: 'connections',revision: library.revision,data: { name: `Backup model ${width}`,endpoint,model: 'synthetic',contextWindow: 100000,maxOutputTokens: 1000,customParameters: {} },apiKey: 'synthetic-backup-api-key' } }); expect(connection.ok()).toBe(true);
  const created = await page.request.post('/api/chats',{ headers: auth,data: { title: `Backup story ${width}`,targetInputTokens: 32000,connectionId: (await connection.json()).id,promptId: 'default',characterId: null,personaId: null,contextPresetId: null,lorebookId: null } });
  expect(created.ok()).toBe(true); const { id } = await created.json();
  const snapshot: ChatSnapshot = await page.request.get(`/api/chats/${id}`).then(response => response.json());
  const turns = Array.from({ length: 85 },(_,i) => ({ user: `Backup input ${i+1} · ${'synthetic prose '.repeat(i === 0 ? 1000 : 2)}`,assistant: `Backup response ${i+1}.`,complete: true }));
  const replaced = await page.request.put(`/api/chats/${id}/history`,{ headers: auth,data: { revision: snapshot.revision,turns } }); expect(replaced.ok()).toBe(true);
  return id;
}
async function openChat(page: Page,title: string) {
  await page.getByRole('button',{ name: 'Libraries',exact: true }).click(); await page.getByRole('button',{ name: 'Chats',exact: true }).click();
  await page.getByRole('article').filter({ has: page.getByRole('heading',{ name: title,exact: true }) }).getByRole('button',{ name: 'Open chat',exact: true }).click();
  await expect(page.getByLabel('Your next turn')).toBeVisible();
}

for (const width of [1440,390]) test(`invalid backup details and recovery at ${width}px`,async ({ page },testInfo) => {
  await page.setViewportSize({ width,height: 950 }); await login(page);
  await page.getByRole('button',{ name: 'Settings',exact: true }).click();
  const input = page.getByLabel('Inspect & import backup');
  await input.setInputFiles({ name: 'invalid.sqlite',mimeType: 'application/octet-stream',buffer: Buffer.alloc(100) });
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
  await input.setInputFiles({ name: 'empty.sqlite',mimeType: 'application/octet-stream',buffer: Buffer.alloc(0) });
  await expect(alert.locator('pre')).toHaveText('File is shorter than a SQLite database header (100 bytes).');
  await expect(alert.locator('pre')).toBeHidden();
  const backup = await page.request.get('/api/data/backup'); expect(backup.ok()).toBe(true);
  await input.setInputFiles({ name: 'valid.sqlite',mimeType: 'application/octet-stream',buffer: await backup.body() });
  await expect(page.getByRole('heading',{ name: 'Import review',exact: true })).toBeVisible();
  await expect(alert).toHaveCount(0);
  await page.getByRole('button',{ name: 'Cancel inspection',exact: true }).click();
  await expect(page.getByRole('heading',{ name: 'Import review',exact: true })).toHaveCount(0);
});

// Runs after the existing suites because import/wipe intentionally invalidate every old client command.
for (const width of [1440,390]) test(`backup inspection, cancel, overwrite retry, wipe and second-tab recovery at ${width}px`,async ({ page,context }) => {
  await page.setViewportSize({ width,height: 950 }); await login(page); const chatId = await fixture(page,width);
  await openChat(page,`Backup story ${width}`);
  const other = await context.newPage(); await other.goto('/'); await openChat(other,`Backup story ${width}`);
  const turn = other.getByRole('article',{ name: 'Turn 85',exact: true });
  await turn.getByRole('button',{ name: 'Edit response',exact: true }).click(); await other.getByLabel('Edit assistant text').fill('Recoverable stale editor text');
  await other.getByLabel('Your next turn').fill('Recoverable browser draft');
  await page.getByRole('button',{ name: 'Settings',exact: true }).click();
  await expect(page.getByText('saved API keys',{ exact: true })).toBeVisible();
  const downloadEvent = page.waitForEvent('download'); await page.getByRole('button',{ name: 'Save backup',exact: true }).click();
  const download = await downloadEvent, path = await download.path(); if (!path) throw new Error('Missing backup download');
  expect(download.suggestedFilename()).toMatch(/^ORE-backup-.*\.sqlite$/);
  const buffer = await readFile(path); expect(buffer.subarray(0,16).toString()).toBe('SQLite format 3\0');
  const upload = () => page.getByLabel('Inspect & import backup',{ exact: true }).setInputFiles({ name: 'ORE-backup.sqlite',mimeType: 'application/octet-stream',buffer });
  await upload(); await expect(page.getByRole('heading',{ name: 'Import review',exact: true })).toBeVisible();
  const categories = page.getByRole('navigation', { name: 'Settings categories' });
  await categories.getByRole('button', { name: 'Wipe application data', exact: true }).click();
  await categories.getByRole('button', { name: 'Data backup', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Import review', exact: true })).toHaveCount(1);
  await page.locator('.settings-panel').evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: `test-results/backups-overview-${width}.png`,fullPage: true });
  const requests: string[] = [];
  page.on('request',request => { if (request.url().includes('/records/')) requests.push(request.url()); });
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
  await page.route('**/api/data/stages/*/import',async route => { const response = await route.fetch(); expect(response.ok()).toBe(true); await route.abort('failed'); },{ times: 1 });
  await page.getByRole('button',{ name: 'Import entire backup',exact: true }).click(); await page.getByRole('dialog').getByRole('button',{ name: 'Overwrite and import',exact: true }).click();
  await expect(page.getByRole('button',{ name: 'Retry data command',exact: true })).toBeVisible();
  await expect(other.getByRole('alert').filter({ hasText: 'Application data was imported or wiped in another tab' })).toBeVisible();
  await other.getByRole('button',{ name: 'Save edit',exact: true }).click();
  await expect(other.getByRole('alert').filter({ hasText: 'Application data was imported or wiped in another tab' })).toBeVisible(); await expect(other.getByLabel('Edit assistant text')).toHaveValue('Recoverable stale editor text');
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
