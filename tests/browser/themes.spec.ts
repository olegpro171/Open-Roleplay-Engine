import { expect } from '@playwright/test';
import { test } from './isolated-app';
import { appearanceStatusSchema } from '../../src/shared/appearance';
import type { LibrarySnapshot } from '../../src/shared/library';
import type { ChatSnapshot } from '../../src/shared/contracts';
import { defaultContextPreset } from '../../src/shared/context';
import { openChatTool } from './chat-tools';

const themeCases = [
  { theme: 'light', label: 'Light', russian: 'Светлая', character: '#343a42', persona: '#562a0a', speech: 'rgb(52, 58, 66)', chrome: '#eeebe5', page: 'rgb(247, 245, 241)', input: 'rgb(255, 255, 255)', scheme: 'light' },
  { theme: 'midnight-black', label: 'Midnight Black', russian: 'Полночная чёрная', character: '#e8e8e8', persona: '#e8e8e8', speech: 'rgb(232, 232, 232)', chrome: /^#(?:000|000000)$/, page: 'rgb(0, 0, 0)', input: 'rgb(0, 0, 0)', scheme: 'dark' },
] as const;

for (const choice of themeCases) for (const width of [1440, 390]) test(`${choice.theme} saves recover, synchronize and preserve speech overrides at ${width}px`, async ({ page, context, browserApp }, testInfo) => {
  await page.setViewportSize({ width, height: 900 });
  const headers = { Origin: browserApp.url };
  await page.goto('/');
  await page.getByLabel('Owner password').fill('browser-synthetic-password');
  await page.getByRole('button', { name: 'Create owner account', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible();
  const read = async () => appearanceStatusSchema.parse(await page.request.get('/api/application/appearance').then(response => response.json()));
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'Chat appearance', exact: true }).click();
  const settings = page.getByRole('region', { name: 'Chat appearance', exact: true });
  const theme = settings.getByRole('combobox', { name: 'Theme', exact: true });
  await expect(theme).toHaveText('Dark');
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('dark-settings.png') });
  const observer = await context.newPage();
  await observer.goto('/');
  await expect(observer.getByRole('navigation', { name: 'Workspace' })).toBeVisible();
  await expect(observer.locator('html')).toHaveAttribute('data-theme', 'dark');
  let fail = true;
  await page.route('**/api/application/appearance', route => route.request().method() === 'PUT' && fail
    ? route.fulfill({ status: 503, json: { message: 'Synthetic theme save failure' } }) : route.continue());
  await theme.click();
  await page.getByRole('option', { name: choice.label, exact: true }).click();
  await expect(settings.getByRole('alert')).toContainText('Synthetic theme save failure');
  await expect(theme).toHaveText(choice.label);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(observer.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect((await read()).settings.theme).toBe('dark');
  fail = false;
  await settings.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(settings.getByRole('alert')).toHaveCount(0);
  await expect(page.locator('html')).toHaveAttribute('data-theme', choice.theme);
  await expect(observer.locator('html')).toHaveAttribute('data-theme', choice.theme);
  await expect(page.getByRole('button', { name: 'Default character speech color', exact: true })).toContainText(choice.character.toUpperCase());
  await expect(page.getByRole('button', { name: 'Default persona speech color', exact: true })).toContainText(choice.persona.toUpperCase());
  await expect(settings.locator('.direct-speech')).toHaveCSS('color', choice.speech);
  await expect(page.locator('html')).toHaveCSS('color-scheme', choice.scheme);
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', choice.chrome);
  await expect(theme).toHaveCSS('background-color', choice.input);
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`${choice.theme}-settings.png`) });

  // A competing save while this window has an old revision preserves unrelated fields.
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  let held = false;
  await page.route('**/api/application/appearance', async route => {
    if (route.request().method() !== 'PUT') return route.fallback();
    if (!held) { held = true; await gate; }
    await route.fallback();
  });
  await theme.click();
  await page.getByRole('option', { name: 'Dark', exact: true }).click();
  await expect.poll(() => held).toBe(true);
  const current = await read();
  const external = await page.request.put('/api/application/appearance', { headers, data: { revision: current.revision, settings: { ...current.settings, chatTextScale: 110, characterSpeechColor: '#765432' } } });
  expect(external.ok()).toBe(true);
  release();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect.poll(async () => (await read()).settings).toEqual({ ...current.settings, theme: 'dark', chatTextScale: 110, characterSpeechColor: '#765432' });
  await expect(page.getByRole('button', { name: 'Default character speech color', exact: true })).toContainText('#765432');
  await theme.click();
  await page.getByRole('option', { name: choice.label, exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', choice.theme);
  await expect(settings.locator('.direct-speech')).toHaveCSS('color', 'rgb(118, 84, 50)');
  await settings.getByRole('button', { name: 'Use theme character color', exact: true }).click();
  await expect.poll(async () => (await read()).settings.characterSpeechColor).toBeNull();
  await expect(settings.locator('.direct-speech')).toHaveCSS('color', choice.speech);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', choice.theme);
  const fresh = await context.browser()?.newContext();
  if (!fresh) throw new Error('Missing browser');
  try {
    const login = await fresh.newPage();
    await login.goto(browserApp.url);
    await expect(login.getByLabel('Owner password')).toBeVisible();
    await expect(login.locator('html')).toHaveAttribute('data-theme', choice.theme);
    await expect(login.locator('html')).toHaveCSS('background-color', choice.page);
    await login.screenshot({ path: testInfo.outputPath(`${choice.theme}-login.png`) });
  } finally { await fresh.close(); }
  await page.getByRole('button', { name: 'Libraries', exact: true }).click();
  for (const card of [
    { category: 'Characters', create: 'New character', kind: 'characters', color: choice.character },
    { category: 'Personas', create: 'New persona', kind: 'personas', color: choice.persona },
  ] as const) {
    const name = `${choice.label} ${card.kind} default ${width}`;
    await page.getByRole('button', { name: card.category, exact: true }).click();
    await page.getByRole('button', { name: card.create, exact: true }).click();
    await page.getByLabel('Name', { exact: true }).fill(name);
    await page.getByRole('button', { name: 'Set color', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Speech color', exact: true })).toContainText(card.color.toUpperCase());
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
    const saved: LibrarySnapshot = await page.request.get('/api/library').then(response => response.json());
    expect(saved[card.kind].find(item => item.name === name)?.speechColor).toBe(card.color);
  }
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('combobox', { name: 'Interface language', exact: true }).click();
  await page.getByRole('option', { name: /Русский/ }).click();
  await expect(page.getByRole('combobox', { name: 'Тема', exact: true })).toHaveText(choice.russian);
  await observer.close();
});

for (const choice of themeCases) test(`${choice.theme} covers story, menus, memory and editable repair at responsive boundaries`, async ({ page, context, browserApp }, testInfo) => {
  test.setTimeout(90_000);
  const headers = { Origin: browserApp.url };
  const command = async (path: string, data: unknown, method = 'POST'): Promise<unknown> => {
    const response = await page.request.fetch(path, { method, headers, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  await page.goto('/');
  await page.getByLabel('Owner password').fill('browser-synthetic-password');
  await page.getByRole('button', { name: 'Create owner account', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible();
  const read = async () => appearanceStatusSchema.parse(await page.request.get('/api/application/appearance').then(response => response.json()));
  const initial = await read();
  await command('/api/application/appearance', { revision: initial.revision, settings: { ...initial.settings, theme: choice.theme } }, 'PUT');
  await expect(page.locator('html')).toHaveAttribute('data-theme', choice.theme);
  const contrast = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Missing canvas');
    const styles = getComputedStyle(document.documentElement);
    function luminance(role: string) {
      if (!context) throw new Error('Missing canvas');
      context.fillStyle = styles.getPropertyValue(`--${role}`);
      context.fillRect(0, 0, 1, 1);
      const channels = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map(value => {
        const channel = value / 255;
        return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
      });
      return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
    }
    return [['text', 'page'], ['muted', 'page'], ['text-faint', 'page'], ['text', 'input-bg'],
      ['accent', 'chrome'], ['muted', 'input-bg'], ['header-highlight', 'chrome'], ['link', 'page'], ['speech-character', 'page'],
      ['on-accent', 'accent'], ['danger-text', 'danger-surface'], ['danger-text-strong', 'danger-surface'],
      ['danger-text-strong', 'danger-surface-strong'], ['warning-text', 'warning-surface'], ['success-text', 'success-surface'], ['info-text', 'info-surface'],
      ['on-danger-button', 'danger-button'], ['on-retained', 'border-strong']].map(([foreground, background]) => {
        const a = luminance(foreground), b = luminance(background);
        return { foreground, background, ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) };
      });
  });
  for (const pair of contrast) expect(pair.ratio, `${pair.foreground} on ${pair.background}`).toBeGreaterThanOrEqual(4.5);
  if (choice.theme === 'midnight-black') {
    const colors = await page.evaluate(() => {
      const styles = getComputedStyle(document.documentElement);
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Missing canvas');
      return Object.fromEntries(['page', 'input-bg', 'chrome', 'surface', 'surface-low', 'surface-footer', 'surface-raised', 'tooltip-bg', 'login-glow',
        'text', 'text-secondary', 'muted', 'text-faint', 'line', 'control-border', 'border-strong', 'accent', 'header-highlight', 'link', 'speech-character', 'speech-persona', 'text-selection',
        'danger', 'success', 'warning', 'input-prompt', 'input-character', 'input-history'].map(role => {
        context.fillStyle = styles.getPropertyValue(`--${role}`);
        context.fillRect(0, 0, 1, 1);
        return [role, [...context.getImageData(0, 0, 1, 1).data].slice(0, 3)];
      }));
    });
    for (const role of ['page', 'input-bg', 'chrome', 'surface', 'surface-low', 'surface-footer', 'surface-raised', 'tooltip-bg', 'login-glow']) {
      expect(colors[role], role).toEqual([0, 0, 0]);
    }
    for (const role of ['text', 'text-secondary', 'muted', 'text-faint', 'line', 'control-border', 'border-strong', 'accent', 'header-highlight', 'link', 'speech-character', 'speech-persona', 'text-selection']) {
      const [red, green, blue] = colors[role];
      expect(red, role).toBe(green);
      expect(green, role).toBe(blue);
    }
    for (const role of ['danger', 'success', 'warning', 'input-prompt', 'input-character', 'input-history']) {
      expect(new Set(colors[role]).size, role).toBeGreaterThan(1);
    }
  }
  const library = (): Promise<LibrarySnapshot> => page.request.get('/api/library').then(response => response.json());
  const endpoint: { endpoint: string } = await page.request.get('/__test/endpoint').then(response => response.json());
  await command('/api/library', { revision: (await library()).revision, kind: 'connections', data: { name: 'Theme mock', endpoint: endpoint.endpoint, model: 'synthetic', contextWindow: 100_000, maxOutputTokens: 1000, customParameters: {} } });
  const connection = (await library()).connections[0];
  if (!connection) throw new Error('Missing Connection');
  await command('/api/library', { revision: (await library()).revision, kind: 'contexts', data: { ...defaultContextPreset, name: 'Theme memory', connectionId: connection.id, minTail: 2, batchSize: 2, promotionGroup: 2, retainedPerLevel: 1 } });
  const preset = (await library()).contexts.find(item => item.name === 'Theme memory');
  if (!preset) throw new Error('Missing context preset');
  await command('/api/chats', { title: 'Theme review', targetInputTokens: 800, connectionId: connection.id, promptId: 'default', characterId: null, personaId: null, contextPresetId: preset.id });
  const chat = (await library()).chats.find(item => item.title === 'Theme review');
  if (!chat) throw new Error('Missing chat');
  const state = (): Promise<ChatSnapshot> => page.request.get(`/api/chats/${chat.id}`).then(response => response.json());
  await command(`/api/chats/${chat.id}/history`, { revision: (await state()).revision, turns: Array.from({ length: 10 }, (_, i) => ({ user: `Turn ${i + 1}. "Ready?"\n\n${'Mira offers Leon the brass key. '.repeat(12)}`, assistant: '"Yes."\n\n**The tower** holds a [secret](https://example.com).\n\n`A small key`\n\n| Place | Clue |\n| --- | --- |\n| Tower | Lantern |\n\n' + 'Leon promises to avoid the cellar. '.repeat(12), complete: true })) }, 'PUT');
  await page.evaluate(id => localStorage.setItem('roleplay-chat', id), chat.id);
  await page.reload();
  await expect(page.locator('.part.assistant .direct-speech').first()).toHaveCSS('color', choice.speech);
  await expect(page.locator('.part.user .direct-speech').first()).toHaveCSS('color', choice.theme === 'light' ? 'rgb(86, 42, 10)' : choice.speech);
  await page.getByLabel('Your next turn').fill('Keep this draft while switching themes.');
  for (const width of [1440, 801, 800, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`${choice.theme}-story-${width}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: 'Libraries', exact: true }).click();
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await page.getByRole('button', { name: 'Actions for Theme mock', exact: true }).click();
  await expect(page.getByRole('menu')).toBeVisible();
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`${choice.theme}-library-menu.png`) });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Story', exact: true }).click();
  await expect(page.getByLabel('Your next turn')).toHaveValue('Keep this draft while switching themes.');
  await command(`/api/chats/${chat.id}/context/prepare`, { revision: (await state()).revision, requestId: crypto.randomUUID(), mode: 'prepare' });
  await expect.poll(async () => (await state()).context.jobs[0]?.status).not.toBe('running');
  const prepared = (await state()).context.jobs[0];
  expect(prepared?.status, JSON.stringify(prepared)).toBe('succeeded');
  const summary = (await state()).context.summaries.find(item => item.level === 1);
  const turn = (await state()).turns[0];
  if (!summary || !turn) throw new Error('Missing memory sources');
  await command(`/api/chats/${chat.id}/context/summaries/${summary.id}`, { revision: (await state()).revision, summaryRevision: summary.revision, text: 'Mira gave Leon the key. The tower door is locked.' }, 'PATCH');
  await command(`/api/chats/${chat.id}/turns/${turn.id}/user`, { revision: (await state()).revision, text: 'Mira kept the key. Leon never received it.' }, 'PATCH');
  await openChatTool(page, 'Inspect memory');
  await expect(page.getByRole('button', { name: 'Repair summaries', exact: true })).toBeEnabled();
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`${choice.theme}-memory.png`) });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.locator('.memory-chart').screenshot({ animations: 'disabled', path: testInfo.outputPath(`${choice.theme}-timeline-${width}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: 'Repair summaries', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Review the proposed replacement' });
  const proposal = dialog.getByLabel('Proposed summary', { exact: true });
  await expect(proposal).toHaveAttribute('contenteditable', 'true');
  // Unified comparisons also render removed text; compare only editable document lines.
  const lines = proposal.locator(':scope > .cm-line');
  const before = await lines.allTextContents();
  for (const width of [1440, 801, 800, 761, 760, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(lines).toHaveText(before);
    await dialog.screenshot({ animations: 'disabled', path: testInfo.outputPath(`${choice.theme}-repair-${width}.png`) });
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  }
  // Live theme changes must preserve an unapproved repair and its editable text.
  await proposal.press('ControlOrMeta+End');
  await proposal.press('Enter');
  await proposal.pressSequentially('My unapproved correction.');
  const current = await read();
  await command('/api/application/appearance', { revision: current.revision, settings: { ...current.settings, theme: 'dark' } }, 'PUT');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(proposal).toContainText('My unapproved correction.');
  await expect(dialog).toBeVisible();
  const latest = await read();
  await command('/api/application/appearance', { revision: latest.revision, settings: { ...latest.settings, theme: choice.theme } }, 'PUT');
  await expect(page.locator('html')).toHaveAttribute('data-theme', choice.theme);
  await expect(proposal).toContainText('My unapproved correction.');
  await expect(dialog.locator('.cm-editor').first()).toHaveCSS('background-color', choice.input);
  const freshPage = await context.newPage();
  await freshPage.goto('/');
  await expect(freshPage.getByLabel('Your next turn')).toHaveValue('Keep this draft while switching themes.');
  await freshPage.close();
});
