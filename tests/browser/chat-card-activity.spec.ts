import { expect } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { turns } from '../../src/persistence/schema';
import { appearanceStatusSchema, themeSchema } from '../../src/shared/appearance';
import { seedTranscript } from '../support/transcript-fixture';
import { test } from './isolated-app';

test.use({ starterChat: false, timezoneId: 'Europe/Moscow' });

test('chat activity shows elapsed time, yesterday, and the exact date at their boundaries', async ({ page, browserApp }, testInfo) => {
  const now = Date.parse('2026-01-15T09:00:00.000Z');
  const minute = 60_000;
  const hour = 60 * minute;
  const samples = [
    { title: 'Just now', age: minute - 1, english: 'less than a minute ago', russian: 'меньше минуты назад' },
    { title: 'One minute', age: minute, english: '1 minute ago', russian: '1 минуту назад' },
    { title: 'Two minutes', age: 2 * minute, english: '2 minutes ago', russian: '2 минуты назад' },
    { title: 'Five minutes', age: 5 * minute, english: '5 minutes ago', russian: '5 минут назад' },
    { title: 'Twenty-one minutes', age: 21 * minute, english: '21 minutes ago', russian: '21 минуту назад' },
    { title: 'Almost an hour', age: hour - 1, english: '59 minutes ago', russian: '59 минут назад' },
    { title: 'One hour', age: hour, english: '1 hour ago', russian: '1 час назад' },
    { title: 'Two hours', age: 2 * hour, english: '2 hours ago', russian: '2 часа назад' },
    { title: 'Five hours', age: 5 * hour, english: '5 hours ago', russian: '5 часов назад' },
    { title: 'Twenty-two hours', age: 22 * hour, english: '22 hours ago', russian: '22 часа назад' },
    { title: 'Almost a day', age: 24 * hour - 1, english: '23 hours ago', russian: '23 часа назад' },
  ];
  const { store } = browserApp;
  function seedChat(title: string, age?: number | null) {
    const id = store.createChat({ title, targetInputTokens: 32_000, promptId: 'default', connectionId: null, characterId: null, personaId: null });
    if (age === undefined) return;
    seedTranscript(store, store.snapshot(id).revision, id, [{ user: 'Hello', assistant: 'Welcome', complete: true }]);
    const messageAt = age === null ? null : new Date(now - age).toISOString();
    store.db.update(turns).set({ messageAt }).where(eq(turns.chatId, id)).run();
  }
  for (const { title, age } of samples) seedChat(title, age);
  seedChat('Exactly a day', 24 * hour);
  seedChat('Yesterday morning', 35 * hour);
  seedChat('Two calendar days ago', 37 * hour);
  seedChat('Future date', -1);
  seedChat('Unknown date', null);
  seedChat('Empty chat');

  await page.clock.install({ time: new Date(now - minute) });
  await page.clock.pauseAt(new Date(now));
  await page.goto('/');
  await page.getByLabel('Owner password').fill('browser-synthetic-password');
  await page.getByRole('button', { name: 'Create owner account', exact: true }).click();
  const card = (title: string) => page.getByRole('article').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
  const activity = (title: string) => card(title).locator('time');
  await page.getByRole('button', { name: 'Libraries', exact: true }).click();
  await page.getByRole('button', { name: 'Chats', exact: true }).click();
  for (const { title, english } of samples) await expect(activity(title)).toHaveText(english);
  await expect(activity('Exactly a day')).toHaveText('Yesterday');
  await expect(activity('Yesterday morning')).toHaveText('Yesterday');
  await expect(activity('Exactly a day')).toHaveAttribute('aria-label', 'Last message: Yesterday');
  await expect(activity('Exactly a day')).toHaveAttribute('title', /^Last message: Jan 14, 2026, 12:00\sPM$/);
  await expect(activity('Two calendar days ago')).toHaveText(/^Jan 13, 2026, 11:00 PM$/);
  await expect(activity('Future date')).toHaveText(/^Jan 15, 2026, 12:00 PM$/);
  await expect(activity('One hour')).toHaveAttribute('datetime', '2026-01-15T08:00:00.000Z');
  await expect(activity('One hour')).toHaveAttribute('aria-label', 'Last message: 1 hour ago');
  await expect(activity('One hour')).toHaveAttribute('title', /^Last message: Jan 15, 2026, 11:00\sAM$/);
  await expect(card('Unknown date')).toBeVisible();
  await expect(activity('Unknown date')).toHaveCount(0);
  await expect(card('Empty chat').getByText('No messages yet')).toBeVisible();

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Language', exact: true }).click();
  await page.getByRole('combobox', { name: 'Interface language', exact: true }).click();
  await page.getByRole('option', { name: 'Русский', exact: true }).click();
  await page.getByRole('button', { name: 'Библиотека', exact: true }).click();
  await page.getByRole('button', { name: 'Чаты', exact: true }).click();
  for (const { title, russian } of samples) await expect(activity(title)).toHaveText(russian);
  await expect(activity('Exactly a day')).toHaveText('Вчера');
  await expect(activity('Yesterday morning')).toHaveText('Вчера');

  const appearancePath = '/api/application/appearance';
  for (const theme of themeSchema.options) {
    const appearance = appearanceStatusSchema.parse(await page.request.get(appearancePath).then(response => response.json()));
    if (theme !== appearance.settings.theme) {
      const response = await page.request.put(appearancePath, {
        headers: { Origin: browserApp.url },
        data: { revision: appearance.revision, settings: { ...appearance.settings, theme } },
      });
      expect(response.ok(), await response.text()).toBe(true);
    }
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    for (const width of [1280, 320]) {
      await page.setViewportSize({ width, height: 850 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await card('Just now').screenshot({ animations: 'disabled', path: testInfo.outputPath(`chat-activity-${theme}-${width}.png`) });
      await card('Exactly a day').screenshot({ animations: 'disabled', path: testInfo.outputPath(`chat-yesterday-${theme}-${width}.png`) });
    }
  }

  await page.clock.runFor(1);
  await expect(activity('Just now')).toHaveText('1 минуту назад');
  await expect(activity('Future date')).toHaveText('меньше минуты назад');
  await expect(activity('Almost an hour')).toHaveText('1 час назад');
  await expect(activity('Almost a day')).toHaveText('Вчера');

  // At local midnight the previous calendar day changes, three hours before UTC midnight.
  await page.clock.fastForward(12 * hour - 2);
  await expect(activity('Exactly a day')).toHaveText('Вчера');
  await page.clock.runFor(1);
  await expect(activity('Exactly a day')).toHaveText(/14 янв\. 2026 г\., 12:00/);
  await expect(activity('One hour')).toHaveText('13 часов назад');
});
