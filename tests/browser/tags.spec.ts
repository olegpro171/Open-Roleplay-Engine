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
async function openFilters(page: Page) {
  const trigger = page.getByRole('button', { name: /^Tags/ });
  if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click();
}
async function openManager(page: Page) {
  if (!await page.getByRole('button', { name: 'Manage tags', exact: true }).isVisible()) await openFilters(page);
  await page.getByRole('button', { name: 'Manage tags', exact: true }).click();
}
const manager = (page: Page) => page.getByRole('dialog', { name: 'Manage tags', exact: true });

test('filters with AND, preserves character drafts through catalog edits, and manages stable assignments on a phone', async ({ page }) => {
  await login(page);
  const fantasy = await command(page, '/library/tags', { revision: (await library(page)).revision, name: 'tag-fantasy' });
  const adventure = await command(page, '/library/tags', { revision: (await library(page)).revision, name: 'tag-adventure' });
  const unused = await command(page, '/library/tags', { revision: (await library(page)).revision, name: 'tag-unused' });
  for (const [name, tagIds] of [['Tag A', [fantasy.id, adventure.id]], ['Tag B', [fantasy.id]], ['Tag C', []]] as const) await command(page, '/library', { kind: 'characters', revision: (await library(page)).revision, data: fields(name), tagIds });
  await expect(row(page, 'Tag C')).toBeVisible();
  await openFilters(page); await filters(page).getByRole('checkbox', { name: /tag-fantasy/ }).check(); await expect(row(page, 'Tag A')).toBeVisible(); await expect(row(page, 'Tag B')).toBeVisible(); await expect(row(page, 'Tag C')).toHaveCount(0);
  await openFilters(page); await filters(page).getByRole('checkbox', { name: /tag-adventure/ }).check(); await expect(row(page, 'Tag B')).toHaveCount(0);
  await row(page, 'Tag A').getByRole('button', { name: /^Edit(?: |$)/ }).click();
  await page.getByLabel('Character description', { exact: true }).fill('Draft survives catalog operations');
  await openManager(page);
  await manager(page).getByLabel('New tag name', { exact: true }).fill('tag-new, punctuation'); await manager(page).getByRole('button', { name: 'Create tag', exact: true }).click();
  await expect(manager(page).getByRole('button', { name: 'Rename tag-new, punctuation' })).toBeVisible();
  await manager(page).getByRole('button', { name: 'Rename tag-adventure', exact: true }).click(); await manager(page).getByLabel('Rename tag', { exact: true }).fill('tag-journey'); await manager(page).getByRole('button', { name: 'Save tag name', exact: true }).click();
  await manager(page).getByRole('button', { name: 'Close tag manager', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Manage tags', exact: true })).toBeFocused();
  await expect(page.getByLabel('Character description')).toHaveValue('Draft survives catalog operations');
  await chooser(page).getByRole('checkbox', { name: /tag-new, punctuation/ }).check();
  await page.getByRole('button', { name: 'Save character', exact: true }).click(); await expect(row(page, 'Tag A')).toContainText('Draft survives catalog operations'); await expect(row(page, 'Tag A')).not.toContainText('tag-new, punctuation');
  // Assignments stay available through filters and the editor without appearing in rows.
  await expect(page.getByRole('group', { name: 'Active tag filters' })).toContainText('tag-journey');
  await row(page, 'Tag A').getByRole('button', { name: /^Duplicate(?: |$)/ }).click(); await expect(row(page, 'Tag A copy')).toBeVisible();
  await row(page, 'Tag A copy').getByRole('button', { name: /^Edit(?: |$)/ }).click();
  await expect(chooser(page).getByRole('checkbox', { name: /tag-journey/ })).toBeChecked();
  await expect(chooser(page).getByRole('checkbox', { name: /tag-new, punctuation/ })).toBeChecked();
  await page.getByRole('button', { name: 'Close editor', exact: true }).click();
  await row(page, 'Tag A').getByRole('button', { name: /^Edit(?: |$)/ }).click();
  await chooser(page).getByRole('button', { name: 'Remove tag-new, punctuation', exact: true }).click(); await page.getByRole('button', { name: 'Close editor', exact: true }).click();
  await row(page, 'Tag A').getByRole('button', { name: /^Edit(?: |$)/ }).click(); await expect(chooser(page).getByRole('checkbox', { name: /tag-new, punctuation/ })).toBeChecked();
  await chooser(page).getByRole('button', { name: 'Remove tag-new, punctuation', exact: true }).click(); await page.getByRole('button', { name: 'Save character', exact: true }).click();
  await openFilters(page); await filters(page).getByRole('checkbox', { name: /tag-unused/ }).check(); await expect(page.getByRole('status').filter({ hasText: 'No characters match all selected tags' })).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click(); await expect(row(page, 'Tag C')).toBeVisible();
  await openManager(page); await page.setViewportSize({ width: 390, height: 844 });
  await manager(page).getByLabel('Search catalog').fill('tag-journey');
  await manager(page).getByRole('button', { name: 'Delete tag-journey', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Delete tag?' })).toContainText('2 characters');
  await page.locator('.confirmation-dialog').getByRole('button', { name: 'Delete tag', exact: true }).click();
  await expect(manager(page).getByRole('button', { name: 'Delete tag-journey', exact: true })).toHaveCount(0);
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
  expect((await library(page)).characters).toEqual(before.characters); await page.getByText('Review tags', { exact: true }).click(); await expect(page.getByRole('radio', { name: 'Import all', exact: true })).toBeChecked();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click(); expect((await library(page)).revision).toBe(before.revision);
  for (const mode of ['existing', 'none', 'all'] as const) {
    await page.getByLabel('Import character', { exact: true }).setInputFiles(file(`Tag import ${mode}`));
    await page.getByText('Review tags', { exact: true }).click();
    await page.getByRole('radio', { name: `Import ${mode}`, exact: true }).check();
    await expect(page.getByText(mode === 'all' ? '1 matching tags · 1 new tags.' : mode === 'existing' ? '1 matching tags.' : 'Tags are not imported.', { exact: true })).toBeVisible();
    if (mode === 'all') {
      const commands: unknown[] = [];
      await page.route('**/api/library/import', async route => { commands.push(route.request().postDataJSON()); await route.fetch(); await route.abort('failed'); });
      await page.getByRole('button', { name: 'Import', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Retry reviewed character import', exact: true })).toBeEnabled();
      await expect.poll(async () => (await library(page)).characters.filter(card => card.name === 'Tag import all').length).toBe(1);
      await page.unroute('**/api/library/import');
      await page.getByRole('button', { name: 'New character', exact: true }).click();
      await page.getByLabel('Name', { exact: true }).fill('Temporary draft during import recovery');
      await page.getByRole('button', { name: 'Close editor', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Retry reviewed character import', exact: true })).toBeEnabled();
      await page.route('**/api/library/import', async route => { commands.push(route.request().postDataJSON()); await route.continue(); });
      await page.getByRole('button', { name: 'Retry reviewed character import', exact: true }).click(); await expect(row(page, 'Tag import all')).toBeVisible();
      expect(commands).toHaveLength(2); expect(commands[1]).toEqual(commands[0]); await page.unroute('**/api/library/import');
    } else { await page.getByRole('button', { name: 'Import', exact: true }).click(); await expect(row(page, `Tag import ${mode}`)).toBeVisible(); }
    const saved = await library(page), card = saved.characters.find(card => card.name === `Tag import ${mode}`);
    expect(saved.characterTags.filter(link => link.characterId === card?.id)).toHaveLength(mode === 'all' ? 2 : mode === 'existing' ? 1 : 0);
  }
  await openFilters(page); await filters(page).getByRole('checkbox', { name: /import-adventure/ }).check();
  await page.getByLabel('Import character', { exact: true }).setInputFiles(file('Tag hidden import')); await page.getByText('Review tags', { exact: true }).click(); await page.getByRole('radio', { name: 'Import none', exact: true }).check(); await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'may be hidden by your tag filters' })).toBeVisible(); await expect(row(page, 'Tag hidden import')).toHaveCount(0);
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await row(page, 'Tag import none').getByRole('button', { name: /^Edit(?: |$)/ }).click(); await page.getByLabel('Character description').fill('Unsaved text during apply');
  await page.getByRole('button', { name: 'Review embedded tags', exact: true }).click(); await page.getByText('Review tags', { exact: true }).click(); await page.getByRole('radio', { name: 'Import all', exact: true }).check(); await page.getByRole('button', { name: 'Apply reviewed tags', exact: true }).click();
  await expect(page.getByLabel('Character description')).toHaveValue('Unsaved text during apply'); await expect(chooser(page).getByRole('checkbox', { name: /import-adventure/ })).toBeChecked();
  await page.getByRole('button', { name: 'Close editor', exact: true }).click(); await expect(row(page, 'Tag import none')).not.toContainText('import-adventure');
  await row(page, 'Tag import none').getByRole('button', { name: /^Edit(?: |$)/ }).click();
  await expect(chooser(page).getByRole('checkbox', { name: /import-adventure/ })).toBeChecked();
  await page.getByRole('button', { name: 'Close editor', exact: true }).click(); await expect(row(page, 'Tag import none')).toContainText('Saved character text');
});

test('previews descriptions, paginates bounded tag rows and imports all tags by default', async ({ page }) => {
  await login(page);
  const longTag = 'Preview'.repeat(14), htmlTag = '<img src=x onerror=alert(2)>';
  const tags = [longTag, htmlTag, ...Array.from({ length: 50 }, (_, i) => `review-table-${i}`)];
  const description = 'The keeper watches the stars.\n'.repeat(60) + '<img src=x onerror=alert(1)>';
  const source = { spec: 'chara_card_v3', data: { ...fields('Tag table preview'), description, tags } };
  const file = { name: 'review.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(source)) };
  const before = await library(page);
  await page.getByLabel('Import character', { exact: true }).setInputFiles(file);
  const review = page.locator('.character-import-review');
  await expect(review.getByLabel('Character description preview')).toHaveText(description);
  await expect(review.getByRole('group', { name: 'Import tags', exact: true })).toBeHidden();
  await expect(review.getByText('0 matching tags · 52 new tags.', { exact: true })).toBeVisible();
  expect((await library(page)).revision).toBe(before.revision);
  await review.getByText('Review tags', { exact: true }).click();
  await expect(review.getByRole('radio', { name: 'Import all', exact: true })).toBeChecked();
  const table = review.getByRole('table', { name: 'Embedded tags' });
  await expect(table.locator('tbody tr')).toHaveCount(50);
  await expect(table.getByText(htmlTag, { exact: true })).toBeVisible();
  await expect(review.locator('img')).toHaveCount(0);
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const picture = await review.locator('.picture-editor-square').boundingBox();
    const text = await review.getByLabel('Character description preview').boundingBox();
    if (!picture || !text) throw new Error('Missing import preview');
    expect(text.x).toBeGreaterThan(picture.x + picture.width);
    expect(Math.abs(text.height - picture.height)).toBeLessThanOrEqual(1);
    expect(Math.abs(text.y - picture.y)).toBeLessThanOrEqual(1);
    expect(await review.getByLabel('Character description preview').evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
    expect(await review.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const longName = table.getByText(longTag, { exact: true });
    await expect(longName).toHaveAttribute('title', longTag);
    expect(await longName.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
    await review.getByRole('radio', { name: 'Import all', exact: true }).focus();
    await page.screenshot({ path: `test-results/character-import-${width}.png`, fullPage: true });
  }
  // Styling retains the native radio group's keyboard navigation and change events.
  await page.keyboard.press('ArrowRight');
  await expect(review.getByRole('radio', { name: 'Import existing', exact: true })).toBeChecked();
  await expect(review.getByText('0 matching tags.', { exact: true })).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect(review.getByRole('radio', { name: 'Import all', exact: true })).toBeChecked();
  await review.getByRole('button', { name: 'Next candidates', exact: true }).click();
  await expect(table.locator('tbody tr')).toHaveCount(2);
  await expect(table.getByText('review-table-49', { exact: true })).toBeVisible();
  await review.getByText('Review tags', { exact: true }).click();
  await review.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(row(page, source.data.name)).toBeVisible();
  const saved = await library(page), card = saved.characters.find(card => card.name === source.data.name);
  if (!card) throw new Error('Missing imported table character');
  expect(card.description).toBe(description);
  expect(saved.characterTags.filter(link => link.characterId === card.id)).toHaveLength(52);
});

test('requires a fresh review after library changes and allows existing tags when all is blocked', async ({ page }) => {
  await login(page);
  await command(page, '/library/tags', { revision: (await library(page)).revision, name: 'review-matching' });
  const overlong = 'x'.repeat(300);
  const source = { spec: 'chara_card_v2', data: { ...fields('Tag blocked review'), tags: ['review-matching', overlong] } };
  const file = { name: 'blocked.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(source)) };
  await page.getByLabel('Import character', { exact: true }).setInputFiles(file);
  await expect(page.getByRole('button', { name: 'Import', exact: true })).toBeDisabled();
  await page.getByText('Review tags', { exact: true }).click();
  await expect(page.getByRole('radio', { name: 'Import all', exact: true })).toBeDisabled();
  await expect(page.getByRole('table', { name: 'Embedded tags' })).toContainText('Exceeds local limit');
  await expect(page.getByRole('table', { name: 'Embedded tags' }).getByText(overlong, { exact: true })).toHaveAttribute('title', overlong);
  await page.getByRole('radio', { name: 'Import existing', exact: true }).check();
  await expect(page.getByRole('button', { name: 'Import', exact: true })).toBeEnabled();
  await command(page, '/library/tags', { revision: (await library(page)).revision, name: 'review-concurrent' });
  await expect(page.getByRole('status').filter({ hasText: 'Cancel and select the card again' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Import', exact: true })).toBeDisabled();
  const changed = await library(page);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect((await library(page)).revision).toBe(changed.revision);
  await page.getByLabel('Import character', { exact: true }).setInputFiles(file);
  await page.getByText('Review tags', { exact: true }).click();
  await expect(page.getByRole('radio', { name: 'Import all', exact: true })).toBeChecked();
  await page.getByRole('radio', { name: 'Import existing', exact: true }).check();
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(row(page, source.data.name)).toBeVisible();
  const saved = await library(page), card = saved.characters.find(card => card.name === source.data.name);
  if (!card) throw new Error('Missing imported existing-only character');
  expect(saved.characterTags.filter(link => link.characterId === card.id)).toHaveLength(1);
  expect(saved.tags.some(tag => tag.name === overlong)).toBe(false);
});

test('refreshes another tab, prunes deleted filters, retains failed drafts and rejects unrelated revision advancement', async ({ page, context }) => {
  await login(page);
  const tag = await command(page, '/library/tags', { revision: (await library(page)).revision, name: 'concurrent-tag' });
  const character = await command(page, '/library', { revision: (await library(page)).revision, kind: 'characters', data: fields('Tag concurrent'), tagIds: [tag.id] });
  await expect(row(page, 'Tag concurrent')).toBeVisible();
  await openFilters(page); await filters(page).getByRole('checkbox', { name: /concurrent-tag/ }).check();
  await command(page, '/library', { revision: (await library(page)).revision, kind: 'characters', data: fields('Tag concurrent untagged') });
  const other = await context.newPage(); await other.goto('/');
  await command(other, `/library/tags/${tag.id}`, { revision: (await library(other)).revision }, 'DELETE');
  await expect(page.getByRole('button', { name: 'Remove concurrent-tag', exact: true })).toHaveCount(0); await expect(row(page, 'Tag concurrent untagged')).toBeVisible();
  await row(page, 'Tag concurrent').getByRole('button', { name: /^Edit(?: |$)/ }).click(); await page.getByLabel('Character description').fill('Draft retained on conflict');
  await page.route(`**/api/library/${character.id}`, route => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ message: 'Synthetic tag save conflict' }) }));
  await page.getByRole('button', { name: 'Save character', exact: true }).click(); await expect(page.getByRole('alert').filter({ hasText: 'Synthetic tag save conflict' }).first()).toBeVisible(); await expect(page.getByLabel('Character description')).toHaveValue('Draft retained on conflict'); await page.unroute(`**/api/library/${character.id}`);
  await command(other, '/library/tags', { revision: (await library(other)).revision, name: 'concurrent-change' });
  await expect(page.getByRole('button', { name: 'Save character', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Close editor', exact: true }).click(); await row(page, 'Tag concurrent').getByRole('button', { name: /^Edit(?: |$)/ }).click();
  await openManager(page); await manager(page).getByLabel('New tag name').fill('CONCURRENT-CHANGE'); await manager(page).getByRole('button', { name: 'Create tag', exact: true }).click();
  await expect(manager(page).getByRole('alert')).toContainText('already exists'); await expect(manager(page).getByLabel('New tag name')).toHaveValue('CONCURRENT-CHANGE');
  await page.setViewportSize({ width: 1280, height: 900 }); await page.screenshot({ path: 'test-results/tags-desktop.png', fullPage: true }); await other.close();
});

test('paginates the catalog and keeps long or HTML-like names usable as text in a phone editor', async ({ page }) => {
  await login(page);
  const longName = 'Long'.repeat(25), htmlName = '<img src=x onerror=alert(1)>';
  for (const name of [longName, htmlName, ...Array.from({ length: 52 }, (_, i) => `page-tag-${String(i).padStart(2, '0')}`)]) {
    await command(page, '/library/tags', { revision: (await library(page)).revision, name });
  }
  await openManager(page);
  await expect(manager(page).locator('.tag-catalog-row')).toHaveCount(50);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await manager(page).evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await manager(page).locator('.tag-catalog').evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
    await expect(manager(page).getByRole('button', { name: 'Next tags', exact: true })).toBeInViewport();
    await expect(manager(page).getByRole('button', { name: 'Close tag manager', exact: true })).toBeInViewport();
    await page.screenshot({ path: `test-results/tag-catalog-${width}.png`, fullPage: true });
  }
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
  await expect(row(page, 'Tag long-name draft')).toBeVisible();
  await expect(row(page, 'Tag long-name draft')).not.toContainText(longName);
  await row(page, 'Tag long-name draft').getByRole('button', { name: /^Edit(?: |$)/ }).click();
  await expect(chooser(page).getByRole('button', { name: `Remove ${longName}`, exact: true })).toBeVisible();
});


test('keeps tag search from shrinking the editor or moving its reading position', async ({ page }, testInfo) => {
  await login(page);
  let assignedId = '';
  for (let index = 0; index < 60; index++) {
    const tag = await command(page, '/library/tags', { revision: (await library(page)).revision, name: `viewport-search-tag-${String(index).padStart(2, '0')}` });
    if (index === 0) assignedId = tag.id;
  }
  // Make the final catalog page short, independently of earlier test fixtures.
  const paddingCount = (51 - (await library(page)).tags.length % 50) % 50;
  for (let index = 0; index < paddingCount; index++) {
    await command(page, '/library/tags', { revision: (await library(page)).revision, name: `viewport-catalog-padding-${index}` });
  }
  await command(page, '/library', { revision: (await library(page)).revision, kind: 'characters', data: fields('Stable tag search keeper'), tagIds: [assignedId] });
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await row(page, 'Stable tag search keeper').getByRole('button', { name: /^Edit(?: |$)/ }).click();
    const tags = chooser(page), search = tags.getByRole('searchbox');
    await tags.scrollIntoViewIfNeeded();
    const scrollArea = page.locator(width > 800 ? '.library-panel' : '.library-layout');
    await scrollArea.evaluate(element => { element.scrollTop = element.scrollHeight - element.clientHeight; });
    await search.focus();
    const before = await scrollArea.evaluate(element => ({ top: element.scrollTop, height: element.scrollHeight }));
    const bounds = await tags.boundingBox();
    if (!bounds) throw new Error('Missing tag chooser');
    const padding = await tags.evaluate(element => {
      const legend = element.querySelector('legend'), pill = element.querySelector('.tag-chip');
      if (!legend || !pill) throw new Error('Missing selected tag preview');
      return {
        above: pill.getBoundingClientRect().top - legend.getBoundingClientRect().bottom,
        left: pill.getBoundingClientRect().left - element.getBoundingClientRect().left - parseFloat(getComputedStyle(element).borderLeftWidth),
      };
    });
    expect(Math.abs(padding.above - padding.left)).toBeLessThanOrEqual(1);
    for (const query of ['viewport-search-tag-59', 'no-tags-match-this-query', '']) {
      await search.fill(query);
      if (query === 'viewport-search-tag-59') await expect(tags.getByRole('checkbox')).toHaveCount(1);
      else if (query) await expect(tags.getByText('No tags match your search.', { exact: true })).toBeVisible();
      else await expect(tags.getByRole('checkbox')).toHaveCount(50);
      const filteredBounds = await tags.boundingBox();
      if (!filteredBounds) throw new Error('Missing filtered tag chooser');
      expect(filteredBounds.height).toBeCloseTo(bounds.height, 0);
      const after = await scrollArea.evaluate(element => ({ top: element.scrollTop, height: element.scrollHeight }));
      expect(after.height).toBe(before.height);
      expect(after.top).toBeCloseTo(before.top, 0);
    }
    await tags.screenshot({ path: testInfo.outputPath(`tag-search-${width}.png`) });
    while (await tags.getByRole('button', { name: 'Next tags', exact: true }).isEnabled()) {
      await tags.getByRole('button', { name: 'Next tags', exact: true }).click();
    }
    await expect(tags.getByRole('checkbox')).toHaveCount(1);
    await search.fill('viewport-search-tag');
    await expect(tags.getByRole('checkbox')).toHaveCount(50);
    const expanded = await tags.boundingBox();
    if (!expanded) throw new Error('Missing expanded search results');
    await search.fill('viewport-search-tag-59');
    await expect(tags.getByRole('checkbox')).toHaveCount(1);
    expect((await tags.boundingBox())?.height).toBeCloseTo(expanded.height, 0);
    await search.fill('');
    await page.getByRole('button', { name: 'Close editor', exact: true }).click();
    await openFilters(page);
    const picker = filters(page), pickerBounds = await picker.boundingBox();
    if (!pickerBounds) throw new Error('Missing tag filter picker');
    for (const query of ['viewport-search-tag-59', 'no-tags-match-this-query', '']) {
      await picker.getByRole('searchbox').fill(query);
      const filteredBounds = await picker.boundingBox();
      if (!filteredBounds) throw new Error('Missing filtered picker');
      expect(filteredBounds.height).toBeCloseTo(pickerBounds.height, 0);
    }
    await page.keyboard.press('Escape');
  }
});

test('keeps tag tools optional, dismisses the picker, and retains visible removable filters', async ({ page }) => {
  await login(page);
  const tag = await command(page, '/library/tags', { revision: (await library(page)).revision, name: 'quiet-ui-tag' });
  await command(page, '/library', { revision: (await library(page)).revision, kind: 'characters', data: fields('Quiet tagged card'), tagIds: [tag.id] });
  await command(page, '/library', { revision: (await library(page)).revision, kind: 'characters', data: fields('Quiet untagged card') });
  await expect(row(page, 'Quiet untagged card')).toBeVisible();
  await expect(filters(page)).toHaveCount(0);
  await expect(manager(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Clear filters', exact: true })).toHaveCount(0);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const buttons = await Promise.all([
      page.getByRole('button', { name: 'New character', exact: true }).boundingBox(),
      page.locator('label.file-button').filter({ has: page.getByLabel('Import character', { exact: true }) }).boundingBox(),
      page.getByRole('button', { name: /^Tags/ }).boundingBox(),
    ]);
    expect(buttons.every(box => box !== null)).toBe(true);
    expect(new Set(buttons.map(box => Math.round(box?.y ?? -1))).size).toBe(1);
    expect(buttons[1]?.width).toBeLessThan(210);
    await openFilters(page);
    await expect(filters(page).getByRole('searchbox')).toBeFocused();
    await filters(page).getByRole('searchbox').fill('quiet-ui');
    await filters(page).getByRole('checkbox', { name: /quiet-ui-tag/ }).check();
    await expect(row(page, 'Quiet untagged card')).toHaveCount(0);
    await page.screenshot({ path: `test-results/tag-picker-${width}.png`, fullPage: true });
    await page.keyboard.press('Escape');
    await expect(filters(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Tags/ })).toBeFocused();
    const active = page.getByRole('group', { name: 'Active tag filters' });
    await expect(active).toContainText('quiet-ui-tag');
    await expect(row(page, 'Quiet tagged card')).toBeVisible();
    await page.screenshot({ path: `test-results/tag-filters-${width}.png`, fullPage: true });
    await active.getByRole('button', { name: 'Remove quiet-ui-tag', exact: true }).click();
    await expect(row(page, 'Quiet untagged card')).toBeVisible();
    await expect(active).toHaveCount(0);
    await openFilters(page);
    await page.getByRole('heading', { name: 'Characters', exact: true }).click();
    await expect(filters(page)).toHaveCount(0);
    await openManager(page);
    await expect(manager(page).getByRole('searchbox')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(manager(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Manage tags', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await openFilters(page);
  await filters(page).getByRole('searchbox').fill('quiet-ui');
  await filters(page).getByRole('checkbox', { name: /quiet-ui-tag/ }).check();
  await page.getByRole('button', { name: 'Personas', exact: true }).click();
  await page.getByRole('button', { name: 'Characters', exact: true }).click();
  await expect(row(page, 'Quiet untagged card')).toBeVisible();
  await expect(filters(page)).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Active tag filters' })).toHaveCount(0);
});
