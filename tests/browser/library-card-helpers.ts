import { expect, type Locator, type Page } from '@playwright/test';

export async function selectLibraryCategory(page: Page, name: string, label = 'Library categories'): Promise<Locator> {
  const sidebar = page.getByRole('navigation', { name: label, exact: true });
  const picker = page.getByRole('combobox', { name: label, exact: true });
  await expect(sidebar.or(picker)).toBeVisible();
  if (await picker.isVisible()) {
    await picker.click();
    await page.getByRole('listbox', { name: label, exact: true }).getByRole('option', { name, exact: true }).click();
    return picker;
  }
  const button = sidebar.getByRole('button', { name, exact: true });
  await button.click();
  return button;
}

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

export async function confirmLeaveEditor(page: Page) {
  await page.getByRole('dialog', { name: 'Leave editor?', exact: true }).getByRole('button', { name: 'Leave editor', exact: true }).click();
}
