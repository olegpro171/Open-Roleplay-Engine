import { expect, type Page } from '@playwright/test';
import type { LibrarySnapshot } from '../../src/shared/library';
import { defaultChatInputTarget } from '../../src/shared/chat-defaults';

export async function openChatCreation(page: Page, language: 'en' | 'ru' = 'en') {
  const label = language === 'ru' ? 'Новый чат' : 'New chat';
  const chats = page.getByRole('region', { name: language === 'ru' ? 'Чаты' : 'Chats', exact: true });
  await chats.getByRole('button', { name: label, exact: true }).click();
  await expect(page.getByRole('main', { name: label, exact: true })).toBeVisible();
}

export async function chooseNewChatCharacter(page: Page, name: string, language: 'en' | 'ru' = 'en') {
  const panel = page.getByRole('region', { name: language === 'ru' ? 'Персонаж' : 'Character', exact: true });
  const selector = panel.getByRole('combobox');
  const selected = panel.getByRole('heading', { name, exact: true });
  await expect(selector.or(selected).first()).toBeVisible();
  if (await selector.isVisible()) {
    await selector.click();
    await page.getByRole('option', { name, exact: true }).click();
  }
  await expect(selected).toBeVisible();
}

export async function addChatModel(page: Page) {
  const library: LibrarySnapshot = await page.request.get('/api/library').then(response => response.json());
  const { endpoint } = await page.request.get('/__test/endpoint').then(response => response.json());
  const response = await page.request.post('/api/library', {
    headers: { Origin: new URL(page.url()).origin },
    data: { kind: 'connections', revision: library.revision, data: {
      name: 'Chat fixture model', endpoint, model: 'mock', contextWindow: 100_000, maxOutputTokens: 1000, customParameters: {},
    } },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

export async function addChatCharacter(page: Page, name: string) {
  const library: LibrarySnapshot = await page.request.get('/api/library').then(response => response.json());
  const response = await page.request.post('/api/library', {
    headers: { Origin: new URL(page.url()).origin },
    data: { kind: 'characters', revision: library.revision, data: {
      name, description: '', personality: '', scenario: '', first_mes: '', mes_example: '',
    } },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

// Tool and editor tests also cover existing chats without a Character.
export async function openBlankChatFixture(page: Page) {
  const response = await page.request.post('/api/chats', {
    headers: { Origin: new URL(page.url()).origin },
    data: { title: 'A new story', targetInputTokens: defaultChatInputTarget, characterId: null, personaId: null },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const { id } = await response.json();
  await page.evaluate(id => localStorage.setItem('roleplay-chat', id), id);
  await page.reload();
  await expect(page.getByRole('region', { name: 'Conversation', exact: true })).toBeVisible();
}

export async function openChatTool(page: Page, name: 'Chat settings' | 'Inspect memory' | 'Request inspector' | 'Chat branches' | 'Pinned turns') {
  await clickChatTool(page, name, 'Chat details');
}

async function clickChatTool(page: Page, name: string, detailsName: string) {
  const tool = page.getByRole('button', { name, exact: true });
  const collapsedDetails = page.getByRole('button', { name: detailsName, exact: true, expanded: false });
  // Story may still be loading after a reload or branch switch.
  await expect(collapsedDetails.or(tool).first()).toBeVisible();
  if (await collapsedDetails.isVisible()) await collapsedDetails.click();
  await tool.click();
}

export async function openNewChatSettings(page: Page, language: 'en' | 'ru' = 'en') {
  const name = language === 'ru' ? 'Настройки чата' : 'Chat settings';
  const settings = page.getByRole('region', { name, exact: true });
  const conversation = page.getByRole('region', { name: language === 'ru' ? 'Переписка' : 'Conversation', exact: true });
  await expect(settings.or(conversation)).toBeVisible();
  if (await settings.isVisible()) return;
  await clickChatTool(page, name, language === 'ru' ? 'О чате' : 'Chat details');
  await expect(settings).toBeVisible();
}
