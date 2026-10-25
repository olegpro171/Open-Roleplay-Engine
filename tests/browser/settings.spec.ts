import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { appearanceStatusSchema, type AppearanceStatus } from '../../src/shared/appearance';

const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

for (const width of [1440, 390]) test(`settings save feedback stays quiet until one second and recovers at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 850 });
  const session = await page.request.get('/api/session').then(response => response.json());
  await page.goto('/');
  await page.getByLabel('Owner password').fill('browser-synthetic-password');
  await page.getByRole('button', { name: session.setupRequired ? 'Create owner account' : 'Sign in', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible();
  const path = '/api/application/appearance';
  const read = async () => appearanceStatusSchema.parse(await page.request.get(path).then(response => response.json()));
  const initial = await read();
  await page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'Chat appearance', exact: true }).click();
  const section = page.getByRole('region', { name: 'Chat appearance', exact: true });
  const checkbox = section.getByRole('checkbox', { name: 'Display character picture in chat.', exact: true });
  await expect(checkbox).toBeEnabled();
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-01-01T00:01:00Z'));
  let release = () => {};
  let gate: Promise<void>;
  const hold = () => { gate = new Promise<void>(resolve => { release = resolve; }); };
  let fail = false;
  let writes = 0;
  hold();
  await page.route(`**${path}`, async route => {
    if (route.request().method() !== 'PUT') return route.continue();
    writes++;
    const shouldFail = fail;
    await gate;
    if (shouldFail) await route.fulfill({ status: 503, json: { message: 'Synthetic save failure' } });
    else await route.continue();
  });
  try {
    const before = await checkbox.boundingBox();
    await checkbox.setChecked(!initial.settings.displayCharacterPicture);
    await expect.poll(() => writes).toBe(1);
    await page.clock.runFor(999);
    await expect(section.getByRole('status')).toHaveCount(0);
    await expect(section.getByRole('alert')).toHaveCount(0);
    expect(await checkbox.boundingBox()).toEqual(before);
    release();
    await expect.poll(async () => (await read()).settings.displayCharacterPicture).toBe(!initial.settings.displayCharacterPicture);
    await page.clock.runFor(1);
    await expect(section.getByRole('alert')).toHaveCount(0);

    hold();
    await checkbox.setChecked(initial.settings.displayCharacterPicture);
    await expect.poll(() => writes).toBe(2);
    await page.clock.runFor(999);
    await expect(section.getByRole('alert')).toHaveCount(0);
    await page.clock.runFor(1);
    await expect(section.getByRole('alert')).toContainText('Saving settings is taking longer than expected');
    await page.screenshot({ path: testInfo.outputPath('slow-settings-save.png') });
    release();
    await expect(section.getByRole('alert')).toHaveCount(0);
    expect((await read()).settings.displayCharacterPicture).toBe(initial.settings.displayCharacterPicture);

    hold();
    fail = true;
    await checkbox.setChecked(!initial.settings.displayCharacterPicture);
    await expect.poll(() => writes).toBe(3);
    release();
    await expect(section.getByRole('alert')).toContainText('Synthetic save failure');
    await expect(checkbox).toBeChecked({ checked: !initial.settings.displayCharacterPicture });
    expect((await read()).settings.displayCharacterPicture).toBe(initial.settings.displayCharacterPicture);
    hold();
    fail = false;
    await section.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect.poll(() => writes).toBe(4);
    await page.clock.runFor(999);
    await expect(section.getByRole('alert')).toHaveCount(0);
    release();
    await expect.poll(async () => (await read()).settings.displayCharacterPicture).toBe(!initial.settings.displayCharacterPicture);
    await page.clock.runFor(1001);
    await expect(section.getByRole('alert')).toHaveCount(0);
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
    const current = await read();
    const restored = await page.request.put(path, { headers: { Origin: 'http://127.0.0.1:4173' }, data: { revision: current.revision, settings: initial.settings } });
    expect(restored.ok()).toBe(true);
  }
});

for (const width of [1440, 820, 390, 320]) {
  test(`application settings shares the workspace and scrolls categories at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 700 });
    const session = await page.request.get('/api/session').then(response => response.json());
    await page.goto('/');
    await page.getByLabel('Owner password').fill('browser-synthetic-password');
    await page.getByRole('button', { name: session.setupRequired ? 'Create owner account' : 'Sign in', exact: true }).click();
    const navigation = page.getByRole('navigation', { name: 'Workspace' });
    await navigation.getByRole('button', { name: 'Libraries', exact: true }).click();
    const librarySidebar = await page.locator(width > 800 ? '.library-sidebar' : '.library-navigation').boundingBox();
    const libraryContent = await page.locator('.library-panel').boundingBox();
    await navigation.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(navigation.getByRole('button', { name: 'Settings', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('heading', { name: 'Data backup', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /^(Save (chat|LAN)|Reload )/ })).toHaveCount(0);
    const categories = page.getByRole('navigation', { name: 'Settings categories' });
    const content = page.locator('.settings-panel');
    const sidebarBox = await page.locator('.library-sidebar').boundingBox();
    const contentBox = await content.boundingBox();
    if (!librarySidebar || !libraryContent || !sidebarBox || !contentBox) throw new Error('Missing workspace columns');
    expect(sidebarBox.x).toBe(librarySidebar.x);
    expect(sidebarBox.width).toBe(librarySidebar.width);
    expect(contentBox.x).toBe(libraryContent.x);
    expect(contentBox.width).toBe(libraryContent.width);
    if (width > 800) expect(contentBox.x).toBeGreaterThanOrEqual(sidebarBox.x + sidebarBox.width);
    else expect(contentBox.y).toBeGreaterThanOrEqual(sidebarBox.y + sidebarBox.height);

    const save = await page.getByRole('button', { name: 'Save...', exact: true }).boundingBox();
    const importHeading = await page.getByRole('heading', { name: 'Import backup', exact: true }).boundingBox();
    if (!save || !importHeading) throw new Error('Missing backup controls');
    expect(save.width).toBeLessThan(200);
    expect(save.height).toBeLessThan(60);
    expect(importHeading.y).toBeGreaterThan(save.y + save.height);
    await expect(page.getByRole('button', { name: 'Select file...', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await content.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`settings-${width}.png`) });
    await categories.getByRole('button', { name: 'Chat appearance', exact: true }).click();
    await expect(page.getByLabel('Default character speech color', { exact: true })).toBeVisible();
    expect(await content.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`settings-appearance-${width}.png`) });

    const pageNode = await content.elementHandle();
    await categories.getByRole('button', { name: 'Wipe application data', exact: true }).click();
    const wipeHeading = page.getByRole('heading', { name: 'Wipe application data', exact: true });
    await expect(wipeHeading).toBeFocused();
    await expect(wipeHeading).toBeInViewport();
    await expect(page.getByRole('region', { name: 'Data backup', exact: true })).toHaveCount(1);
    expect(await pageNode?.evaluate(node => node.isConnected)).toBe(true);
    await expect(navigation).toBeInViewport();
    await categories.getByRole('button', { name: 'About ORE', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'About ORE', exact: true })).toBeFocused();
    await expect(page.getByText(commit, { exact: true })).toBeVisible();
    await expect(page.locator('.about-version dt')).toHaveText(['Commit', 'Database schema', 'Node runtime', 'Platform']);
    expect(await content.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`about-${width}.png`) });
    await categories.getByRole('button', { name: 'Data backup', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Data backup', exact: true })).toBeFocused();
    await expect(page.getByRole('button', { name: 'Save...', exact: true })).toBeInViewport();
  });
}

