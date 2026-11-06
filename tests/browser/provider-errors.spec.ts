import { expect } from '@playwright/test';
import { z } from 'zod';
import { appearanceStatusSchema } from '../../src/shared/appearance';
import { test } from './isolated-app';

for (const theme of ['dark', 'light', 'midnight-black'] as const) {
  test(`renders provider failures in the active language in the ${theme} theme`, async ({ page, browserApp }, testInfo) => {
    const headers = { Origin: browserApp.url };
    const post = async (url: string, data: unknown) => {
      const response = await page.request.post(url, { headers, data });
      expect(response.ok(), await response.text()).toBe(true);
      return response.json();
    };
    await page.goto('/');
    await page.getByLabel('Owner password').fill('browser-synthetic-password');
    await page.getByRole('button', { name: 'Create owner account', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
    const appearance = appearanceStatusSchema.parse(await page.request.get('/api/application/appearance').then(response => response.json()));
    const saved = await page.request.put('/api/application/appearance', {
      headers, data: { revision: appearance.revision, settings: { ...appearance.settings, theme } },
    });
    expect(saved.ok(), await saved.text()).toBe(true);
    const { endpoint } = z.object({ endpoint: z.string() }).parse(await page.request.get('/__test/endpoint').then(response => response.json()));
    const { revision } = z.object({ revision: z.number() }).parse(await page.request.get('/api/library').then(response => response.json()));
    const { id: connectionId } = z.object({ id: z.string() }).parse(await post('/api/library', {
      kind: 'connections', revision,
      data: { name: 'Mock provider', endpoint, model: 'synthetic', contextWindow: 100_000, maxOutputTokens: 1000, customParameters: {} },
    }));
    const { id: chatId } = z.object({ id: z.string() }).parse(await post('/api/chats', {
      title: 'Provider errors', connectionId, promptId: 'default', contextPresetId: null,
      characterId: null, personaId: null, targetInputTokens: 10_000,
    }));
    await post('/__test/mode', { mode: 429 });
    await page.evaluate(id => localStorage.setItem('roleplay-chat', id), chatId);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const input = 'I look for the missing key.';
    await page.getByLabel('Your next turn').fill(input);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const recovery = page.getByRole('status').filter({ has: page.getByRole('button', { name: /Retry response|Повторить ответ/ }) });
    await expect(recovery).toContainText(/usage limit was reached \(HTTP 429\)/);

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Language', exact: true }).click();
    await page.getByRole('combobox', { name: 'Interface language', exact: true }).click();
    await page.getByRole('option', { name: 'Русский', exact: true }).click();
    await page.getByRole('button', { name: 'История', exact: true }).click();
    const russianRateLimit = /Достигнут лимит провайдера.*HTTP 429.*баланс аккаунта/;
    await expect(recovery).toContainText(russianRateLimit);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(recovery.getByRole('button', { name: 'Повторить ответ', exact: true })).toBeInViewport();
      await recovery.screenshot({ path: testInfo.outputPath(`pending-response-${width}.png`) });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }

    await post('/__test/mode', { mode: 'normal' });
    await recovery.getByRole('button', { name: 'Повторить ответ', exact: true }).click();
    await expect(page.getByText('The lantern flickers. 🕯', { exact: true })).toBeVisible();
    await expect(page.getByText(input, { exact: true })).toHaveCount(1);
    await expect(recovery).toHaveCount(0);

    await page.getByRole('button', { name: 'Библиотека', exact: true }).click();
    await page.getByRole('button', { name: 'Подключения', exact: true }).click();
    await page.getByRole('heading', { name: 'Mock provider', exact: true }).click();
    const sendTest = page.getByRole('button', { name: 'Отправить тестовое сообщение', exact: true });
    const failure = page.getByRole('alert').filter({ hasText: 'Ничего не сохранено.' });
    await post('/__test/mode', { mode: 'broken' });
    await sendTest.click();
    await expect(failure).toHaveText('Поток тестового ответа прервался до завершения. Ничего не сохранено. Нажмите «Отправить тестовое сообщение», чтобы повторить попытку.');
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await failure.screenshot({ path: testInfo.outputPath(`connection-test-${width}.png`) });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  });
}
