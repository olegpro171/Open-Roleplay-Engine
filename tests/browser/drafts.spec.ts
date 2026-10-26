import { openChatTool } from './chat-tools';
import { test, expect, devices, type Page } from '@playwright/test';
import type { LibrarySnapshot } from '../../src/shared/library';
import { appearanceStatusSchema } from '../../src/shared/appearance';

async function setup(page: Page) {
  const session = await page.request.get('/api/session').then(response => response.json());
  const { endpoint } = await page.request.get('/__test/endpoint').then(response => response.json());
  await page.request.post('/__test/mode', { data: { mode: 'normal' } });
  await page.goto('/');
  await page.getByLabel('Owner password').fill('browser-synthetic-password');
  await page.getByRole('button', { name: session.setupRequired ? 'Create owner account' : 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Libraries', exact: true })).toBeVisible();
  const library = await page.request.get('/api/library').then(response => response.json() as Promise<LibrarySnapshot>);
  const response = await page.request.post('/api/library', { headers: { Origin: 'http://127.0.0.1:4173' }, data: {
    revision: library.revision, kind: 'connections', data: { name: 'Draft model', endpoint, model: 'synthetic-roleplay', contextWindow: 100_000, maxOutputTokens: 1_000, customParameters: {} },
  } });
  expect(response.ok()).toBe(true);
  const { id: connectionId } = await response.json();
  const ids: string[] = [];
  for (const title of ['Draft story A', 'Draft story B']) {
    const created = await page.request.post('/api/chats', { headers: { Origin: 'http://127.0.0.1:4173' }, data: {
      title: `${title} ${test.info().testId}`, targetInputTokens: 20_000, connectionId, promptId: 'default', characterId: null, personaId: null, contextPresetId: null,
    } });
    expect(created.ok()).toBe(true);
    ids.push((await created.json()).id);
  }
  await open(page, 'Draft story A');
  return ids;
}
async function open(page: Page, title: string) {
  await page.getByRole('button', { name: 'Libraries', exact: true }).click();
  await page.getByRole('button', { name: 'Chats', exact: true }).click();
  await page.getByRole('article').filter({ has: page.getByRole('heading', { name: `${title} ${test.info().testId}`, exact: true }) }).last().click();
  await expect(page.getByLabel('Your next turn')).toBeVisible();
}

for (const platform of ['iPhone', 'iPad desktop mode', 'Android'] as const) test.describe(platform, () => {
  const device = platform === 'iPhone' ? devices['iPhone 13']
    : platform === 'Android' ? devices['Pixel 7']
      : { ...devices['Desktop Safari'], viewport: { width: 1024, height: 1366 } };
  test.use({ userAgent: device.userAgent, viewport: device.viewport,
    isMobile: device.isMobile, hasTouch: device.hasTouch, deviceScaleFactor: device.deviceScaleFactor });

  test('composer shape, expansion and sending', async ({ page }) => {
    if (platform === 'iPad desktop mode') {
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' });
        Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5 });
      });
    }
    await setup(page);
    const composer = page.getByLabel('Your next turn');
    const send = page.getByRole('button', { name: 'Send', exact: true });
    const rounded = platform !== 'Android';
    await expect(composer).toHaveCSS('border-top-left-radius', rounded ? '22px' : '7px');
    await expect(send).toHaveCSS('border-top-left-radius', rounded ? '50%' : '8px');
    const initialHeight = await composer.evaluate(field => field.getBoundingClientRect().height);
    expect(initialHeight).toBe(44);
    const expectPhoneInsets = async () => {
      if (platform !== 'iPhone') return;
      const inputBounds = await composer.boundingBox();
      const sendBounds = await send.boundingBox();
      const viewport = page.viewportSize();
      if (!inputBounds || !sendBounds || !viewport) throw new Error('Phone composer must be visible');
      expect(inputBounds.x).toBeGreaterThanOrEqual(26);
      expect(viewport.width - sendBounds.x - sendBounds.width).toBeGreaterThanOrEqual(26);
      expect(viewport.height - sendBounds.y - sendBounds.height).toBeGreaterThanOrEqual(28);
    };
    await expectPhoneInsets();
    await page.screenshot({ path: `test-results/composer-${platform.replaceAll(' ', '-')}-compact.png`, fullPage: true });
    await composer.fill('Mira waits by the lantern.\nLeon returns the key.\nThey open the door.');
    await expect.poll(() => composer.evaluate(field => field.getBoundingClientRect().height)).toBeGreaterThan(initialHeight);
    await expect.poll(() => composer.evaluate(field => field.scrollHeight <= field.clientHeight + 1)).toBe(true);
    const inputBounds = await composer.boundingBox();
    const sendBounds = await send.boundingBox();
    if (!inputBounds || !sendBounds) throw new Error('Composer controls must be visible');
    expect(sendBounds.width).toBe(44);
    expect(sendBounds.height).toBe(44);
    expect(sendBounds.x).toBeGreaterThan(inputBounds.x + inputBounds.width);
    expect(Math.abs(sendBounds.y + sendBounds.height - inputBounds.y - inputBounds.height)).toBeLessThan(1);
    await expectPhoneInsets();
    await page.screenshot({ path: `test-results/composer-${platform.replaceAll(' ', '-')}.png`, fullPage: true });
    await send.click();
    await expect(composer).toHaveValue('');
    await expect.poll(() => composer.evaluate(field => field.getBoundingClientRect().height)).toBe(initialHeight);
  });

  if (platform !== 'iPad desktop mode') test('keyboard spacing follows viewport loss and restores after dismissal', async ({ page }) => {
    // Chromium emulation cannot open the iOS keyboard. Drive its viewport
    // signals explicitly, exercising the real hook and composer rendering.
    await page.addInitScript(() => {
      const viewport = window.visualViewport;
      if (!viewport) throw new Error('Visual viewport is required for this test');
      const expandedHeight = viewport.height;
      let height = expandedHeight;
      let scale = 1;
      Object.defineProperty(viewport, 'height', { get: () => height });
      Object.defineProperty(viewport, 'scale', { get: () => scale });
      window.addEventListener('test-keyboard-viewport', event => {
        if (!(event instanceof CustomEvent)) return;
        height = expandedHeight - event.detail.loss;
        scale = event.detail.scale;
        viewport.dispatchEvent(new Event('resize'));
      });
    });
    await setup(page);
    const input = page.getByLabel('Your next turn');
    const panel = page.locator('form.composer');
    const normalBottom = platform === 'iPhone' ? '28px' : '14px';
    const viewport = (loss: number, scale = 1) => page.evaluate(({ loss, scale }) => {
      window.dispatchEvent(new CustomEvent('test-keyboard-viewport', { detail: { loss, scale } }));
    }, { loss, scale });

    await viewport(300);
    await expect(panel).toHaveCSS('padding-bottom', normalBottom);
    await viewport(0);
    await input.focus();
    await expect(panel).toHaveCSS('padding-bottom', normalBottom);
    await viewport(60); // Browser chrome is not a keyboard.
    await expect(panel).toHaveCSS('padding-bottom', normalBottom);
    await viewport(300, 2); // Pinch zoom must not masquerade as a keyboard.
    await expect(panel).toHaveCSS('padding-bottom', normalBottom);
    await viewport(300);
    await expect(panel).toHaveCSS('padding-bottom', platform === 'iPhone' ? '8px' : normalBottom);
    await expect(panel).toHaveCSS('padding-left', '16px');
    const draft = 'Mira waits.\nLeon opens the door.\nThe story continues.';
    await input.fill(draft);
    await expect.poll(() => input.evaluate(field => field.scrollHeight <= field.clientHeight + 1)).toBe(true);
    await page.screenshot({ path: `test-results/composer-${platform}-keyboard-signals.png`, fullPage: true });

    await viewport(0); // iOS can dismiss its keyboard without blurring the field.
    await expect(input).toBeFocused();
    await expect(panel).toHaveCSS('padding-bottom', normalBottom);
    await expect(panel).toHaveCSS('padding-left', platform === 'iPhone' ? '26px' : '16px');
    await viewport(300);
    await page.getByRole('button', { name: 'Story', exact: true }).focus();
    await expect(panel).toHaveCSS('padding-bottom', normalBottom);
    await expect(input).toHaveValue(draft);
    await viewport(0);
    await input.focus();
    await expect(panel).toHaveCSS('padding-bottom', normalBottom);
  });
  if (platform === 'iPhone') test('touch gestures stay within intended scroll areas and retain native controls', async ({ page }) => {
    await setup(page);
    await page.getByLabel('Your next turn').fill('Long draft line.\n'.repeat(60));
    const result = await page.evaluate(() => {
      const field = document.querySelector('textarea#turn-input');
      const panel = document.querySelector('.composer');
      if (!(field instanceof HTMLTextAreaElement) || !(panel instanceof HTMLElement)) throw new Error('Missing composer');
      // Synthetic events verify the real non-passive listener's decisions;
      // they do not emulate Safari's native viewport panning.
      const gesture = (target: Element, dx: number, dy: number, touches = 1) => {
        const points = (x: number, y: number) => Array.from({ length: touches }, (_, identifier) => new Touch({ identifier, target, clientX: x + identifier * 20, clientY: y }));
        target.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: points(100, 150) }));
        const move = new TouchEvent('touchmove', { bubbles: true, cancelable: true, touches: points(100 + dx, 150 + dy) });
        target.dispatchEvent(move);
        target.dispatchEvent(new TouchEvent('touchend', { bubbles: true }));
        return move.defaultPrevented;
      };
      field.setSelectionRange(0, 0);
      field.scrollTop = 50;
      const inside = gesture(field, 0, -25);
      field.scrollTop = 0;
      const top = gesture(field, 0, 25);
      field.scrollTop = field.scrollHeight;
      const bottom = gesture(field, 0, -25);
      field.setSelectionRange(0, 5);
      const selection = gesture(field, 0, -25);
      field.setSelectionRange(0, 0);
      const staticControl = gesture(panel, 0, -25);
      const pinch = gesture(panel, 0, -25, 2);
      const range = document.createElement('input');
      range.type = 'range';
      panel.append(range);
      const slider = gesture(range, 25, 0);
      range.remove();
      const scroller = document.createElement('div');
      scroller.style.cssText = 'width:80px;height:20px;overflow:auto;direction:rtl';
      const child = document.createElement('div');
      child.style.cssText = 'width:300px;height:20px';
      scroller.append(child);
      panel.append(scroller);
      scroller.scrollLeft = -50;
      const horizontal = gesture(scroller, 25, 0);
      scroller.remove();
      return { inside, top, bottom, selection, staticControl, pinch, slider, horizontal };
    });
    expect(result).toEqual({ inside: false, top: true, bottom: true, selection: false, staticControl: true, pinch: false, slider: false, horizontal: false });
    // Exercise a real Chromium touch scroll as well as cancellation decisions.
    const input = page.getByLabel('Your next turn');
    await input.evaluate(node => { node.scrollTop = 0; });
    const bounds = await input.boundingBox();
    if (!bounds) throw new Error('Composer must be visible');
    const session = await page.context().newCDPSession(page);
    const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height - 12;
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let step = 1; step <= 6; step++) await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - step * 12 }] });
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(() => input.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await session.detach();
  });
  if (platform === 'iPhone') test('transcript boundary gestures remain native while the outer frame stays still', async ({ page }, testInfo) => {
    const [chatId] = await setup(page);
    const transcript = page.locator('.transcript');
    const boundaries = () => transcript.evaluate(node => {
      const target = node.querySelector('.prose') ?? node.firstElementChild ?? node;
      const gesture = (element: Element, dx: number, dy: number) => {
        const touch = (x: number, y: number) => [new Touch({ identifier: 0, target: element, clientX: x, clientY: y })];
        element.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: touch(100, 150) }));
        const move = new TouchEvent('touchmove', { bubbles: true, cancelable: true, touches: touch(100 + dx, 150 + dy) });
        element.dispatchEvent(move);
        element.dispatchEvent(new TouchEvent('touchend', { bubbles: true }));
        return move.defaultPrevented;
      };
      node.scrollTop = 0;
      const top = gesture(target, 0, 25);
      node.scrollTop = node.scrollHeight;
      const bottom = gesture(target, 0, -25);
      const horizontal = gesture(target, 25, 0);
      // A contained editor inside the transcript still owns its boundaries.
      const editor = document.createElement('textarea');
      editor.style.cssText = 'height:44px;min-height:0;overflow:auto;overscroll-behavior:contain';
      editor.value = 'Nested editor line.\n'.repeat(40);
      node.append(editor);
      editor.setSelectionRange(0, 0);
      editor.scrollTop = 0;
      const editorTop = gesture(editor, 0, 25);
      editor.scrollTop = editor.scrollHeight;
      const editorBottom = gesture(editor, 0, -25);
      editor.value = '';
      editor.style.height = '88px';
      if (editor.scrollHeight > editor.clientHeight + 1) throw new Error('Short editor must not overflow');
      const shortEditorTop = gesture(editor, 0, 25);
      const shortEditorBottom = gesture(editor, 0, -25);
      editor.remove();
      return { top, bottom, horizontal, editorTop, editorBottom, shortEditorTop, shortEditorBottom };
    });
    const expected = { top: false, bottom: false, horizontal: true, editorTop: true, editorBottom: true, shortEditorTop: true, shortEditorBottom: true };
    await expect.poll(() => transcript.evaluate(node => node.scrollHeight <= node.clientHeight + 1)).toBe(true);
    expect(await boundaries()).toEqual(expected);

    const imported = await page.request.put(`/api/chats/${chatId}/history`, {
      headers: { Origin: 'http://127.0.0.1:4173' }, data: { revision: 0, turns: [
        { user: 'Mira enters the archive.', assistant: 'Leon watches the lantern.\n\n'.repeat(100), complete: true },
      ] },
    });
    expect(imported.ok(), await imported.text()).toBe(true);
    await page.reload();
    await expect.poll(() => transcript.evaluate(node => node.scrollHeight - node.clientHeight)).toBeGreaterThan(100);
    expect(await boundaries()).toEqual(expected);

    const originalAppearance = appearanceStatusSchema.parse(await page.request.get('/api/application/appearance').then(response => response.json()));
    const session = await page.context().newCDPSession(page);
    try {
      const swipe = async (fromTop: boolean, edge: 'top' | 'bottom' = 'top') => {
        const bounds = await transcript.boundingBox();
        if (!bounds) throw new Error('Transcript must be visible');
        const x = bounds.x + bounds.width / 2;
        const y = bounds.y + bounds.height / 2;
        await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
        // Touch down stops the previous swipe's momentum. Let resize observers
        // settle before placing this gesture at its intended boundary.
        await transcript.evaluate((node, edge) => new Promise<void>(resolve => {
          requestAnimationFrame(() => requestAnimationFrame(() => {
            node.scrollTop = edge === 'top' ? 0 : node.scrollHeight;
            resolve();
          }));
        }), edge);
        await expect.poll(() => transcript.evaluate((node, edge) => edge === 'top'
          ? node.scrollTop : node.scrollHeight - node.clientHeight - node.scrollTop, edge)).toBe(0);
        for (let step = 1; step <= 6; step++) {
          await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + (fromTop ? 1 : -1) * step * 12 }] });
        }
        await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      };
      const outerPosition = () => page.evaluate(() => ({
        x: window.scrollX, y: window.scrollY,
        viewportX: window.visualViewport?.offsetLeft, viewportY: window.visualViewport?.offsetTop,
        header: document.querySelector('header')?.getBoundingClientRect().top,
      }));
      const initial = await outerPosition();
      for (const theme of ['dark', 'light', 'midnight-black'] as const) {
        const appearance = appearanceStatusSchema.parse(await page.request.get('/api/application/appearance').then(response => response.json()));
        const saved = await page.request.put('/api/application/appearance', {
          headers: { Origin: 'http://127.0.0.1:4173' }, data: { revision: appearance.revision, settings: { ...appearance.settings, theme } },
        });
        expect(saved.ok()).toBe(true);
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        for (const width of [390, 1440]) {
          await page.setViewportSize({ width, height: 844 });
          await swipe(true);
          await expect.poll(outerPosition).toEqual(initial);
          await expect.poll(() => transcript.evaluate(node => node.scrollTop)).toBe(0);
          await swipe(false);
          await expect.poll(() => transcript.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
          await swipe(false, 'bottom');
          await expect.poll(outerPosition).toEqual(initial);
          await page.screenshot({ path: testInfo.outputPath(`${theme}-transcript-${width}.png`) });
        }
      }
    } finally {
      await session.detach();
      const current = appearanceStatusSchema.parse(await page.request.get('/api/application/appearance').then(response => response.json()));
      const restored = await page.request.put('/api/application/appearance', {
        headers: { Origin: 'http://127.0.0.1:4173' }, data: { revision: current.revision, settings: originalAppearance.settings },
      });
      expect(restored.ok()).toBe(true);
    }
  });
});

