import { expect, type Page } from '@playwright/test';
import { appearanceStatusSchema, themeSchema } from '../../src/shared/appearance';
import type { ChatSnapshot, RequestBody } from '../../src/shared/contracts';

export async function setupScene(page: Page, greeting = '') {
  await page.goto('/');
  await page.getByLabel('Owner password').fill('browser-synthetic-password');
  await page.getByRole('button', { name: 'Create owner account', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible();
  const headers = { Origin: new URL(page.url()).origin };
  const read = async (path: string) => page.request.get(path).then(response => response.json());
  const write = async (path: string, data: unknown, method: 'POST' | 'PUT' = 'POST') => {
    const response = await page.request.fetch(path, { method, headers, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const saveLibrary = async (kind: string, data: unknown) => write('/api/library', {
    revision: (await read('/api/library')).revision, kind, data,
  });
  const { endpoint } = await read('/__test/endpoint');
  const connection = await saveLibrary('connections', {
    name: 'Opening connection', endpoint, model: 'synthetic-roleplay', contextWindow: 100_000, maxOutputTokens: 1_000, customParameters: {},
  });
  const character = await saveLibrary('characters', {
    name: 'Mira', description: 'The ferry keeper.', personality: '', scenario: 'The ferry is overdue.',
    mes_example: '', first_mes: greeting,
  });
  const chat = await write('/api/chats', { title: 'The overdue ferry', connectionId: connection.id, promptId: 'default',
    characterId: character.id, personaId: null, contextPresetId: null, targetInputTokens: 20_000 });
  await page.evaluate(id => localStorage.setItem('roleplay-chat', id), chat.id);
  await page.reload();
  return {
    chatId: chat.id as string, write,
    state: (): Promise<ChatSnapshot> => read(`/api/chats/${chat.id}`),
    calls: (): Promise<{ body: RequestBody }[]> => read('/__test/requests'),
    setMode: (mode: number | string) => write('/__test/mode', { mode }),
    async setTheme(theme: typeof themeSchema.options[number]) {
      const appearance = appearanceStatusSchema.parse(await read('/api/application/appearance'));
      await write('/api/application/appearance', { revision: appearance.revision, settings: { ...appearance.settings, theme } }, 'PUT');
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    },
  };
}
