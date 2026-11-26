import { selectLibraryCategory } from './library-card-helpers';
import { expect } from '@playwright/test';
import { appearanceStatusSchema } from '../../src/shared/appearance';
import { defaultContextPreset } from '../../src/shared/context';
import type { ChatSnapshot } from '../../src/shared/contracts';
import { defaultPrompt, type LibrarySnapshot } from '../../src/shared/library';
import { newLorebook } from '../../src/shared/lorebook';
import { openChatTool, openNewChatSettings, openChatCreation } from './chat-tools';
import { test } from './isolated-app';

for (const width of [1440, 390]) {
  test(`chat selections follow their saved Library sorting at ${width}px`, async ({ page, browserApp }, testInfo) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await page.getByLabel('Owner password').fill('browser-synthetic-password');
    await page.getByRole('button', { name: 'Create owner account', exact: true }).click();
    const libraries = page.getByRole('button', { name: 'Libraries', exact: true });
    await expect(libraries).toBeVisible();

    const headers = { Origin: browserApp.url };
    const readLibrary = (): Promise<LibrarySnapshot> => page.request.get('/api/library').then(response => response.json());
    const { endpoint } = await page.request.get('/__test/endpoint').then(response => response.json());
    const fixtures = [
      { kind: 'prompts', key: 'promptId', category: 'Prompts', label: 'Prompt preset', data: defaultPrompt, sort: 'Name A–Z',
        order: ['Amber Prompt preset', 'Default roleplay', 'Echo Prompt preset'] },
      { kind: 'contexts', key: 'contextPresetId', category: 'Context presets', label: 'Context preset', data: defaultContextPreset, sort: 'Name Z–A',
        order: ['Layered narrative memory', 'Echo Context preset', 'Amber Context preset'] },
      { kind: 'connections', key: 'connectionId', category: 'Connections', label: 'Connection', sort: 'Name A–Z',
        data: { endpoint, model: 'mock', contextWindow: 100_000, maxOutputTokens: 1000, customParameters: {} }, order: ['Amber Connection', 'Echo Connection'] },
      { kind: 'lorebooks', key: 'lorebookId', category: 'Lorebooks', label: 'Lorebook', data: newLorebook(), sort: 'Added: oldest',
        order: ['Echo Lorebook', 'Amber Lorebook'] },
    ];
    const selectedSettings: Record<string, string> = {};
    const character = await page.request.post('/api/library', {
      headers, data: { kind: 'characters', revision: (await readLibrary()).revision,
        data: { name: 'Sorting witness', description: '', personality: '', scenario: '', first_mes: '', mes_example: '' } },
    });
    expect(character.ok(), await character.text()).toBe(true);
    for (const fixture of fixtures) {
      for (const prefix of ['Echo', 'Amber']) {
        const response = await page.request.post('/api/library', {
          headers, data: { kind: fixture.kind, revision: (await readLibrary()).revision, data: { ...fixture.data, name: `${prefix} ${fixture.label}` } },
        });
        expect(response.ok(), await response.text()).toBe(true);
        if (prefix === 'Amber') selectedSettings[fixture.key] = (await response.json()).id;
      }
    }
    // Existing installations may retain the old names of these built-in records.
    for (const legacy of [
      { kind: 'prompts', id: 'default', data: { ...defaultPrompt, name: 'Default roleplay' } },
      { kind: 'contexts', id: 'default-context', data: { ...defaultContextPreset, name: 'Layered narrative memory' } },
    ]) {
      const response = await page.request.put(`/api/library/${legacy.id}`, {
        headers, data: { kind: legacy.kind, revision: (await readLibrary()).revision, data: legacy.data },
      });
      expect(response.ok(), await response.text()).toBe(true);
    }

    await page.reload();
    await libraries.click();
    for (const fixture of fixtures) {
      await selectLibraryCategory(page, fixture.category);
      const sortLabel = `Sort ${fixture.category.toLowerCase()}`;
      await page.getByRole('combobox', { name: sortLabel, exact: true }).click();
      await page.getByRole('listbox', { name: sortLabel, exact: true }).getByRole('option', { name: fixture.sort, exact: true }).click();
      await expect(page.getByRole('region', { name: fixture.category, exact: true }).getByRole('heading', { level: 2 })).toHaveText(fixture.order);
    }
    await selectLibraryCategory(page, 'Chats');
    await openChatCreation(page);
    const [created] = await Promise.all([
      page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/chats'),
      page.getByRole('button', { name: 'Start chat', exact: true }).click(),
    ]);
    expect(created.ok()).toBe(true);
    const { id }: { id: string } = await created.json();
    await openNewChatSettings(page);

    for (const theme of ['dark', 'light', 'midnight-black'] as const) {
      const appearance = appearanceStatusSchema.parse(await page.request.get('/api/application/appearance').then(response => response.json()));
      const response = await page.request.put('/api/application/appearance', { headers, data: {
        revision: appearance.revision, settings: { ...appearance.settings, theme },
      } });
      expect(response.ok(), await response.text()).toBe(true);
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await openChatTool(page, 'Chat settings');
      for (const fixture of fixtures) {
        const trigger = page.getByRole('combobox', { name: fixture.label, exact: true });
        await trigger.click();
        const options = page.getByRole('listbox', { name: fixture.label, exact: true }).getByRole('option');
        await expect(options).toHaveText(fixture.kind === 'prompts' ? fixture.order : ['None selected', ...fixture.order]);
        if (fixture.kind === 'contexts') await page.screenshot({ path: testInfo.outputPath(`${theme}-context-options.png`), animations: 'disabled' });
        await trigger.press('Escape');
      }
      await page.getByRole('button', { name: 'Return without saving', exact: true }).click();
      await openChatTool(page, 'Inspect memory');
      const closeMemory = page.getByRole('button', { name: 'Return to chat', exact: true });
      const controls = page.locator('.chat-page-actions').filter({ has: closeMemory });
      await expect(controls).toHaveCSS('box-shadow', 'none');
      await expect(controls).toHaveCSS('padding', '0px');
      if (width === 390) {
        await expect(closeMemory).not.toHaveCSS('box-shadow', 'none');
        await closeMemory.screenshot({ path: testInfo.outputPath(`${theme}-floating-close.png`) });
      }
      const checkOptions = async (label: string, expected: string[]) => {
        const trigger = page.getByRole('combobox', { name: label, exact: true });
        await trigger.click();
        await expect(page.getByRole('listbox', { name: label, exact: true }).getByRole('option')).toHaveText(expected);
        await trigger.press('Escape');
      };
      await checkOptions('Context preset', ['No context preset', ...fixtures[1].order]);
      await libraries.click();
      await selectLibraryCategory(page, 'Context presets');
      await page.getByRole('button', { name: 'Amber Context preset', exact: true }).click();
      await checkOptions('Summarization Connection', ['Same as current chat connection', 'Amber Connection · mock', 'Echo Connection · mock']);
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await selectLibraryCategory(page, 'Characters');
      await page.getByRole('button', { name: 'Sorting witness', exact: true }).click();
      await page.getByRole('tab', { name: 'Lore & tags', exact: true }).click();
      await checkOptions('Default lorebook', ['None selected', ...fixtures[3].order]);
      const reviewTags = page.getByRole('button', { name: 'Review embedded tags', exact: true });
      await reviewTags.scrollIntoViewIfNeeded();
      const manage = await page.getByRole('button', { name: 'Manage tags', exact: true }).boundingBox();
      const review = await reviewTags.boundingBox();
      if (!manage || !review) throw new Error('Missing Character tag controls');
      expect(Math.max(review.x - manage.x - manage.width, review.y - manage.y - manage.height)).toBeGreaterThanOrEqual(7);
      await page.screenshot({ path: testInfo.outputPath(`${theme}-character-tag-actions.png`), animations: 'disabled' });
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await page.getByRole('button', { name: 'Story', exact: true }).click();
      await openChatTool(page, 'Chat settings');
    }

    for (const fixture of fixtures) {
      const trigger = page.getByRole('combobox', { name: fixture.label, exact: true });
      await trigger.click();
      await page.getByRole('option', { name: `Amber ${fixture.label}`, exact: true }).click();
      await expect(trigger).toHaveText(`Amber ${fixture.label}`);
    }
    await page.getByRole('button', { name: 'Save and return', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Chat settings', exact: true })).toHaveCount(0);
    const saved: ChatSnapshot = await page.request.get(`/api/chats/${id}`).then(response => response.json());
    expect(saved.settings).toMatchObject(selectedSettings);

    if (width === 1440) {
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByRole('button', { name: 'Language', exact: true }).click();
      await page.getByRole('combobox', { name: 'Interface language', exact: true }).click();
      await page.getByRole('option', { name: 'Русский', exact: true }).click();
      await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
      await page.getByRole('button', { name: 'История', exact: true }).click();
      await page.getByRole('button', { name: 'Настройки чата', exact: true }).click();
      const context = page.getByRole('combobox', { name: 'Пресет контекста', exact: true });
      await expect(context).toHaveText('Amber Context preset');
      await context.click();
      await expect(page.getByRole('listbox', { name: 'Пресет контекста', exact: true }).getByRole('option')).toHaveText([
        'Не выбрано', ...fixtures[1].order,
      ]);
    }
  });
}