for (const width of [1440, 390]) test(`composer fits its content at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await setup(page);
  const composer = page.getByLabel('Your next turn');
  const send = page.getByRole('button', { name: 'Send', exact: true });
  const height = () => composer.evaluate(field => field.getBoundingClientRect().height);
  const fits = () => composer.evaluate(field => field.scrollHeight <= field.clientHeight + 1);
  const minimum = await send.evaluate(button => button.getBoundingClientRect().height);
  const expectSendLayout = async (viewportWidth: number) => {
    await expect.poll(async () => {
      const inputBounds = await composer.boundingBox();
      const sendBounds = await send.boundingBox();
      if (!inputBounds || !sendBounds) return false;
      return sendBounds.x >= inputBounds.x + inputBounds.width
        && Math.abs(sendBounds.y + sendBounds.height - inputBounds.y - inputBounds.height) < 1
        && sendBounds.x + sendBounds.width <= viewportWidth;
    }).toBe(true);
    await expect(send).toHaveText('');
    await expect(send).toHaveAttribute('title', /^Send \(Ctrl(?: \/ ⌘)? \+ Enter\)$/);
    await expect.poll(() => send.evaluate(button => {
      const bounds = button.getBoundingClientRect();
      return bounds.width === bounds.height;
    })).toBe(true);
  };
  await expect.poll(height).toBe(minimum);
  await expectSendLayout(width);

  await composer.pressSequentially('Mira waits.');
  await composer.press('Enter');
  await composer.pressSequentially('Leon returns the key.');
  await expect.poll(height).toBeGreaterThan(minimum);
  await expect.poll(fits).toBe(true);
  await expectSendLayout(width);
  const multilineHeight = await height();
  await page.reload();
  await expect(composer).toHaveValue('Mira waits.\nLeon returns the key.');
  await expect.poll(height).toBe(multilineHeight);
  await composer.fill('');
  await expect.poll(height).toBe(minimum);

  await composer.fill('Mira watches the lantern. '.repeat(12));
  await expect.poll(fits).toBe(true);
  const originalHeight = await height();
  await page.setViewportSize({ width: width === 1440 ? 390 : 1440, height: 900 });
  await expect.poll(async () => width === 1440 ? (await height()) > originalHeight : (await height()) < originalHeight).toBe(true);
  await expect.poll(fits).toBe(true);
  await expectSendLayout(width === 1440 ? 390 : 1440);
  await page.setViewportSize({ width, height: 900 });
  await expect.poll(height).toBe(originalHeight);

  await composer.fill('A long draft line.\n'.repeat(60));
  await expect.poll(height).toBeLessThanOrEqual(270);
  await expect.poll(fits).toBe(false);
  await expectSendLayout(width);
  await composer.press('ControlOrMeta+End');
  expect(await composer.evaluate(field => field.scrollTop)).toBeGreaterThan(0);
  await composer.pressSequentially('The story continues.');
  expect(await composer.evaluate(field => field.scrollTop)).toBeGreaterThan(0);
  await page.screenshot({ path: `test-results/composer-${width}.png`, fullPage: true });
  await composer.fill('I keep the key.');
  await expect.poll(height).toBe(minimum);
  await send.click();
  await expect(composer).toBeEnabled();
  await expect(composer).toHaveValue('');
  await expect.poll(height).toBe(minimum);
});

test('drafts survive menus, chat switches, reloads and closing the browser page', async ({ page, context }) => {
  await setup(page);
  const text = '\n  Mira holds the key.\nОна ждёт ответа.  \n';
  await page.getByLabel('Your next turn').fill(text);
  await page.getByRole('button', { name: 'Story', exact: true }).click();
  await openChatTool(page, 'Chat settings');
  await page.getByRole('button', { name: 'Story', exact: true }).click();
  await expect(page.getByLabel('Your next turn')).toHaveValue(text);
  await open(page, 'Draft story B');
  await expect(page.getByLabel('Your next turn')).toHaveValue('');
  await page.getByLabel('Your next turn').fill('Leon waits in the other story.');
  await open(page, 'Draft story A');
  await expect(page.getByLabel('Your next turn')).toHaveValue(text);
  await page.reload();
  await expect(page.getByLabel('Your next turn')).toHaveValue(text);
  await page.close();
  const reopened = await context.newPage();
  await reopened.goto('/');
  await expect(reopened.getByLabel('Your next turn')).toHaveValue(text);
  await open(reopened, 'Draft story B');
  await expect(reopened.getByLabel('Your next turn')).toHaveValue('Leon waits in the other story.');
  await reopened.getByLabel('Your next turn').fill('');
  await reopened.reload();
  await expect(reopened.getByLabel('Your next turn')).toHaveValue('');
});

test('failed sends retain exact drafts and retry identity across reload until acknowledged', async ({ page }) => {
  const [chatId] = await setup(page);
  const text = '\nMira refuses to lose this message.\n';
  await page.getByLabel('Your next turn').fill(text);
  const commands: unknown[] = [];
  await page.route(`**/api/chats/${chatId}/turns`, async route => {
    commands.push(route.request().postDataJSON());
    await route.abort('connectionrefused');
  });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.locator('.error-banner').getByRole('button')).toHaveCount(1);
  await page.locator('.error-banner').getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(page.locator('.error-banner')).toHaveCount(0);
  await expect(page.getByLabel('Your next turn')).toHaveValue(text);
  await page.reload();
  await expect(page.getByLabel('Your next turn')).toHaveValue(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => commands.length).toBe(2);
  expect(commands[1]).toEqual(commands[0]);
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
  await page.unroute(`**/api/chats/${chatId}/turns`);
  // The server saves the turn, but the acknowledgement is lost.
  await page.route(`**/api/chats/${chatId}/turns`, async route => {
    await route.fetch();
    await route.abort('failed');
  });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('article')).toHaveCount(1);
  await expect(page.getByLabel('Your next turn')).toBeEnabled();
  await expect(page.getByLabel('Your next turn')).toHaveValue(text);
  await page.reload();
  await expect(page.getByLabel('Your next turn')).toHaveValue(text);
  await page.unroute(`**/api/chats/${chatId}/turns`);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByLabel('Your next turn')).toHaveValue('');
  await expect(page.getByRole('article')).toHaveCount(1);
  await page.reload();
  await expect(page.getByLabel('Your next turn')).toHaveValue('');
});

test('late acknowledgement clears only the submitted chat draft', async ({ page }) => {
  const [chatId] = await setup(page);
  await open(page, 'Draft story B');
  await page.getByLabel('Your next turn').fill('Keep story B draft.');
  await open(page, 'Draft story A');
  await page.getByLabel('Your next turn').fill('Send from story A.');
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/chats/${chatId}/turns`, async route => {
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('article')).toHaveCount(1);
  await open(page, 'Draft story B');
  release();
  await expect(page.getByLabel('Your next turn')).toBeEnabled();
  await expect(page.getByLabel('Your next turn')).toHaveValue('Keep story B draft.');
  await open(page, 'Draft story A');
  await expect(page.getByLabel('Your next turn')).toHaveValue('');
  await open(page, 'Draft story B');
  await expect(page.getByLabel('Your next turn')).toHaveValue('Keep story B draft.');
});


