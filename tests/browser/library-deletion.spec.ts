import { expect, type Page } from '@playwright/test';
import { appearanceStatusSchema } from '../../src/shared/appearance';
import { defaultContextPreset } from '../../src/shared/context';
import type { StorySnapshot } from '../../src/shared/transcript';
import type { LibrarySnapshot } from '../../src/shared/library';
import type { LibraryDeletionCommand } from '../../src/shared/library-deletion';
import { newLorebook } from '../../src/shared/lorebook';
import { test } from './isolated-app';
import { openLibraryActions } from './library-card-helpers';

const password = 'browser-synthetic-password';
const base = { title: 'Synthetic deletion story', targetInputTokens: 1234, connectionId: null, promptId: 'default', characterId: null, personaId: null };

async function fixture(page: Page, origin: string) {
  const headers = { Origin: origin };
  const send = async <T>(path: string, data: object, method: 'POST' | 'PUT' = 'POST'): Promise<T> => {
    const response = await page.request[method === 'POST' ? 'post' : 'put'](`/api${path}`, { headers, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  await send('/setup', { password });
  const library = (): Promise<LibrarySnapshot> => page.request.get('/api/library?includeLorebookUses=false').then(response => response.json());
  const save = async (kind: string, data: object) => (await send<{ id: string }>('/library', { kind, revision: (await library()).revision, data })).id;
  const create = async (data: object) => (await send<{ id: string }>('/chats', { ...base, ...data })).id;
  const story = (id: string): Promise<StorySnapshot> => page.request.get(`/api/chats/${id}/story`).then(response => response.json());
  return { send, save, create, story, library };
}

async function enterLibrary(page: Page, category: string) {
  await page.getByRole('button', { name: 'Libraries', exact: true }).click();
  await page.getByRole('navigation', { name: 'Library categories' }).getByRole('button', { name: category, exact: true }).click();
}

test('keeps a Character’s Lorebook by default and supports deleting both', async ({ page, browserApp }, testInfo) => {
  const f = await fixture(page, browserApp.url);
  const card = { description: '', personality: '', scenario: '', first_mes: '', mes_example: '' };
  const keepBook = await f.save('lorebooks', { ...newLorebook(), name: 'Lore to keep' });
  const deleteBook = await f.save('lorebooks', { ...newLorebook(), name: 'Lore to remove' });
  const keepCharacter = await f.save('characters', { ...card, name: 'First Keeper', lorebookId: keepBook });
  const deleteCharacter = await f.save('characters', { ...card, name: 'Second Keeper', lorebookId: deleteBook });
  await page.goto('/');
  await enterLibrary(page, 'Characters');
  const dialog = page.getByRole('dialog', { name: 'Delete library item?' });
  const confirm = dialog.getByRole('button', { name: 'Delete', exact: true });
  async function open(name: string) {
    const card = page.getByRole('article').filter({ has: page.getByRole('heading', { name, exact: true }) });
    await (await openLibraryActions(page, card)).getByRole('menuitem', { name: `Delete ${name}`, exact: true }).click();
  }
  await open('First Keeper');
  await expect(confirm).toBeEnabled();
  await expect(dialog.getByRole('checkbox', { name: 'Also delete the Lorebook “Lore to keep”' })).not.toBeChecked();
  await confirm.click();
  await expect(dialog).toHaveCount(0);
  const kept = await f.library();
  expect(kept.characters.some(card => card.id === keepCharacter)).toBe(false);
  expect(kept.lorebooks.some(book => book.id === keepBook)).toBe(true);

  for (const theme of ['dark', 'light', 'midnight-black'] as const) {
    const appearance = appearanceStatusSchema.parse(await page.request.get('/api/application/appearance').then(response => response.json()));
    await f.send('/application/appearance', { revision: appearance.revision, settings: { ...appearance.settings, theme } }, 'PUT');
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 730 });
      await open('Second Keeper');
      await expect(confirm).toBeEnabled();
      await dialog.screenshot({ path: testInfo.outputPath(`character-lorebook-${theme}-${width}.png`), animations: 'disabled' });
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog).toHaveCount(0);
    }
  }
  const option = dialog.getByRole('checkbox', { name: 'Also delete the Lorebook “Lore to remove”' });
  const progress = dialog.getByText('Checking linked items…', { exact: true });
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-01-01T00:01:00Z'));
  let release = () => {};
  let gate: Promise<void>;
  const hold = () => { gate = new Promise<void>(resolve => { release = resolve; }); };
  let reviews = 0;
  hold();
  await page.route(`**/api/library/${deleteCharacter}/deletion?*`, async route => {
    reviews++;
    await gate;
    await route.continue();
  });
  try {
    await open('Second Keeper');
    await expect.poll(() => reviews).toBe(1);
    await page.clock.runFor(999);
    await expect(progress).toHaveCount(0);
    release();
    await expect(confirm).toBeEnabled();
    await page.clock.runFor(1);
    await expect(progress).toHaveCount(0);

    hold();
    await page.keyboard.press('Tab');
    await expect(option).toBeFocused();
    await option.press('Space');
    await expect(option).toBeChecked();
    await expect.poll(() => reviews).toBe(2);
    await page.clock.runFor(999);
    await expect(progress).toHaveCount(0);
    await expect(confirm).toBeDisabled();
    await page.clock.runFor(1);
    await expect(progress).toBeVisible();
    release();
    await expect(confirm).toBeEnabled();
    await expect(progress).toHaveCount(0);
  } finally {
    release();
    await page.clock.resume();
  }
  await confirm.click();
  await expect(dialog).toHaveCount(0);
  const saved = await f.library();
  expect(saved.characters.some(card => card.id === deleteCharacter)).toBe(false);
  expect(saved.lorebooks.map(book => book.id)).toContain(keepBook);
  expect(saved.lorebooks.map(book => book.id)).not.toContain(deleteBook);
});

