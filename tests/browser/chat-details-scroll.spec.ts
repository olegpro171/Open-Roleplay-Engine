import { devices, expect, type Locator, type Page } from '@playwright/test';
import { test } from './isolated-app';
import { appearanceStatusSchema } from '../../src/shared/appearance';

const device = devices['iPhone 13'];
test.use({ userAgent: device.userAgent, viewport: device.viewport,
  isMobile: device.isMobile, hasTouch: device.hasTouch, deviceScaleFactor: device.deviceScaleFactor });

async function boundaryDecisions(container: Locator) {
  return container.evaluate(node => {
    const gesture = (target: Element, dx: number, dy: number) => {
      const touches = (x: number, y: number) => [new Touch({ identifier: 0, target, clientX: x, clientY: y })];
      target.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: touches(100, 150) }));
      const move = new TouchEvent('touchmove', { bubbles: true, cancelable: true, touches: touches(100 + dx, 150 + dy) });
      target.dispatchEvent(move);
      target.dispatchEvent(new TouchEvent('touchend', { bubbles: true }));
      return move.defaultPrevented;
    };
    const target = node.querySelector('h1') ?? node;
    node.scrollTop = 0;
    const top = gesture(target, 0, 25);
    node.scrollTop = node.scrollHeight;
    const bottom = gesture(target, 0, -25);
    const horizontal = gesture(target, 25, 0);
    // Nested contained inputs must retain ownership instead of inheriting bounce.
    const editor = document.createElement('textarea');
    editor.style.cssText = 'height:44px;min-height:0;overflow:auto;overscroll-behavior:contain';
    node.append(editor);
    const nested = [];
    for (const value of ['', 'Nested line.\n'.repeat(40)]) {
      editor.value = value;
      editor.setSelectionRange(0, 0);
      editor.scrollTop = 0;
      nested.push(gesture(editor, 0, 25));
      editor.scrollTop = editor.scrollHeight;
      nested.push(gesture(editor, 0, -25));
    }
    editor.remove();
    return { top, bottom, horizontal, nested };
  });
}

async function outerPosition(page: Page) {
  return page.evaluate(() => ({
    x: window.scrollX, y: window.scrollY,
    viewportX: window.visualViewport?.offsetLeft, viewportY: window.visualViewport?.offsetTop,
    header: document.querySelector('header')?.getBoundingClientRect().top,
  }));
}

for (const width of [390, 800, 801, 1440]) test(`Chat details keeps native vertical gestures contained at ${width}px`, async ({ page, browserApp }, testInfo) => {
  await page.setViewportSize({ width, height: 1100 });
  await page.goto('/');
  await page.getByLabel('Owner password').fill('browser-synthetic-password');
  await page.getByRole('button', { name: 'Create owner account', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Libraries', exact: true })).toBeVisible();
  const created = await page.request.post('/api/chats', {
    headers: { Origin: browserApp.url }, data: {
      title: 'Details scroll fixture', targetInputTokens: 20_000, promptId: 'default',
      connectionId: null, characterId: null, personaId: null, contextPresetId: null,
    },
  });
  expect(created.ok(), await created.text()).toBe(true);
  await page.reload();
  await page.getByRole('button', { name: 'Libraries', exact: true }).click();
  await page.getByRole('button', { name: 'Chats', exact: true }).click();
  await page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Details scroll fixture', exact: true }) }).click();
  await expect(page.getByLabel('Your next turn')).toBeVisible();
  const details = page.locator('.chat-details');
  const container = page.locator(width <= 800 ? '.chat-details' : '.story-meta');
  const toggle = page.getByRole('button', { name: 'Chat details', exact: true });
  const expand = async () => {
    if (width <= 800 && await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
    await expect(details).toBeVisible();
  };
  await expand();
  await expect.poll(() => container.evaluate(node => node.scrollHeight <= node.clientHeight + 1)).toBe(true);
  const expected = { top: false, bottom: false, horizontal: true, nested: [true, true, true, true] };
  expect(await boundaryDecisions(container)).toEqual(expected);

  await details.locator('summary').click();
  await page.setViewportSize({ width, height: 430 });
  await expect.poll(() => container.evaluate(node => node.scrollHeight - node.clientHeight)).toBeGreaterThan(100);
  expect(await boundaryDecisions(container)).toEqual(expected);

  const session = await page.context().newCDPSession(page);
  try {
    for (const theme of ['dark', 'light', 'midnight-black'] as const) {
      const appearance = appearanceStatusSchema.parse(await page.request.get('/api/application/appearance').then(response => response.json()));
      const saved = await page.request.put('/api/application/appearance', {
        headers: { Origin: browserApp.url }, data: { revision: appearance.revision, settings: { ...appearance.settings, theme } },
      });
      expect(saved.ok()).toBe(true);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      const initial = await outerPosition(page);
      const swipe = async (edge: 'top' | 'bottom', downward: boolean) => {
        await expand();
        const bounds = await container.boundingBox();
        if (!bounds) throw new Error('Chat details must be visible');
        const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
        await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
        await container.evaluate((node, edge) => new Promise<void>(resolve => {
          requestAnimationFrame(() => requestAnimationFrame(() => {
            node.scrollTop = edge === 'top' ? 0 : node.scrollHeight;
            resolve();
          }));
        }), edge);
        for (let step = 1; step <= 6; step++) {
          await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + (downward ? 1 : -1) * step * 12 }] });
        }
        await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      };
      await swipe('top', true);
      await expect.poll(() => outerPosition(page)).toEqual(initial);
      await expect.poll(() => container.evaluate(node => node.scrollTop)).toBe(0);
      await swipe('top', false);
      await expect.poll(() => container.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
      await swipe('bottom', false);
      await expect.poll(() => outerPosition(page)).toEqual(initial);
      await expect(details).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`${theme}-details-${width}.png`) });
    }
  } finally {
    await session.detach();
  }
});
