import { test, expect, type Page } from '@playwright/test';
import type { LibrarySnapshot } from '../../src/shared/library';

async function login(page: Page) {
  const session = await page.request.get('/api/session').then(response => response.json());
  await page.request.post('/__test/mode', { data: { mode: 'normal' } });
  await page.goto('/'); await page.getByLabel('Owner password').fill('browser-synthetic-password');
  await page.getByRole('button', { name: session.setupRequired ? 'Create owner account' : 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: 'Libraries', exact: true }).click();
  await page.getByRole('button', { name: 'Characters', exact: true }).click();
}
async function library(page: Page): Promise<LibrarySnapshot> { return page.request.get('/api/library').then(response => response.json()); }
async function command(page: Page, path: string, data: unknown, method = 'POST') {
  const response = await page.request.fetch(`/api${path}`, { method, headers: { Origin: 'http://127.0.0.1:4173' }, data });
  expect(response.ok(), await response.text()).toBe(true); return response.json();
}
const fields = (name: string) => ({ name, description: 'Saved character text', personality: '', scenario: '', first_mes: '', mes_example: '', lorebookId: null });
const row = (page: Page, name: string) => page.getByRole('article').filter({ has: page.getByRole('heading', { name, exact: true }) });
const filters = (page: Page) => page.getByRole('group', { name: 'Filter characters by tags', exact: true });
const chooser = (page: Page) => page.getByRole('group', { name: 'Assign tags', exact: true });
const manager = (page: Page) => page.getByRole('region', { name: 'Manage tags', exact: true });

