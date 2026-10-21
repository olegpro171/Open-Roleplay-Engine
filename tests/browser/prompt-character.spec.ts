import { test, expect, type Page } from '@playwright/test';
import type { ChatSnapshot, RequestPreview } from '../../src/shared/contracts';
import type { LibrarySnapshot, PromptPreset } from '../../src/shared/library';
import { newLorebook, newLoreEntry } from '../../src/shared/lorebook';
import { legacyLorePrompt } from '../../src/persistence/legacy-prompt';

async function choose(page: Page, label: string, value: string) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name: value, exact: true }).click();
}

test('selects Character fields, groups resolved messages and sends exact automatic lore placement', async ({ page }) => {
  const session = await page.request.get('/api/session').then(response => response.json());
  await page.goto('/');
  await page.getByLabel('Owner password').fill('browser-synthetic-password');
  await page.getByRole('button', { name: session.setupRequired ? 'Create owner account' : 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Libraries', exact: true })).toBeVisible();
  const library = () => page.request.get('/api/library').then(response => response.json() as Promise<LibrarySnapshot>);
  const command = async (url: string, data: unknown) => {
    const response = await page.request.post(url, { headers: { Origin: 'http://127.0.0.1:4173' }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const { endpoint } = await page.request.get('/__test/endpoint').then(response => response.json());
  await page.request.post('/__test/mode', { data: { mode: 'normal' } });
  const connection = await command('/api/library', { revision: (await library()).revision, kind: 'connections', data: { name: 'Field proof model', endpoint, model: 'synthetic-roleplay', contextWindow: 100000, maxOutputTokens: 1000, customParameters: {} } });
  const character = await command('/api/library', { revision: (await library()).revision, kind: 'characters', data: { name: 'Mira', description: '{{char}} keeps the key.', personality: 'PERSONALITY EXCLUDED', scenario: 'A quiet tower.', mes_example: 'EXAMPLES EXCLUDED', first_mes: '' } });
  const book = await command('/api/library', { revision: (await library()).revision, kind: 'lorebooks', data: { ...newLorebook(), name: 'Field proof lore', entries: [
    { ...newLoreEntry('description'), name: 'Tower secret', constant: true, placement: 'after_desc', content: 'The key opens the northern vault.' },
    { ...newLoreEntry('personality'), name: 'Absent personality lore', constant: true, placement: 'personality', content: 'MUST NOT INSERT' },
    { ...newLoreEntry('history'), name: 'History lore', constant: true, placement: 'history', content: 'The moon is rising.' },
  ] } });
  await page.getByRole('button', { name: 'Libraries', exact: true }).click();
  await page.getByRole('button', { name: 'Prompts', exact: true }).click();
  await page.getByRole('button', { name: 'New prompt', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Selectable fields proof');
  await page.getByRole('button', { name: 'Expand block 2', exact: true }).click();
  const fields = page.getByRole('group', { name: 'Included character fields', exact: true });
  await expect(fields.getByRole('checkbox')).toHaveCount(5);
  for (const label of ['Name', 'Personality', 'Example dialogue']) await fields.getByRole('checkbox', { name: label, exact: true }).uncheck();
  await choose(page, 'Role for block 2', 'user');
  await choose(page, 'Marker source for block 2', 'Character');
  await expect(fields.getByRole('checkbox', { name: 'Personality', exact: true })).not.toBeChecked();
  await page.getByRole('combobox', { name: 'Marker source for block 2', exact: true }).click();
  await expect(page.getByRole('option', { name: /Lore/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.screenshot({ path: 'test-results/character-fields-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/character-fields-phone.png', fullPage: true });
  await page.getByRole('button', { name: 'Save prompt', exact: true }).click();
  const saved = (await library()).prompts.find(prompt => prompt.name === 'Selectable fields proof');
  expect(saved?.blocks.find(block => block.kind === 'marker' && block.marker === 'character')).toMatchObject({ fields: ['description', 'scenario'], role: 'user' });
  if (!saved) throw new Error('Missing saved prompt.');
  const row = page.getByRole('article').filter({ has: page.getByRole('heading', { name: saved.name, exact: true }) });
  await row.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('button', { name: 'Expand block 2', exact: true }).click();
  await expect(fields.getByRole('checkbox', { name: 'Name', exact: true })).not.toBeChecked();
  await expect(fields.getByRole('checkbox', { name: 'Description', exact: true })).toBeChecked();
  await page.getByRole('button', { name: 'Close editor', exact: true }).click();
  const exported = await page.request.get(`/api/library/prompts/${saved.id}/export`).then(response => response.json() as Promise<PromptPreset>);
  expect(exported.blocks).toEqual(saved.blocks);
  const chat = await command('/api/chats', { title: 'Character field story', targetInputTokens: 5000, connectionId: connection.id, characterId: character.id, promptId: saved.id, personaId: null, lorebookId: book.id });
  await page.getByRole('button', { name: 'Chats', exact: true }).click();
  await page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Character field story', exact: true }) }).click();
  await page.getByLabel('Your next turn').fill('I enter the tower.');
  const state = () => page.request.get(`/api/chats/${chat.id}`).then(response => response.json() as Promise<ChatSnapshot>);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator('.context-dropdown > summary').click();
  await page.getByRole('button', { name: 'Prompt peek', exact: true }).click();
  const peek = page.getByRole('dialog', { name: 'Prompt peek', exact: true });
  const group = peek.getByRole('region', { name: 'Character messages', exact: true });
  await expect(group.locator('details')).toHaveCount(3);
  expect(await group.locator('.prompt-message summary').allTextContents()).toEqual(expect.arrayContaining([expect.stringContaining('Description'), expect.stringContaining('Lore · Tower secret'), expect.stringContaining('Scenario')]));
  await expect(peek).toContainText('Absent personality lore · excluded');
  await group.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/character-peek-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await group.scrollIntoViewIfNeeded();
  expect(await peek.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/character-peek-phone.png', fullPage: true });
  await page.getByRole('button', { name: 'Close peek', exact: true }).click();
  const preview: RequestPreview = await command(`/api/chats/${chat.id}/preview`, { revision: (await state()).revision, text: 'I enter the tower.' });
  expect(preview.body.messages.slice(1)).toEqual([
    { role: 'user', content: 'Mira keeps the key.' }, { role: 'system', content: 'The key opens the northern vault.' },
    { role: 'user', content: 'A quiet tower.' }, { role: 'user', content: 'I enter the tower.' }, { role: 'system', content: 'The moon is rising.' },
  ]);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(async () => (await state()).generations[0]?.status).toBe('succeeded');
  const requests: { body: object }[] = await page.request.get('/__test/requests').then(response => response.json());
  expect(requests.at(-1)?.body).toEqual(preview.body);
  expect((await state()).generations[0]?.request?.layout?.filter(part => part.group)).toEqual(preview.layout?.filter(part => part.group));
});

test('imports older prompt exports with retired lore controls as selectable fields', async ({ page }) => {
  const session = await page.request.get('/api/session').then(response => response.json());
  await page.goto('/'); await page.getByLabel('Owner password').fill('browser-synthetic-password');
  await page.getByRole('button', { name: session.setupRequired ? 'Create owner account' : 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Libraries', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Libraries', exact: true }).click();
  await page.getByRole('button', { name: 'Prompts', exact: true }).click();
  await page.getByLabel('Import prompt', { exact: true }).setInputFiles({ name: 'old-prompt.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ ...legacyLorePrompt, name: 'Legacy fields import' })) });
  await expect(page.getByRole('heading', { name: 'Legacy fields import', exact: true })).toBeVisible();
  const library: LibrarySnapshot = await page.request.get('/api/library').then(response => response.json());
  const prompt = library.prompts.find(item => item.name === 'Legacy fields import');
  expect(prompt?.blocks).toHaveLength(5);
  expect(prompt?.blocks.find(block => block.kind === 'marker' && block.marker === 'character')).toMatchObject({ fields: ['name', 'description', 'personality', 'scenario', 'examples'] });
});
