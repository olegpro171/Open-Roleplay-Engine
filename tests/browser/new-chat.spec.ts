import { test, expect, type Page } from '@playwright/test';
import type { ChatSnapshot } from '../../src/shared/contracts';
import type { LibrarySnapshot } from '../../src/shared/library';
import { newLorebook } from '../../src/shared/lorebook';

async function library(page: Page): Promise<LibrarySnapshot> {
  return page.request.get('/api/library').then(response => response.json());
}

async function choose(page: Page, label: string, name: string) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name, exact: true }).click();
}

for (const width of [1440, 390]) {
  test(`new chat saves its title and defaults before opening Setup at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const session = await page.request.get('/api/session').then(response => response.json());
    await page.goto('/');
    await page.getByLabel('Owner password').fill('browser-synthetic-password');
    await page.getByRole('button', { name: session.setupRequired ? 'Create owner account' : 'Sign in', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Libraries', exact: true })).toBeVisible();

    async function add(kind: 'characters' | 'personas' | 'lorebooks', data: unknown): Promise<string> {
      const response = await page.request.post('/api/library', {
        headers: { Origin: 'http://127.0.0.1:4173' },
        data: { kind, revision: (await library(page)).revision, data },
      });
      expect(response.ok(), await response.text()).toBe(true);
      return (await response.json()).id;
    }
    const characterName = width === 390 ? 'Long character '.padEnd(100, 'x') : 'Chat starter';
    const title = width === 390 ? `${characterName.slice(0, 89)} - Roleplay` : 'Chat starter - Roleplay';
    const book = newLorebook();
    book.name = `Starter lore ${width}`;
    const bookId = await add('lorebooks', book);
    const characterId = await add('characters', {
      name: characterName, description: 'A synthetic character.', personality: '', scenario: '',
      first_mes: 'Welcome, {{user}}.', mes_example: '', lorebookId: bookId,
    });
    const personaId = await add('personas', { name: `Starter visitor ${width}`, description: 'A synthetic visitor.' });
    const before = await library(page);
    await page.getByRole('button', { name: 'Libraries', exact: true }).click();
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    const form = page.getByRole('group', { name: 'New chat', exact: true });
    await expect(form.getByRole('combobox')).toHaveCount(2);
    await expect(form.getByRole('textbox')).toHaveCount(0);
    await choose(page, 'Character', characterName);
    await choose(page, 'Persona', `Starter visitor ${width}`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/new-chat-${width}.png`, fullPage: true });

    // A rejected create keeps the form and its selections, and does not navigate or save a chat.
    await page.route('**/api/chats', route => route.fulfill({
      status: 422, contentType: 'application/json', body: JSON.stringify({ message: 'Synthetic creation failure.' }),
    }), { times: 1 });
    await page.getByRole('button', { name: 'Create chat', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Synthetic creation failure.');
    await expect(form.getByRole('combobox', { name: 'Character', exact: true })).toContainText(characterName);
    await expect(form.getByRole('combobox', { name: 'Persona', exact: true })).toContainText(`Starter visitor ${width}`);
    expect((await library(page)).chats).toHaveLength(before.chats.length);

    await page.getByRole('button', { name: 'Create chat', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Chat setup', exact: true })).toBeVisible();
    await expect(page.getByLabel('Chat title')).toHaveValue(title);
    await expect(page.getByRole('combobox', { name: 'Lorebook', exact: true })).toContainText(book.name);
    await page.screenshot({ path: `test-results/new-chat-setup-${width}.png`, fullPage: true });
    const after = await library(page);
    const created = after.chats.filter(chat => !before.chats.some(old => old.id === chat.id));
    expect(created).toHaveLength(1);
    const chat = created[0];
    if (!chat) throw new Error('The new chat was not saved.');
    const saved: ChatSnapshot = await page.request.get(`/api/chats/${chat.id}`).then(response => response.json());
    expect(saved.settings).toMatchObject({
      title, characterId, personaId, lorebookId: bookId, promptId: 'default',
      connectionId: before.connections[0]?.id ?? null, contextPresetId: null, targetInputTokens: 32_000,
    });
    expect(saved.turns).toHaveLength(1);
    expect(saved.turns[0]?.assistant.text).toBe(`Welcome, Starter visitor ${width}.`);
    expect(saved.turns[0]?.complete).toBe(true);
    expect(saved.generations).toHaveLength(0);

    // Leave Setup without saving, then reload and reopen it: the initial values are already durable.
    await page.getByRole('button', { name: 'Story', exact: true }).click();
    await expect(page.getByLabel('Conversation')).toContainText(`Welcome, Starter visitor ${width}.`);
    await page.reload();
    await expect(page.getByLabel('Conversation')).toContainText(`Welcome, Starter visitor ${width}.`);
    await page.getByRole('button', { name: 'Story', exact: true }).click();
    await page.getByRole('button', { name: 'Chat settings', exact: true }).click();
    await expect(page.getByLabel('Chat title')).toHaveValue(title);
    await expect(page.getByRole('combobox', { name: 'Character', exact: true })).toContainText(characterName);
    await expect(page.getByRole('combobox', { name: 'Persona', exact: true })).toContainText(`Starter visitor ${width}`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
