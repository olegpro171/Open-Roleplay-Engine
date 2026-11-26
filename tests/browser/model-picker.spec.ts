import { selectLibraryCategory } from './library-card-helpers';
import { expect, type Page } from '@playwright/test';
import { test } from './isolated-app';
import { appearanceStatusSchema, themeSchema } from '../../src/shared/appearance';
import type { LibrarySnapshot } from '../../src/shared/library';

async function editor(page: Page) {
  await page.goto('/');
  await page.getByLabel('Owner password').fill('browser-synthetic-password');
  await page.getByRole('button', { name: 'Create owner account', exact: true }).click();
  await page.getByRole('button', { name: 'Libraries', exact: true }).click();
  await selectLibraryCategory(page, 'Connections');
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
          return route.fulfill({ json: { models: models.map(id => ({ id })) } });
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
        if (width === 390) await page.touchscreen.tap(2, 2);
        else if (width === 1280) await page.mouse.click(2, 2);
        else await search.press('Escape');
        await expect(dialog).toHaveCount(0);
        await expect(trigger).toHaveText(models[1]);
        if (width === 390 || width === 1280) await expect(trigger).toBeFocused();
        else await expect(trigger).not.toBeFocused();
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
    if (calls === 1) { await gate; await route.fulfill({ json: { models: [{ id: 'late-model' }] } }); }
    else if (calls === 2) await route.fulfill({ status: 502, json: { message: 'Synthetic model discovery failure' } });
    else await route.fulfill({ json: { models: calls === 3 ? [] : [{ id: 'listed-model' }] } });
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
  await page.getByRole('article').getByRole('heading').getByRole('button').click();
  await expect(page.getByLabel('Model context window', { exact: true })).toHaveAccessibleDescription('Provider limit unknown');
});

