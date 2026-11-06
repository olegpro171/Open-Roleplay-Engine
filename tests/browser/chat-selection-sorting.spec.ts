import { expect } from '@playwright/test';
import { appearanceStatusSchema } from '../../src/shared/appearance';
import { defaultContextPreset } from '../../src/shared/context';
import type { ChatSnapshot } from '../../src/shared/contracts';
import { defaultPrompt, type LibrarySnapshot } from '../../src/shared/library';
import { newLorebook } from '../../src/shared/lorebook';
import { test } from './isolated-app';

for (const width of [1440, 390]) {
  test(`chat selections follow their saved Library sorting at ${width}px`, async ({ page, browserApp }, testInfo) => {
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
        order: ['Amber Prompt preset', 'Default prompt', 'Echo Prompt preset'] },
      { kind: 'contexts', key: 'contextPresetId', category: 'Context presets', label: 'Context preset', data: defaultContextPreset, sort: 'Name Z–A',
        order: ['Echo Context preset', 'Default context preset', 'Amber Context preset'] },
      { kind: 'connections', key: 'connectionId', category: 'Connections', label: 'Connection', sort: 'Name A–Z',
        data: { endpoint, model: 'mock', contextWindow: 100_000, maxOutputTokens: 1000, customParameters: {} }, order: ['Amber Connection', 'Echo Connection'] },
      { kind: 'lorebooks', key: 'lorebookId', category: 'Lorebooks', label: 'Lorebook', data: newLorebook(), sort: 'Added: oldest',
        order: ['Echo Lorebook', 'Amber Lorebook'] },
    ];
    const selectedSettings: Record<string, string> = {};
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
    const categories = page.getByRole('navigation', { name: 'Library categories' });
    for (const fixture of fixtures) {
      await categories.getByRole('button', { name: fixture.category, exact: true }).click();
      const sortLabel = `Sort ${fixture.category.toLowerCase()}`;
      await page.getByRole('combobox', { name: sortLabel, exact: true }).click();
      await page.getByRole('listbox', { name: sortLabel, exact: true }).getByRole('option', { name: fixture.sort, exact: true }).click();
      await expect(page.getByRole('region', { name: fixture.category, exact: true }).getByRole('heading', { level: 2 })).toHaveText(fixture.order);
    }
    await categories.getByRole('button', { name: 'Chats', exact: true }).click();
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    const [created] = await Promise.all([
      page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/chats'),
      page.getByRole('button', { name: 'Create chat', exact: true }).click(),
    ]);
    expect(created.ok()).toBe(true);
    const { id }: { id: string } = await created.json();
    await expect(page.getByRole('region', { name: 'Chat settings', exact: true })).toBeVisible();

    for (const theme of ['dark', 'light', 'midnight-black'] as const) {
      const appearance = appearanceStatusSchema.parse(await page.request.get('/api/application/appearance').then(response => response.json()));
      const response = await page.request.put('/api/application/appearance', { headers, data: {
        revision: appearance.revision, settings: { ...appearance.settings, theme },
      } });
      expect(response.ok(), await response.text()).toBe(true);
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await page.getByRole('button', { name: 'Open chat settings', exact: true }).click();
      for (const fixture of fixtures) {
        const trigger = page.getByRole('combobox', { name: fixture.label, exact: true });
        await trigger.click();
        const options = page.getByRole('listbox', { name: fixture.label, exact: true }).getByRole('option');
        await expect(options).toHaveText(fixture.kind === 'prompts' ? fixture.order : ['None selected', ...fixture.order]);
        if (fixture.kind === 'contexts') await page.screenshot({ path: testInfo.outputPath(`${theme}-context-options.png`), animations: 'disabled' });
        await trigger.press('Escape');
      }
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
        'Не выбрано', 'Echo Context preset', 'Amber Context preset', 'Пресет контекста по умолчанию',
      ]);
    }
  });
}
