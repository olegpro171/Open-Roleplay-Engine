import { expect } from '@playwright/test';
import type { ChatSnapshot } from '../../src/shared/contracts';
import type { LibrarySnapshot } from '../../src/shared/library';
import { openChatTool } from './chat-tools';
import { test } from './isolated-app';

for (const width of [1280, 390]) {
  test(`Escape returns from chat tools in dismissal order at ${width}px`, async ({ page, browserApp }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await page.getByLabel('Owner password').fill('browser-synthetic-password');
    await page.getByRole('button', { name: 'Create owner account', exact: true }).click();
    const composer = page.getByLabel('Your next turn');
    const draft = 'Keep this draft in the same chat.';
    await composer.fill(draft);

    const headers = { Origin: browserApp.url };
    const library: LibrarySnapshot = await page.request.get('/api/library').then(response => response.json());
    const { endpoint } = await page.request.get('/__test/endpoint').then(response => response.json());
    const connection = await page.request.post('/api/library', { headers, data: {
      revision: library.revision, kind: 'connections',
      data: { name: 'Escape test model', endpoint, model: 'synthetic', contextWindow: 100_000, maxOutputTokens: 1000, customParameters: {} },
    } });
    expect(connection.ok(), await connection.text()).toBe(true);
    const state = (): Promise<ChatSnapshot> => page.request.get('/api/chats/main').then(response => response.json());
    const initial = await state();
    const { title, targetInputTokens, promptId, contextPresetId } = initial.settings;
    const selected = await page.request.put('/api/chats/main/selections', { headers, data: {
      revision: initial.revision,
      settings: { title, targetInputTokens, promptId, contextPresetId, characterId: null, personaId: null, connectionId: (await connection.json()).id },
    } });
    expect(selected.ok(), await selected.text()).toBe(true);
    await expect(page.getByText('Escape test model · synthetic', { exact: true })).toBeAttached();

    await openChatTool(page, 'Chat settings');
    const settings = page.getByRole('region', { name: 'Chat settings', exact: true });
    await settings.getByLabel('Chat title').fill('Discarded with Escape');
    await page.keyboard.press('Escape');
    const leave = page.getByRole('dialog', { name: 'Leave editor?', exact: true });
    await leave.getByRole('button', { name: 'Go back', exact: true }).click();
    await expect(settings.getByLabel('Chat title')).toHaveValue('Discarded with Escape');
    await page.keyboard.press('Escape');
    await leave.getByRole('button', { name: 'Leave editor', exact: true }).click();
    await expect(composer).toHaveValue(draft);
    expect((await state()).settings.title).toBe(initial.settings.title);

    const memory = page.getByRole('region', { name: 'Memory', exact: true });
    const toolsPath = '**/api/chats/main/tools';
    await page.route(toolsPath, route => route.fulfill({
      status: 503, json: { message: 'Synthetic chat tools load failure' },
    }), { times: 1 });
    await openChatTool(page, 'Inspect memory');
    const loadError = page.getByRole('alert').filter({ hasText: 'Synthetic chat tools load failure' });
    await expect(loadError).toBeVisible();
    await loadError.getByRole('button', { name: 'Retry loading' }).press('Escape');
    await expect(composer).toHaveValue(draft);

    await openChatTool(page, 'Inspect memory');
    await expect(memory).toBeVisible();
    if (width <= 800) {
      const details = page.getByRole('button', { name: 'Chat details', exact: true });
      await details.press('Enter');
      await expect(details).toHaveAttribute('aria-expanded', 'true');
      await page.keyboard.press('Escape');
      await expect(details).toHaveAttribute('aria-expanded', 'false');
      await expect(memory).toBeVisible();
    }
    await page.keyboard.press('Escape');
    await expect(composer).toHaveValue(draft);

    await openChatTool(page, 'Request inspector');
    const inspector = page.getByRole('region', { name: 'Request inspector', exact: true });
    const peek = inspector.getByRole('button', { name: 'Prompt peek', exact: true });
    await peek.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(inspector).toBeVisible();
    const requests = inspector.getByRole('combobox', { name: 'Inspect request', exact: true });
    await requests.press('ArrowDown');
    await expect(requests).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Escape');
    await expect(requests).toHaveAttribute('aria-expanded', 'false');
    await expect(requests).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(composer).toHaveValue(draft);
    expect(await page.evaluate(() => localStorage.getItem('roleplay-chat'))).toBe('main');

    await openChatTool(page, 'Chat settings');
    await settings.getByLabel('Chat title').fill('Saved during Escape');
    let resumeSave = () => {};
    const saveGate = new Promise<void>(resolve => { resumeSave = resolve; });
    await page.route('**/api/chats/main/selections', async route => {
      await saveGate;
      await route.continue();
    }, { times: 1 });
    try {
      await page.getByRole('button', { name: 'Save and return', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Return without saving', exact: true })).toBeDisabled();
      await page.keyboard.press('Escape');
      await expect(settings).toBeVisible();
    } finally {
      resumeSave();
    }
    await expect(composer).toHaveValue(draft);
    expect((await state()).settings.title).toBe('Saved during Escape');
  });
}
