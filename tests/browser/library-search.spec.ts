import { expect, test, type Page } from '@playwright/test';
import { defaultPrompt, type LibraryKind, type LibrarySnapshot } from '../../src/shared/library';
import { defaultContextPreset } from '../../src/shared/context';
import { newLorebook, newLoreEntry } from '../../src/shared/lorebook';

const categories = ['Chats', 'Personas', 'Characters', 'Lorebooks', 'Prompts', 'Connections', 'Context presets'];

async function login(page: Page) {
  const session = await page.request.get('/api/session').then(response => response.json());
  await page.goto('/');
  await page.getByLabel('Owner password').fill('browser-synthetic-password');
  await page.getByRole('button', { name: session.setupRequired ? 'Create owner account' : 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: 'Libraries', exact: true }).click();
}

async function library(page: Page): Promise<LibrarySnapshot> {
  return page.request.get('/api/library').then(response => response.json());
}

async function command(page: Page, url: string, data: unknown) {
  const response = await page.request.post(url, { headers: { Origin: 'http://127.0.0.1:4173' }, data });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

test('searches every library, preserves the query through editing, and combines character search with tags', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await login(page);
  const { endpoint } = await page.request.get('/__test/endpoint').then(response => response.json());
  const tag: { id: string } = await command(page, '/api/library/tags', { revision: (await library(page)).revision, name: 'Library search tag' });
  const fixtures: { kind: LibraryKind; data: object }[] = [
    { kind: 'personas', data: { description: 'A search-fixture-observatory keeper.' } },
    { kind: 'characters', data: { description: 'A search-fixture-observatory keeper.', personality: '', scenario: '', first_mes: '', mes_example: '' } },
    { kind: 'lorebooks', data: { ...newLorebook(), entries: [{ ...newLoreEntry('search-entry'), content: 'The search-fixture-observatory bell rings.' }] } },
    { kind: 'prompts', data: defaultPrompt },
    { kind: 'connections', data: { endpoint, model: 'search-fixture-observatory-model', contextWindow: 100_000, maxOutputTokens: 1000, customParameters: {} } },
    { kind: 'contexts', data: defaultContextPreset },
  ];
  for (const suffix of ['Café', 'Garden']) {
    await command(page, '/api/chats', { title: `Search Chats ${suffix}`, promptId: 'default', targetInputTokens: 32_000, connectionId: null, characterId: null, personaId: null });
    for (const { kind, data } of fixtures) {
      await command(page, '/api/library', {
        revision: (await library(page)).revision, kind, data: { ...data, name: `Search ${kind} ${suffix}` },
        ...(kind === 'characters' ? { tagIds: suffix === 'Café' ? [tag.id] : [] } : {}),
      });
    }
  }
  await page.reload();
  await page.getByRole('button', { name: 'Libraries', exact: true }).click();
  const navigation = page.getByRole('navigation', { name: 'Library categories' });
  for (const category of categories) {
    await navigation.getByRole('button', { name: category, exact: true }).click();
    const content = page.getByRole('region', { name: category, exact: true });
    const search = content.getByRole('searchbox', { name: `Search ${category.toLowerCase()}`, exact: true });
    await expect(search).toHaveValue('');
    await search.fill('CAFE\u0301');
    await expect(content.getByRole('article')).toHaveCount(1);
    await expect(content.getByRole('article').getByRole('heading')).toContainText('Café');
    if (category !== 'Chats') {
      await content.getByRole('article').getByRole('heading').getByRole('button').click();
      await page.getByRole('group', { name: 'Editor actions', exact: true }).getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(search).toHaveValue('CAFE\u0301');
      await expect(content.getByRole('article')).toHaveCount(1);
    }
    await search.fill('no-such-library-item-778');
    await expect(content.getByRole('article')).toHaveCount(0);
    await expect(content.getByRole('status')).toContainText('match your search');
    await search.fill('');
    await expect(content.getByRole('article').filter({ hasText: 'Garden' })).toHaveCount(1);
    if (['Personas', 'Characters', 'Lorebooks', 'Connections'].includes(category)) {
      await search.fill('SEARCH-FIXTURE-OBSERVATORY');
      await expect(content.getByRole('article')).toHaveCount(2);
    }
    if (category === 'Lorebooks') {
      await search.fill('Café');
      await page.screenshot({ path: testInfo.outputPath('library-search-desktop.png'), animations: 'disabled' });
    }
  }
  await navigation.getByRole('button', { name: 'Characters', exact: true }).click();
  const characters = page.getByRole('region', { name: 'Characters', exact: true });
  await characters.getByRole('button', { name: 'Tags', exact: true }).click();
  await page.getByRole('checkbox', { name: /Library search tag/ }).check();
  await page.getByRole('checkbox', { name: /Library search tag/ }).press('Escape');
  await expect(page.getByRole('group', { name: 'Filter characters by tags', exact: true })).toHaveCount(0);
  await characters.getByRole('searchbox', { name: 'Search characters', exact: true }).fill('Garden');
  await expect(characters.getByRole('article')).toHaveCount(0);
  await expect(characters.getByRole('status').filter({ hasText: 'match your search and selected tags' })).toBeVisible();
  await characters.getByRole('searchbox', { name: 'Search characters', exact: true }).fill('');
  await expect(characters.getByRole('article')).toHaveCount(1);
  await expect(characters.getByRole('article')).toContainText('Café');
  await characters.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(characters.getByRole('article').filter({ hasText: 'Garden' })).toHaveCount(1);
});

