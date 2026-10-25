import { expect, type Locator, type Page } from '@playwright/test';

export async function openLibraryActions(page: Page, card: Locator): Promise<Locator> {
  const trigger = card.getByRole('button', { name: /^Actions for / });
  // Settle automatic scrolling before opening a panel that closes on scroll.
  await trigger.scrollIntoViewIfNeeded();
  await trigger.hover();
  await trigger.click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  return menu;
}