test('storage failure warns without discarding the in-memory draft', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key.startsWith('roleplay-draft:')) throw new DOMException('Storage full', 'QuotaExceededError');
      original.call(this, key, value);
    };
  });
  await page.getByLabel('Your next turn').fill('Keep this even when storage is full.');
  await expect(page.getByRole('alert')).toContainText('Draft could not be saved');
  await open(page, 'Draft story B');
  await open(page, 'Draft story A');
  await expect(page.getByLabel('Your next turn')).toHaveValue('Keep this even when storage is full.');
  await expect(page.getByRole('alert')).toContainText('Draft could not be saved');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/phone-draft-storage-warning.png', fullPage: true });
});


test('a rejected command keeps its draft and permits a corrected explicit retry', async ({ page }) => {
  const [chatId] = await setup(page);
  await page.getByLabel('Your next turn').fill('Mira keeps her unsent response.');
  let rejectedId = '';
  await page.route(`**/api/chats/${chatId}/turns`, async route => {
    rejectedId = route.request().postDataJSON().requestId;
    await route.fulfill({ status: 422, json: { message: 'Synthetic command rejection' } });
  });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Synthetic command rejection');
  await expect(page.locator('.error-banner').getByRole('button')).toHaveCount(1);
  await page.locator('.error-banner').getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(page.locator('.error-banner')).toHaveCount(0);
  await expect(page.getByLabel('Your next turn')).toHaveValue('Mira keeps her unsent response.');
  await page.reload();
  await expect(page.getByLabel('Your next turn')).toHaveValue('Mira keeps her unsent response.');
  await page.unroute(`**/api/chats/${chatId}/turns`);
  const sent = page.waitForRequest(request => request.url().endsWith(`/api/chats/${chatId}/turns`) && request.method() === 'POST');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  expect((await sent).postDataJSON().requestId).not.toBe(rejectedId);
  await expect(page.getByLabel('Your next turn')).toHaveValue('');
  await expect(page.getByRole('article')).toHaveCount(1);
});

