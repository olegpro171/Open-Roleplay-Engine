import { expect, type Page } from '@playwright/test';
import { test } from './isolated-app';
import { appearanceStatusSchema } from '../../src/shared/appearance';

async function editor(page: Page) {
  await page.goto('/');
  await page.getByLabel('Owner password').fill('browser-synthetic-password');
  await page.getByRole('button', { name: 'Create owner account', exact: true }).click();
  await page.getByRole('button', { name: 'Libraries', exact: true }).click();
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await page.getByRole('button', { name: 'New Connection', exact: true }).click();
  const { endpoint } = await page.request.get('/__test/endpoint').then(response => response.json());
  await page.getByLabel('Name', { exact: true }).fill('Model picker draft');
  await page.getByLabel('API base URL', { exact: true }).fill(endpoint);
  return endpoint;
}

for (const width of [1280, 801, 800, 390]) {
  test.describe(`model picker at ${width}px`, () => {
    test.use({ viewport: { width, height: 844 }, hasTouch: width === 390 });
    for (const theme of ['dark', 'light', 'midnight-black'] as const) {
      test(`${theme} browses and filters in a compact keyboard-safe modal`, async ({ page, browserApp }, testInfo) => {
        await page.addInitScript(() => {
          const viewport = window.visualViewport;
          if (!viewport) throw new Error('Visual viewport required');
          let height = innerHeight;
          let top = 0;
          Object.defineProperty(viewport, 'height', { get: () => height });
          Object.defineProperty(viewport, 'offsetTop', { get: () => top });
          window.addEventListener('test-model-viewport', event => {
            if (!(event instanceof CustomEvent)) return;
            height = event.detail.height;
            top = event.detail.top;
            viewport.dispatchEvent(new Event(event.detail.type));
          });
        });
        const endpoint = await editor(page);
        const appearance = appearanceStatusSchema.parse(await page.request.get('/api/application/appearance').then(response => response.json()));
        const saved = await page.request.put('/api/application/appearance', {
          headers: { Origin: browserApp.url }, data: { revision: appearance.revision, settings: { ...appearance.settings, theme } },
        });
        expect(saved.ok()).toBe(true);
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        const models = Array.from({ length: 250 }, (_, index) => index < 3
          ? `moon/model-with-a-long-identifier-that-wraps-on-phone-${index}` : `synthetic/model-${index}`);
        const calls: unknown[] = [];
        await page.route('**/api/models', route => {
          calls.push(route.request().postDataJSON());
          return route.fulfill({ json: { models } });
        });
        const trigger = page.getByRole('button', { name: 'Model identifier', exact: true });
        await expect(trigger).toHaveText('Select model');
        await expect(page.getByRole('button', { name: 'Fetch model list', exact: true })).toHaveCount(0);
        expect(calls).toHaveLength(0);
        await trigger.click();
        const dialog = page.getByRole('dialog', { name: 'Select model', exact: true });
        const search = dialog.getByRole('textbox');
        const list = dialog.getByRole('region', { name: 'Models', exact: true });
        await expect(dialog).toBeFocused();
        await expect(list.locator('[data-model]')).toHaveCount(100);
        if (width <= 800) expect(await list.evaluate(node => node.clientHeight)).toBeGreaterThan(600);
        expect(calls).toEqual([{ endpoint }]);
        await dialog.getByRole('button', { name: 'Show more models', exact: true }).click();
        await expect(list.locator('[data-model]')).toHaveCount(200);
        await list.evaluate(node => { node.scrollTop = 300; });
        await expect.poll(() => list.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
        const beforeGesture = await list.evaluate(node => node.scrollTop);
        const listBounds = await list.boundingBox();
        if (!listBounds) throw new Error('Missing model list');
        const x = listBounds.x + listBounds.width / 2;
        const y = listBounds.y + listBounds.height * 0.75;
        if (width === 390) {
          const touch = await page.context().newCDPSession(page);
          try {
            await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
            for (let step = 1; step <= 6; step++) {
              await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - step * 10 }] });
            }
            await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
          } finally { await touch.detach(); }
        } else {
          await page.mouse.move(x, y);
          await page.mouse.wheel(0, 80);
        }
        await expect.poll(() => list.evaluate(node => node.scrollTop)).toBeGreaterThan(beforeGesture);
        await expect(dialog).toBeVisible();
        await search.fill('MOON');
        await expect(list.locator('[data-model]')).toHaveCount(3);
        expect(calls).toHaveLength(1);
        await page.screenshot({ path: testInfo.outputPath('picker-filtered.png') });

        // Emulation cannot show an iOS keyboard. Exercise resize/pan signals
        // without resizing the layout viewport, including the retained footer.
        for (const state of [{ height: 350, top: 0, type: 'resize' }, { height: 310, top: 40, type: 'scroll' }]) {
          await page.evaluate(detail => window.dispatchEvent(new CustomEvent('test-model-viewport', { detail })), state);
          const bounds = await dialog.evaluate(node => {
            const viewport = window.visualViewport;
            const input = node.querySelector('input');
            const footer = node.querySelector('.model-picker-footer');
            if (!viewport || !input || !footer) throw new Error('Missing picker geometry');
            return {
              top: node.getBoundingClientRect().top - viewport.offsetTop,
              bottom: viewport.offsetTop + viewport.height - node.getBoundingClientRect().bottom,
              gap: footer.getBoundingClientRect().top - input.getBoundingClientRect().bottom,
            };
          });
          expect(bounds.top).toBeCloseTo(8);
          expect(bounds.bottom).toBeGreaterThanOrEqual(7.5);
          expect(bounds.gap).toBeGreaterThan(150);
          await expect(search).toBeFocused();
        }
        await page.screenshot({ path: testInfo.outputPath('picker-keyboard.png') });
        await search.press('ArrowDown');
        await expect(list.locator('[data-model]').first()).toBeFocused();
        await list.locator('[data-model]').first().press('ArrowDown');
        await expect(list.locator('[data-model]').nth(1)).toBeFocused();
        await list.locator('[data-model]').nth(1).press('Enter');
        await expect(dialog).toHaveCount(0);
        await expect(trigger).toHaveText(models[1]);
        await expect(trigger).toBeFocused();
        const library = await page.request.get('/api/library').then(response => response.json());
        expect(library.connections).toHaveLength(0);

        await trigger.click();
        await expect(list.getByRole('button', { name: models[1], exact: true })).toHaveAttribute('aria-pressed', 'true');
        await search.fill('cancel-this');
        await search.press('Escape');
        await expect(dialog).toHaveCount(0);
        await expect(trigger).toHaveText(models[1]);
        await page.evaluate(() => window.dispatchEvent(new CustomEvent('test-model-viewport', { detail: { height: 844, top: 0, type: 'resize' } })));
        await page.getByRole('button', { name: 'Save', exact: true }).click();
        await expect(page.getByRole('article')).toContainText(models[1]);
        expect(calls).toHaveLength(2);
      });
    }
  });
}

