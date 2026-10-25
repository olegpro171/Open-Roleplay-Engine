import { expect, test } from '@playwright/test';
import type { ChatSnapshot } from '../../src/shared/contracts';
import { openChatTool } from './chat-tools';

for (const width of [320, 390, 800]) {
  test(`mobile header details overlay preserves chat space and keyboard access at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 650 });
    const session = await page.request.get('/api/session').then(response => response.json());
    await page.goto('/');
    await page.getByLabel('Owner password').fill('browser-synthetic-password');
    await page.getByRole('button', { name: session.setupRequired ? 'Create owner account' : 'Sign in', exact: true }).click();
    await page.getByRole('button', { name: 'Libraries', exact: true }).click();
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    await page.getByRole('button', { name: 'Create chat', exact: true }).click();
    await page.getByRole('button', { name: 'Return without saving', exact: true }).click();
    const toggle = page.locator('header').getByRole('button', { name: 'Chat details', exact: true, includeHidden: true });
    const sidebar = page.getByRole('complementary', { name: 'Current chat' });
    const content = page.getByLabel('Conversation');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(sidebar.getByRole('button', { name: 'Chat settings', exact: true })).toBeHidden();
    await expect(sidebar.getByRole('button', { name: 'Inspect memory', exact: true })).toBeHidden();
    await expect(sidebar.getByRole('button', { name: 'Request inspector', exact: true })).toBeHidden();
    const before = await content.boundingBox();
    const header = await page.locator('header').boundingBox();
    if (!before || !header) throw new Error('Missing workspace');
    expect(before.y).toBe(header.y + header.height);
    await page.screenshot({ path: testInfo.outputPath(`collapsed-${width}.png`) });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(await content.boundingBox()).toEqual(before);
    await toggle.press('Tab');
    await expect(sidebar.locator('.context-dropdown summary')).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(toggle).toBeFocused();
    await toggle.press('Tab');
    await page.keyboard.press('Escape');
    await expect(toggle).toBeFocused();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await sidebar.locator('.context-dropdown summary').click();
    await sidebar.getByRole('button', { name: 'Request inspector', exact: true }).scrollIntoViewIfNeeded();
    await expect(sidebar.getByRole('button', { name: 'Request inspector', exact: true })).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath(`expanded-${width}.png`) });
    await toggle.click();
    await page.getByLabel('Your next turn').fill('Draft preserved by dropdown dismissal.');
    await toggle.click();
    await page.getByLabel('Your next turn').click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByLabel('Your next turn')).toHaveValue('Draft preserved by dropdown dismissal.');
    await toggle.click();
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(toggle).toBeHidden();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(sidebar.getByRole('button', { name: 'Request inspector', exact: true })).toBeVisible();
    await page.setViewportSize({ width, height: 650 });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

for (const width of [1280, 820, 801, 800, 390, 320]) {
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
    await expect(navigation.getByRole('button')).toHaveText(['Story', 'Libraries', 'Settings']);
    await page.getByLabel('Chat title').fill('Discard this title');
    await sidebar.getByRole('button', { name: 'Return without saving', exact: true }).click();
    await expect(page.getByLabel('Conversation')).toBeVisible();
    expect(await state()).toEqual(initial);
    await page.getByLabel('Your next turn').fill('A composer draft survives the tools.');
    await openChatTool(page, 'Chat settings');
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
    for (const [button, region] of [['Chat settings', 'Chat settings'], ['Inspect memory', 'Memory'], ['Request inspector', 'Request inspector']] as const) {
      await openChatTool(page, button);
      const content = page.getByRole('region', { name: region, exact: true });
      await expect(content).toBeVisible();
      await expect(sidebar.getByRole('button', { name: 'Chat settings', exact: true })).toHaveCount(0);
      const actions = sidebar.locator('.chat-page-actions');
      const close = actions.getByRole('button', { name: region === 'Chat settings' ? 'Return without saving' : 'Return to chat', exact: true });
      await expect(actions.getByRole('button')).toHaveCount(region === 'Chat settings' ? 2 : 1);
      await expect(close).toHaveAttribute('title', region === 'Chat settings' ? 'Return without saving' : 'Return to chat');
      if (width <= 800) {
        const header = await page.locator('header').boundingBox();
        const bounds = await close.boundingBox();
        const heading = await content.getByRole('heading', { level: 1 }).boundingBox();
        if (!header || !bounds || !heading) throw new Error('Missing compact tool controls');
        expect(bounds.width).toBe(44);
        expect(bounds.height).toBe(44);
        expect(bounds.y).toBeGreaterThanOrEqual(header.y + header.height);
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(heading.y);
        expect(bounds.x + bounds.width).toBeGreaterThan(width - 40);
        await expect(close.locator('svg')).toBeVisible();
        await expect(close.locator('span')).toBeHidden();
        if (region === 'Chat settings') {
          const save = actions.getByRole('button', { name: 'Save and return', exact: true });
          const saveBounds = await save.boundingBox();
          if (!saveBounds) throw new Error('Missing compact Save control');
          expect(saveBounds.width).toBe(44);
          expect(saveBounds.height).toBe(44);
          expect(saveBounds.y).toBe(bounds.y);
          expect(saveBounds.x + saveBounds.width).toBeLessThan(bounds.x);
          await expect(save.locator('svg')).toBeVisible();
          await expect(save.locator('span')).toBeHidden();
        }
      } else {
        await expect(close.locator('svg')).toBeHidden();
        await expect(close.locator('span')).toBeVisible();
      }
      const actionBounds = await close.boundingBox();
      await page.screenshot({ path: testInfo.outputPath(`${region}-controls-${width}.png`), animations: 'disabled' });
      if (width <= 800) await page.getByRole('button', { name: 'Chat details', exact: true }).click();
      await expect(sidebar.getByRole('heading', { name: `Saved workspace ${width}`, exact: true })).toBeVisible();
      const left = await sidebar.boundingBox(), right = await content.boundingBox();
      if (!left || !right) throw new Error('Missing chat workspace');
      if (width > 800) expect(right.x).toBeGreaterThanOrEqual(left.x + left.width);
      else {
        expect(right.y).toBeGreaterThanOrEqual(left.y + left.height);
        const panel = await sidebar.locator('.chat-details').boundingBox();
        if (!panel) throw new Error('Missing details overlay');
        expect(panel.y).toBeLessThanOrEqual(right.y + 1);
        expect(panel.height).toBeGreaterThan(250);
        expect(panel.width).toBe(width);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await content.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`${region}-${width}.png`), animations: 'disabled' });
      if (width <= 800) await page.getByRole('button', { name: 'Chat details', exact: true }).click();
      await content.evaluate(node => { node.scrollTop = node.scrollHeight; });
      expect(await close.boundingBox()).toEqual(actionBounds);
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
      if (width < 800) await page.getByRole('button', { name: 'Chat details', exact: true }).click();
      await context.locator('summary').click();
      await expect(context).toHaveJSProperty('open', expanded);
      for (const [button, back] of [
        ['Chat settings', 'Save and return'],
        ['Chat settings', 'Return without saving'],
        ['Inspect memory', 'Return to chat'],
        ['Request inspector', 'Return to chat'],
      ] as const) {
        await openChatTool(page, button);
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
