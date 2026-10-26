import { openLibraryActions } from './library-card-helpers';
import { openChatTool } from './chat-tools';
import { test, expect, type Page } from '@playwright/test';
import type { ChatSnapshot, RequestPreview } from '../../src/shared/contracts';
import type { LibrarySnapshot } from '../../src/shared/library';
import { newLorebook, newLoreEntry } from '../../src/shared/lorebook';
import { appearanceStatusSchema } from '../../src/shared/appearance';

async function login(page: Page) {
  const session = await page.request.get('/api/session').then(response => response.json());
  await page.request.post('/__test/mode', { data: { mode: 'normal' } });
  await page.goto('/');
  await page.getByLabel('Owner password').fill('browser-synthetic-password');
  await page.getByRole('button', { name: session.setupRequired ? 'Create owner account' : 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Libraries', exact: true })).toBeVisible();
}
async function choose(page: Page, label: string, name: string) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name, exact: true }).click();
}
async function library(page: Page): Promise<LibrarySnapshot> {
  return page.request.get('/api/library').then(response => response.json());
}
async function command(page: Page, url: string, data: unknown, method = 'POST') {
  const response = await page.request.fetch(url, { method, headers: { Origin: 'http://127.0.0.1:4173' }, data });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function books(page: Page) {
  await page.getByRole('button', { name: 'Libraries', exact: true }).click();
  await page.getByRole('button', { name: 'Lorebooks', exact: true }).click();
}

test('edits a shared book, prefills a character default, inspects immutable lore and chooses None', async ({ page }) => {
  await login(page);
  const { endpoint } = await page.request.get('/__test/endpoint').then(response => response.json());
  const connection = await command(page, '/api/library', { revision: (await library(page)).revision, kind: 'connections', data: { name: 'Lore browser model', endpoint, model: 'synthetic-roleplay', contextWindow: 100_000, maxOutputTokens: 1000, customParameters: {} } });
  await books(page);
  await page.getByRole('button', { name: 'New lorebook', exact: true }).click();
  await page.getByLabel('Book name', { exact: true }).fill('Moon Gate atlas');
  await page.getByRole('button', { name: 'Add entry', exact: true }).click();
  await page.getByLabel('Entry name', { exact: true }).fill('Moon Gate memory');
  await page.getByLabel('Primary keys', { exact: true }).fill(' MoonGate, Silver Hall\n,, harbor,  \nBell Tower \n');
  await page.getByLabel('Secondary keys', { exact: true }).fill(' crescent, moonlight\n, silver \n');
  await page.getByLabel('Require a secondary-key match', { exact: true }).check();
  await page.getByLabel('Lore content', { exact: true }).fill('The Moon Gate is sealed with a silver crescent.');
  await page.getByLabel('Entry comment', { exact: true }).fill('Never send this human-only comment.');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const bookRow = page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Moon Gate atlas', exact: true }) });
  await expect(bookRow).toContainText('1 entries · 1 enabled');
  const savedEntry = (await library(page)).lorebooks.find(book => book.name === 'Moon Gate atlas')?.entries[0];
  expect(savedEntry?.keys).toEqual(['MoonGate', 'Silver Hall', 'harbor', 'Bell Tower']);
  expect(savedEntry?.secondaryKeys).toEqual(['crescent', 'moonlight', 'silver']);
  await bookRow.getByRole('heading').getByRole('button').click();
  await expect(page.getByLabel('Primary keys', { exact: true })).toHaveValue('MoonGate\nSilver Hall\nharbor\nBell Tower');
  await expect(page.getByLabel('Secondary keys', { exact: true })).toHaveValue('crescent\nmoonlight\nsilver');
  await expect(page.getByLabel('Lore content', { exact: true })).toHaveValue('The Moon Gate is sealed with a silver crescent.');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await (await openLibraryActions(page, bookRow)).getByRole('menuitem', { name: 'Duplicate', exact: true }).click();
  const copyRow = page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Moon Gate atlas copy', exact: true }) });
  await expect(copyRow).toBeVisible();
  const copiedLibrary = await library(page);
  const originalBook = copiedLibrary.lorebooks.find(book => book.name === 'Moon Gate atlas');
  const copiedBook = copiedLibrary.lorebooks.find(book => book.name === 'Moon Gate atlas copy');
  expect(copiedBook?.id).not.toBe(originalBook?.id);
  expect(copiedBook?.entries[0]?.id).not.toBe(originalBook?.entries[0]?.id);
  await (await openLibraryActions(page, copyRow)).getByRole('menuitem', { name: 'Delete', exact: true }).click();
  await page.locator('.confirmation-dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(copyRow).toHaveCount(0);
  await page.getByRole('button', { name: 'Characters', exact: true }).click();
  await page.getByRole('button', { name: 'New character', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Moon keeper');
  await page.getByLabel('Character description', { exact: true }).fill('Keeper of the city gate.');
  await choose(page, 'Default lorebook', 'Moon Gate atlas');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'Chats', exact: true }).click();
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  await choose(page, 'Character', 'Moon keeper');
  await page.getByRole('button', { name: 'Create chat', exact: true }).click();
  await expect(page.getByLabel('Chat title')).toHaveValue('Moon keeper - Roleplay');
  await expect(page.getByRole('combobox', { name: 'Lorebook', exact: true })).toContainText('Moon Gate atlas');
  await page.getByLabel('Chat title').fill('Lore browser story');
  await choose(page, 'Connection', 'Lore browser model');
  await page.getByRole('button', { name: 'Save and return', exact: true }).click();
  await page.getByLabel('Your next turn').fill('I approach Silver Hall in the moonlight.');
  await page.getByRole('button', { name: 'Story', exact: true }).click();
  await openChatTool(page, 'Request inspector');
  await expect(page.getByRole('region', { name: 'Resolved lore' })).toContainText('Moon Gate memory · admitted');
  await page.getByText('Endpoint and request body', { exact: true }).click();
  await expect(page.getByTestId('request-body')).toContainText('silver crescent');
  await expect(page.getByTestId('request-body')).not.toContainText('human-only');
  await page.getByRole('button', { name: 'Story', exact: true }).click();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByLabel('Your next turn')).toBeEnabled();
  const snapshot = await library(page);
  const chat = snapshot.chats.find(item => item.title === 'Lore browser story');
  expect(chat).toBeDefined();
  if (!chat) throw new Error('Missing browser chat.');
  const saved: ChatSnapshot = await page.request.get(`/api/chats/${chat.id}`).then(response => response.json());
  expect(saved.settings.connectionId).toBe(connection.id);
  const generation = saved.generations[0];
  if (!generation) throw new Error('Missing saved generation.');
  const historical: RequestPreview = await page.request.get(`/api/chats/${chat.id}/generations/${generation.id}/request`).then(response => response.json());
  expect(historical?.lore?.outcomes.some(entry => entry.text.includes('silver crescent'))).toBe(true);
  await books(page);
  await expect((await openLibraryActions(page, bookRow)).getByRole('menuitem', { name: 'Delete', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(bookRow).toContainText('Moon keeper');
  await expect(bookRow).toContainText('Lore browser story');
  await bookRow.getByRole('heading').getByRole('button').click();
  await page.getByLabel('Lore content', { exact: true }).fill('The Moon Gate now bears a golden sun.');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'Story', exact: true }).click();
  await openChatTool(page, 'Request inspector');
  await page.getByRole('combobox', { name: 'Inspect request', exact: true }).click();
  await page.getByRole('option').filter({ hasText: 'succeeded' }).first().click();
  const region = page.getByRole('region', { name: 'Resolved lore' });
  await region.getByText('Moon Gate memory · admitted', { exact: false }).click();
  await expect(region).toContainText('silver crescent');
  await expect(region).not.toContainText('golden sun');
  const after: ChatSnapshot = await page.request.get(`/api/chats/${chat.id}`).then(response => response.json());
  expect(after.generations[0]?.request).toEqual(saved.generations[0]?.request);
  expect(await page.request.get(`/api/chats/${chat.id}/generations/${generation.id}/request`).then(response => response.json())).toEqual(historical);
  await page.getByRole('button', { name: 'Story', exact: true }).click();
  await openChatTool(page, 'Chat settings');
  await choose(page, 'Character', 'None selected');
  await expect(page.getByRole('combobox', { name: 'Lorebook', exact: true })).toContainText('Moon Gate atlas');
  await choose(page, 'Lorebook', 'None selected');
  await page.getByRole('button', { name: 'Save and return', exact: true }).click();
  const unlinked: ChatSnapshot = await page.request.get(`/api/chats/${chat.id}`).then(response => response.json());
  expect(unlinked.settings.lorebookId).toBeNull();
  expect(unlinked.turns).toEqual(after.turns);
  expect(unlinked.generations[0]?.request).toEqual(saved.generations[0]?.request);
});

test('reviews separate and embedded imports and retries a lost import acknowledgement without duplication', async ({ page }) => {
  await login(page); await books(page);
  const raw = { name: 'Imported harbor atlas', entries: { '17': { uid: 17, key: ['harbor'], keysecondary: [], content: 'The harbor bell rings at dusk.', comment: 'Harbor bell', constant: false, disable: false, order: 1, position: 1, probability: 50, useProbability: true, group: 'unsupported-group' } } };
  await page.getByLabel('Lorebook JSON file').setInputFiles({ name: 'harbor.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(raw)) });
  await expect(page.getByRole('heading', { name: 'Review Imported harbor atlas' })).toBeVisible();
  await expect(page.locator('.lore-import-review')).toContainText('1 entries (1 enabled)');
  await page.locator('.lore-import-review').getByText(/Compatibility notices/).click();
  await expect(page.locator('.lore-import-review')).toContainText('preserved');
  const before = (await library(page)).lorebooks.length;
  const commands: unknown[] = [];
  await page.route('**/api/library/lorebooks/import', async route => { commands.push(route.request().postDataJSON()); await route.fetch(); await route.abort('failed'); });
  await page.getByRole('button', { name: 'Import reviewed lorebook', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry reviewed import', exact: true })).toBeEnabled();
  await expect.poll(async () => (await library(page)).lorebooks.length).toBe(before + 1);
  await page.unroute('**/api/library/lorebooks/import');
  await page.route('**/api/library/lorebooks/import', async route => { commands.push(route.request().postDataJSON()); await route.continue(); });
  await page.getByRole('button', { name: 'Retry reviewed import', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Review Imported harbor atlas' })).toHaveCount(0);
  expect(commands).toHaveLength(2); expect(commands[1]).toEqual(commands[0]);
  expect((await library(page)).lorebooks.length).toBe(before + 1);
  const imported = (await library(page)).lorebooks.find(book => book.name === 'Imported harbor atlas');
  expect(imported).toBeDefined();
  if (!imported) throw new Error('Missing imported book.');
  const exported = await page.request.get(`/api/library/lorebooks/${imported.id}/export`).then(response => response.json());
  expect(exported.entries['17'].group).toBe('unsupported-group');
  await page.getByRole('button', { name: 'Characters', exact: true }).click();
  const character = { spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'Imported harbor keeper', description: 'The keeper waits.', personality: '', scenario: '', first_mes: '', mes_example: '', character_book: { name: 'Embedded harbor book', entries: [{ keys: ['bell'], content: 'The bell is bronze.', enabled: true, insertion_order: 0, extensions: {} }], extensions: {} } } };
  await page.getByLabel('Import character', { exact: true }).setInputFiles({ name: 'keeper.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(character)) });
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Embedded harbor book' })).toBeVisible();
  await page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Imported harbor keeper', exact: true }) }).getByRole('heading').getByRole('button').click();
  await expect(page.getByRole('combobox', { name: 'Default lorebook', exact: true })).toContainText('Embedded harbor book');
  await page.getByRole('button', { name: 'Open book', exact: true }).click();
  await expect(page.getByLabel('Book name', { exact: true })).toHaveValue('Embedded harbor book');
  await expect(page.getByLabel('Lore content', { exact: true })).toHaveValue('The bell is bronze.');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  const legacySource = { ...character, data: { ...character.data, name: 'Legacy harbor keeper' } };
  const legacy = await command(page, '/api/library', { kind: 'characters', revision: (await library(page)).revision, data: { name: 'Legacy harbor keeper', description: 'Existing editable description.', personality: '', scenario: '', first_mes: '', mes_example: '', source: legacySource } });
  const beforeExtraction = (await library(page)).lorebooks.length;
  await page.getByRole('button', { name: 'Characters', exact: true }).click();
  await page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Legacy harbor keeper', exact: true }) }).getByRole('heading').getByRole('button').click();
  await page.getByRole('button', { name: 'Extract embedded lorebook', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Embedded lorebook extracted' })).toBeVisible();
  await expect(page.getByLabel('Book name', { exact: true })).toHaveValue('Embedded harbor book');
  const afterExtraction = await library(page);
  expect(afterExtraction.lorebooks.length).toBe(beforeExtraction + 1);
  const linked = afterExtraction.characters.find(item => item.id === legacy.id);
  expect(linked?.description).toBe('Existing editable description.');
  expect(linked?.lorebookId).toBeTruthy();
});

test('preserves regex commas and key boundaries when switching modes and entries', async ({ page }, testInfo) => {
  await login(page);
  await books(page);
  await page.getByRole('button', { name: 'New lorebook', exact: true }).click();
  await page.getByLabel('Book name', { exact: true }).fill('Key editor atlas');
  await page.getByRole('button', { name: 'Add entry', exact: true }).click();
  await page.getByLabel('Entry name', { exact: true }).fill('Regex commas');
  const primary = page.getByLabel('Primary keys', { exact: true });
  const secondary = page.getByLabel('Secondary keys', { exact: true });
  const regex = page.getByLabel('Use regular expressions', { exact: true });
  await regex.check();
  await primary.fill('gate{1,3}\n[red,blue]+\n  literal, spaces  ');
  await secondary.fill('moon,light\nstar{2,4}');
  await page.getByLabel('Lore content', { exact: true }).fill('The gate opens at moonrise.');
  await page.getByRole('button', { name: 'Add entry', exact: true }).click();
  await page.getByLabel('Entry name', { exact: true }).fill('Literal keys');
  await primary.fill('gate, tower');
  await secondary.fill('moon, star');
  await regex.check();
  await expect(primary).toHaveValue('gate\ntower');
  await expect(secondary).toHaveValue('moon\nstar');
  await regex.uncheck();
  await page.getByRole('button', { name: 'Regex commas', exact: false }).click();
  await expect(primary).toHaveValue('gate{1,3}\n[red,blue]+\n  literal, spaces  ');
  await expect(secondary).toHaveValue('moon,light\nstar{2,4}');
  await regex.uncheck();
  await expect(primary).toHaveValue('gate{1,3}\n[red,blue]+\n  literal, spaces  ');
  await regex.check();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const saved = (await library(page)).lorebooks.find(book => book.name === 'Key editor atlas');
  expect(saved?.entries.map(entry => ({ keys: entry.keys, secondaryKeys: entry.secondaryKeys, useRegex: entry.useRegex }))).toEqual([
    { keys: ['gate{1,3}', '[red,blue]+', '  literal, spaces  '], secondaryKeys: ['moon,light', 'star{2,4}'], useRegex: true },
    { keys: ['gate', 'tower'], secondaryKeys: ['moon', 'star'], useRegex: false },
  ]);
  await page.getByRole('heading', { name: 'Key editor atlas', exact: true }).getByRole('button').click();
  await expect(primary).toHaveValue('gate{1,3}\n[red,blue]+\n  literal, spaces  ');
  await page.getByRole('button', { name: 'Literal keys', exact: false }).click();
  const originalAppearance = appearanceStatusSchema.parse(await page.request.get('/api/application/appearance').then(response => response.json()));
  try {
    for (const theme of ['dark', 'light', 'midnight-black']) {
      const appearance = appearanceStatusSchema.parse(await page.request.get('/api/application/appearance').then(response => response.json()));
      await command(page, '/api/application/appearance', { revision: appearance.revision, settings: { ...appearance.settings, theme } }, 'PUT');
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 844 });
        await primary.scrollIntoViewIfNeeded();
        await expect(primary).toBeVisible();
        await expect(secondary).toHaveValue('moon\nstar');
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.locator('.lore-entry-editor').screenshot({ path: testInfo.outputPath(`${theme}-${width}-keys.png`) });
      }
    }
  } finally {
    const appearance = appearanceStatusSchema.parse(await page.request.get('/api/application/appearance').then(response => response.json()));
    await command(page, '/api/application/appearance', { revision: appearance.revision, settings: { ...appearance.settings, theme: originalAppearance.settings.theme } }, 'PUT');
  }
});

test('keeps unsaved entries on failures and revision conflicts, with bounded editors on a phone', async ({ page }) => {
  await login(page);
  const large = { ...newLorebook(), name: 'Large browser atlas', entries: Array.from({ length: 125 }, (_, i) => ({ ...newLoreEntry(`browser-entry-${i}`), name: `Record ${i}`, keys: [`key-${i}`], content: `Saved detail ${i}.`, insertionOrder: i })) };
  const created = await command(page, '/api/library', { kind: 'lorebooks', revision: (await library(page)).revision, data: large });
  await books(page);
  await page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Large browser atlas', exact: true }) }).getByRole('heading').getByRole('button').click();
  await expect(page.locator('.lore-entry-list > button')).toHaveCount(50);
  await expect(page.getByLabel('Lore content', { exact: true })).toHaveCount(1);
  await page.getByLabel('Search entries', { exact: true }).fill('key-124');
  await page.getByRole('button', { name: 'Record 124', exact: false }).click();
  await page.getByLabel('Lore content', { exact: true }).fill('Unsaved detail survives the failed write.');
  await page.getByLabel('Primary keys', { exact: true }).fill(' key-124, lighthouse\n bell ');
  await page.getByLabel('Entry name', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/lorebook-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel('Entry name', { exact: true }).scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/lorebook-phone-editor.png' });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.route(`**/api/library/${created.id}`, route => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ message: 'Synthetic shared-edit conflict.' }) }));
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Synthetic shared-edit conflict');
  await expect(page.getByLabel('Lore content', { exact: true })).toHaveValue('Unsaved detail survives the failed write.');
  await expect(page.getByLabel('Primary keys', { exact: true })).toHaveValue(' key-124, lighthouse\n bell ');
  await page.unroute(`**/api/library/${created.id}`);
  const current = (await library(page)).lorebooks.find(book => book.id === created.id);
  if (!current) throw new Error('Missing large book.');
  const { id: _id, revision: _revision, ...data } = current;
  await command(page, `/api/library/${created.id}`, { kind: 'lorebooks', revision: (await library(page)).revision, data: { ...data, description: 'Changed from another tab.' } }, 'PUT');
  await expect(page.getByRole('status').filter({ hasText: 'Your unsaved edits remain here' })).toBeVisible();
  await expect(page.getByLabel('Lore content', { exact: true })).toHaveValue('Unsaved detail survives the failed write.');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Cancel', exact: true }).scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/lorebook-phone.png', fullPage: true });
});
