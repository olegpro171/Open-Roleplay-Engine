import { expect, webkit, type Locator } from '@playwright/test';
import { defaultPrompt, type LibrarySnapshot } from '../../src/shared/library';
import { test } from './isolated-app';
import { selectLibraryCategory } from './library-card-helpers';

for (const [engine, input, width] of [['chromium', 'mouse', 800], ['chromium', 'touch', 390], ['webkit', 'touch', 390]] as const) {
  test(`${engine} ${input} outside the Library category picker only dismisses it`, async ({ browser, browserApp }) => {
    const webkitBrowser = engine === 'webkit' ? await webkit.launch() : undefined;
    const touch = input === 'touch';
    try {
      const page = await (webkitBrowser ?? browser).newPage({
        baseURL: browserApp.url, viewport: { width, height: 844 }, hasTouch: touch, isMobile: touch,
      });
      try {
        await page.goto('/');
        await page.getByLabel('Owner password').fill('browser-synthetic-password');
        await page.getByRole('button', { name: 'Create owner account', exact: true }).click();
        const libraries = page.getByRole('button', { name: 'Libraries', exact: true });
        await expect(libraries).toBeVisible();
        // Place the built-in prompt below the expanded picker.
        for (let index = 1; index <= 5; index++) {
          const library: LibrarySnapshot = await page.request.get('/api/library').then(response => response.json());
          const saved = await page.request.post('/api/library', {
            headers: { Origin: browserApp.url }, data: {
              kind: 'prompts', revision: library.revision, data: { ...defaultPrompt, name: `Dismissal prompt ${index}` },
            },
          });
          expect(saved.ok(), await saved.text()).toBe(true);
        }
        await libraries.click();
        const picker = await selectLibraryCategory(page, 'Prompts');
        const list = page.getByRole('listbox', { name: 'Library categories' });
        const card = page.getByRole('button', { name: defaultPrompt.name, exact: true });
        const settings = page.getByRole('button', { name: 'Settings', exact: true });

        async function dismissOver(target: Locator, withFingerMovement = false) {
          await expect(target).toBeInViewport();
          const bounds = await target.boundingBox();
          if (!bounds) throw new Error('Missing dismissal target');
          const x = Math.round(bounds.x + bounds.width / 2);
          const y = Math.round(bounds.y + bounds.height / 2);
          expect(await target.evaluate((element, point) => element.contains(document.elementFromPoint(point.x, point.y)), { x, y })).toBe(true);
          if (touch) await picker.tap();
          else await picker.click();
          await expect(list).toBeVisible();
          const menu = await list.boundingBox();
          if (!menu) throw new Error('Missing category options');
          expect(x < menu.x || x >= menu.x + menu.width || y < menu.y || y >= menu.y + menu.height).toBe(true);
          // Use real hit testing at the same point for dismissal and activation.
          const activate = () => touch ? page.touchscreen.tap(x, y) : page.mouse.click(x, y);
          if (!touch) {
            await page.mouse.move(x, y);
            expect(await target.evaluate(button => button.matches(':hover'))).toBe(false);
            await page.mouse.down();
            await expect(target).not.toHaveAttribute('data-pointer-pressed', '');
            await expect(list).toBeVisible();
            await page.mouse.up();
          } else if (withFingerMovement) {
            const session = await page.context().newCDPSession(page);
            try {
              await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
              await expect(target).not.toHaveAttribute('data-pointer-pressed', '');
              await expect(list).toBeVisible();
              await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + 2, y }] });
              await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
            } finally {
              await session.detach();
            }
          } else await activate();
          await expect(list).toBeHidden();
          await expect(picker).toBeFocused();
          return activate;
        }

        const openCard = await dismissOver(card, engine === 'chromium' && touch);
        const editor = page.getByRole('group', { name: 'Editor actions' });
        await expect(card).toBeVisible();
        await expect(editor).toBeHidden();
        await openCard();
        await expect(editor).toBeVisible();
        await editor.getByRole('button', { name: 'Cancel', exact: true }).click();

        if (!touch) {
          await picker.click();
          await expect(list).toBeVisible();
          await page.mouse.move(200, 650);
          await page.mouse.wheel(0, 120);
          await expect(list).toBeHidden();
        } else if (engine === 'chromium') {
          await picker.tap();
          await expect(list).toBeVisible();
          const session = await page.context().newCDPSession(page);
          try {
            await session.send('Input.synthesizeScrollGesture', { x: 200, y: 650, yDistance: -120, gestureSourceType: 'touch' });
          } finally {
            await session.detach();
          }
          await expect(list).toBeHidden();
        }

        const openSettings = await dismissOver(settings);
        await expect(libraries).toHaveAttribute('aria-current', 'page');
        await expect(picker).toHaveText('Prompts');
        await openSettings();
        await expect(settings).toHaveAttribute('aria-current', 'page');
      } finally {
        await page.close();
      }
    } finally {
      await webkitBrowser?.close();
    }
  });
}
