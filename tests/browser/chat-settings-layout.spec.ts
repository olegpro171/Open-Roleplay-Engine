import { expect } from '@playwright/test';
import { appearanceStatusSchema } from '../../src/shared/appearance';
import type { RequestEstimate } from '../../src/shared/contracts';
import type { LibrarySnapshot } from '../../src/shared/library';
import { openChatTool, openNewChatSettings } from './chat-tools';
import { test } from './isolated-app';

test('Chat settings shows saved branch input alongside editable selections', async ({ page, browserApp }, testInfo) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await page.getByLabel('Owner password').fill('browser-synthetic-password');
  await page.getByRole('button', { name: 'Create owner account', exact: true }).click();
  const composer = page.getByLabel('Your next turn');
  await expect(composer).toBeVisible();

  const headers = { Origin: browserApp.url };
  const { endpoint } = await page.request.get('/__test/endpoint').then(response => response.json());
  async function createConnection(name: string, model: string): Promise<string> {
    const library: LibrarySnapshot = await page.request.get('/api/library').then(response => response.json());
    const response = await page.request.post('/api/library', { headers, data: { revision: library.revision, kind: 'connections',
      data: { name, endpoint, model, contextWindow: 100_000, maxOutputTokens: 1000, customParameters: {} },
    } });
    expect(response.ok(), await response.text()).toBe(true);
    return (await response.json()).id;
  }
  const connectionId = await createConnection('Saved Connection', 'saved-model');
  const alternateConnectionId = await createConnection('Alternate Connection', 'alternate-model');
  const targetInputTokens = 40_000;
  const { revision, settings } = await page.request.get('/api/chats/main').then(response => response.json());
  const selected = await page.request.put('/api/chats/main/selections', { headers, data: { revision, settings: {
    title: settings.title, targetInputTokens, promptId: 'default', connectionId, characterId: null, personaId: null,
  } } });
  expect(selected.ok(), await selected.text()).toBe(true);
  const saved = await selected.json();
  const transcript = await page.request.put('/api/__test/transcripts/main', { headers, data: { revision: saved.revision, turns: [
    { user: 'Open the gate.', assistant: 'The gate swings inward.', complete: true },
    { user: 'Enter the courtyard.', assistant: 'A lantern lights the path.', complete: true },
  ] } });
  expect(transcript.ok(), await transcript.text()).toBe(true);
  const currentRevision = (await transcript.json()).revision;

  async function estimate(text: string): Promise<number> {
    const response = await page.request.post('/api/chats/main/preview', {
      headers, data: { revision: currentRevision, inspection: true, detail: 'estimate', text },
    });
    expect(response.ok(), await response.text()).toBe(true);
    const preview: RequestEstimate = await response.json();
    return preview.budget.inputTokens;
  }

  const draft = 'Consider the sound of footsteps before taking the next step. '.repeat(30).trimEnd();
  const savedTokens = await estimate('');
  const draftTokens = await estimate(draft);
  const sidebar = page.getByRole('complementary', { name: 'Current chat' });
  const stats = sidebar.locator('dl dd');
  const savedTarget = targetInputTokens.toLocaleString('en');
  const inputEstimate = (tokens: number) => `≈ ${tokens.toLocaleString('en')} / ${savedTarget}`;
  expect(draftTokens).toBeGreaterThan(savedTokens);
  await expect(sidebar.getByText('Saved Connection · saved-model', { exact: true })).toBeVisible();
  await composer.fill(draft);
  await expect(stats).toHaveText(['2', '2', inputEstimate(draftTokens)]);

  const panel = page.getByRole('region', { name: 'Chat settings', exact: true });
  const context = panel.getByRole('region', { name: 'Context', exact: true });
  const branchContext = sidebar.locator('.context-dropdown summary');
  const peekButton = sidebar.getByRole('button', { name: 'Prompt peek', exact: true });
  const target = context.getByLabel('Target input tokens', { exact: true });
  let releasePreview = () => {};
  const previewGate = new Promise<void>(resolve => { releasePreview = resolve; });
  await page.route('**/api/chats/main/preview', async route => {
    if (route.request().postDataJSON().text === '') await previewGate;
    await route.continue();
  });
  try {
    await openChatTool(page, 'Chat settings');
    await expect(target).toHaveAccessibleDescription('Counting current input…');
    await expect(stats).toHaveText(['2', '2', `— / ${savedTarget}`]);
  } finally {
    releasePreview();
  }
  const savedEstimate = `Estimated input with saved settings · ${savedTokens.toLocaleString('en')}`;
  await expect(target).toHaveAccessibleDescription(savedEstimate);
  await expect(panel.getByText('Applies to all branches of this chat', { exact: false })).toBeVisible();
  await expect(panel.getByRole('region', { name: 'Story', exact: true }).getByLabel('Chat title')).toHaveValue(settings.title);
  const connection = panel.getByRole('region', { name: 'Generation', exact: true }).getByRole('combobox', { name: 'Connection', exact: true });
  await expect(connection).toHaveAccessibleDescription('Model · saved-model');
  await connection.click();
  await page.getByRole('option', { name: 'Alternate Connection', exact: true }).click();
  await target.fill('15000');
  await expect(connection).toHaveAccessibleDescription('Model · alternate-model');
  await expect(panel.getByText('Unsaved changes', { exact: true })).toBeVisible();
  await expect(target).toHaveAccessibleDescription(savedEstimate);
  await expect(context.locator('details')).toHaveCount(0);
  await expect(sidebar.getByText('Saved Connection · saved-model', { exact: true })).toBeVisible();
  await expect(stats).toHaveText(['2', '2', inputEstimate(savedTokens)]);
  await expect(branchContext).toContainText('Full history');
  await branchContext.click();
  await peekButton.click();
  const peek = page.getByRole('dialog', { name: 'Prompt peek', exact: true });
  await expect(peek.getByRole('region', { name: 'Assembled prompt', exact: true })).toBeVisible();
  await expect(peek.locator('.prompt-message.draft')).toHaveCount(0);
  await page.getByRole('button', { name: 'Close peek', exact: true }).click();
  await branchContext.click();

  const save = sidebar.getByRole('button', { name: 'Save and return', exact: true });
  const chatDetails = page.getByRole('button', { name: 'Chat details', exact: true });
  for (const theme of ['dark', 'light', 'midnight-black', 'porcelain'] as const) {
    const appearance = appearanceStatusSchema.parse(await page.request.get('/api/application/appearance').then(response => response.json()));
    const response = await page.request.put('/api/application/appearance', { headers, data: { revision: appearance.revision, settings: { ...appearance.settings, theme } } });
    expect(response.ok(), await response.text()).toBe(true);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await panel.evaluate(node => { node.scrollTop = 0; });
      await expect(save).toBeInViewport();
      await expect(panel.getByRole('heading', { name: 'Chat settings', exact: true, level: 1 })).toBeInViewport();
      expect(await panel.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`${theme}-${width}.png`), animations: 'disabled' });
      if (width === 390) await chatDetails.click();
      await branchContext.click();
      await peekButton.scrollIntoViewIfNeeded();
      await expect(sidebar.getByRole('meter')).toBeInViewport();
      await page.screenshot({ path: testInfo.outputPath(`${theme}-${width}-context.png`), animations: 'disabled' });
      await branchContext.click();
      if (width === 390) await chatDetails.click();
      await expect(save).toBeInViewport();
    }
  }
  await save.click();
  await expect(composer).toHaveValue(draft);
  const after = await page.request.get('/api/chats/main').then(response => response.json());
  expect(after.settings.targetInputTokens).toBe(15_000);
  expect(after.settings.connectionId).toBe(alternateConnectionId);
  expect(await page.request.get('/__test/requests').then(response => response.json())).toEqual([]);

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Language', exact: true }).click();
  await page.getByRole('combobox', { name: 'Interface language', exact: true }).click();
  await page.getByRole('option', { name: 'Русский', exact: true }).click();
  await page.getByRole('button', { name: 'История', exact: true }).click();
  await openNewChatSettings(page, 'ru');
  const russian = page.getByRole('region', { name: 'Настройки чата', exact: true });
  await expect(russian.getByRole('combobox', { name: 'Подключение', exact: true })).toHaveAccessibleDescription('Модель · alternate-model');
  await expect(russian.getByLabel('Целевой размер входа в токенах', { exact: true }))
    .toHaveAccessibleDescription(/Оценка для сохранённых настроек/);
  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await russian.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`porcelain-russian-${width}.png`), animations: 'disabled' });
  }
});
