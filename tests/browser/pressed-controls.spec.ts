import { expect, devices, webkit, type Locator } from '@playwright/test';
import { appearanceStatusSchema, themeSchema } from '../../src/shared/appearance';
import { test } from './isolated-app';

test.use({ ...devices['Pixel 7'] });

function shadow(control: Locator) {
  return control.evaluate(element => getComputedStyle(element).boxShadow);
}

async function point(control: Locator, position?: { x: number; y: number }) {
  await control.scrollIntoViewIfNeeded();
  const bounds = await control.boundingBox();
  if (!bounds) throw new Error('Missing press target');
  return { x: bounds.x + (position?.x ?? bounds.width / 2), y: bounds.y + (position?.y ?? bounds.height / 2) };
}

test.describe('visible feedback during a phone press', () => {
  for (const theme of themeSchema.options) test(theme, async ({ page, browserApp, browser }, testInfo) => {
    await page.goto('/');
    await page.getByLabel('Owner password').fill('browser-synthetic-password');
    await page.getByRole('button', { name: 'Create owner account', exact: true }).tap();
    const workspace = page.getByRole('navigation', { name: 'Workspace' });
    await expect(workspace).toBeVisible();
    const appearance = appearanceStatusSchema.parse(await page.request.get('/api/application/appearance').then(response => response.json()));
    const saved = await page.request.put('/api/application/appearance', {
      headers: { Origin: browserApp.url }, data: { revision: appearance.revision, settings: { ...appearance.settings, theme } },
    });
    expect(saved.ok(), await saved.text()).toBe(true);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);

    const touch = await page.context().newCDPSession(page);
    const down = (position: { x: number; y: number }) => touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [position] });
    const end = (type: 'touchEnd' | 'touchCancel') => touch.send('Input.dispatchTouchEvent', { type, touchPoints: [] });
    const chats = page.getByRole('region', { name: 'Chats', exact: true });

    for (const name of ['Libraries', 'Settings', 'Story', 'Libraries']) {
      const tab = workspace.getByRole('button', { name, exact: true });
      const idle = await shadow(tab);
      await down(await point(tab));
      await expect(tab).toHaveCSS('box-shadow', idle);
      await expect(tab).not.toHaveAttribute('aria-current', 'page');
      await end('touchEnd');
      await expect(tab).toHaveAttribute('aria-current', 'page');
    }

    const card = chats.getByRole('article').filter({ hasText: 'A new story' });
    const more = card.getByRole('button', { name: /^Actions for / });
    const idleCard = await shadow(card);
    const idleMore = await shadow(more);
    await down(await point(more));
    await expect(more).not.toHaveCSS('box-shadow', idleMore);
    await expect(card).toHaveCSS('box-shadow', idleCard);
    await expect(page.getByRole('menu')).toBeHidden();
    await page.screenshot({ path: testInfo.outputPath('phone-more-pressed.png') });
    await end('touchEnd');
    await expect(page.getByRole('menu')).toBeVisible();
    await expect(more).toHaveCSS('box-shadow', idleMore);
    await page.keyboard.press('Escape');

    // Press the card away from its title and independent action button.
    const cardPoint = await point(card, { x: 12, y: 12 });
    await down(cardPoint);
    await expect(card).not.toHaveCSS('box-shadow', idleCard);
    await expect(more).toHaveCSS('box-shadow', idleMore);
    await page.screenshot({ path: testInfo.outputPath('phone-card-pressed.png') });
    await end('touchCancel');
    await expect(card).toHaveCSS('box-shadow', idleCard);
    await expect(chats).toBeVisible();

    await down(cardPoint);
    for (const distance of [4, 16, 36, 60]) {
      await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...cardPoint, y: cardPoint.y - distance }] });
    }
    await expect(card).toHaveCSS('box-shadow', idleCard);
    await end('touchEnd');
    await expect(chats).toBeVisible();
    const newChat = chats.getByRole('button', { name: 'New chat', exact: true });
    const idleNewChat = await shadow(newChat);
    await down(await point(newChat));
    await expect(newChat).not.toHaveCSS('box-shadow', idleNewChat);
    await page.screenshot({ path: testInfo.outputPath('phone-primary-pressed.png') });
    await end('touchEnd');
    const startChat = page.getByRole('button', { name: 'Start chat', exact: true });
    await expect(startChat).toBeDisabled();
    const idleStart = await shadow(startChat);
    await down(await point(startChat));
    await expect(startChat).toHaveCSS('box-shadow', idleStart);
    await end('touchEnd');
    await expect(startChat).toBeDisabled();

    const desktop = await browser.newContext({ ...devices['Desktop Chrome'], baseURL: browserApp.url, storageState: await page.context().storageState() });
    try {
      const desktopPage = await desktop.newPage();
      await desktopPage.goto('/');
      expect(await desktopPage.evaluate(() => matchMedia('(hover: hover)').matches)).toBe(true);
      const libraryTab = desktopPage.getByRole('button', { name: 'Libraries', exact: true });
      await libraryTab.hover();
      const hoveredTab = await shadow(libraryTab);
      const hoveredFilter = await libraryTab.evaluate(element => getComputedStyle(element).filter);
      await desktopPage.mouse.down();
      await expect(libraryTab).toHaveCSS('box-shadow', hoveredTab);
      await expect(libraryTab).toHaveCSS('filter', hoveredFilter);
      await expect(libraryTab).not.toHaveAttribute('aria-current', 'page');
      await desktopPage.mouse.up();
      await expect(libraryTab).toHaveAttribute('aria-current', 'page');
      for (const width of [1440, 801, 800]) {
        await desktopPage.setViewportSize({ width, height: 850 });
        const button = desktopPage.getByRole('button', { name: /^Actions for A new story/ });
        const { x, y } = await point(button);
        await desktopPage.mouse.move(x, y);
        const idle = await shadow(button);
        await desktopPage.mouse.down();
        await expect(button).not.toHaveCSS('box-shadow', idle);
        await desktopPage.screenshot({ path: testInfo.outputPath(`desktop-pressed-${width}.png`) });
        await desktopPage.mouse.up();
        await expect(button).toHaveCSS('box-shadow', idle);
        await expect(desktopPage.getByRole('menu')).toBeVisible();
        await desktopPage.keyboard.press('Escape');
      }
    } finally {
      await desktop.close();
    }
  });
});