test('retries retain the query and new openings use the latest endpoint/key without stale results', async ({ page }) => {
  const endpoint = await editor(page);
  const calls: unknown[] = [];
  await page.route('**/api/models', route => {
    calls.push(route.request().postDataJSON());
    return route.fulfill(calls.length === 1
      ? { status: 502, json: { message: 'Synthetic failure' } }
      : { json: { models: [{ id: calls.length === 2 ? 'retry-model' : 'changed-model' }] } });
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
  await expect(page.getByRole('alert')).toHaveText('Select a model or enter its identifier.');
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  let settled: () => void = () => {};
  const firstSettled = new Promise<void>(resolve => { settled = resolve; });
  let calls = 0;
  await page.route('**/api/models', async route => {
    calls++;
    if (calls === 1) {
      await gate;
      try { await route.fulfill({ json: { models: [{ id: 'late-old-model' }] } }); }
      finally { settled(); }
    } else await route.fulfill({ json: { models: [{ id: 'current-model' }] } });
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
  await expect(page.getByRole('group', { name: 'Новое подключение', exact: true })).toBeVisible();
  await page.route('**/api/models', route => route.fulfill({ json: { models: [{ id: 'valid-model' }, 42] } }));
  await page.getByRole('button', { name: 'Идентификатор модели', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Выберите модель', exact: true });
  await expect(dialog.getByRole('alert')).toContainText('Не удалось получить модели');
  await expect(dialog.getByRole('button', { name: 'Подтвердить', exact: true })).toBeDisabled();
  await dialog.getByRole('textbox', { name: 'Поиск или идентификатор модели', exact: true }).fill('Literal/provider-model');
  await page.screenshot({ path: testInfo.outputPath('picker-russian-error.png') });
  await dialog.getByRole('button', { name: 'Подтвердить', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Идентификатор модели', exact: true })).toHaveText('Literal/provider-model');
});

async function readConnections(page: Page) {
  const response = await page.request.get('/api/library');
  expect(response.ok()).toBe(true);
  return (await response.json() as LibrarySnapshot).connections;
}

async function chooseModel(page: Page, id: string) {
  await page.getByRole('button', { name: 'Model identifier', exact: true }).click();
  await page.getByRole('dialog', { name: 'Select model', exact: true }).getByRole('button', { name: id, exact: true }).click();
}

test('fills the total window for new selections and preserves a manual edit when reselecting the same model', async ({ page }) => {
  const endpoint = await editor(page);
  const window = page.getByLabel('Model context window', { exact: true });
  const reserved = page.getByLabel('Reserved output tokens', { exact: true });
  await expect(window).toHaveValue('128000');
  await expect(window).toHaveAccessibleDescription('');
  await chooseModel(page, 'another-model');
  await expect(window).toHaveValue('16384');
  await expect(window).toHaveAccessibleDescription('Reported by the provider');
  await expect(reserved).toHaveValue('8196');
  await chooseModel(page, 'synthetic-roleplay');
  await expect(window).toHaveValue('128000');
  await expect(window).toHaveAccessibleDescription('Default · provider limit unknown');
  await chooseModel(page, 'another-model');
  await expect(window).toHaveValue('16384');
  await window.fill('128000');
  await expect(window).toHaveValue('128000');
  await expect(window).toHaveAccessibleDescription('Manually set');
  page.once('dialog', dialog => dialog.accept());
  await page.reload();
  await page.getByRole('button', { name: 'Libraries', exact: true }).click();
  await expect(window).toHaveValue('128000');
  await expect(window).toHaveAccessibleDescription('Manually set');
  await chooseModel(page, 'another-model');
  await expect(window).toHaveValue('128000');
  await expect(window).toHaveAccessibleDescription('Manually set');
  const restore = page.getByRole('button', { name: 'Use 16,384', exact: true });
  await expect(restore).toBeVisible();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const card = page.getByRole('article').getByRole('heading').getByRole('button');
  await expect(page.getByRole('article')).toContainText('another-model');
  const saved = await readConnections(page);
  expect(saved).toMatchObject([{ contextWindow: 128_000, maxOutputTokens: 8196,
    modelWindowReport: { endpoint, model: 'another-model', tokens: 16_384 } }]);
  const discoveryCalls: string[] = [];
  await page.route('**/api/models', route => {
    discoveryCalls.push(route.request().url());
    return route.abort();
  });
  await page.reload();
  await page.getByRole('button', { name: 'Libraries', exact: true }).click();
  await card.click();
  await expect(window).toHaveValue('128000');
  await expect(window).toHaveAccessibleDescription('Manually set');
  await restore.click();
  await expect(window).toHaveValue('16384');
  await expect(window).toHaveAccessibleDescription('Reported by the provider');
  await expect(restore).toBeHidden();
  expect(discoveryCalls).toEqual([]);
  expect(await readConnections(page)).toEqual(saved);
});

test('existing Connections apply reported windows to the draft and resolve conflicting output before Save', async ({ page }) => {
  const endpoint = await editor(page);
  await chooseModel(page, 'another-model');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const edit = page.getByRole('article').getByRole('heading').getByRole('button');
  await edit.click();
  const before = await readConnections(page);
  const window = page.getByLabel('Model context window', { exact: true });
  const reserved = page.getByLabel('Reserved output tokens', { exact: true });
  const trigger = page.getByRole('button', { name: 'Model identifier', exact: true });
  const picker = page.getByRole('dialog', { name: 'Select model', exact: true });
  const apply = page.getByRole('button', { name: /^Use [\d,]+$/ });
  const save = page.getByRole('button', { name: 'Save', exact: true });

  await expect(window).toHaveAccessibleDescription('Reported by the provider');
  await expect(apply).toBeHidden();
  await window.fill('1');
  await expect(reserved).toHaveAccessibleDescription('Set a context window above 1.');
  await expect(save).toBeDisabled();
  await window.fill('16384');
  await page.route('**/api/models', route => route.fulfill({ json: { models: [
    { id: 'another-model', contextWindow: 8196 }, { id: 'other-model', contextWindow: 32_768 },
  ] } }));
  await trigger.click();
  await expect(picker.getByRole('button', { name: 'another-model', exact: true })).toBeVisible();
  await picker.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(window).toHaveValue('16384');
  await expect(window).toHaveAccessibleDescription('Manually set');
  await expect(apply).toHaveAccessibleName('Use 8,196');
  expect(await readConnections(page)).toEqual(before);

  await apply.click();
  await expect(window).toHaveValue('8196');
  await expect(reserved).toHaveValue('8196');
  await expect(reserved).toHaveAccessibleDescription('Set reserve below 8,196.');
  await expect(save).toBeDisabled();
  expect(await readConnections(page)).toEqual(before);

  await chooseModel(page, 'other-model');
  await expect(window).toHaveValue('16384');
  await expect(apply).toHaveAccessibleName('Use 32,768');
  await apply.click();
  await expect(window).toHaveValue('32768');
  const endpointField = page.getByLabel('API base URL', { exact: true });
  await endpointField.fill(`${endpoint}/changed`);
  await expect(window).toHaveValue('16384');
  await expect(window).toHaveAccessibleDescription('Provider limit unknown');
  await expect(apply).toBeHidden();
  await endpointField.fill(endpoint);
  await expect(apply).toBeHidden();

  await chooseModel(page, 'another-model');
  await apply.click();
  await reserved.fill('2048');
  await expect(save).toBeEnabled();
  await expect(reserved).not.toHaveAttribute('aria-invalid');
  expect(await readConnections(page)).toEqual(before);
  await save.click();
  await expect(edit).toBeVisible();
  expect(await readConnections(page)).toMatchObject([{ model: 'another-model', contextWindow: 8196, maxOutputTokens: 2048 }]);
  await edit.click();
  await expect(window).toHaveAccessibleDescription('Reported by the provider');
  await expect(apply).toBeHidden();
});

test('ignores a delayed window after the model or endpoint changes', async ({ page }) => {
  const endpoint = await editor(page);
  const endpointField = page.getByLabel('API base URL', { exact: true });
  const trigger = page.getByRole('button', { name: 'Model identifier', exact: true });
  const picker = page.getByRole('dialog', { name: 'Select model', exact: true });
  const window = page.getByLabel('Model context window', { exact: true });
  let release = () => {};
  const delayed = new Promise<void>(resolve => { release = resolve; });
  let finish = () => {};
  const settled = new Promise<void>(resolve => { finish = resolve; });
  await page.route('**/api/models', async route => {
    if (route.request().postDataJSON().endpoint !== endpoint) {
      await route.fulfill({ json: { models: [{ id: 'new-model', contextWindow: 64_000 }] } });
      return;
    }
    await delayed;
    try {
      await route.fulfill({ json: { models: [{ id: 'new-model', contextWindow: 32_000 }] } });
    } finally { finish(); }
  });
  await trigger.click();
  await expect(picker.getByRole('status')).toHaveText('Loading models…');
  await picker.getByRole('textbox').fill('new-model');
  await picker.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(window).toHaveValue('128000');
  await endpointField.fill(`${endpoint}/changed`);
  await chooseModel(page, 'new-model');
  await expect(window).toHaveValue('64000');
  release();
  await settled;
  await expect(window).toHaveValue('64000');
  await expect(window).toHaveAccessibleDescription('Reported by the provider');
  await expect(page.getByTitle('Use reported window', { exact: true })).toBeHidden();

  await endpointField.fill(endpoint);
  await expect(window).toHaveValue('128000');
  await expect(window).toHaveAccessibleDescription('Default · provider limit unknown');
  await expect(page.getByTitle('Use reported window', { exact: true })).toBeHidden();
});

for (const language of ['en', 'ru']) {
  test(`context window sources and conflict fit the editor in ${language}`, async ({ page, browserApp }, testInfo) => {
    await editor(page);
    const russian = language === 'ru';
    if (russian) {
      await page.evaluate(() => localStorage.setItem('ore-interface-language', 'ru'));
      page.once('dialog', dialog => dialog.accept());
      await page.reload();
      await page.getByRole('button', { name: 'Библиотека', exact: true }).click();
    }
    const window = page.getByLabel(russian ? 'Окно контекста модели' : 'Model context window', { exact: true });
    const reserve = page.getByLabel(russian ? 'Резерв выходных токенов' : 'Reserved output tokens', { exact: true });
    const trigger = page.getByRole('button', { name: russian ? 'Идентификатор модели' : 'Model identifier', exact: true });
    const picker = page.getByRole('dialog', { name: russian ? 'Выберите модель' : 'Select model', exact: true });
    const apply = page.getByRole('button', { name: russian ? /^Вернуть 4\s096$/ : 'Use 4,096' });
    const diagnostics = page.getByRole('heading', { name: russian ? 'Проверка подключения' : 'Connection diagnostics', exact: true });
    const diagnosticsPosition = () => diagnostics.evaluate(heading => {
      if (!(heading instanceof HTMLElement)) throw new Error('Expected the diagnostics heading');
      return heading.offsetTop;
    });
    await expect(window).toHaveAccessibleDescription('');
    const blankPosition = await diagnosticsPosition();
    await page.route('**/api/models', route => route.fulfill({ json: { models: [{ id: 'small-window', contextWindow: 4096 }] } }));
    await trigger.click();
    await picker.getByRole('button', { name: 'small-window', exact: true }).click();
    await expect(window).toHaveAccessibleDescription(russian ? 'По данным провайдера' : 'Reported by the provider');
    await expect(reserve).toHaveAccessibleDescription(russian ? /Задайте резерв меньше/ : /Set reserve below/);
    expect(await diagnosticsPosition()).toBe(blankPosition);
    await window.fill('16384');
    await expect(window).toHaveValue('16384');
    await expect(reserve).not.toHaveAttribute('aria-invalid');
    await expect(window).toHaveAccessibleDescription(russian ? 'Установлено вручную' : 'Manually set');
    await expect(apply).toBeVisible();

    for (const theme of themeSchema.options) {
      const appearance = appearanceStatusSchema.parse(await page.request.get('/api/application/appearance').then(response => response.json()));
      const saved = await page.request.put('/api/application/appearance', {
        headers: { Origin: browserApp.url }, data: { revision: appearance.revision, settings: { ...appearance.settings, theme } },
      });
      expect(saved.ok()).toBe(true);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      for (const width of [1280, 1160, 1148, 801, 800, 390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        for (const control of [window, reserve, apply]) {
          const bounds = await control.boundingBox();
          if (!bounds) throw new Error('Missing context window control');
          expect(bounds.x).toBeGreaterThanOrEqual(0);
          expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
        }
        const pairs = await Promise.all([window, reserve].map(control => control.evaluate(input => {
          if (!(input instanceof HTMLInputElement) || !input.labels?.[0]) throw new Error('Expected a labeled token limit');
          const range = document.createRange();
          range.selectNodeContents(input.labels[0]);
          const label = range.getBoundingClientRect(), box = input.getBoundingClientRect();
          const row = input.parentElement?.getBoundingClientRect();
          if (!row) throw new Error('Missing token limits grid');
          return {
            gap: box.left - label.right,
            centerOffset: (box.top + box.bottom - label.top - label.bottom) / 2,
            left: box.left,
            rightInset: row.right - box.right,
          };
        })));
        expect(pairs[0].left).toBe(pairs[1].left);
        if (width >= 1160) {
          expect(Math.min(...pairs.map(pair => pair.gap))).toBeLessThanOrEqual(16);
        } else {
          for (const pair of pairs) expect(Math.abs(pair.rightInset)).toBeLessThan(1);
        }
        for (const pair of pairs) {
          expect(pair.gap).toBeGreaterThanOrEqual(0);
          expect(Math.abs(pair.centerOffset)).toBeLessThan(2);
        }
        const status = await apply.evaluate(button => {
          const label = button.previousElementSibling;
          const row = button.parentElement;
          const field = row?.previousElementSibling;
          if (!label || !(field instanceof HTMLInputElement)) throw new Error('Expected the context window and its source');
          const range = document.createRange();
          range.selectNodeContents(label);
          const labelText = range.getBoundingClientRect();
          range.selectNodeContents(button);
          const linkText = range.getBoundingClientRect();
          return {
            gap: labelText.top - field.getBoundingClientRect().bottom,
            linkFollowsSource: (linkText.left >= labelText.right && Math.abs(linkText.top - labelText.top) < 1)
              || linkText.top >= labelText.bottom,
          };
        });
        expect(status.gap).toBeGreaterThanOrEqual(0);
        expect(status.gap).toBeLessThanOrEqual(8);
        expect(status.linkFollowsSource).toBe(true);
        if (width !== 1280 && width !== 390) continue;
        const beforeApply = await diagnosticsPosition();
        await window.evaluate(input => input.scrollIntoView({ block: 'center' }));
        await page.screenshot({ path: testInfo.outputPath(`proposal-${theme}-${width}.png`), animations: 'disabled' });
        await apply.click();
        await expect(reserve).toHaveAttribute('aria-invalid', 'true');
        expect(await diagnosticsPosition()).toBe(beforeApply);
        await window.evaluate(input => input.scrollIntoView({ block: 'center' }));
        await page.screenshot({ path: testInfo.outputPath(`conflict-${theme}-${width}.png`), animations: 'disabled' });
        await window.fill('16384');
        await expect(reserve).not.toHaveAttribute('aria-invalid');
      }
    }
  });
}
