import { expect } from '@playwright/test';
import { test } from './isolated-app';
import { appearanceStatusSchema } from '../../src/shared/appearance';
import type { LibrarySnapshot } from '../../src/shared/library';
import type { ChatSnapshot } from '../../src/shared/contracts';

for (const theme of ['dark', 'light', 'midnight-black'] as const) {
  for (const width of [1440, 390]) {
    test(`new chat uses only the character name in English and Russian, ${theme} at ${width}px`, async ({ page, browserApp }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/');
      await page.getByLabel('Owner password').fill('browser-synthetic-password');
      await page.getByRole('button', { name: 'Create owner account', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Libraries', exact: true })).toBeVisible();
      const headers = { Origin: browserApp.url };
      const appearance = appearanceStatusSchema.parse(await page.request.get('/api/application/appearance').then(response => response.json()));
      const updated = await page.request.put('/api/application/appearance', { headers, data: {
        revision: appearance.revision, settings: { ...appearance.settings, theme },
      } });
      expect(updated.ok()).toBe(true);

      for (const locale of ['en', 'ru'] as const) {
        const name = locale === 'en' ? 'Moon' : 'Луна'.repeat(25);
        const library: LibrarySnapshot = await page.request.get('/api/library').then(response => response.json());
        const created = await page.request.post('/api/library', { headers, data: {
          revision: library.revision, kind: 'characters', data: {
            name, titleComment: 'Local display comment', description: '', personality: '', scenario: '', first_mes: '', mes_example: '',
          },
        } });
        expect(created.ok(), await created.text()).toBe(true);
        await page.evaluate(locale => localStorage.setItem('ore-interface-language', locale), locale);
        await page.reload();
        await expect(page.locator('html')).toHaveAttribute('lang', locale);
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        await page.getByRole('button', { name: locale === 'en' ? 'Libraries' : 'Библиотека', exact: true }).click();
        await page.getByRole('button', { name: locale === 'en' ? 'Chats' : 'Чаты', exact: true }).click();
        await page.getByRole('button', { name: locale === 'en' ? 'New chat' : 'Новый чат', exact: true }).click();
        await page.getByRole('combobox', { name: locale === 'en' ? 'Character' : 'Персонаж', exact: true }).click();
        await page.getByRole('option', { name: `${name} · Local display comment`, exact: true }).click();
        await page.getByRole('button', { name: locale === 'en' ? 'Create chat' : 'Создать чат', exact: true }).click();
        const title = page.getByLabel(locale === 'en' ? 'Chat title' : 'Название чата', { exact: true });
        await expect(title).toHaveValue(name);
        const id = await page.evaluate(() => localStorage.getItem('roleplay-chat'));
        const chat: ChatSnapshot = await page.request.get(`/api/chats/${id}`).then(response => response.json());
        expect(chat.settings.title).toBe(name);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`chat-title-${locale}.png`), fullPage: true });
      }
    });
  }
}