for (const width of [1440, 390]) test(`typed double dashes become em dashes in composer and turn editors at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  const [chatId] = await setup(page);
  const composer = page.getByLabel('Your next turn');
  await composer.pressSequentially('Wait--please - stay');
  await expect(composer).toHaveValue('Wait—please - stay');
  await page.reload();
  await expect(composer).toHaveValue('Wait—please - stay');

  // Replacing selected text in the middle must keep subsequent typing at the edit.
  // Existing double dashes elsewhere are left literal.
  await composer.fill('old--text / -X end');
  await composer.evaluate((field: HTMLTextAreaElement) => field.setSelectionRange(13, 14));
  await composer.pressSequentially('-here');
  await expect(composer).toHaveValue('old--text / —here end');
  expect(await composer.evaluate((field: HTMLTextAreaElement) => field.selectionStart)).toBe(17);

  // Composition input is left to the IME, and deletion must not trigger substitution.
  await composer.fill('--');
  await composer.evaluate((field: HTMLTextAreaElement) => {
    field.value = '---';
    field.setSelectionRange(3, 3);
    field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '-', isComposing: true }));
  });
  await expect(composer).toHaveValue('---');
  await composer.press('Backspace');
  await expect(composer).toHaveValue('--');

  await composer.fill('');
  await composer.pressSequentially('I wait--quietly.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const turn = page.getByRole('article', { name: 'Turn 1', exact: true });
  await expect(turn.getByRole('button', { name: 'Edit response', exact: true })).toBeEnabled();
  for (const [button, label, text] of [
    ['Edit input', 'Edit user text', 'Input—changed.'],
    ['Edit response', 'Edit assistant text', 'Response—changed.'],
  ]) {
    await turn.getByRole('button', { name: button, exact: true }).click();
    const editor = page.getByLabel(label);
    await editor.fill('');
    await editor.pressSequentially(text.replace('—', '--'));
    await expect(editor).toHaveValue(text);
    await page.getByRole('button', { name: 'Save edit', exact: true }).click();
    await expect(editor).toHaveCount(0);
  }
  await page.reload();
  const saved = await page.request.get(`/api/chats/${chatId}`).then(response => response.json());
  expect(saved.turns[0].user.text).toBe('Input—changed.');
  expect(saved.turns[0].assistant.text).toBe('Response—changed.');
  await turn.getByRole('button', { name: 'Edit response', exact: true }).click();
  const responseEditor = page.getByLabel('Edit assistant text');
  await responseEditor.fill('Leon remembers the corridor and the locked door. '.repeat(20));
  await expect.poll(() => responseEditor.evaluate(field => field.scrollHeight <= field.clientHeight + 1)).toBe(true);
  await responseEditor.fill('Response—changed.');
  await page.getByLabel('Edit assistant text').pressSequentially('--discard');
  await page.getByRole('button', { name: 'Cancel edit', exact: true }).click();
  await turn.getByRole('button', { name: 'Edit response', exact: true }).click();
  await expect(page.getByLabel('Edit assistant text')).toHaveValue('Response—changed.');
  const longResponse = 'Leon remembers the corridor and the locked door. '.repeat(20);
  await responseEditor.fill(longResponse);
  await page.getByRole('button', { name: 'Save edit', exact: true }).click();
  await turn.getByRole('button', { name: 'Edit response', exact: true }).click();
  await expect(responseEditor).toHaveValue(longResponse);
  await expect.poll(() => responseEditor.evaluate(field => field.scrollHeight <= field.clientHeight + 1)).toBe(true);
});
