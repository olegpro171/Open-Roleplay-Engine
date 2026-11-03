import { expect, type Page } from '@playwright/test';
import { test } from './isolated-app';
import { appearanceStatusSchema } from '../../src/shared/appearance';
import type { ChatSnapshot } from '../../src/shared/contracts';
import { defaultContextPreset } from '../../src/shared/context';
import type { LibrarySnapshot } from '../../src/shared/library';
import { openChatTool } from './chat-tools';

const password = 'synthetic-password-ноябрь';
async function register(page: Page) {
  await page.goto('/');
  await page.getByLabel('Owner password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Create owner account', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible();
}

for (const theme of ['dark', 'light', 'midnight-black'] as const) {
  test(`password visibility preserves authentication and fits in ${theme}`, async ({ page, browserApp }, testInfo) => {
    await page.goto('/');
    const input = page.getByLabel('Owner password', { exact: true });
    const show = page.getByRole('button', { name: 'Show password', exact: true });
    let submissions = 0;
    page.on('request', request => { if (/\/api\/(setup|login)$/.test(request.url())) submissions++; });
    await expect(input).toHaveAttribute('type', 'password');
    await expect(input).toHaveAttribute('autocomplete', 'new-password');
    await expect(input).toHaveAttribute('minlength', '12');
    await expect(input).toHaveAttribute('maxlength', '256');
    await expect(input).toHaveAttribute('required', '');
    await show.press('Enter');
    await expect(input).toHaveValue('');
    await expect(input).toHaveAttribute('type', 'text');
    await input.fill(password);
    await page.getByRole('button', { name: 'Hide password', exact: true }).press('Space');
    await expect(input).toHaveValue(password);
    await expect(input).toHaveAttribute('type', 'password');
    expect(submissions).toBe(0);
    await input.press('Enter');
    await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible();
    expect(submissions).toBe(1);
    const appearance = appearanceStatusSchema.parse(await page.request.get('/api/application/appearance').then(response => response.json()));
    expect((await page.request.put('/api/application/appearance', { headers: { Origin: browserApp.url }, data: { revision: appearance.revision, settings: { ...appearance.settings, theme } } })).ok()).toBe(true);
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(input).toHaveAttribute('type', 'password');
    await expect(input).toHaveAttribute('autocomplete', 'current-password');
    await expect(input).toHaveValue('');
    await input.fill('synthetic-wrong-password');
    await show.click();
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(input).toHaveValue('synthetic-wrong-password');
    await expect(input).toHaveAttribute('type', 'text');
    for (const width of [1280, 801, 800, 390]) {
      await page.setViewportSize({ width, height: 850 });
      await expect(input).toBeInViewport({ ratio: 1 });
      await expect(page.getByRole('button', { name: 'Hide password', exact: true })).toBeInViewport({ ratio: 1 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`${theme}-${width}-login.png`) });
      await page.getByRole('button', { name: 'Hide password', exact: true }).click();
      await page.screenshot({ path: testInfo.outputPath(`${theme}-${width}-login-masked.png`) });
      await show.click();
    }
    await input.fill(password);
    await input.press('Enter');
    await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('combobox', { name: 'Interface language', exact: true }).click();
    await page.getByRole('option', { name: 'Русский', exact: true }).click();
    await page.getByRole('button', { name: 'Выйти', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Показать пароль', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Показать пароль', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Скрыть пароль', exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByLabel('Пароль владельца', { exact: true })).toHaveAttribute('type', 'password');
  });

  test(`chat warnings, preparation and character guidance in ${theme}`, async ({ page, browserApp }, testInfo) => {
    test.setTimeout(60_000);
    await register(page);
    const headers = { Origin: browserApp.url };
    const appearance = appearanceStatusSchema.parse(await page.request.get('/api/application/appearance').then(response => response.json()));
    expect((await page.request.put('/api/application/appearance', { headers, data: { revision: appearance.revision, settings: { ...appearance.settings, theme } } })).ok()).toBe(true);
    const library = async (): Promise<LibrarySnapshot> => page.request.get('/api/library').then(response => response.json());
    async function create(kind: string, data: unknown) {
      const response = await page.request.post('/api/library', { headers, data: { revision: (await library()).revision, kind, data } });
      expect(response.ok()).toBe(true);
      return (await response.json()).id as string;
    }
    const { endpoint } = await page.request.get('/__test/endpoint').then(response => response.json());
    const connectionId = await create('connections', { name: 'Sweep Connection', endpoint, model: 'synthetic', contextWindow: 100_000, maxOutputTokens: 1000, customParameters: {} });
    const contextPresetId = await create('contexts', { ...defaultContextPreset, name: 'Sweep context', minTail: 1, batchSize: 2, summaryTokens: 100 });
    const response = await page.request.post('/api/chats', { headers, data: { title: 'Sweep chat', connectionId, contextPresetId, promptId: 'default', targetInputTokens: 600, characterId: null, personaId: null } });
    expect(response.ok()).toBe(true);
    const id: string = (await response.json()).id;
    const state = async (): Promise<ChatSnapshot> => page.request.get(`/api/chats/${id}`).then(result => result.json());
    await page.evaluate(id => localStorage.setItem('roleplay-chat', id), id);
    await page.reload();
    await expect(page.getByLabel('Your next turn')).toBeVisible();
    await openChatTool(page, 'Chat settings');
    await expect(page.getByRole('status').filter({ hasText: 'Checking prompt configuration' })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Prompt configuration warnings', exact: true })).toHaveCount(0);
    await page.route('**/api/chats/*/prompt-diagnostics', route => route.fulfill({ status: 503, json: { message: 'Synthetic diagnostic failure' } }));
    await page.getByRole('button', { name: 'Return without saving', exact: true }).click();
    await openChatTool(page, 'Chat settings');
    const warnings = page.getByRole('region', { name: 'Prompt configuration warnings', exact: true });
    await expect(warnings.getByRole('alert')).toHaveText('Synthetic diagnostic failure');
    await page.unroute('**/api/chats/*/prompt-diagnostics');
    await warnings.getByRole('button', { name: 'Check again', exact: true }).click();
    await expect(warnings).toHaveCount(0);
    await page.getByRole('button', { name: 'Return without saving', exact: true }).click();
    expect((await page.request.put(`/api/chats/${id}/history`, { headers, data: { revision: (await state()).revision, turns: Array.from({ length: 6 }, (_, i) => ({ user: `Turn ${i}. ` + 'Mira carries the silver key. '.repeat(20), assistant: 'Leon waits beside the tower. '.repeat(20), complete: true })) } })).ok()).toBe(true);
    await page.request.post('/__test/mode', { data: { mode: 'hold' } });
    let jobId: string | undefined;
    try {
      const started = await page.request.post(`/api/chats/${id}/context/prepare`, { headers, data: { revision: (await state()).revision, requestId: crypto.randomUUID(), mode: 'prepare' } });
      expect(started.ok()).toBe(true);
      jobId = (await started.json()).jobId;
      const status = page.locator('.memory-preparation-status');
      await expect(status).toHaveText('Preparing memory…');
      for (const width of [1280, 801, 800, 390]) {
        await page.setViewportSize({ width, height: 850 });
        await expect(status).toBeInViewport({ ratio: 1 });
        const notice = await status.boundingBox(), composer = await page.locator('.composer').boundingBox();
        if (!notice || !composer) throw new Error('Missing preparation notice or composer');
        expect(notice.y + notice.height).toBeLessThanOrEqual(composer.y);
        const frame = page.locator('.transcript-frame');
        const shownFrame = await frame.boundingBox();
        await status.evaluate(element => { element.style.display = 'none'; });
        const hiddenFrame = await frame.boundingBox();
        await status.evaluate(element => { element.style.removeProperty('display'); });
        expect(shownFrame).toEqual(hiddenFrame);
        await page.locator('.transcript').evaluate(element => { element.scrollTop = 0; });
        const latest = page.getByRole('button', { name: 'Latest turn', exact: true });
        await expect(latest).toBeVisible();
        const latestBox = await latest.boundingBox();
        if (!latestBox) throw new Error('Missing latest-turn control');
        expect(latestBox.y + latestBox.height).toBeLessThanOrEqual(notice.y);
        await latest.click();
        await page.screenshot({ path: testInfo.outputPath(`${theme}-${width}-preparation-notice.png`) });
        const trigger = page.getByRole('button', { name: 'Chat details', exact: true });
        if (await trigger.isVisible() && await trigger.getAttribute('aria-expanded') === 'false') await trigger.click();
        await page.getByRole('button', { name: 'Author’s note', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'Author’s note', exact: true });
        await expect(dialog.getByRole('status')).toHaveText('Preparing memory…');
        await expect(dialog.getByLabel('Note text')).toBeDisabled();
        await expect(dialog.getByLabel('Depth', { exact: true })).toHaveValue('0');
        await page.screenshot({ path: testInfo.outputPath(`${theme}-${width}-preparing.png`) });
        await dialog.getByRole('button', { name: 'Close Author’s note' }).click();
        const details = page.getByRole('button', { name: 'Chat details', exact: true });
        if (await details.isVisible() && await details.getAttribute('aria-expanded') === 'true') await details.click();
      }
    } finally {
      if (jobId) await page.request.post(`/api/context/jobs/${jobId}/cancel`, { headers, data: {} });
      await page.request.post('/__test/mode', { data: { mode: 'normal' } });
    }
    await page.getByRole('button', { name: 'Libraries', exact: true }).click();
    await page.getByRole('button', { name: 'Characters', exact: true }).click();
    await page.getByRole('button', { name: 'New character', exact: true }).click();
    const example = page.getByLabel('Example dialogue', { exact: true });
    await expect(example).toHaveValue('');
    await expect(example).toHaveAttribute('placeholder', '<START>\n{{user}}: \n{{char}}:');
    await expect(page.getByText(/Write sample exchanges/)).toContainText('{{user}}: and {{char}}:');
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 850 });
      await example.scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`${theme}-${width}-example.png`) });
    }
  });
}

