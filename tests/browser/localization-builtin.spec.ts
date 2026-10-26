import { expect, test, type Page } from '@playwright/test';
import { languageStatusSchema } from '../../src/shared/localization';
import { z } from 'zod';
import { defaultPrompt } from '../../src/shared/library';

async function openTool(page: Page, name: string) {
  const toggle = page.getByRole('button', { name: 'Сведения о чате', exact: true });
  if (await toggle.isVisible() && await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
  await page.getByRole('button', { name, exact: true }).click();
}

for (const width of [1440, 390, 320]) test(`built-in Russian needs no import and preserves chat input at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 900 });
  const session = await page.request.get('/api/session').then(response => response.json());
  await page.goto('/');
  await page.getByLabel('Owner password').fill('browser-synthetic-password');
  await page.getByRole('button', { name: session.setupRequired ? 'Create owner account' : 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
  const status = languageStatusSchema.parse(await page.request.get('/api/localization').then(response => response.json()));
  expect(status.languages.find(pack => pack.locale === 'ru')).toMatchObject({ custom: false, translationIssues: [] });
  const library = z.object({ revision: z.number().int() }).parse(await page.request.get('/api/library').then(response => response.json()));
  const { endpoint } = await page.request.get('/__test/endpoint').then(response => response.json());
  const headers = { Origin: 'http://127.0.0.1:4173' };
  const connection = await page.request.post('/api/library', { headers, data: { revision: library.revision, kind: 'connections', data: {
    name: `Russian mock ${width}`, endpoint, model: 'synthetic', contextWindow: 100_000, maxOutputTokens: 1000, customParameters: {},
  } } }).then(response => response.json());
  const libraryRevision = async () => z.object({ revision: z.number().int() }).parse(await page.request.get('/api/library').then(response => response.json())).revision;
  const character = await page.request.post('/api/library', { headers, data: { revision: await libraryRevision(), kind: 'characters', data: {
    name: 'Literal character', description: 'Literal description', personality: 'Literal personality',
    scenario: 'Literal scenario', mes_example: 'Literal examples', first_mes: '',
  } } }).then(response => response.json());
  const prompt = await page.request.post('/api/library', { headers, data: { revision: await libraryRevision(), kind: 'prompts', data: {
    ...defaultPrompt, name: `Literal prompt ${width}`, blocks: [
      { id: 'literal', name: 'Turn 2 · input', kind: 'text', enabled: true, role: 'system', text: 'Literal instruction' },
      ...defaultPrompt.blocks,
    ],
  } } }).then(response => response.json());
  const chat = await page.request.post('/api/chats', { headers, data: {
    title: `Literal story ${width}`, targetInputTokens: 10000, connectionId: connection.id, promptId: prompt.id,
    characterId: character.id, personaId: null, contextPresetId: 'default-context',
  } }).then(response => response.json());
  expect(typeof chat.id).toBe('string');
  const initial = z.object({ revision: z.number().int() }).parse(await page.request.get(`/api/chats/${chat.id}`).then(response => response.json()));
  const history = await page.request.put(`/api/chats/${chat.id}/history`, { headers, data: { revision: initial.revision, turns: [
    { user: '', assistant: 'Literal greeting', complete: true },
    { user: 'Literal input', assistant: 'Literal response', complete: true },
  ] } });
  expect(history.ok(), await history.text()).toBe(true);
  await page.evaluate(id => localStorage.setItem('roleplay-chat', id), chat.id);
  await page.reload();
  const draft = 'Keep this original story text. Не переводить.';
  await page.getByLabel('Your next turn').fill(draft);
  const saved = z.object({ revision: z.number().int() }).parse(await page.request.get(`/api/chats/${chat.id}`).then(response => response.json()));
  const preview = async () => {
    const response = await page.request.post(`/api/chats/${chat.id}/preview`, { headers, data: { revision: saved.revision, inspection: true, text: draft } });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const before = await preview();
  expect(before.body.messages.length).toBeGreaterThan(0);
  if (width <= 800) await page.getByRole('button', { name: 'Chat details', exact: true }).click();
  await page.locator('.context-dropdown > summary').click();
  await page.getByRole('button', { name: 'Prompt peek', exact: true }).click();
  await expect(page.locator('.prompt-message.draft > summary')).toContainText('Unsent input');
  await expect(page.locator('.prompt-message.history > summary')).toHaveText([
    /Turn 1 · response/, /Turn 2 · input/, /Turn 2 · response/,
  ]);
  await page.getByRole('button', { name: 'Close peek', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Language', exact: true }).click();
  await page.getByRole('combobox', { name: 'Interface language', exact: true }).click();
  await page.getByRole('option', { name: 'Русский', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  await expect(page.getByRole('heading', { name: 'Язык', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Язык', exact: true })).toContainText(`Переведено ${status.languages[0].total} из ${status.languages[0].total}`);
  await expect(page.getByRole('slider', { name: 'Масштаб текста — 100% (по умолчанию)', exact: true })).toHaveAttribute('aria-valuetext', '100% (по умолчанию)');
  await page.screenshot({ path: testInfo.outputPath(`russian-settings-${width}.png`) });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'История', exact: true }).click();
  await expect(page.getByLabel('Ваш следующий ход')).toHaveValue(draft);
  expect((await preview()).body).toEqual(before.body);
  await page.screenshot({ path: testInfo.outputPath(`russian-story-${width}.png`) });
  if (width <= 800) await page.getByRole('button', { name: 'Сведения о чате', exact: true }).click();
  await page.getByRole('button', { name: 'Просмотр промпта', exact: true }).click();
  const peek = page.getByRole('dialog', { name: 'Просмотр промпта', exact: true });
  await expect(peek.locator('.prompt-message.history > summary')).toHaveText([
    /Ход 1 · ответ/, /Ход 2 · ввод/, /Ход 2 · ответ/,
  ]);
  await expect(peek.locator('.prompt-message.draft > summary')).toContainText('Неотправленный текст');
  await expect(peek.locator('.prompt-message.character > summary')).toHaveText([
    /Имя/, /Описание/, /Личность/, /Сценарий/, /Пример диалога/,
  ]);
  await expect(peek.locator('.prompt-message.prompt > summary').first()).toContainText('Turn 2 · input');
  await peek.locator('.prompt-message.draft > summary').click();
  await expect(peek.locator('.prompt-message.draft .prose')).toHaveText(draft);
  await peek.locator('.prompt-message.draft').scrollIntoViewIfNeeded();
  expect(await peek.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath(`russian-prompt-peek-${width}.png`) });
  await page.getByRole('button', { name: 'Закрыть просмотр промпта', exact: true }).click();
  await openTool(page, 'Просмотр памяти');
  await expect(page.getByRole('button', { name: 'Подготовить чат', exact: true })).toBeVisible();
  await expect(page.locator('.budget')).toContainText('Активных сводок: 0');
  await expect(page.locator('.budget')).not.toContainText('active summaries');
  await page.screenshot({ path: testInfo.outputPath(`russian-memory-${width}.png`) });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Вернуться в чат', exact: true }).click();
  await openTool(page, 'Инспектор запросов');
  await expect(page.getByRole('heading', { name: 'Посмотрите, что получает модель.', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Библиотека', exact: true }).click();
  for (const category of ['Чаты', 'Персонажи', 'Лорбуки', 'Промпты', 'Подключения', 'Пресеты контекста', 'Персоны']) {
    await page.getByRole('button', { name: category, exact: true }).click();
    await expect(page.getByRole('searchbox')).toBeVisible();
    if (category === 'Промпты') await page.screenshot({ path: testInfo.outputPath(`russian-library-prompts-${width}.png`) });
  }
  await page.getByRole('button', { name: 'Новая персона', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Новая персона', exact: true })).toBeVisible();
  await page.getByLabel('Имя', { exact: true }).fill('Literal persona name');
  await expect(page.getByRole('button', { name: 'Сохранить', exact: true })).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath(`russian-editor-${width}.png`) });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Библиотека', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'История', exact: true }).click();
  await expect(page.getByLabel('Ваш следующий ход')).toHaveValue(draft);
});
