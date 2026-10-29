import { expect, test, type Page, type Route } from '@playwright/test';
import { defaultPrompt, type LibrarySnapshot } from '../../src/shared/library';
import { defaultContextPreset } from '../../src/shared/context';
import type { ChatDefaultsStatus, ChatDefaultKind } from '../../src/shared/chat-defaults';
import type { ChatSnapshot } from '../../src/shared/contracts';
import { appearanceStatusSchema } from '../../src/shared/appearance';
import { test as isolatedTest } from './isolated-app';

const headers = { Origin: 'http://127.0.0.1:4173' };
const readLibrary = (page: Page): Promise<LibrarySnapshot> => page.request.get('/api/library').then(response => response.json());
const readDefaults = (page: Page): Promise<ChatDefaultsStatus> => page.request.get('/api/application/chat-defaults').then(response => response.json());

for (const width of [1440, 390]) {
  isolatedTest(`fresh installations bookmark both factory presets at ${width}px`, async ({ page, browserApp }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await page.getByLabel('Owner password').fill('browser-synthetic-password');
    await page.getByRole('button', { name: 'Create owner account', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Libraries', exact: true })).toBeVisible();
    expect((await readDefaults(page)).settings).toEqual({ prompts: 'default', connections: null, contexts: 'default-context' });
    const library = await readLibrary(page);
    const builtIns = [
      { category: 'Prompts', preset: library.prompts.find(item => item.id === 'default') },
      { category: 'Context presets', preset: library.contexts.find(item => item.id === 'default-context') },
    ];
    const headers = { Origin: browserApp.url };
    for (const theme of ['dark', 'light', 'midnight-black'] as const) {
      const appearance = appearanceStatusSchema.parse(await page.request.get('/api/application/appearance').then(response => response.json()));
      const saved = await page.request.put('/api/application/appearance', { headers, data: { revision: appearance.revision, settings: { ...appearance.settings, theme } } });
      expect(saved.ok()).toBe(true);
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await page.getByRole('button', { name: 'Libraries', exact: true }).click();
      for (const { category, preset } of builtIns) {
        if (!preset) throw new Error('Missing factory preset');
        await page.getByRole('navigation', { name: 'Library categories' }).getByRole('button', { name: category, exact: true }).click();
        await expect(page.getByRole('button', { name: `Clear ${preset.name} as default`, exact: true })).toHaveAttribute('aria-pressed', 'true');
        await page.screenshot({ path: testInfo.outputPath(`${theme}-${preset.id}-${width}.png`), animations: 'disabled' });
      }
    }
    await page.getByRole('navigation', { name: 'Library categories' }).getByRole('button', { name: 'Chats', exact: true }).click();
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    await page.getByRole('button', { name: 'Create chat', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Chat settings', exact: true })).toBeVisible();
    for (const { category, preset } of builtIns) {
      if (!preset) throw new Error('Missing factory preset');
      await expect(page.getByRole('combobox', { name: category === 'Prompts' ? 'Prompt preset' : 'Context preset', exact: true })).toContainText(preset.name);
    }
    const created = (await readLibrary(page)).chats.find(chat => !library.chats.some(old => old.id === chat.id));
    if (!created) throw new Error('Missing created chat');
    const snapshot: ChatSnapshot = await page.request.get(`/api/chats/${created.id}`).then(response => response.json());
    expect(snapshot.settings).toMatchObject({ promptId: 'default', contextPresetId: 'default-context' });
  });
}

for (const width of [1440, 390]) {
  test(`bookmarks persist defaults for all new-chat selections at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const session = await page.request.get('/api/session').then(response => response.json());
    await page.goto('/');
    await page.getByLabel('Owner password').fill('browser-synthetic-password');
    await page.getByRole('button', { name: session.setupRequired ? 'Create owner account' : 'Sign in', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Libraries', exact: true })).toBeVisible();
    const previous = await readDefaults(page);
    const before = await readLibrary(page);
    const oldChat = before.chats[0];
    const oldState: ChatSnapshot | null = oldChat ? await page.request.get(`/api/chats/${oldChat.id}`).then(response => response.json()) : null;
    const { endpoint } = await page.request.get('/__test/endpoint').then(response => response.json());
    const fixtures: { kind: ChatDefaultKind; category: string; label: string; name: string; data: object; id?: string }[] = [
      { kind: 'prompts', category: 'Prompts', label: 'Prompt preset', name: `Bookmarked prompt ${width}`, data: defaultPrompt },
      { kind: 'connections', category: 'Connections', label: 'Connection', name: `Bookmarked connection ${width}`, data: { endpoint, model: 'mock', contextWindow: 100000, maxOutputTokens: 1000, customParameters: {} } },
      { kind: 'contexts', category: 'Context presets', label: 'Context preset', name: `Bookmarked context ${width}`, data: defaultContextPreset },
    ];
    try {
      for (const fixture of fixtures) {
        const response = await page.request.post('/api/library', { headers, data: { kind: fixture.kind, revision: (await readLibrary(page)).revision, data: { ...fixture.data, name: fixture.name } } });
        expect(response.ok(), await response.text()).toBe(true);
        fixture.id = (await response.json()).id;
      }
      await page.getByRole('button', { name: 'Libraries', exact: true }).click();
      const categories = page.getByRole('navigation', { name: 'Library categories' });
      for (const fixture of fixtures) {
        await categories.getByRole('button', { name: fixture.category, exact: true }).click();
        const set = page.getByRole('button', { name: `Set ${fixture.name} as default`, exact: true });
        await expect(set).toHaveAttribute('aria-pressed', 'false');
        if (fixture.kind === 'prompts') {
          // Failed writes never show a committed filled bookmark.
          const failSave = (route: Route) => route.request().method() === 'PUT'
            ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'Synthetic defaults save failure.' }) })
            : route.continue();
          await page.route('**/api/application/chat-defaults', failSave);
          await set.click();
          await expect(page.getByRole('alert')).toContainText('Synthetic defaults save failure.');
          await expect(set).toHaveAttribute('aria-pressed', 'false');
          await page.unroute('**/api/application/chat-defaults', failSave);
        }
        await set.click();
        await expect(page.getByRole('button', { name: `Clear ${fixture.name} as default`, exact: true })).toHaveAttribute('aria-pressed', 'true');
        expect((await readDefaults(page)).settings[fixture.kind]).toBe(fixture.id);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`default-${fixture.kind}-${width}.png`), fullPage: true });
      }
      // Choosing another default in a category replaces the previous bookmark.
      await categories.getByRole('button', { name: 'Prompts', exact: true }).click();
      const builtIn = (await readLibrary(page)).prompts.find(item => item.id === 'default');
      if (!builtIn) throw new Error('Missing built-in prompt');
      await page.getByRole('button', { name: `Set ${builtIn.name} as default`, exact: true }).click();
      const prompt = fixtures.find(fixture => fixture.kind === 'prompts');
      if (!prompt) throw new Error('Missing prompt fixture');
      await expect(page.getByRole('button', { name: `Set ${prompt.name} as default`, exact: true })).toHaveAttribute('aria-pressed', 'false');
      await page.getByRole('button', { name: `Set ${prompt.name} as default`, exact: true }).click();
      await page.reload();
      await page.getByRole('button', { name: 'Libraries', exact: true }).click();
      await expect(page.getByRole('button', { name: `Clear ${prompt.name} as default`, exact: true })).toHaveAttribute('aria-pressed', 'true');
      await categories.getByRole('button', { name: 'Chats', exact: true }).click();
      await page.getByRole('button', { name: 'New chat', exact: true }).click();
      await page.getByRole('button', { name: 'Create chat', exact: true }).click();
      await expect(page.getByRole('region', { name: 'Chat settings', exact: true })).toBeVisible();
      for (const fixture of fixtures) await expect(page.getByRole('combobox', { name: fixture.label, exact: true })).toContainText(fixture.name);
      const after = await readLibrary(page);
      const created = after.chats.find(chat => !before.chats.some(old => old.id === chat.id));
      if (!created) throw new Error('Missing created chat');
      const saved: ChatSnapshot = await page.request.get(`/api/chats/${created.id}`).then(response => response.json());
      expect(saved.settings).toMatchObject({ promptId: fixtures[0]?.id, connectionId: fixtures[1]?.id, contextPresetId: fixtures[2]?.id });
      if (oldState) expect(await page.request.get(`/api/chats/${oldState.id}`).then(response => response.json())).toEqual(oldState);
      await page.screenshot({ path: testInfo.outputPath(`default-chat-settings-${width}.png`), fullPage: true });
      // Clear a bookmark without changing the chat that already selected it.
      await page.getByRole('button', { name: 'Libraries', exact: true }).click();
      await categories.getByRole('button', { name: 'Prompts', exact: true }).click();
      await page.getByRole('button', { name: `Clear ${prompt.name} as default`, exact: true }).click();
      await expect(page.getByRole('button', { name: `Set ${prompt.name} as default`, exact: true })).toHaveAttribute('aria-pressed', 'false');
      expect((await readDefaults(page)).settings.prompts).toBeNull();
      const retained: ChatSnapshot = await page.request.get(`/api/chats/${created.id}`).then(response => response.json());
      expect(retained.settings).toEqual(saved.settings);
    } finally {
      for (const kind of ['prompts', 'connections', 'contexts'] as const) {
        const response = await page.request.put('/api/application/chat-defaults', { headers, data: {
          revision: (await readDefaults(page)).revision, libraryRevision: (await readLibrary(page)).revision, kind, id: previous.settings[kind],
        } });
        expect(response.ok(), await response.text()).toBe(true);
      }
    }
  });
}
