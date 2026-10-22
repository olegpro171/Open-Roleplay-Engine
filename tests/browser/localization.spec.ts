import { expect, test, type Page } from '@playwright/test';
import type { ChatSnapshot } from '../../src/shared/contracts';
import { languageStatusSchema } from '../../src/shared/localization';

const russian = { formatVersion: 1, locale: 'ru', nativeName: 'Русский', direction: 'ltr', messages: {
  'language.heading': 'Язык', 'language.select': 'Язык интерфейса',
  'app.story': 'История', 'app.libraries': 'Библиотеки', 'app.settings': 'Настройки',
  'libraries.chat_title': 'Название истории',
  'color_picker.title': 'Выбор цвета', 'color_picker.hue': 'Оттенок',
  'errors.this_response_is_no_longer_active': 'Этот ответ уже завершён.',
} };

async function signIn(page: Page) {
  const session = await page.request.get('/api/session').then(response => response.json());
  await page.goto('/');
  await page.getByLabel('Owner password').fill('browser-synthetic-password');
  await page.getByRole('button', { name: session.setupRequired ? 'Create owner account' : 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Libraries', exact: true })).toBeVisible();
}

async function chooseLanguage(page: Page, label: string, language: string) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name: language, exact: true }).click();
}

for (const width of [1440, 390, 320]) test(`runtime packs localize live controls, preserve the composer draft and fall back safely at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 900 });
  await signIn(page);
  const library = await page.request.get('/api/library').then(response => response.json());
  if (!library.connections.length) {
    const endpoint = await page.request.get('/__test/endpoint').then(response => response.json());
    const created = await page.request.post('/api/library', { headers: { Origin: 'http://127.0.0.1:4173' }, data: { revision: library.revision, kind: 'connections', data: { name: 'Localization mock', endpoint: endpoint.endpoint, model: 'synthetic', contextWindow: 100_000, maxOutputTokens: 1000, customParameters: {} } } });
    expect(created.ok()).toBe(true);
    await page.reload();
  }
  await page.getByRole('button', { name: 'Libraries', exact: true }).click();
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  await page.getByRole('button', { name: 'Create chat', exact: true }).click();
  await page.getByRole('button', { name: 'Return without saving', exact: true }).click();
  await page.getByLabel('Your next turn').fill('Keep this composer draft exactly.');
  const chatId = await page.evaluate(() => localStorage.getItem('roleplay-chat'));
  const savedBefore = await page.request.get(`/api/chats/${chatId}`).then(response => response.json() as Promise<ChatSnapshot>);
  const preview = async () => {
    const result = await page.request.post(`/api/chats/${chatId}/preview`, { headers: { Origin: 'http://127.0.0.1:4173' }, data: { revision: savedBefore.revision, inspection: true, text: 'Keep this composer draft exactly.' } });
    expect(result.ok()).toBe(true);
    return result.json();
  };
  const inputBefore = await preview();
  await expect(page.locator('.topbar').getByRole('combobox')).toHaveCount(0);
  if (width <= 800) {
    await page.getByRole('button', { name: 'Chat details', exact: true }).click();
    await expect(page.getByRole('combobox', { name: /interface language/i })).toHaveCount(0);
    await page.getByRole('button', { name: 'Chat details', exact: true }).click();
  }
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Language', exact: true }).click();
  await page.getByLabel('Import language file', { exact: true }).setInputFiles({ name: 'ru.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(russian)) });
  const replace = page.getByRole('button', { name: 'Replace language file', exact: true });
  await expect(replace.or(page.getByRole('status').filter({ hasText: 'Language file saved.' }))).toBeVisible();
  if (await replace.isVisible()) await replace.click();
  await expect(page.getByRole('status').filter({ hasText: 'Language file saved.' })).toBeVisible();
  await chooseLanguage(page, 'Interface language', 'Русский');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  await expect(page.getByRole('heading', { name: 'Язык', exact: true })).toBeVisible();
  // Missing translation is a readable English fallback, not an internal key.
  await expect(page.getByRole('button', { name: 'Reload languages', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'История', exact: true }).click();
  await expect(page.getByLabel('Your next turn')).toHaveValue('Keep this composer draft exactly.');
  expect(await page.request.get(`/api/chats/${chatId}`).then(response => response.json())).toEqual(savedBefore);
  expect(await preview()).toEqual(inputBefore);
  await page.getByRole('button', { name: 'Библиотеки', exact: true }).click();
  await page.getByRole('button', { name: 'Personas', exact: true }).click();
  await page.getByRole('button', { name: 'New persona', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Unsaved persona name');
  await page.getByRole('button', { name: 'Set color', exact: true }).click();
  await page.getByRole('button', { name: 'Speech color', exact: true }).click();
  const colorPicker = page.getByRole('dialog', { name: 'Выбор цвета', exact: true });
  await expect(colorPicker.getByRole('slider', { name: 'Оттенок', exact: true })).toBeVisible();
  await colorPicker.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath(`localized-${width}.png`) });
  await page.reload();
  await expect(page.getByRole('button', { name: 'Библиотеки', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  await page.getByRole('button', { name: 'Язык', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Язык интерфейса', exact: true })).toHaveText('Русский');
  await chooseLanguage(page, 'Язык интерфейса', 'English');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
});

test('failed language requests preserve the previous selection and stored errors translate when the language changes', async ({ page }) => {
  await signIn(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Language', exact: true }).click();
  await page.route('**/api/localization/ru', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }), { times: 1 });
  await chooseLanguage(page, 'Interface language', 'Русский');
  await expect(page.getByRole('alert')).toContainText('Languages could not be loaded');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('combobox', { name: 'Interface language', exact: true })).toHaveText('English');
  const status = languageStatusSchema.parse(await page.request.get('/api/localization').then(response => response.json()));
  const installed = status.languages.find(item => item.locale === 'ru');
  const saved = await page.request.post('/api/localization/import', { headers: { Origin: 'http://127.0.0.1:4173' }, data: { pack: russian, expectedRevision: installed?.custom ? installed.revision : null } });
  expect(saved.ok()).toBe(true);
  await page.getByRole('button', { name: 'Reload languages', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.route('**/api/logout', route => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ message: 'This response is no longer active.', localized: { key: 'errors.this_response_is_no_longer_active', fallback: 'This response is no longer active.' } }) }), { times: 1 });
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('This response is no longer active.');
  await chooseLanguage(page, 'Interface language', 'Русский');
  await expect(page.getByRole('alert')).toContainText('Этот ответ уже завершён.');
});