test('reviews all 300 saved Connection users with bounded search, visible actions and bilingual theme coverage', async ({ page, browserApp }, testInfo) => {
  test.setTimeout(75_000);
  const f = await fixture(page, browserApp.url);
  const { endpoint } = await page.request.get('/__test/endpoint').then(response => response.json());
  const profile = { endpoint, model: 'synthetic-roleplay', contextWindow: 8192, maxOutputTokens: 256, customParameters: {} };
  const targetName = 'Shared deletion Connection';
  const id = await f.save('connections', { ...profile, name: targetName });
  const replacement = await f.save('connections', { ...profile, name: 'Safe replacement' });
  await f.save('contexts', { ...defaultContextPreset, name: 'Linked memory preset', connectionId: id });
  const chats = [];
  for (let index = 0; index < 300; index++) {
    const title = index < 2 ? 'Identical linked name' : `Linked story ${index}`;
    chats.push(await f.create({ title, connectionId: id }));
  }
  await page.goto('/');
  await enterLibrary(page, 'Connections');
  const card = page.getByRole('article').filter({ has: page.getByRole('heading', { name: targetName, exact: true }) });
  const trigger = card.getByRole('button', { name: /^Actions for / });
  const dialog = page.getByRole('dialog', { name: 'Delete library item?' });
  const query = dialog.getByRole('searchbox', { name: 'Search linked items' });
  const open = async () => {
    await (await openLibraryActions(page, card)).getByRole('menuitem', { name: 'Delete', exact: true }).click();
    await expect(dialog.getByRole('heading', { name: 'Chats (300)', exact: true })).toBeVisible();
  };
  for (const theme of ['dark', 'light', 'midnight-black'] as const) {
    const appearance = appearanceStatusSchema.parse(await page.request.get('/api/application/appearance').then(response => response.json()));
    await f.send('/application/appearance', { revision: appearance.revision, settings: { ...appearance.settings, theme } }, 'PUT');
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 730 : 900 });
      await open();
      await expect(dialog.getByRole('heading', { level: 2 })).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(query).toBeFocused();
      await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeInViewport();
      await expect(dialog.getByRole('button', { name: 'Unlink and delete', exact: true })).toBeInViewport();
      expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await expect(dialog.getByRole('listitem')).toHaveCount(31);
      await dialog.screenshot({ path: testInfo.outputPath(`deletion-${theme}-${width}.png`), animations: 'disabled' });
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
    }
  }
  expect((await f.story(chats[0])).settings.connectionId).toBe(id);
  expect((await f.library()).connections.some(item => item.id === id)).toBe(true);

  await open();
  const more = dialog.getByRole('button', { name: 'Show more', exact: true });
  await query.focus();
  await page.keyboard.press('Tab');
  await expect(more).toBeFocused();
  await more.press('Enter');
  await expect(dialog.getByRole('listitem')).toHaveCount(61);
  await query.fill('Identical linked name');
  await expect(dialog.getByRole('listitem')).toHaveCount(2);
  for (const identity of chats.slice(0, 2)) await expect(dialog.getByText(`Identical linked name (${identity})`, { exact: true })).toBeVisible();
  await query.fill('no matching chat');
  await expect(dialog.getByText('No matching items.')).toBeVisible();
  await query.fill('Linked story 299');
  await expect(dialog.getByRole('listitem')).toHaveCount(1);
  await query.focus();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('radio', { name: 'Clear selections' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(query).toBeFocused();
  await dialog.getByRole('radio', { name: 'Replace with another item' }).check();
  const select = dialog.getByRole('combobox', { name: 'Replacement', exact: true });
  await expect(select).toHaveText('Select a replacement');
  await expect(dialog.getByRole('button', { name: 'Replace and delete' })).toBeDisabled();
  await select.click();
  await expect(dialog.getByRole('option', { name: targetName, exact: true })).toHaveCount(0);
  await dialog.getByRole('option', { name: 'Safe replacement', exact: true }).click();
  const confirm = dialog.getByRole('button', { name: 'Replace and delete' });
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: 'Item deleted.' })).toBeVisible();
  await page.reload();
  await enterLibrary(page, 'Connections');
  await expect(card).toHaveCount(0);
  for (const chat of [chats[0], chats[100], chats[299]]) {
    expect((await f.story(chat)).settings).toMatchObject({ connectionId: replacement, targetInputTokens: base.targetInputTokens });
  }
  expect(await page.request.get('/__test/requests').then(response => response.json())).toEqual([]);

  // Open the same dependency review using the built-in Russian catalog.
  await page.evaluate(() => localStorage.setItem('ore-interface-language', 'ru'));
  await page.reload();
  await page.getByRole('button', { name: 'Библиотека', exact: true }).click();
  await page.getByRole('button', { name: 'Подключения', exact: true }).click();
  const replacementCard = page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Safe replacement', exact: true }) });
  await replacementCard.getByRole('button', { name: 'Действия: Safe replacement', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Удалить', exact: true }).click();
  const russian = page.getByRole('dialog', { name: 'Удалить запись библиотеки?' });
  await expect(russian.getByRole('heading', { name: 'Чаты (300)', exact: true })).toBeVisible();
  await expect(russian.getByRole('searchbox', { name: 'Поиск связанных записей' })).toBeVisible();
  await expect(russian.getByRole('radio', { name: 'Сбросить выбор' })).toBeChecked();
  await expect(russian.getByRole('button', { name: 'Отвязать и удалить' })).toBeInViewport();
  await russian.screenshot({ path: testInfo.outputPath('deletion-russian-390.png'), animations: 'disabled' });
  await russian.getByRole('button', { name: 'Отмена', exact: true }).click();
  expect((await f.story(chats[0])).settings.connectionId).toBe(replacement);
});

