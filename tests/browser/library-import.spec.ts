import { expect, test, type Page } from '@playwright/test';
import { defaultContextPreset, type ContextPreset } from '../../src/shared/context';
import { defaultPrompt, type LibrarySnapshot } from '../../src/shared/library';
import { appearanceStatusSchema } from '../../src/shared/appearance';

async function login(page: Page) {
  const session = await page.request.get('/api/session').then(response => response.json());
  await page.goto('/');
  await page.getByLabel('Owner password').fill('browser-synthetic-password');
  await page.getByRole('button', { name: session.setupRequired ? 'Create owner account' : 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: 'Libraries', exact: true }).click();
}

for (const width of [1280, 801]) {
  test(`Library import popup supports closing, browsing and dropping at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await login(page);
    let chooserCount = 0;
    page.on('filechooser', () => chooserCount++);
    for (const category of ['Characters', 'Personas', 'Lorebooks', 'Prompts', 'Context presets', 'Connections']) {
      await page.getByRole('navigation', { name: 'Library categories' }).getByRole('button', { name: category, exact: true }).click();
      const trigger = page.getByRole('group', { name: 'Library actions', exact: true }).getByRole('button').nth(1);
      await trigger.click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('heading')).toBeFocused();
      await expect(dialog.getByRole('button', { name: 'Drop file here or click to browse' })).toBeVisible();
      expect(chooserCount).toBe(0);
      if (category === 'Characters') await page.screenshot({ path: testInfo.outputPath(`import-${width}.png`) });
      await dialog.getByRole('button', { name: 'Close import' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toBeFocused();
      await trigger.press('Enter');
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toBeFocused();
    }
    await page.getByRole('button', { name: 'Prompts', exact: true }).click();
    await page.getByRole('group', { name: 'Library actions' }).getByRole('button').nth(1).click();
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Drop file here or click to browse' }).press('Enter');
    await (await chooser).setFiles({ name: 'prompt.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ ...defaultPrompt, name: `Popup browse ${width}` })) });
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: `Popup browse ${width}`, exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Lorebooks', exact: true }).click();
    const before = await page.request.get('/api/library').then(response => response.json());
    await page.getByRole('button', { name: 'Import lorebook', exact: true }).click();
    const dropArea = page.getByRole('button', { name: 'Drop file here or click to browse' });
    const files = await page.evaluateHandle(() => {
      const data = new DataTransfer();
      data.items.add(new File([JSON.stringify({ name: 'Popup dropped book', entries: [] })], 'book.json', { type: 'application/json' }));
      data.items.add(new File(['{}'], 'extra.json', { type: 'application/json' }));
      return data;
    });
    await dropArea.dispatchEvent('drop', { dataTransfer: files });
    await expect(page.getByRole('alert')).toHaveText('Choose one file at a time.');
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.evaluate(data => data.items.remove(1), files);
    await dropArea.dispatchEvent('dragenter', { dataTransfer: files });
    await dropArea.dispatchEvent('drop', { dataTransfer: files });
    await files.dispose();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Review Popup dropped book', exact: true })).toBeVisible();
    const after = await page.request.get('/api/library').then(response => response.json());
    expect(after.lorebooks).toHaveLength(before.lorebooks.length);
  });
}

for (const width of [800, 390]) {
  test(`phone Library import opens the picker directly at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await login(page);
    for (const category of ['Characters', 'Personas', 'Lorebooks', 'Prompts', 'Context presets', 'Connections']) {
      await page.getByRole('navigation', { name: 'Library categories' }).getByRole('button', { name: category, exact: true }).click();
      const trigger = page.getByRole('group', { name: 'Library actions', exact: true }).getByRole('button').nth(1);
      const chooser = page.waitForEvent('filechooser', { timeout: 2000 });
      await trigger.click();
      await (await chooser).setFiles([]);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(trigger).toBeEnabled();
    }
    await page.getByRole('button', { name: 'Prompts', exact: true }).click();
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('group', { name: 'Library actions' }).getByRole('button').nth(1).click();
    await (await chooser).setFiles({ name: 'prompt.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ ...defaultPrompt, name: `Phone picker ${width}` })) });
    await expect(page.getByRole('heading', { name: `Phone picker ${width}`, exact: true })).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.setViewportSize({ width: 1280, height: 844 });
    await page.getByRole('group', { name: 'Library actions' }).getByRole('button').nth(1).click();
    await expect(page.getByRole('dialog')).toBeVisible();
  });
}

test('warns after a portable context preset falls back and keeps valid Connection references', async ({ page }, testInfo) => {
  await login(page);
  const read = async () => page.request.get('/api/library').then(response => response.json() as Promise<LibrarySnapshot>);
  const headers = { Origin: new URL(page.url()).origin };
  const before = await read();
  const { endpoint } = await page.request.get('/__test/endpoint').then(response => response.json());
  const created = await page.request.post('/api/library', { headers, data: {
    revision: before.revision, kind: 'connections',
    data: { endpoint, name: 'Preset import Connection', model: 'synthetic', contextWindow: 20_000, maxOutputTokens: 512, customParameters: {} },
  } });
  expect(created.ok(), await created.text()).toBe(true);
  const { id: connectionId } = await created.json();
  await page.getByRole('button', { name: 'Context presets', exact: true }).click();

  const unavailable = { ...defaultContextPreset, name: 'Portable memory preset', connectionId: 'missing-synthetic-connection', minTail: 11 };
  const normalCreate = await page.request.post('/api/library', { headers, data: { revision: (await read()).revision, kind: 'contexts', data: unavailable } });
  expect(normalCreate.ok()).toBe(false);
  async function importPreset(data: ContextPreset) {
    await page.locator('input[type="file"][accept=".json"]').setInputFiles({
      name: 'memory.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(data)),
    });
  }
  const warning = page.getByRole('dialog', { name: 'Warning', exact: true });
  const trigger = page.getByRole('button', { name: 'Import context preset', exact: true });
  const readAppearance = async () => appearanceStatusSchema.parse(await page.request.get('/api/application/appearance').then(response => response.json()));
  const originalTheme = (await readAppearance()).settings.theme;
  async function setTheme(theme: typeof originalTheme) {
    const appearance = await readAppearance();
    const themed = await page.request.put('/api/application/appearance', {
      headers, data: { revision: appearance.revision, settings: { ...appearance.settings, theme } },
    });
    expect(themed.ok(), await themed.text()).toBe(true);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  }
  try {
    for (const theme of ['dark', 'light', 'midnight-black'] as const) {
      await setTheme(theme);
      for (const width of [1280, 320]) {
        await page.setViewportSize({ width, height: 720 });
        const data = { ...unavailable, name: `Portable preset ${theme} ${width}` };
        await importPreset(data);
        await expect(warning).toContainText('it will use the chat’s Connection');
        await expect(warning.getByRole('heading')).toBeFocused();
        await expect(warning).toBeInViewport();
        await expect(warning.getByRole('button', { name: 'Dismiss', exact: true })).toBeInViewport();
        await trigger.evaluate(button => button.focus());
        await expect(warning.getByRole('heading')).toBeFocused();
        expect((await read()).contexts.find(preset => preset.name === data.name)).toMatchObject({ ...data, connectionId: null });
        await page.screenshot({ path: testInfo.outputPath(`preset-warning-${theme}-${width}.png`) });
        const escape = theme !== 'light' && width === 1280;
        if (escape) await page.keyboard.press('Escape');
        else if (width === 1280) await page.mouse.click(4, 4);
        else await warning.getByRole('button', { name: 'Dismiss', exact: true }).click();
        await expect(warning).toHaveCount(0);
        if (escape) await expect(trigger).not.toBeFocused();
        else await expect(trigger).toBeFocused();
        await expect(page.getByRole('heading', { name: data.name, exact: true })).toBeVisible();
      }
    }
  } finally {
    await setTheme(originalTheme);
  }
  await importPreset({ ...unavailable, name: 'Local memory preset', connectionId });
  await expect(page.getByRole('heading', { name: 'Local memory preset', exact: true })).toBeVisible();
  await expect(warning).toHaveCount(0);
  expect((await read()).contexts.find(preset => preset.name === 'Local memory preset')?.connectionId).toBe(connectionId);
});