test('filters with AND, preserves character drafts through catalog edits, and manages stable assignments on a phone', async ({ page }) => {
  await login(page);
  const fantasy = await command(page, '/library/tags', { revision: (await library(page)).revision, name: 'tag-fantasy' });
  const adventure = await command(page, '/library/tags', { revision: (await library(page)).revision, name: 'tag-adventure' });
  const unused = await command(page, '/library/tags', { revision: (await library(page)).revision, name: 'tag-unused' });
  for (const [name, tagIds] of [['Tag A', [fantasy.id, adventure.id]], ['Tag B', [fantasy.id]], ['Tag C', []]] as const) await command(page, '/library', { kind: 'characters', revision: (await library(page)).revision, data: fields(name), tagIds });
  await expect(row(page, 'Tag C')).toBeVisible();
  await filters(page).getByRole('checkbox', { name: /tag-fantasy/ }).check(); await expect(row(page, 'Tag A')).toBeVisible(); await expect(row(page, 'Tag B')).toBeVisible(); await expect(row(page, 'Tag C')).toHaveCount(0);
  await filters(page).getByRole('checkbox', { name: /tag-adventure/ }).check(); await expect(row(page, 'Tag B')).toHaveCount(0);
  await row(page, 'Tag A').getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByLabel('Character description', { exact: true }).fill('Draft survives catalog operations');
  await page.getByRole('button', { name: 'Manage tags', exact: true }).click();
  await manager(page).getByLabel('New tag name', { exact: true }).fill('tag-new, punctuation'); await manager(page).getByRole('button', { name: 'Create tag', exact: true }).click();
  await expect(chooser(page).getByRole('checkbox', { name: /tag-new, punctuation/ })).toBeVisible(); await expect(page.getByLabel('Character description')).toHaveValue('Draft survives catalog operations');
  await chooser(page).getByRole('checkbox', { name: /tag-new, punctuation/ }).check();
  await manager(page).getByRole('button', { name: 'Rename tag-adventure', exact: true }).click(); await manager(page).getByLabel('Rename tag', { exact: true }).fill('tag-journey'); await manager(page).getByRole('button', { name: 'Save tag name', exact: true }).click();
  await expect(filters(page).getByRole('checkbox', { name: /tag-journey/ })).toBeChecked();
  await page.getByRole('button', { name: 'Save character', exact: true }).click(); await expect(row(page, 'Tag A')).toContainText('Draft survives catalog operations'); await expect(row(page, 'Tag A')).toContainText('tag-new, punctuation');
  await row(page, 'Tag A').getByRole('button', { name: 'Duplicate', exact: true }).click(); await expect(row(page, 'Tag A copy')).toContainText('tag-journey');
  await row(page, 'Tag A').getByRole('button', { name: 'Edit', exact: true }).click();
  await chooser(page).getByRole('button', { name: 'Remove tag-new, punctuation', exact: true }).click(); await page.getByRole('button', { name: 'Close editor', exact: true }).click();
  await row(page, 'Tag A').getByRole('button', { name: 'Edit', exact: true }).click(); await expect(chooser(page).getByRole('checkbox', { name: /tag-new, punctuation/ })).toBeChecked();
  await chooser(page).getByRole('button', { name: 'Remove tag-new, punctuation', exact: true }).click(); await page.getByRole('button', { name: 'Save character', exact: true }).click();
  await filters(page).getByRole('checkbox', { name: /tag-unused/ }).check(); await expect(page.getByRole('status').filter({ hasText: 'No characters match all selected tags' })).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click(); await expect(row(page, 'Tag C')).toBeVisible();
  await page.getByRole('button', { name: 'Manage tags', exact: true }).click(); await page.setViewportSize({ width: 390, height: 844 });
  await manager(page).getByLabel('Search catalog').fill('tag-journey'); page.once('dialog', dialog => { expect(dialog.message()).toContain('2 characters'); return dialog.accept(); });
  await manager(page).getByRole('button', { name: 'Delete tag-journey', exact: true }).click(); await expect(filters(page).getByRole('checkbox', { name: /tag-journey/ })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/tags-phone.png', fullPage: true });
  await manager(page).getByRole('button', { name: 'Close tag manager', exact: true }).click();
  const current = await library(page); expect(current.tags.find(tag => tag.id === adventure.id)).toBeUndefined(); expect(current.tags.find(tag => tag.id === unused.id)?.usageCount).toBe(0);
});

test('reviews every import mode before commit, cancels without writes and safely retries a lost acknowledgement', async ({ page }) => {
  await login(page);
  await command(page, '/library/tags', { revision: (await library(page)).revision, name: 'import-fantasy' });
  const file = (name: string) => ({ name: 'tag-card.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', data: { ...fields(name), tags: ['Import-Fantasy', 'import-adventure', 'IMPORT-FANTASY', null, ' '], character_book: { name: 'Tag embedded book', entries: [], extensions: {} } } })) });
  const before = await library(page);
  await page.getByLabel('Import character', { exact: true }).setInputFiles(file('Tag cancelled import')); await expect(page.getByRole('heading', { name: 'Review Tag cancelled import' })).toBeVisible();
  expect((await library(page)).characters).toEqual(before.characters); await expect(page.getByRole('radio', { name: 'Import none', exact: true })).toBeChecked();
  await page.getByRole('button', { name: 'Cancel character import', exact: true }).click(); expect((await library(page)).revision).toBe(before.revision);
  for (const mode of ['existing', 'none', 'all'] as const) {
    await page.getByLabel('Import character', { exact: true }).setInputFiles(file(`Tag import ${mode}`));
    await page.getByRole('radio', { name: `Import ${mode}`, exact: true }).check();
    if (mode === 'all') {
      const commands: unknown[] = [];
      await page.route('**/api/library/import', async route => { commands.push(route.request().postDataJSON()); await route.fetch(); await route.abort('failed'); });
      await page.getByRole('button', { name: 'Import reviewed character', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Retry reviewed character import', exact: true })).toBeEnabled();
      await expect.poll(async () => (await library(page)).characters.filter(card => card.name === 'Tag import all').length).toBe(1);
      await page.unroute('**/api/library/import');
      await page.route('**/api/library/import', async route => { commands.push(route.request().postDataJSON()); await route.continue(); });
      await page.getByRole('button', { name: 'Retry reviewed character import', exact: true }).click(); await expect(row(page, 'Tag import all')).toBeVisible();
      expect(commands).toHaveLength(2); expect(commands[1]).toEqual(commands[0]); await page.unroute('**/api/library/import');
    } else { await page.getByRole('button', { name: 'Import reviewed character', exact: true }).click(); await expect(row(page, `Tag import ${mode}`)).toBeVisible(); }
    const saved = await library(page), card = saved.characters.find(card => card.name === `Tag import ${mode}`);
    expect(saved.characterTags.filter(link => link.characterId === card?.id)).toHaveLength(mode === 'all' ? 2 : mode === 'existing' ? 1 : 0);
  }
  await filters(page).getByRole('checkbox', { name: /import-adventure/ }).check();
  await page.getByLabel('Import character', { exact: true }).setInputFiles(file('Tag hidden import')); await page.getByRole('button', { name: 'Import reviewed character', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'may be hidden by your tag filters' })).toBeVisible(); await expect(row(page, 'Tag hidden import')).toHaveCount(0);
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await row(page, 'Tag import none').getByRole('button', { name: 'Edit', exact: true }).click(); await page.getByLabel('Character description').fill('Unsaved text during apply');
  await page.getByRole('button', { name: 'Apply embedded tags', exact: true }).click(); await page.getByRole('radio', { name: 'Import all', exact: true }).check(); await page.getByRole('button', { name: 'Apply reviewed tags', exact: true }).click();
  await expect(page.getByLabel('Character description')).toHaveValue('Unsaved text during apply'); await expect(chooser(page).getByRole('checkbox', { name: /import-adventure/ })).toBeChecked();
  await page.getByRole('button', { name: 'Close editor', exact: true }).click(); await expect(row(page, 'Tag import none')).toContainText('import-adventure'); await expect(row(page, 'Tag import none')).toContainText('Saved character text');
});

