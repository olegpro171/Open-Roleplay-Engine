import { selectLibraryCategory } from './library-card-helpers';
import { addChatCharacter, addChatModel, chooseNewChatCharacter, openChatTool, openNewChatSettings, openChatCreation } from './chat-tools';
import { expect, type Page } from '@playwright/test';
import { test } from './isolated-app';
import type { ChatSnapshot } from '../../src/shared/contracts';
import type { LibrarySnapshot } from '../../src/shared/library';
import { newLorebook } from '../../src/shared/lorebook';
import { appearanceStatusSchema } from '../../src/shared/appearance';

async function library(page: Page): Promise<LibrarySnapshot> {
  return page.request.get('/api/library').then(response => response.json());
}

async function choose(page: Page, label: string, name: string) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name, exact: true }).click();
}

for (const width of [1440, 390]) {
  test(`starts a chat from the library while preserving the previous chat at ${width}px`, async ({ page, browserApp }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const session = await page.request.get('/api/session').then(response => response.json());
    await page.goto('/');
    await page.getByLabel('Owner password').fill('browser-synthetic-password');
    await page.getByRole('button', { name: session.setupRequired ? 'Create owner account' : 'Sign in', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Libraries', exact: true })).toBeVisible();
    const composer = page.getByLabel('Your next turn');
    await composer.fill('Keep the draft from the previous chat.');
    const currentChat = () => page.evaluate(() => localStorage.getItem('roleplay-chat'));
    const previousChat = await currentChat();
    const previous: ChatSnapshot = await page.request.get(`/api/chats/${previousChat}`).then(response => response.json());
    await page.getByRole('button', { name: 'Libraries', exact: true }).click();
    await openChatCreation(page);
    await expect(page.getByRole('button', { name: 'Start chat', exact: true })).toBeDisabled();
    await page.reload();
    await expect(composer).toHaveValue('Keep the draft from the previous chat.');
    expect(await currentChat()).toBe(previousChat);
    await addChatModel(page);

    async function add(kind: 'characters' | 'personas' | 'lorebooks', data: unknown): Promise<string> {
      const response = await page.request.post('/api/library', {
        headers: { Origin: browserApp.url },
        data: { kind, revision: (await library(page)).revision, data },
      });
      expect(response.ok(), await response.text()).toBe(true);
      return (await response.json()).id;
    }
    const characterName = width === 390 ? 'Long character '.padEnd(100, 'x') : 'Chat starter';
    const title = characterName;
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
    await openChatCreation(page);
    const setup = page.getByRole('main', { name: 'New chat', exact: true });
    const start = setup.getByRole('button', { name: 'Start chat', exact: true });
    expect(await currentChat()).toBe(previousChat);
    expect((await library(page)).chats).toEqual(before.chats);
    await expect(composer).toHaveCount(0);
    await expect(setup.getByRole('heading', { level: 1 })).toBeFocused();
    await setup.getByRole('button', { name: 'Characters', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Characters', exact: true })).toBeVisible();
    const primaryTab = page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'New chat', exact: true });
    await primaryTab.click();
    await expect(primaryTab).toHaveAttribute('aria-current', 'page');
    await chooseNewChatCharacter(page, characterName);
    await choose(page, 'Persona', `Starter visitor ${width}`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('new-chat.png'), fullPage: true });

    // A rejected create keeps the form and its selections, and does not navigate or save a chat.
    await page.route('**/api/chats', route => route.fulfill({
      status: 422, contentType: 'application/json', body: JSON.stringify({ message: 'Synthetic creation failure.' }),
    }), { times: 1 });
    await start.click();
    await expect(page.getByRole('alert')).toContainText('Synthetic creation failure.');
    await expect(setup.getByRole('heading', { name: characterName, exact: true })).toBeVisible();
    await expect(setup.getByRole('combobox', { name: 'Persona', exact: true })).toContainText(`Starter visitor ${width}`);
    expect((await library(page)).chats).toEqual(before.chats);
    expect(await currentChat()).toBe(previousChat);

    await start.click();
    const conversation = page.getByRole('region', { name: 'Conversation', exact: true });
    await expect(conversation).toContainText(`Welcome, Starter visitor ${width}.`);
    await expect(conversation.getByRole('button', { name: 'generate an opening', exact: true })).toHaveCount(0);
    await openNewChatSettings(page);
    await expect(page.getByRole('region', { name: 'Chat settings', exact: true })).toBeVisible();
    await expect(page.getByLabel('Chat title')).toHaveValue(title);
    await expect(page.getByRole('combobox', { name: 'Lorebook', exact: true })).toContainText(book.name);
    const after = await library(page);
    const created = after.chats.filter(chat => !before.chats.some(old => old.id === chat.id));
    expect(created).toHaveLength(1);
    const chat = created[0];
    if (!chat) throw new Error('The new chat was not saved.');
    const saved: ChatSnapshot = await page.request.get(`/api/chats/${chat.id}`).then(response => response.json());
    expect(saved.settings).toMatchObject({
      title, characterId, personaId, lorebookId: bookId, promptId: 'default',
      connectionId: before.connections[0]?.id ?? null, contextPresetId: 'default-context', targetInputTokens: 32_000,
    });
    expect(saved.turns).toHaveLength(1);
    expect(saved.turns[0]?.assistant.text).toBe(`Welcome, Starter visitor ${width}.`);
    expect(saved.turns[0]?.complete).toBe(true);
    expect(saved.generations).toHaveLength(0);
    expect(await page.request.get(`/api/chats/${previousChat}`).then(response => response.json())).toEqual(previous);

    // Leave Chat settings without saving, then reload and reopen it: the initial values are already durable.
    await page.getByRole('button', { name: 'Story', exact: true }).click();
    await expect(page.getByLabel('Conversation')).toContainText(`Welcome, Starter visitor ${width}.`);
    await page.reload();
    await expect(page.getByLabel('Conversation')).toContainText(`Welcome, Starter visitor ${width}.`);
    await page.getByRole('button', { name: 'Story', exact: true }).click();
    await openChatTool(page, 'Chat settings');
    await expect(page.getByLabel('Chat title')).toHaveValue(title);
    await expect(page.getByRole('combobox', { name: 'Character', exact: true })).toContainText(characterName);
    await expect(page.getByRole('combobox', { name: 'Persona', exact: true })).toContainText(`Starter visitor ${width}`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('button', { name: 'Return without saving', exact: true }).click();
    await page.getByRole('button', { name: 'Libraries', exact: true }).click();
    await selectLibraryCategory(page, 'Chats');
    await page.getByRole('button', { name: previous.settings.title, exact: true }).click();
    await expect(composer).toHaveValue('Keep the draft from the previous chat.');
  });
}

test('an empty Story guides the first send or offers help choosing a Connection', async ({ page, browserApp }, testInfo) => {
  await page.goto('/');
  await page.getByLabel('Owner password').fill('browser-synthetic-password');
  await page.getByRole('button', { name: 'Create owner account', exact: true }).click();
  const conversation = page.getByRole('region', { name: 'Conversation', exact: true });
  const composer = conversation.getByLabel('Your next turn');
  const send = conversation.getByRole('button', { name: 'Send', exact: true });
  const settingsShortcut = conversation.getByRole('button', { name: 'Open chat settings', exact: true });
  const firstMessage = conversation.getByText('No messages yet. Send the first message or generate an opening.', { exact: true });
  const missingConnection = conversation.getByText('Choose a Connection to send messages.', { exact: true });
  await expect(composer).toBeVisible();
  const [legacyChat] = (await library(page)).chats;
  if (!legacyChat) throw new Error('Missing starter chat fixture.');
  const headers = { Origin: browserApp.url };

  await addChatModel(page);
  await addChatCharacter(page, 'Silent keeper');
  const libraries = page.getByRole('button', { name: 'Libraries', exact: true });
  await libraries.click();
  await selectLibraryCategory(page, 'Chats');
  await openChatCreation(page);
  await page.getByRole('button', { name: 'Start chat', exact: true }).click();
  await expect(firstMessage).toBeVisible();
  await expect(settingsShortcut).toHaveCount(0);
  await expect(composer).not.toBeFocused();
  await expect(send).toBeDisabled();

  async function inspectThemes(hint: typeof firstMessage, state: string) {
    for (const theme of ['dark', 'light', 'midnight-black'] as const) {
      const appearance = appearanceStatusSchema.parse(await page.request.get('/api/application/appearance').then(response => response.json()));
      const response = await page.request.put('/api/application/appearance', {
        headers, data: { revision: appearance.revision, settings: { ...appearance.settings, theme } },
      });
      expect(response.ok(), await response.text()).toBe(true);
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      for (const width of [1440, 801, 800, 390]) {
        await page.setViewportSize({ width, height: 844 });
        await expect(hint).toBeInViewport();
        await expect(composer).toBeInViewport();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        if (width === 1440 || width === 390) {
          await page.screenshot({ path: testInfo.outputPath(`${state}-${theme}-${width}.png`) });
        }
      }
    }
  }

  await inspectThemes(firstMessage, 'ready');
  await composer.fill('I knock on the door.');
  await page.request.post('/__test/mode', { data: { mode: 'hold' } });
  await send.click();
  const turn = conversation.getByRole('article', { name: 'Turn 1', exact: true });
  await expect(turn).toContainText('I knock on the door.');
  await expect(turn.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
  await expect(firstMessage).toHaveCount(0);
  await expect(turn).toContainText('The lantern');
  await page.request.post('/__test/finish', { data: {} });
  await expect(turn).toContainText('The lantern flickers.');
  await turn.getByRole('button', { name: 'More turn actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Delete turn', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete turn', exact: true }).click();
  await expect(firstMessage).toBeVisible();
  await expect(turn).toHaveCount(0);

  await libraries.click();
  await selectLibraryCategory(page, 'Chats');
  await page.getByRole('region', { name: 'Chats', exact: true }).getByRole('button', { name: legacyChat.title, exact: true }).click();
  await expect(missingConnection).toBeVisible();
  await expect(firstMessage).toHaveCount(0);
  await inspectThemes(missingConnection, 'missing-connection');
  await composer.fill('Keep this first draft.');
  await expect(send).toBeDisabled();
  await settingsShortcut.click();
  await choose(page, 'Connection', 'Chat fixture model');
  await page.getByRole('button', { name: 'Save and return', exact: true }).click();
  await expect(firstMessage).toBeVisible();
  await expect(composer).toHaveValue('Keep this first draft.');
  await expect(send).toBeEnabled();
});