test('manual identifiers work during loading, after errors/empty lists, and after a successful fetch', async ({ page }) => {
  await editor(page);
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  await page.route('**/api/models', async route => {
    calls++;
    if (calls === 1) { await gate; await route.fulfill({ json: { models: ['late-model'] } }); }
    else if (calls === 2) await route.fulfill({ status: 502, json: { message: 'Synthetic model discovery failure' } });
    else await route.fulfill({ json: { models: calls === 3 ? [] : ['listed-model'] } });
  });
  const trigger = page.getByRole('button', { name: 'Model identifier', exact: true });
  const dialog = page.getByRole('dialog', { name: 'Select model', exact: true });
  await trigger.click();
  await expect(dialog.getByRole('status')).toHaveText('Loading models…');
  await dialog.getByRole('textbox').fill('manual-while-loading');
  await dialog.getByRole('textbox').press('Enter');
  await expect(trigger).toHaveText('manual-while-loading');
  release();
  await trigger.click();
  await expect(dialog.getByRole('alert')).toContainText('Synthetic model discovery failure');
  await dialog.getByRole('textbox').fill('manual-after-error');
  await dialog.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(trigger).toHaveText('manual-after-error');
  await trigger.click();
  await expect(dialog.getByRole('status')).toContainText('empty model list');
  await dialog.getByRole('textbox').fill(' ');
  await expect(dialog.getByRole('button', { name: 'Submit', exact: true })).toBeDisabled();
  await dialog.getByRole('textbox').fill('  manual-after-empty  ');
  await dialog.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(trigger).toHaveText('manual-after-empty');
  await trigger.click();
  await expect(dialog.getByRole('button', { name: 'listed-model', exact: true })).toBeVisible();
  await dialog.getByRole('textbox').fill('unlisted-model');
  await expect(dialog.getByRole('status')).toContainText('No matching models');
  await dialog.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(trigger).toHaveText('unlisted-model');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('article')).toContainText('unlisted-model');
});

