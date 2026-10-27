import { expect, type Page } from '@playwright/test';

export async function enterModel(page: Page, value: string) {
  await page.getByRole('button', { name: 'Model identifier', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Select model', exact: true });
  await dialog.getByRole('textbox', { name: 'Search or enter model identifier', exact: true }).fill(value);
  await dialog.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(dialog).toHaveCount(0);
}
