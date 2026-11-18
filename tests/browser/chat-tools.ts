import { expect, type Page } from '@playwright/test';

export async function openChatTool(page: Page, name: 'Chat settings' | 'Inspect memory' | 'Request inspector' | 'Chat branches' | 'Pinned turns') {
  const toggle = page.getByRole('button', { name: 'Chat details', exact: true });
  if (await toggle.isVisible() && await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
  await page.getByRole('button', { name, exact: true }).click();
}

export async function openNewChatSettings(page: Page, language: 'en' | 'ru' = 'en') {
  const name = language === 'ru' ? 'Настройки чата' : 'Chat settings';
  const settings = page.getByRole('region', { name, exact: true });
  const conversation = page.getByRole('region', { name: language === 'ru' ? 'Переписка' : 'Conversation', exact: true });
  await expect(settings.or(conversation)).toBeVisible();
  if (await settings.isVisible()) return;
  const details = page.getByRole('button', { name: language === 'ru' ? 'О чате' : 'Chat details', exact: true });
  if (await details.isVisible()) await details.click();
  await page.getByRole('button', { name, exact: true }).click();
  await expect(settings).toBeVisible();
}