test('retries retain the query and new openings use the latest endpoint/key without stale results', async ({ page }) => {
  const endpoint = await editor(page);
  const calls: unknown[] = [];
  await page.route('**/api/models', route => {
    calls.push(route.request().postDataJSON());
    return route.fulfill(calls.length === 1
      ? { status: 502, json: { message: 'Synthetic failure' } }
      : { json: { models: [calls.length === 2 ? 'retry-model' : 'changed-model'] } });
  });
  const trigger = page.getByRole('button', { name: 'Model identifier', exact: true });
  const dialog = page.getByRole('dialog', { name: 'Select model', exact: true });
  await trigger.click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await dialog.getByRole('textbox').fill('retry');
  await dialog.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(dialog.getByRole('textbox')).toHaveValue('retry');
  await dialog.getByRole('button', { name: 'retry-model', exact: true }).click();
  await page.getByLabel('API base URL', { exact: true }).fill(`${endpoint}/changed`);
  await page.getByLabel('API key', { exact: true }).fill('synthetic-new-key');
  await trigger.click();
  await expect(dialog.getByRole('button', { name: 'changed-model', exact: true })).toBeVisible();
  expect(calls).toEqual([{ endpoint }, { endpoint }, { endpoint: `${endpoint}/changed`, apiKey: 'synthetic-new-key' }]);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(trigger).toHaveText('retry-model');
});

test('a cancelled discovery cannot replace a reopened picker and missing models cannot be saved', async ({ page }) => {
  await editor(page);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Select a model or enter its identifier before saving.');
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  let settled: () => void = () => {};
  const firstSettled = new Promise<void>(resolve => { settled = resolve; });
  let calls = 0;
  await page.route('**/api/models', async route => {
    calls++;
    if (calls === 1) {
      await gate;
      try { await route.fulfill({ json: { models: ['late-old-model'] } }); }
      finally { settled(); }
    } else await route.fulfill({ json: { models: ['current-model'] } });
  });
  const trigger = page.getByRole('button', { name: 'Model identifier', exact: true });
  const dialog = page.getByRole('dialog', { name: 'Select model', exact: true });
  await trigger.click();
  await expect(dialog.getByRole('status')).toHaveText('Loading models…');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await trigger.click();
  await expect(dialog.getByRole('button', { name: 'current-model', exact: true })).toBeVisible();
  release();
  await firstSettled;
  await expect(dialog.locator('[data-model]')).toHaveText(['current-model']);
  await dialog.getByRole('button', { name: 'current-model', exact: true }).click();
  await expect(trigger).toHaveText('current-model');
});

test('saved-key discovery sends only the Connection identity; removal overrides it explicitly', async ({ page }) => {
  const endpoint = await editor(page);
  await page.getByLabel('API key', { exact: true }).fill('synthetic-saved-secret');
  await page.getByRole('button', { name: 'Model identifier', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Select model', exact: true });
  await dialog.getByRole('button', { name: 'synthetic-roleplay', exact: true }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('article').getByRole('heading').getByRole('button').click();
  await expect(page.getByLabel('API key', { exact: true })).toHaveValue('');
  const calls: Record<string, unknown>[] = [];
  await page.route('**/api/models', async route => {
    calls.push(route.request().postDataJSON());
    await route.continue();
  });
  const trigger = page.getByRole('button', { name: 'Model identifier', exact: true });
  await trigger.click();
  await expect(dialog.getByRole('button', { name: 'synthetic-roleplay', exact: true })).toBeVisible();
  expect(calls[0]).toEqual({ endpoint, connectionId: expect.any(String) });
  expect(await page.locator('body').textContent()).not.toContain('synthetic-saved-secret');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByLabel('Remove the saved API key', { exact: true }).check();
  await trigger.click();
  await expect(dialog.getByRole('button', { name: 'synthetic-roleplay', exact: true })).toBeVisible();
  expect(calls[1]).toEqual({ ...calls[0], apiKey: '' });
});

test('Russian picker preserves literal model identifiers and rejects malformed discovery data safely', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await editor(page);
  await page.evaluate(() => localStorage.setItem('ore-interface-language', 'ru'));
  await page.reload();
  await page.getByRole('button', { name: 'Библиотека', exact: true }).click();
  await page.getByRole('button', { name: 'Подключения', exact: true }).click();
  await page.getByRole('button', { name: 'Новое подключение', exact: true }).click();
  await page.route('**/api/models', route => route.fulfill({ json: { models: ['valid-model', 42] } }));
  await page.getByRole('button', { name: 'Идентификатор модели', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Выберите модель', exact: true });
  await expect(dialog.getByRole('alert')).toContainText('Не удалось получить модели');
  await expect(dialog.getByRole('button', { name: 'Подтвердить', exact: true })).toBeDisabled();
  await dialog.getByRole('textbox', { name: 'Поиск или идентификатор модели', exact: true }).fill('Literal/provider-model');
  await page.screenshot({ path: testInfo.outputPath('picker-russian-error.png') });
  await dialog.getByRole('button', { name: 'Подтвердить', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Идентификатор модели', exact: true })).toHaveText('Literal/provider-model');
});