test('deletion retries review failures, requires fresh confirmation for stale data and recovers a lost acknowledgement after reload', async ({ page, browserApp }) => {
  const f = await fixture(page, browserApp.url);
  const name = 'Travel companion';
  const persona = await f.save('personas', { name, description: '' });
  const replacement = await f.save('personas', { name: 'Second companion', description: '' });
  const first = await f.create({ title: 'First linked story', personaId: persona });
  const second = await f.create({ title: 'Second linked story' });
  await page.goto('/');
  await enterLibrary(page, 'Personas');
  const row = page.getByRole('article').filter({ has: page.getByRole('heading', { name, exact: true }) });
  const dialog = page.getByRole('dialog', { name: 'Delete library item?' });
  let rejectReview = true, rejectCommit = false, loseAcknowledgement = false;
  const commands: LibraryDeletionCommand[] = [];
  await page.route(`**/api/library/${persona}/deletion*`, async route => {
    if (route.request().method() === 'GET') {
      if (!rejectReview) return route.continue();
      rejectReview = false;
      return route.fulfill({ status: 503, json: { code: 'request_failed' } });
    }
    commands.push(route.request().postDataJSON());
    if (rejectCommit) {
      rejectCommit = false;
      return route.fulfill({ status: 500, json: {
        code: 'library_deletion_rolled_back', message: 'Could not delete the item. Nothing was changed. Try again.',
      } });
    }
    if (!loseAcknowledgement) return route.continue();
    loseAcknowledgement = false;
    const response = await route.fetch();
    expect(response.ok(), await response.text()).toBe(true);
    await route.abort('failed');
  });
  await (await openLibraryActions(page, row)).getByRole('menuitem', { name: 'Delete', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Could not check linked items. Try again.');
  await dialog.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(dialog.getByText('First linked story', { exact: true })).toBeVisible();
  await dialog.getByRole('radio', { name: 'Replace with another item' }).check();
  await dialog.getByRole('combobox', { name: 'Replacement', exact: true }).click();
  await dialog.getByRole('option', { name: 'Second companion', exact: true }).click();
  const confirm = dialog.getByRole('button', { name: 'Replace and delete' });
  await expect(confirm).toBeEnabled();
  await f.send(`/chats/${first}/selections`, { revision: (await f.story(first)).revision, settings: { ...base, title: 'First linked story' } }, 'PUT');
  await f.send(`/chats/${second}/selections`, { revision: (await f.story(second)).revision, settings: { ...base, title: 'Second linked story', personaId: persona } }, 'PUT');
  await confirm.click();
  await expect(dialog.getByRole('alert')).toHaveText('Linked items have changed. Review the updated list before deleting.');
  await expect(dialog.getByText('Second linked story', { exact: true })).toBeVisible();
  await expect(dialog.getByText('First linked story', { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('combobox', { name: 'Replacement', exact: true })).toHaveText('Second companion');
  await expect(confirm).toBeEnabled();
  expect((await f.story(second)).settings.personaId).toBe(persona);
  expect(commands).toHaveLength(1);

  rejectCommit = true;
  await confirm.click();
  await expect(dialog.getByRole('alert')).toHaveText('Could not delete the item. Nothing was changed. Try again.');
  await expect(dialog.getByRole('combobox', { name: 'Replacement', exact: true })).toHaveText('Second companion');
  expect((await f.story(second)).settings.personaId).toBe(persona);
  await expect(confirm).toBeEnabled();

  loseAcknowledgement = true;
  await confirm.click();
  await expect(dialog.getByRole('alert')).toHaveText('The result could not be confirmed. Retry to check or complete the deletion.');
  expect((await f.story(second)).settings.personaId).toBe(replacement);
  await page.reload();
  await page.getByRole('button', { name: 'Libraries', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
  expect(commands).toHaveLength(3);
  await dialog.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(commands).toHaveLength(4);
  expect(commands[3]).toEqual(commands[2]);
  expect((await f.story(second)).settings.personaId).toBe(replacement);
  expect((await f.library()).personas.some(item => item.id === persona)).toBe(false);
});