test('WebKit touch feedback reaches Story, Settings and a modal', async ({ browserApp }) => {
  const browser = await webkit.launch();
  try {
    const context = await browser.newContext({ ...devices['iPhone 13'], baseURL: browserApp.url });
    const page = await context.newPage();
    await page.goto('/');
    await page.getByLabel('Owner password').fill('browser-synthetic-password');

    // Playwright's WebKit tap delivers down and up together. Sample the actual
    // style during the trusted pointerdown, before control activation.
    const tapAndCheck = async (control: Locator) => {
      const idle = await shadow(control);
      await control.evaluate(element => {
        delete document.documentElement.dataset.testTouchShadow;
        element.addEventListener('pointerdown', event => {
          if (event instanceof PointerEvent && event.pointerType === 'touch' && event.isTrusted) {
            document.documentElement.dataset.testTouchShadow = getComputedStyle(element).boxShadow;
          }
        }, { once: true });
      });
      await control.tap();
      const duringPress = await page.locator('html').getAttribute('data-test-touch-shadow');
      expect(duringPress).toBeTruthy();
      expect(duringPress).not.toBe(idle);
    };

    await tapAndCheck(page.getByRole('button', { name: 'Create owner account', exact: true }));
    const details = page.getByRole('button', { name: 'Chat details', exact: true });
    await tapAndCheck(details);
    await expect(details).toHaveAttribute('aria-expanded', 'true');
    const disclosure = page.locator('.context-dropdown > summary');
    await tapAndCheck(disclosure);
    await expect(disclosure.locator('..')).toHaveAttribute('open', '');
    await details.tap();

    await page.getByRole('button', { name: 'Settings', exact: true }).tap();
    await page.getByRole('button', { name: 'Chat appearance', exact: true }).tap();
    await tapAndCheck(page.getByRole('combobox', { name: 'Theme', exact: true }));
    await tapAndCheck(page.getByRole('option', { name: 'Light', exact: true }));
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await tapAndCheck(page.getByRole('button', { name: 'Default character speech color', exact: true }));
    const picker = page.getByRole('dialog');
    await expect(picker).toBeVisible();
    await tapAndCheck(picker.getByRole('button', { name: 'Close', exact: true }));
    await expect(picker).toBeHidden();
  } finally {
    await browser.close();
  }
});
