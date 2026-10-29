import { expect } from '@playwright/test';
import { test } from './isolated-app';
import { appearanceStatusSchema } from '../../src/shared/appearance';
import type { LibrarySnapshot } from '../../src/shared/library';

for (const theme of ['dark', 'light', 'midnight-black'] as const) {
  test(`settings network feedback translates, fits and safely retries in ${theme}`, async ({ page, browserApp }, testInfo) => {
    await page.goto('/');
    await page.getByLabel('Owner password').fill('browser-synthetic-password');
    await page.getByRole('button', { name: 'Create owner account', exact: true }).click();
    await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible();
    const path = '/api/application/appearance';
    const read = async () => appearanceStatusSchema.parse(await page.request.get(path).then(response => response.json()));
    const initial = await read();
    expect((await page.request.put(path, { headers: { Origin: browserApp.url }, data: { revision: initial.revision, settings: { ...initial.settings, theme } } })).ok()).toBe(true);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    let writes = 0;
    await page.route(`**${path}`, async route => {
      if (route.request().method() !== 'PUT') return route.continue();
      writes++;
      await route.abort('failed');
    });
    const check = page.getByRole('checkbox', { name: 'Display character picture in chat.', exact: true });
    await check.setChecked(!initial.settings.displayCharacterPicture);
    const alert = page.locator('.settings-save-status[role=alert]');
    await expect(alert).toContainText('Could not reach the server.');
    expect(writes).toBe(1);
    expect((await read()).settings.displayCharacterPicture).toBe(initial.settings.displayCharacterPicture);
    await page.getByRole('combobox', { name: 'Interface language', exact: true }).click();
    await page.getByRole('option', { name: 'Русский', exact: true }).click();
    await expect(alert).toContainText('Не удалось связаться с сервером.');
    await expect(alert).not.toContainText('Load failed');
    await expect(page.getByRole('checkbox', { name: 'Разрешить доступ из локальной сети', exact: true })).toBeVisible();
    await expect(page.getByText('Удалить все чаты, память, библиотеки, API-ключи, теги и остальные данные. Учётная запись владельца сохранится.', { exact: true })).toHaveCount(1);
    for (const width of [1280, 801, 800, 390, 320]) {
      await page.setViewportSize({ width, height: 850 });
      await alert.scrollIntoViewIfNeeded();
      await expect(alert.getByRole('button', { name: 'Повторить', exact: true })).toBeInViewport({ ratio: 1 });
      expect(await alert.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      const gap = await alert.evaluate(element => {
        const next = element.nextElementSibling;
        if (!next) throw new Error('Missing setting below the notice');
        return next.getBoundingClientRect().top - element.getBoundingClientRect().bottom;
      });
      expect(gap).toBeGreaterThanOrEqual(12);
      await page.screenshot({ path: testInfo.outputPath(`${theme}-${width}-settings-error.png`) });
    }
    await page.unroute(`**${path}`);
    await alert.getByRole('button', { name: 'Повторить', exact: true }).click();
    await expect(alert).toHaveCount(0);
    await expect.poll(async () => (await read()).settings.displayCharacterPicture).toBe(!initial.settings.displayCharacterPicture);
  });
}

test('Connection check and test successes use the built-in Russian catalog with literal model output', async ({ page, browserApp }) => {
  await page.goto('/');
  await page.getByLabel('Owner password').fill('browser-synthetic-password');
  await page.getByRole('button', { name: 'Create owner account', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible();
  const headers = { Origin: browserApp.url };
  const library: LibrarySnapshot = await page.request.get('/api/library').then(response => response.json());
  const { endpoint } = await page.request.get('/__test/endpoint').then(response => response.json());
  expect((await page.request.post('/api/library', { headers, data: { kind: 'connections', revision: library.revision, data: {
    name: 'Sweep diagnostics', endpoint, model: 'synthetic', contextWindow: 100_000, maxOutputTokens: 1000, customParameters: {},
  } } })).ok()).toBe(true);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('combobox', { name: 'Interface language', exact: true }).click();
  await page.getByRole('option', { name: 'Русский', exact: true }).click();
  await page.getByRole('button', { name: 'Библиотека', exact: true }).click();
  await expect(page.locator('.eyebrow').filter({ hasText: 'БИБЛИОТЕКА' })).toBeVisible();
  await page.getByRole('button', { name: 'Подключения', exact: true }).click();
  await page.getByRole('button', { name: 'Sweep diagnostics', exact: true }).click();
  const tools = page.locator('.connection-tools');
  await tools.getByRole('button', { name: 'Проверить подключение', exact: true }).click();
  await expect(tools.locator('.connection-success')).toHaveText('Эндпоинт принял проверку подключения');
  await tools.getByRole('button', { name: 'Отправить тестовое сообщение', exact: true }).click();
  await expect(tools.locator('.connection-success')).toHaveText('Проверка завершена.');
  await tools.locator('summary').click();
  await expect(tools.locator('pre')).toContainText('The lantern flickers.');
  const requests = await page.request.get('/__test/requests').then(response => response.json());
  expect(requests).toHaveLength(1);
  expect(requests[0].body.messages).toEqual([{ role: 'user', content: 'Hi' }]);
});