test('rapid settings edits survive delayed saves and leaving or reopening Settings', async ({ page }) => {
  const session = await page.request.get('/api/session').then(response => response.json());
  await page.goto('/');
  await page.getByLabel('Owner password').fill('browser-synthetic-password');
  await page.getByRole('button', { name: session.setupRequired ? 'Create owner account' : 'Sign in', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible();
  await page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Libraries', exact: true }).click();
  await expect(page.getByRole('button', { name: 'New chat', exact: true })).toBeVisible();
  const path = '/api/application/appearance';
  const initial = appearanceStatusSchema.parse(await page.request.get(path).then(response => response.json()));
  const navigation = page.getByRole('navigation', { name: 'Workspace' });
  await navigation.getByRole('button', { name: 'Settings', exact: true }).click();
  const section = page.getByRole('region', { name: 'Chat appearance', exact: true });
  const checkbox = section.getByRole('checkbox', { name: 'Display character picture in chat.', exact: true });
  const slider = section.getByRole('slider', { name: 'Text scale' });
  const scale = initial.settings.chatTextScale === 120 ? 90 : 120;
  let release: () => void = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  const writes: AppearanceStatus[] = [];
  await page.route(`**${path}`, async route => {
    if (route.request().method() === 'PUT') {
      writes.push(appearanceStatusSchema.parse(route.request().postDataJSON()));
      if (writes.length === 1) await held;
    }
    await route.continue();
  });
  try {
    await checkbox.setChecked(!initial.settings.displayCharacterPicture);
    await expect.poll(() => writes.length).toBe(1);
    await slider.focus();
    await slider.press(scale === 120 ? 'End' : 'Home');
    await expect(slider).toHaveValue(String(scale));
    await navigation.getByRole('button', { name: 'Libraries', exact: true }).click();
    await navigation.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(checkbox).toBeChecked({ checked: !initial.settings.displayCharacterPicture });
    await expect(slider).toHaveValue(String(scale));
    await checkbox.setChecked(initial.settings.displayCharacterPicture);
    await navigation.getByRole('button', { name: 'Libraries', exact: true }).click();
    release();
    await expect.poll(async () => appearanceStatusSchema.parse(await page.request.get(path).then(response => response.json())).settings)
      .toEqual({ ...initial.settings, chatTextScale: scale });
    expect(writes).toHaveLength(2);
    expect(writes[1]?.revision).toBe(initial.revision + 1);
    await page.reload();
    await navigation.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(slider).toHaveValue(String(scale));
    await expect(checkbox).toBeChecked({ checked: initial.settings.displayCharacterPicture });
  } finally {
    release();
    await page.unroute(`**${path}`);
    const current = appearanceStatusSchema.parse(await page.request.get(path).then(response => response.json()));
    const restored = await page.request.put(path, { headers: { Origin: 'http://127.0.0.1:4173' }, data: { revision: current.revision, settings: initial.settings } });
    expect(restored.ok()).toBe(true);
  }
});

for (const width of [1440, 390]) test(`app color choices save while the picker is open and invalid hex stays local at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 850 });
  const session = await page.request.get('/api/session').then(response => response.json());
  await page.goto('/');
  await page.getByLabel('Owner password').fill('browser-synthetic-password');
  await page.getByRole('button', { name: session.setupRequired ? 'Create owner account' : 'Sign in', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible();
  await page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Libraries', exact: true }).click();
  await expect(page.getByRole('button', { name: 'New chat', exact: true })).toBeVisible();
  const path = '/api/application/appearance';
  const appearance = async () => appearanceStatusSchema.parse(await page.request.get(path).then(response => response.json()));
  const initial = await appearance();
  await page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Settings', exact: true }).click();
  const writes: AppearanceStatus[] = [];
  page.on('request', request => {
    if (request.url().endsWith(path) && request.method() === 'PUT') writes.push(appearanceStatusSchema.parse(request.postDataJSON()));
  });
  try {
    await page.getByRole('button', { name: 'Default character speech color', exact: true }).click();
    const picker = page.getByRole('dialog', { name: 'Choose color', exact: true });
    const hex = picker.getByRole('textbox', { name: 'Hex color', exact: true });
    await expect(picker.getByRole('button', { name: 'Apply color', exact: true })).toHaveCount(0);
    await hex.fill('#zz');
    await expect(hex).toHaveAttribute('aria-invalid', 'true');
    await expect(picker.getByRole('alert')).toContainText('six-digit hex color');
    expect(writes).toHaveLength(0);
    expect((await appearance()).settings).toEqual(initial.settings);
    await picker.getByRole('button', { name: 'Coral', exact: true }).click();
    await expect.poll(async () => (await appearance()).settings.characterSpeechColor).toBe('#f07878');
    await hex.fill('#ab12cd');
    await expect.poll(async () => (await appearance()).settings.characterSpeechColor).toBe('#ab12cd');
    const hue = picker.getByRole('slider', { name: 'Hue', exact: true });
    await hue.focus();
    await hue.press('ArrowRight');
    await expect.poll(async () => (await appearance()).settings.characterSpeechColor).not.toBe('#ab12cd');
    await expect(page.getByRole('status').filter({ hasText: 'Saving changes' })).toHaveCount(0);
    const saved = await appearance();
    await expect(picker).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('instant-color-picker.png') });
    expect(await picker.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    await picker.press('Escape');
    await expect(picker).toHaveCount(0);
    expect((await appearance()).settings).toEqual(saved.settings);
    await expect(page.getByRole('button', { name: 'Default character speech color', exact: true })).toContainText(saved.settings.characterSpeechColor.toUpperCase());
    expect(writes).toHaveLength(3);
  } finally {
    const current = await appearance();
    const restored = await page.request.put(path, { headers: { Origin: 'http://127.0.0.1:4173' }, data: { revision: current.revision, settings: initial.settings } });
    expect(restored.ok()).toBe(true);
  }
});
