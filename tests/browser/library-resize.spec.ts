import { expect } from '@playwright/test';
import { test } from './isolated-app';

test.use({ browserName: 'webkit' });

test('sizes the same Russian labels after gradual and direct resizes', async ({ page }) => {
  const resize = (width: number) => page.setViewportSize({ width, height: 1000 });
  await resize(1280);
  await page.goto('/');
  await page.getByLabel('Owner password').fill('browser-synthetic-password');
  await page.getByRole('button', { name: 'Create owner account', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Libraries', exact: true })).toBeVisible();
  await page.evaluate(() => localStorage.setItem('ore-interface-language', 'ru'));
  await page.reload();
  await page.getByRole('button', { name: 'Библиотека', exact: true }).click();

  const toolbar = page.getByRole('group', { name: 'Действия библиотеки' });
  const newChat = toolbar.getByRole('button', { name: 'Новый чат', exact: true });
  const importChat = toolbar.getByRole('button', { name: 'Импортировать чат из JSONL', exact: true });
  const picker = page.getByRole('combobox', { name: 'Разделы библиотеки', exact: true });
  const contextPresets = page.getByRole('option', { name: 'Пресеты контекста', exact: true });
  const heights = async () => {
    await picker.click();
    await expect(contextPresets).toBeInViewport();
    const result = await Promise.all([newChat, importChat, contextPresets].map(button =>
      button.evaluate(element => Math.round(element.getBoundingClientRect().height))));
    await page.keyboard.press('Escape');
    return result;
  };

  for (const width of [900, 801, 800, 650, 550, 421, 420, 390, 360, 350, 340, 336]) await resize(width);
  const gradual = await heights();
  await resize(1280);
  await resize(336);
  expect(await heights()).toEqual(gradual);
  expect(gradual.slice(0, 2)).toEqual([44, 44]);
  expect(gradual[2]).toBeGreaterThanOrEqual(44);

  await resize(320);
  const [newHeight, importHeight] = await heights();
  expect(importHeight).toBeGreaterThanOrEqual(44);
  expect(newHeight).toBe(importHeight);
  expect(await importChat.evaluate(button => {
    const label = document.createRange();
    label.selectNodeContents(button);
    const text = label.getBoundingClientRect();
    const bounds = button.getBoundingClientRect();
    return text.top >= bounds.top && text.bottom <= bounds.bottom;
  })).toBe(true);
  await resize(336);
  expect(await heights()).toEqual(gradual);
});