test('keeps search close to the actions on narrow screens and opens reviewed lorebook import from its button', async ({ page }, testInfo) => {
  await login(page);
  const navigation = page.getByRole('navigation', { name: 'Library categories' });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    for (const category of categories) {
      await navigation.getByRole('button', { name: category, exact: true }).click();
      const content = page.getByRole('region', { name: category, exact: true });
      const search = content.getByRole('searchbox', { name: `Search ${category.toLowerCase()}`, exact: true });
      const actions = await content.getByRole('group', { name: 'Library actions', exact: true }).boundingBox();
      const bounds = await search.boundingBox();
      const sort = content.getByRole('combobox', { name: `Sort ${category.toLowerCase()}`, exact: true });
      const sortBounds = await sort.boundingBox();
      if (!bounds || !actions || !sortBounds) throw new Error('Missing library search, sort or actions');
      if (width === 320) {
        expect(sortBounds.y).toBeGreaterThanOrEqual(bounds.y + bounds.height);
        expect(sortBounds.x).toBe(bounds.x);
        expect(sortBounds.width).toBe(bounds.width);
      } else {
        expect(Math.abs(bounds.y - sortBounds.y)).toBeLessThanOrEqual(2);
        expect(sortBounds.x).toBeGreaterThan(bounds.x + bounds.width);
      }
      await sort.focus();
      await sort.press('Enter');
      await expect(page.getByRole('listbox', { name: `Sort ${category.toLowerCase()}`, exact: true })).toBeVisible();
      await sort.press('Escape');
      expect(bounds.y - actions.y - actions.height).toBeGreaterThanOrEqual(0);
      expect(bounds.y - actions.y - actions.height).toBeLessThanOrEqual(8);
      await search.fill('no-such-library-item-778');
      await expect(content.getByRole('article')).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await search.clear();
    }
    await navigation.getByRole('button', { name: 'Lorebooks', exact: true }).click();
    await page.screenshot({ path: testInfo.outputPath(`library-search-phone-${width}.png`), animations: 'disabled' });
  }
  const before = (await library(page)).lorebooks.length;
  const importButton = page.getByRole('button', { name: 'Import lorebook', exact: true });
  await importButton.focus();
  const chooser = page.waitForEvent('filechooser');
  await importButton.press('Enter');
  await (await chooser).setFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{}') });
  await expect(page.getByRole('alert')).toBeVisible();
  expect((await library(page)).lorebooks).toHaveLength(before);
  const retry = page.waitForEvent('filechooser');
  await importButton.click();
  await (await retry).setFiles({ name: 'review.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ name: 'Toolbar import book', entries: [] })) });
  await expect(page.getByRole('heading', { name: 'Review Toolbar import book', exact: true })).toBeVisible();
  expect((await library(page)).lorebooks).toHaveLength(before);
  await page.getByRole('button', { name: 'Cancel import', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Review Toolbar import book', exact: true })).toHaveCount(0);
  expect((await library(page)).lorebooks).toHaveLength(before);
});

test('sorts every library in both directions and remembers independent choices through editing and reload', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await login(page);
  const { endpoint } = await page.request.get('/__test/endpoint').then(response => response.json());
  const fixtures: { kind: LibraryKind; data: object }[] = [
    { kind: 'personas', data: { description: '' } },
    { kind: 'characters', data: { description: '', personality: '', scenario: '', first_mes: '', mes_example: '' } },
    { kind: 'lorebooks', data: newLorebook() },
    { kind: 'prompts', data: defaultPrompt },
    { kind: 'connections', data: { endpoint, model: 'synthetic', contextWindow: 100_000, maxOutputTokens: 1000, customParameters: {} } },
    { kind: 'contexts', data: defaultContextPreset },
  ];
  const oldIds = new Map<LibraryKind | 'chats', string>();
  for (const suffix of ['Zulu', 'Alpha']) {
    const chat = await command(page, '/api/chats', { title: `Sorting fixture ${suffix}`, promptId: 'default', targetInputTokens: 32_000, connectionId: null, characterId: null, personaId: null });
    if (suffix === 'Zulu') oldIds.set('chats', chat.id);
    for (const { kind, data } of fixtures) {
      const result = await command(page, '/api/library', { revision: (await library(page)).revision, kind, data: { ...data, name: `Sorting fixture ${suffix}` } });
      if (suffix === 'Zulu') oldIds.set(kind, result.id);
    }
  }
  for (const { kind, data } of fixtures) {
    const response = await page.request.put(`/api/library/${oldIds.get(kind)}`, {
      headers: { Origin: 'http://127.0.0.1:4173' },
      data: { revision: (await library(page)).revision, kind, data: { ...data, name: 'Sorting fixture Zulu', ...(['characters', 'personas'].includes(kind) ? { description: 'Edited fixture' } : {}) } },
    });
    expect(response.ok(), await response.text()).toBe(true);
  }
  const snapshot = await page.request.get(`/api/chats/${oldIds.get('chats')}`).then(response => response.json());
  const history = await page.request.put(`/api/chats/${oldIds.get('chats')}/history`, {
    headers: { Origin: 'http://127.0.0.1:4173' }, data: { revision: snapshot.revision, turns: [{ user: 'A later message', assistant: 'Saved', complete: true }] },
  });
  expect(history.ok(), await history.text()).toBe(true);
  await page.reload();
  await page.getByRole('button', { name: 'Libraries', exact: true }).click();
  const navigation = page.getByRole('navigation', { name: 'Library categories' });
  for (const category of categories) {
    await navigation.getByRole('button', { name: category, exact: true }).click();
    const content = page.getByRole('region', { name: category, exact: true });
    const search = content.getByRole('searchbox', { name: `Search ${category.toLowerCase()}`, exact: true });
    await search.fill('Sorting fixture');
    const headings = content.getByRole('article').getByRole('heading');
    const sort = content.getByRole('combobox', { name: `Sort ${category.toLowerCase()}`, exact: true });
    for (const [method, first] of [
      ['Name A–Z', 'Alpha'], ['Name Z–A', 'Zulu'],
      ['Added: newest', 'Alpha'], ['Added: oldest', 'Zulu'],
      ...(category === 'Chats' ? [['Message: recent', 'Zulu'], ['Message: oldest', 'Alpha']] : [['Edited: newest', 'Zulu'], ['Edited: oldest', 'Alpha']]),
    ]) {
      await sort.click();
      await page.getByRole('option', { name: method, exact: true }).click();
      await expect(headings).toHaveCount(2);
      await expect(headings.first()).toHaveText(`Sorting fixture ${first}`);
    }
    const savedMethod = category === 'Personas' ? 'Name A–Z' : 'Name Z–A';
    await sort.click();
    await page.getByRole('option', { name: savedMethod, exact: true }).click();
    if (category !== 'Chats') {
      await content.getByRole('article').first().getByRole('heading').getByRole('button').click();
      await page.getByRole('group', { name: 'Editor actions', exact: true }).getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(headings.first()).toHaveText(`Sorting fixture ${category === 'Personas' ? 'Alpha' : 'Zulu'}`);
      await expect(sort).toContainText(savedMethod);
    }
  }
  await page.reload();
  await page.getByRole('button', { name: 'Libraries', exact: true }).click();
  for (const category of categories) {
    await navigation.getByRole('button', { name: category, exact: true }).click();
    const content = page.getByRole('region', { name: category, exact: true });
    await expect(content.getByRole('combobox', { name: `Sort ${category.toLowerCase()}`, exact: true })).toContainText(category === 'Personas' ? 'Name A–Z' : 'Name Z–A');
  }
  const characters = page.getByRole('navigation', { name: 'Library categories' }).getByRole('button', { name: 'Characters', exact: true });
  await characters.click();
  await page.getByRole('searchbox', { name: 'Search characters', exact: true }).fill('Sorting fixture');
  await page.screenshot({ path: testInfo.outputPath('library-sort-desktop.png'), animations: 'disabled' });
});