test('refreshes another tab, prunes deleted filters, retains failed drafts and rejects unrelated revision advancement', async ({ page, context }) => {
  await login(page);
  const tag = await command(page, '/library/tags', { revision: (await library(page)).revision, name: 'concurrent-tag' });
  const character = await command(page, '/library', { revision: (await library(page)).revision, kind: 'characters', data: fields('Tag concurrent'), tagIds: [tag.id] });
  await expect(row(page, 'Tag concurrent')).toBeVisible();
  await filters(page).getByRole('checkbox', { name: /concurrent-tag/ }).check();
  await command(page, '/library', { revision: (await library(page)).revision, kind: 'characters', data: fields('Tag concurrent untagged') });
  const other = await context.newPage(); await other.goto('/');
  await command(other, `/library/tags/${tag.id}`, { revision: (await library(other)).revision }, 'DELETE');
  await expect(filters(page).getByRole('button', { name: 'Remove concurrent-tag', exact: true })).toHaveCount(0); await expect(row(page, 'Tag concurrent untagged')).toBeVisible();
  await row(page, 'Tag concurrent').getByRole('button', { name: 'Edit', exact: true }).click(); await page.getByLabel('Character description').fill('Draft retained on conflict');
  await page.route(`**/api/library/${character.id}`, route => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ message: 'Synthetic tag save conflict' }) }));
  await page.getByRole('button', { name: 'Save character', exact: true }).click(); await expect(page.getByRole('alert').filter({ hasText: 'Synthetic tag save conflict' }).first()).toBeVisible(); await expect(page.getByLabel('Character description')).toHaveValue('Draft retained on conflict'); await page.unroute(`**/api/library/${character.id}`);
  await command(other, '/library/tags', { revision: (await library(other)).revision, name: 'concurrent-change' });
  await expect(page.getByRole('button', { name: 'Save character', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Close editor', exact: true }).click(); await row(page, 'Tag concurrent').getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('button', { name: 'Manage tags', exact: true }).click(); await manager(page).getByLabel('New tag name').fill('CONCURRENT-CHANGE'); await manager(page).getByRole('button', { name: 'Create tag', exact: true }).click();
  await expect(manager(page).getByRole('alert')).toContainText('already exists'); await expect(manager(page).getByLabel('New tag name')).toHaveValue('CONCURRENT-CHANGE');
  await page.setViewportSize({ width: 1280, height: 900 }); await page.screenshot({ path: 'test-results/tags-desktop.png', fullPage: true }); await other.close();
});

test('paginates the catalog and keeps long or HTML-like names usable as text in a phone editor', async ({ page }) => {
  await login(page);
  const longName = 'Long'.repeat(25), htmlName = '<img src=x onerror=alert(1)>';
  for (const name of [longName, htmlName, ...Array.from({ length: 52 }, (_, i) => `page-tag-${String(i).padStart(2, '0')}`)]) {
    await command(page, '/library/tags', { revision: (await library(page)).revision, name });
  }
  await page.getByRole('button', { name: 'Manage tags', exact: true }).click();
  await expect(manager(page).locator('.tag-catalog-row')).toHaveCount(50);
  await manager(page).getByRole('button', { name: 'Next tags', exact: true }).click();
  await expect(manager(page).locator('.tag-catalog-row').first()).toBeVisible();
  await manager(page).getByLabel('Search catalog').fill(htmlName);
  await expect(manager(page).locator('.tag-catalog-row')).toContainText(htmlName);
  await expect(manager(page).locator('img')).toHaveCount(0);
  await manager(page).getByRole('button', { name: 'Close tag manager', exact: true }).click();
  await page.getByRole('button', { name: 'New character', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Tag long-name draft');
  await chooser(page).getByRole('searchbox').fill(longName);
  await chooser(page).getByRole('checkbox', { name: new RegExp(longName) }).check();
  await page.setViewportSize({ width: 390, height: 844 });
  await chooser(page).scrollIntoViewIfNeeded();
  expect(await chooser(page).evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await chooser(page).screenshot({ path: 'test-results/tags-phone-chooser.png' });
  await page.getByRole('button', { name: 'Save character', exact: true }).click();
  await expect(row(page, 'Tag long-name draft')).toContainText(longName);
  await row(page, 'Tag long-name draft').getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(chooser(page).getByRole('button', { name: `Remove ${longName}`, exact: true })).toBeVisible();
});
