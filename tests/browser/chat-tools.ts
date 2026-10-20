import type { Page } from '@playwright/test';

export async function openChatTool(page: Page, name: 'Chat settings' | 'Inspect memory' | 'Request inspector') {
  const toggle = page.getByRole('button', { name: 'Chat details', exact: true });
  if (await toggle.isVisible() && await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
  await page.getByRole('button', { name, exact: true }).click();
}