test('Character and Persona choices follow each Library sort in new and existing chats', async ({ page, browserApp }) => {
  await register(page);
  const headers = { Origin: browserApp.url };
  for (const kind of ['characters', 'personas']) {
    for (const name of ['Zulu', 'Alpha']) {
      const library: LibrarySnapshot = await page.request.get('/api/library').then(response => response.json());
      const data = kind === 'characters' ? { name, description: '', personality: '', scenario: '', first_mes: '', mes_example: '' } : { name, description: '' };
      expect((await page.request.post('/api/library', { headers, data: { kind, revision: library.revision, data } })).ok()).toBe(true);
    }
  }
  await page.getByRole('button', { name: 'Libraries', exact: true }).click();
  for (const category of ['Characters', 'Personas']) {
    await page.getByRole('button', { name: category, exact: true }).click();
    await page.getByRole('combobox', { name: `Sort ${category.toLowerCase()}`, exact: true }).click();
    await page.getByRole('option', { name: category === 'Characters' ? 'Name Z–A' : 'Name A–Z', exact: true }).click();
  }
  await page.getByRole('button', { name: 'Chats', exact: true }).click();
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  const check = async () => {
    for (const [label, names] of [['Character', ['None selected', 'Zulu', 'Alpha']], ['Persona', ['None selected', 'Alpha', 'Zulu']]] as const) {
      await page.getByRole('combobox', { name: label, exact: true }).click();
      const options = page.getByRole('listbox').getByRole('option');
      await expect(options).toHaveCount(names.length);
      for (const [index, name] of names.entries()) await expect(options.nth(index)).toHaveAccessibleName(name);
      await page.getByRole('option', { name: 'Alpha', exact: true }).click();
    }
  };
  await check();
  await page.getByRole('button', { name: 'Create chat', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Chat settings', exact: true })).toBeVisible();
  await check();
});
