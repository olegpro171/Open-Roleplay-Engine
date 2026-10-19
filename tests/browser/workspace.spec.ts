import { expect, test } from '@playwright/test';
import type { ChatSnapshot } from '../../src/shared/contracts';

for (const width of [1280, 820, 390, 320]) {
  test(`chat tools share the workspace and return safely at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const session = await page.request.get('/api/session').then(response => response.json());
    await page.goto('/');
    await page.getByLabel('Owner password').fill('browser-synthetic-password');
    await page.getByRole('button', { name: session.setupRequired ? 'Create owner account' : 'Sign in', exact: true }).click();
    await page.getByRole('button', { name: 'Libraries', exact: true }).click();
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    await page.getByRole('button', { name: 'Create chat', exact: true }).click();
    await expect(page.getByLabel('Chat title')).toHaveValue('A new story');
    const chatId = await page.evaluate(() => localStorage.getItem('roleplay-chat'));
    const state = () => page.request.get(`/api/chats/${chatId}`).then(response => response.json() as Promise<ChatSnapshot>);
    const initial = await state();
    const sidebar = page.getByRole('complementary', { name: 'Current chat' });
    const navigation = page.getByRole('navigation', { name: 'Workspace' });
    await expect(navigation.getByRole('button')).toHaveText(['Story', 'Libraries']);
    await page.getByLabel('Chat title').fill('Discard this title');
    await sidebar.getByRole('button', { name: 'Return without saving', exact: true }).click();
    await expect(page.getByLabel('Conversation')).toBeVisible();
    expect(await state()).toEqual(initial);
    await page.getByLabel('Your next turn').fill('A composer draft survives the tools.');
    await sidebar.getByRole('button', { name: 'Chat settings', exact: true }).click();
    await expect(page.getByLabel('Chat title')).toHaveValue(initial.settings.title);
    await page.getByLabel('Chat title').fill(`Saved workspace ${width}`);
    await page.route(`**/api/chats/${chatId}/selections`, route => route.fulfill({
      status: 422, contentType: 'application/json', body: JSON.stringify({ message: 'Synthetic setup failure' }),
    }), { times: 1 });
    await sidebar.getByRole('button', { name: 'Save and return', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Synthetic setup failure');
    await expect(page.getByLabel('Chat title')).toHaveValue(`Saved workspace ${width}`);
    expect(await state()).toEqual(initial);
    await sidebar.getByRole('button', { name: 'Save and return', exact: true }).click();
    await expect(page.getByLabel('Your next turn')).toHaveValue('A composer draft survives the tools.');
    expect((await state()).settings.title).toBe(`Saved workspace ${width}`);
    for (const [button, region] of [['Chat settings', 'Chat settings'], ['Inspect memory', 'Memory'], ['Request inspector', 'Request inspector']]) {
      await sidebar.getByRole('button', { name: button, exact: true }).click();
      const content = page.getByRole('region', { name: region, exact: true });
      await expect(content).toBeVisible();
      await expect(sidebar.getByRole('button', { name: 'Chat settings', exact: true })).toHaveCount(0);
      if (width < 800) await sidebar.getByRole('button', { name: 'Chat details', exact: true }).click();
      await expect(sidebar.getByRole('heading', { name: `Saved workspace ${width}`, exact: true })).toBeVisible();
      const left = await sidebar.boundingBox(), right = await content.boundingBox();
      if (!left || !right) throw new Error('Missing chat workspace');
      if (width > 800) expect(right.x).toBeGreaterThanOrEqual(left.x + left.width);
      else expect(right.y).toBeGreaterThanOrEqual(left.y + left.height);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await content.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`${region}-${width}.png`), animations: 'disabled' });
      await content.evaluate(node => { node.scrollTop = node.scrollHeight; });
      await expect(sidebar.getByRole('button', { name: region === 'Chat settings' ? 'Return without saving' : 'Return to chat', exact: true })).toBeInViewport();
      await sidebar.getByRole('button', { name: region === 'Chat settings' ? 'Return without saving' : 'Return to chat', exact: true }).click();
      await expect(page.getByLabel('Your next turn')).toHaveValue('A composer draft survives the tools.');
      expect(await page.evaluate(() => localStorage.getItem('roleplay-chat'))).toBe(chatId);
    }
  });
}

for (const width of [1280, 390]) {
  test(`Context keeps its expanded and collapsed state across chat tools at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const session = await page.request.get('/api/session').then(response => response.json());
    await page.goto('/');
    await page.getByLabel('Owner password').fill('browser-synthetic-password');
    await page.getByRole('button', { name: session.setupRequired ? 'Create owner account' : 'Sign in', exact: true }).click();
    await page.getByRole('button', { name: 'Libraries', exact: true }).click();
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    await page.getByRole('button', { name: 'Create chat', exact: true }).click();
    await page.getByRole('button', { name: 'Return without saving', exact: true }).click();
    const sidebar = page.getByRole('complementary', { name: 'Current chat' });
    const context = sidebar.locator('.context-dropdown');
    for (const expanded of [true, false]) {
      if (width < 800) await sidebar.getByRole('button', { name: 'Chat details', exact: true }).click();
      await context.locator('summary').click();
      await expect(context).toHaveJSProperty('open', expanded);
      for (const [button, back] of [
        ['Chat settings', 'Save and return'],
        ['Chat settings', 'Return without saving'],
        ['Inspect memory', 'Return to chat'],
        ['Request inspector', 'Return to chat'],
      ]) {
        await sidebar.getByRole('button', { name: button, exact: true }).click();
        await expect(context).toHaveJSProperty('open', expanded);
        await sidebar.getByRole('button', { name: back, exact: true }).click();
        await expect(page.getByLabel('Conversation')).toBeVisible();
        await expect(context).toHaveJSProperty('open', expanded);
      }
      await page.getByRole('button', { name: 'Libraries', exact: true }).click();
      await page.getByRole('button', { name: 'Story', exact: true }).click();
      await expect(context).toHaveJSProperty('open', expanded);
    }
  });
}
