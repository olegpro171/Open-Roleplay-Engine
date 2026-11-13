import { expect, type Page } from '@playwright/test';
import { test } from './appearance-test';
import { openChatTool } from './chat-tools';

const dialog = (page: Page) => page.getByRole('dialog', { name: 'Leave editor?', exact: true });
const goBack = (page: Page) => dialog(page).getByRole('button', { name: 'Go back', exact: true });
const leave = (page: Page) => dialog(page).getByRole('button', { name: 'Leave editor', exact: true });
const title = (page: Page) => page.getByLabel('Chat title', { exact: true });
const header = (page: Page, name: string) => page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name, exact: true });

async function signIn(page: Page) {
  const { setupRequired } = await page.request.get('/api/session').then(response => response.json());
  await page.getByLabel('Owner password').fill('browser-synthetic-password');
  await page.getByRole('button', { name: setupRequired ? 'Create owner account' : 'Sign in', exact: true }).click();
  await expect(header(page, 'Story')).toBeVisible();
}

test('protects changed Chat settings across header navigation and sign-out', async ({ page, setAppearance }, testInfo) => {
  await page.goto('/');
  await signIn(page);
  await header(page, 'Libraries').click();
  await page.getByRole('navigation', { name: 'Library categories' }).getByRole('button', { name: 'Chats', exact: true }).click();
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  await page.getByRole('button', { name: 'Create chat', exact: true }).click();
  await expect(title(page)).toHaveValue('A new story');

  for (const theme of ['dark', 'light', 'midnight-black'] as const) {
    await setAppearance({ theme });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 840 });
      await title(page).fill('An unsaved title');
      await header(page, 'Story').click();
      await expect(goBack(page)).toBeInViewport();
      await expect(leave(page)).toBeInViewport();
      expect(await dialog(page).evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
      await dialog(page).screenshot({ path: testInfo.outputPath(`${theme}-${width}.png`) });
      await goBack(page).click();
      await expect(header(page, 'Story')).toBeFocused();
      await expect(title(page)).toHaveValue('An unsaved title');
    }
  }

  await header(page, 'Libraries').click();
  await leave(page).click();
  await expect(header(page, 'Libraries')).toHaveAttribute('aria-current', 'page');
  await header(page, 'Story').click();
  await openChatTool(page, 'Chat settings');
  await expect(title(page)).toHaveValue('A new story');
  await title(page).fill('Discard on Settings navigation');
  await header(page, 'Settings').click();
  await leave(page).click();
  await expect(header(page, 'Settings')).toHaveAttribute('aria-current', 'page');

  await header(page, 'Story').click();
  await openChatTool(page, 'Chat settings');
  await title(page).fill('Keep until signed out');
  const signOut = page.getByRole('button', { name: 'Sign out', exact: true });
  await signOut.click();
  await goBack(page).click();
  await expect(title(page)).toHaveValue('Keep until signed out');
  await page.route('**/api/logout', route => route.fulfill({ status: 503, json: { message: 'Synthetic sign-out failure' } }), { times: 1 });
  await signOut.click();
  await leave(page).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Synthetic sign-out failure' })).toBeVisible();
  await expect(title(page)).toHaveValue('Keep until signed out');
  await signOut.click();
  await leave(page).click();
  await expect(page.getByLabel('Owner password')).toBeVisible();
  await signIn(page);
  await openChatTool(page, 'Chat settings');
  await expect(title(page)).toHaveValue('A new story');
});

test('warns before browser exits with unfinished Chat settings and stops warning after a revert', async ({ page }) => {
  await page.route('**/previous-chat-settings-document', route => route.fulfill({ contentType: 'text/html', body: '<title>Previous document</title>' }));
  await page.goto('/previous-chat-settings-document');
  await page.goto('/');
  await signIn(page);
  await openChatTool(page, 'Chat settings');
  const limit = page.getByLabel('Target input tokens', { exact: true });
  const original = await limit.inputValue();
  await limit.click();
  await limit.fill('unfinished');

  const dismissWarning = () => page.waitForEvent('dialog').then(async warning => {
    expect(warning.type()).toBe('beforeunload');
    await warning.dismiss();
  });
  await Promise.all([dismissWarning(), page.evaluate(() => history.back())]);
  await expect(limit).toHaveValue('unfinished');
  await Promise.all([dismissWarning(), page.close({ runBeforeUnload: true })]);
  await expect(limit).toHaveValue('unfinished');

  const acceptReload = page.waitForEvent('dialog').then(async warning => {
    expect(warning.type()).toBe('beforeunload');
    await warning.accept();
  });
  await Promise.all([acceptReload, page.reload()]);
  await openChatTool(page, 'Chat settings');
  await expect(limit).toHaveValue(original);
  await limit.fill('unfinished again');
  await limit.fill(original);
  const dialogs: string[] = [];
  page.on('dialog', async warning => { dialogs.push(warning.type()); await warning.accept(); });
  await page.reload();
  expect(dialogs).toEqual([]);
});
