import { openLibraryActions } from './library-card-helpers';
import { expect, test, type Page } from '@playwright/test';
import sharp from 'sharp';
import { cardPng, pngChunk, quadrantPicture, pixel } from '../support/pictures';
import type { LibrarySnapshot } from '../../src/shared/library';
import { russianPack } from '../../src/shared/localization';

const fields = (name: string) => ({ name, description: 'A quiet keeper of the old observatory. '.repeat(30), personality: '', scenario: '', first_mes: '', mes_example: '', lorebookId: null });
const row = (page: Page, name: string) => page.getByRole('article').filter({ has: page.getByRole('heading', { name, exact: true }) });
async function library(page: Page): Promise<LibrarySnapshot> { return page.request.get('/api/library').then(response => response.json()); }
async function command(page: Page, url: string, data: unknown, method = 'POST') {
  const response = await page.request.fetch(`/api${url}`, { method, data, headers: { Origin: 'http://127.0.0.1:4173' } });
  expect(response.ok(), await response.text()).toBe(true); return response.json();
}
async function login(page: Page) {
  const session = await page.request.get('/api/session').then(response => response.json());
  await page.goto('/'); await page.getByLabel('Owner password').fill('browser-synthetic-password');
  await page.getByRole('button', { name: session.setupRequired ? 'Create owner account' : 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: 'Libraries', exact: true }).click(); await page.getByRole('button', { name: 'Characters', exact: true }).click();
}
async function corner(page: Page) {
  await page.getByRole('button', { name: 'Adjust crop', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Adjust picture crop' });
  await expect(dialog.getByRole('heading', { level: 2 })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dialog.getByLabel('Zoom', { exact: true })).toBeFocused();
  // Native range controls make the complete crop accessible from the keyboard.
  await dialog.getByLabel('Zoom', { exact: true }).press('End');
  await dialog.getByLabel('Horizontal position', { exact: true }).focus(); await page.keyboard.press('Home');
  await dialog.getByLabel('Vertical position', { exact: true }).focus(); await page.keyboard.press('Home');
  return dialog;
}
async function upload(page: Page, bytes: Buffer, label = 'Choose picture') {
  await page.getByLabel(label, { exact: true }).setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: bytes });
  await expect(page.getByRole('button', { name: 'Adjust crop', exact: true })).toBeEnabled();
}

test('imports a PNG card with a null lorebook and retains its picture and greetings', async ({ page }) => {
  await login(page);
  const source = { spec: 'chara_card_v2', data: { ...fields('Null book browser keeper'), first_mes: 'The keeper welcomes you.', alternate_greetings: ['The keeper waves.'], character_book: null } };
  const before = await library(page);
  await page.getByLabel('Import character', { exact: true }).setInputFiles({ name: 'null-book.png', mimeType: 'image/png', buffer: cardPng(await quadrantPicture(), source) });
  await expect(page.getByRole('heading', { name: `Review ${source.data.name}` })).toBeVisible();
  await expect(page.locator('.import-picture .cropped-picture')).toBeVisible();
  expect((await library(page)).characters).toEqual(before.characters);
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(row(page, source.data.name)).toBeVisible();
  const saved = await library(page), card = saved.characters.find(card => card.name === source.data.name);
  if (!card) throw new Error('Missing null-book character');
  expect(card.lorebookId).toBeNull();
  expect(saved.lorebooks).toEqual(before.lorebooks);
  const picture = saved.characterPictures.find(item => item.characterId === card.id);
  if (!picture) throw new Error('Missing null-book character picture');
  await expect(row(page, card.name).locator('img')).toHaveAttribute('src', picture.thumbnailUrl);
  await row(page, source.data.name).getByRole('button', { name: `${source.data.name}`, exact: true }).click();
  await expect(page.getByLabel('Greeting', { exact: true })).toHaveValue(source.data.first_mes);
  await expect(page.getByLabel('Alternate greeting 1', { exact: true })).toHaveValue(source.data.alternate_greetings[0]);
  await expect(page.getByRole('button', { name: 'Extract embedded lorebook', exact: true })).toHaveCount(0);
});

test('fits Russian color controls and centers picture actions across the editor breakpoint', async ({ page }, testInfo) => {
  await login(page);
  const name = 'Russian picture layout';
  await page.getByRole('button', { name: 'New character', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill(name);
  await upload(page, await sharp(await quadrantPicture()).resize(640, 640).png().toBuffer());
  await page.getByRole('button', { name: 'Set color', exact: true }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(row(page, name)).toBeVisible();
  // Layout qualification uses the built-in catalog even after custom-pack workflows.
  await page.route('**/api/localization/ru', route => route.fulfill({ json: russianPack }));
  await page.evaluate(() => localStorage.setItem('ore-interface-language', 'ru'));
  await page.reload();
  await page.getByRole('button', { name: 'Библиотека', exact: true }).click();
  await page.getByRole('button', { name: 'Персонажи', exact: true }).click();
  await row(page, name).getByRole('button', { name, exact: true }).click();
  const color = page.getByRole('button', { name: 'Цвет прямой речи', exact: true });
  const picture = page.getByRole('region', { name: 'Изображение персонажа', exact: true });
  for (const width of [1280, 801, 800, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await color.scrollIntoViewIfNeeded();
    expect(await color.evaluate(button => {
      const bounds = button.getBoundingClientRect();
      return [...button.children].every(child => {
        const rect = child.getBoundingClientRect();
        return rect.left >= bounds.left && rect.right <= bounds.right && child.scrollWidth <= child.clientWidth;
      });
    })).toBe(true);
    const before = await page.getByRole('button', { name: 'Сбросить цвет', exact: true }).boundingBox();
    await page.getByRole('button', { name: 'Сбросить цвет', exact: true }).click();
    const after = await page.getByRole('button', { name: 'Задать цвет', exact: true }).boundingBox();
    if (!before || !after) throw new Error('Missing speech color actions');
    expect(after.x).toBe(before.x);
    expect(after.y).toBe(before.y);
    await page.getByRole('button', { name: 'Задать цвет', exact: true }).click();
    await picture.scrollIntoViewIfNeeded();
    const square = await picture.locator('.picture-editor-square').boundingBox();
    const controls = await picture.locator('.picture-editor-controls').boundingBox();
    if (!square || !controls) throw new Error('Missing picture layout');
    if (controls.x > square.x + square.width) {
      expect(Math.abs(controls.y + controls.height / 2 - square.y - square.height / 2)).toBeLessThanOrEqual(1);
    } else {
      expect(controls.y).toBeGreaterThanOrEqual(square.y + square.height);
    }
    const uploadFont = await picture.locator('.file-button').evaluate(element => {
      const style = getComputedStyle(element);
      return { size: style.fontSize, weight: style.fontWeight };
    });
    expect(await picture.getByRole('button', { name: 'Обрезать', exact: true }).evaluate(element => {
      const style = getComputedStyle(element);
      return { size: style.fontSize, weight: style.fontWeight };
    })).toEqual(uploadFont);
    expect(await picture.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`russian-picture-editor-${width}.png`) });
  }
  await picture.getByRole('button', { name: 'Обрезать', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('heading', { level: 2 })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(picture.getByRole('button', { name: 'Обрезать', exact: true })).toBeFocused();
});

test('keeps crop/editor save levels separate, recovers exact saves, and refreshes another tab', async ({ page, context }) => {
  await login(page); const image = await quadrantPicture();
  await page.getByRole('button', { name: 'New character', exact: true }).click(); await page.getByLabel('Name', { exact: true }).fill('Picture browser keeper');
  await upload(page, image); const dialog = await corner(page);
  await dialog.getByRole('button', { name: 'Use crop', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Adjust crop', exact: true })).toBeFocused();
  expect((await library(page)).characters.some(card => card.name === 'Picture browser keeper')).toBe(false);
  await page.getByRole('button', { name: 'Save', exact: true }).click(); await expect(row(page, 'Picture browser keeper')).toBeVisible();
  const saved = await library(page), card = saved.characters.find(card => card.name === 'Picture browser keeper'); if (!card) throw new Error('Missing saved character');
  const picture = saved.characterPictures.find(item => item.characterId === card.id); if (!picture) throw new Error('Missing saved picture');
  expect(picture.crop).toEqual({ version: 1, x: 0, y: 0, width: .125, height: .25 });
  expect(await pixel(await page.request.get(picture.thumbnailUrl).then(response => response.body()), 160, 160)).toEqual([240,30,30,255]);
  const other = await context.newPage(); await other.goto('/'); await other.getByRole('button', { name: 'Libraries', exact: true }).click(); await other.getByRole('button', { name: 'Characters', exact: true }).click();
  await expect(row(other, card.name).locator('img')).toHaveAttribute('src', picture.thumbnailUrl);
  await row(page, card.name).getByRole('button', { name: `${card.name}`, exact: true }).click();
  await upload(page, await sharp({ create: { width: 100, height: 300, channels: 4, background: 'teal' } }).png().toBuffer(), 'Replace picture');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect((await library(page)).characterPictures.find(item => item.characterId === card.id)?.key).toBe(picture.key);
  await row(page, card.name).getByRole('button', { name: `${card.name}`, exact: true }).click();
  const cancelled = await corner(page); await cancelled.getByRole('button', { name: 'Reset crop', exact: true }).click(); await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Adjust crop', exact: true })).toBeFocused();
  const before = await library(page); await page.getByRole('button', { name: 'Save', exact: true }).click(); await expect(row(page, card.name)).toBeVisible(); expect((await library(page)).revision).toBe(before.revision);
  await row(page, card.name).getByRole('button', { name: `${card.name}`, exact: true }).click(); await upload(page, image, 'Replace picture');
  await page.getByLabel('Character description').fill('Text and picture survive uncertain acknowledgement.');
  const sent: unknown[] = [];
  await page.route(`**/api/library/${card.id}`, async route => { sent.push(route.request().postDataJSON()); await route.fetch(); await route.abort(); });
  await page.getByRole('button', { name: 'Save', exact: true }).click(); await expect(page.getByRole('button', { name: 'Retry same save', exact: true })).toBeEnabled();
  await expect(page.getByLabel('Character description')).toHaveValue('Text and picture survive uncertain acknowledgement.'); await expect(page.getByLabel('Character description')).toBeDisabled();
  await page.unroute(`**/api/library/${card.id}`); await page.route(`**/api/library/${card.id}`, async route => { sent.push(route.request().postDataJSON()); await route.continue(); });
  await page.getByRole('button', { name: 'Retry same save', exact: true }).click(); await expect(row(page, card.name)).toBeVisible(); expect(sent[1]).toEqual(sent[0]);
  const replacement = (await library(page)).characterPictures.find(item => item.characterId === card.id); if (!replacement) throw new Error('Missing replacement'); expect(replacement.key).not.toBe(picture.key);
  await expect(row(other, card.name).locator('img')).toHaveAttribute('src', replacement.thumbnailUrl);
  await (await openLibraryActions(page, row(page, card.name))).getByRole('menuitem', { name: /^Duplicate(?: |$)/ }).click(); await expect(row(page, `${card.name} copy`)).toBeVisible();
  await row(page, `${card.name} copy`).getByRole('heading').getByRole('button').click(); await page.getByRole('button', { name: 'Remove picture', exact: true }).click(); await page.getByRole('button', { name: 'Save', exact: true }).click(); await expect(row(page, `${card.name} copy`)).toContainText('No picture');
  expect((await library(page)).characterPictures.find(item => item.characterId === card.id)?.key).toBe(replacement.key); await other.close();
});

test('reviews PNG artwork, preserves diagnostics, blocks failed art and retains picture drafts through conflicts/tag edits', async ({ page }) => {
  await login(page);
  const source = { spec: 'chara_card_v3', data: { ...fields('Picture imported card'), tags: ['picture-imported-tag'], character_book: { name: 'Picture import book', entries: [], extensions: {} } } };
  const image = await quadrantPicture(); const original = cardPng(image, source);
  await page.getByLabel('Import character', { exact: true }).setInputFiles({ name: 'card.png', mimeType: 'image/png', buffer: original });
  await expect(page.getByRole('heading', { name: 'Review Picture imported card' })).toBeVisible(); await expect(page.locator('.import-picture .cropped-picture')).toBeVisible();
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(row(page, source.data.name)).toBeVisible(); await row(page, source.data.name).getByRole('button', { name: `${source.data.name}`, exact: true }).click();
  await upload(page, image, 'Replace picture'); await page.getByLabel('Character description').fill('Local text remains after definite failure');
  await page.getByRole('button', { name: 'Manage tags', exact: true }).click(); const manager = page.getByRole('dialog', { name: 'Manage tags', exact: true });
  await manager.getByLabel('New tag name').fill('picture-manager-tag'); await manager.getByRole('button', { name: 'Create tag', exact: true }).click(); await expect(manager.getByRole('button', { name: 'Rename picture-manager-tag', exact: true })).toBeVisible(); await manager.getByRole('button', { name: 'Close tag manager', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Adjust crop', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Review embedded tags', exact: true }).click(); await page.getByText('Review tags', { exact: true }).click(); await page.getByRole('radio', { name: 'Import all', exact: true }).check(); await page.getByRole('button', { name: 'Apply reviewed tags', exact: true }).click();
  const saved = await library(page), card = saved.characters.find(card => card.name === source.data.name); if (!card) throw new Error('Missing imported character');
  await page.route(`**/api/library/${card.id}`, route => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ message: 'Synthetic picture conflict' }) }));
  await page.getByRole('button', { name: 'Save', exact: true }).click(); await expect(page.getByRole('alert').filter({ hasText: 'Synthetic picture conflict' }).first()).toBeVisible(); await expect(page.getByLabel('Character description')).toHaveValue('Local text remains after definite failure'); await page.unroute(`**/api/library/${card.id}`);
  await command(page, `/library/${card.id}`, { kind: 'characters', revision: (await library(page)).revision, data: { ...fields(card.name), description: 'Newer independent text' } }, 'PUT');
  await expect(page.getByRole('button', { name: 'Use current text and tags; keep my picture draft', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Use current text and tags; keep my picture draft', exact: true }).click(); await expect(page.getByLabel('Character description')).toHaveValue('Newer independent text');
  await expect(page.getByRole('button', { name: 'Adjust crop', exact: true })).toBeEnabled(); await page.getByRole('button', { name: 'Save', exact: true }).click(); await expect(row(page, card.name)).toContainText('Newer independent text');
  const invalidSource = { ...source, data: { ...source.data, name: 'Picture metadata only' } }, invalid = Buffer.concat([image.subarray(0,8), pngChunk('tEXt', Buffer.from(`chara\0${Buffer.from(JSON.stringify(invalidSource)).toString('base64')}`))]);
  await page.getByLabel('Import character', { exact: true }).setInputFiles({ name: 'invalid-card.png', mimeType: 'image/png', buffer: invalid }); await expect(page.getByRole('heading', { name: 'Review Picture metadata only' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Import', exact: true })).toBeDisabled();
  await expect(page.getByRole('alert').filter({ hasText: 'Cancel and select a card with valid artwork' })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Import without picture', exact: true })).toHaveCount(0);
  const beforeCancel = await library(page);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect((await library(page)).revision).toBe(beforeCancel.revision);
  expect((await library(page)).characters.some(card => card.name === invalidSource.data.name)).toBe(false);
});

test('keeps mixed library rows bounded and crop controls usable at desktop, phone, landscape and enlarged sizes', async ({ page }) => {
  await login(page); const image = await quadrantPicture(), tagIds: string[] = [];
  for (let index = 0; index < 8; index++) tagIds.push((await command(page, '/library/tags', { revision: (await library(page)).revision, name: `picture-visual-tag-${index}` })).id);
  const images = [image, await sharp({ create: { width: 100, height: 400, channels: 4, background: 'teal' } }).png().toBuffer(), await sharp({ create: { width: 600, height: 100, channels: 4, background: { r: 228, g: 170, b: 127, alpha: .5 } } }).png().toBuffer(), null];
  for (const [index, bytes] of images.entries()) {
    const data = fields(`Picture visual ${index} ${index === 1 ? 'with a long name that wraps predictably over two lines' : ''}`);
    const analysis = bytes ? await command(page, '/pictures/preview', { base64: bytes.toString('base64') }) : undefined;
    await command(page, '/library', { kind: 'characters', revision: (await library(page)).revision, requestId: crypto.randomUUID(), data, tagIds: index === 3 ? [] : tagIds, expectedPicture: null, ...(bytes ? { picture: { mode: 'replace', base64: bytes.toString('base64'), crop: analysis.crop } } : {}) });
  }
  await page.route('**/picture/*/thumbnail', async route => { if (route.request().url().includes('/characters/')) { const last = (await library(page)).characters.find(card => card.name.startsWith('Picture visual 2')); if (last && route.request().url().includes(last.id)) return route.abort(); } await route.continue(); });
  await page.reload(); await page.getByRole('button', { name: 'Libraries', exact: true }).click(); await page.getByRole('button', { name: 'Characters', exact: true }).click();
  await row(page, 'Picture visual 2').scrollIntoViewIfNeeded(); await expect(row(page, 'Picture visual 2')).toContainText('Picture unavailable');
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    const rows = page.getByRole('article').filter({ has: page.getByRole('heading', { name: /^Picture visual / }) }); await expect(rows).toHaveCount(4);
    for (const characterRow of await rows.all()) {
      const heading = await characterRow.getByRole('heading').boundingBox();
      const description = await characterRow.locator('.library-card-description').boundingBox();
      if (!heading || !description) throw new Error('Missing character preview');
      const picture = await characterRow.locator('.picture-square').boundingBox();
      if (!picture) throw new Error('Missing character picture');
      expect(Math.abs(description.y + description.height - (picture.y + picture.height))).toBeLessThanOrEqual(1);
      if (width > 800) {
        const bounds = await characterRow.locator('.library-card-body').boundingBox();
        if (!bounds) throw new Error('Missing character row');
        const topMargin = picture.y - bounds.y;
        const bottomMargin = bounds.y + bounds.height - (picture.y + picture.height);
        expect(Math.abs(topMargin - bottomMargin)).toBeLessThanOrEqual(1);
        expect(Math.abs(picture.width - picture.height)).toBeLessThanOrEqual(1);
      }
      const gap = description.y - (heading.y + heading.height);
      expect(gap).toBeGreaterThanOrEqual(0);
      expect(gap).toBeLessThanOrEqual(8);
      await expect(characterRow).not.toContainText('picture-visual-tag-');
    }
    const heights = await rows.evaluateAll(elements => elements.map(element => Math.round(element.getBoundingClientRect().height))); expect(new Set(heights).size).toBe(1);
    // Card height now contains the picture and equal padding, without a footer.
    expect(Math.max(...heights)).toBeLessThanOrEqual(width > 800 ? 150 : 130);
    const more = await rows.first().getByRole('button', { name: /^Actions for / }).boundingBox();
    if (!more) throw new Error('Missing character action trigger');
    expect(more.width).toBeGreaterThanOrEqual(44);
    expect(more.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await rows.first().scrollIntoViewIfNeeded(); await page.screenshot({ path: `test-results/pictures-library-${width}.png`, fullPage: true });
  }
  await row(page, 'Picture visual 0').getByRole('heading').getByRole('button').click();
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 568 }, { width: 740, height: 360 }]) {
    await page.setViewportSize(viewport); await page.getByRole('button', { name: 'Adjust crop', exact: true }).click(); const dialog = page.getByRole('dialog', { name: 'Adjust picture crop' });
    await expect(dialog.getByRole('button', { name: 'Use crop', exact: true })).toBeInViewport(); expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await dialog.getByLabel('Zoom', { exact: true }).press('End'); const surface = dialog.locator('.crop-surface'); const box = await surface.boundingBox(); if (!box) throw new Error('Missing crop viewport');
    // Real pointer drag uses mouse capture for this deterministic browser fixture.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + box.width, box.y + box.height); await page.mouse.up();
    await page.screenshot({ path: `test-results/pictures-crop-${viewport.width}.png`, fullPage: true }); await page.keyboard.press('Escape');
  }
  await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' }); await page.getByRole('button', { name: 'Adjust crop', exact: true }).click(); await expect(page.getByRole('dialog').getByRole('button', { name: 'Use crop', exact: true })).toBeVisible(); await page.keyboard.press('Escape');
  await page.emulateMedia({ forcedColors: 'none' }); await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  // 1280×900 at 200% zoom has a 640×450 CSS viewport and doubled pixel ratio.
  await page.setViewportSize({ width: 640, height: 450 });
  const zoomSession = await page.context().newCDPSession(page);
  await zoomSession.send('Emulation.setDeviceMetricsOverride', { width: 640, height: 450, deviceScaleFactor: 2, mobile: false, screenWidth: 1280, screenHeight: 900 });
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(640);
  expect(await page.evaluate(() => document.documentElement.clientWidth)).toBe(640);
  expect(await page.locator('.document-panel').evaluate(element => element.scrollWidth <= element.clientWidth && element.getBoundingClientRect().right <= innerWidth)).toBe(true);
  await row(page, 'Picture visual 0').scrollIntoViewIfNeeded(); await page.screenshot({ path: 'test-results/pictures-zoom200.png', fullPage: true });
  await zoomSession.send('Emulation.clearDeviceMetricsOverride'); await zoomSession.detach();
});

test('ignores a closed editor’s delayed picture analysis and preserves the next editor draft', async ({ page }) => {
  await login(page);
  const image = await quadrantPicture();
  const preview = await command(page, '/pictures/preview', { base64: image.toString('base64') });
  let finish: (() => Promise<void>) | undefined;
  await page.route('**/api/pictures/preview', async route => {
    await new Promise<void>(resolve => {
      finish = async () => { try { await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(preview) }); } finally { resolve(); } };
    });
  });
  await page.getByRole('button', { name: 'New character', exact: true }).click(); await page.getByLabel('Name', { exact: true }).fill('Picture old delayed draft');
  await page.getByLabel('Choose picture', { exact: true }).setInputFiles({ name: 'first.png', mimeType: 'image/png', buffer: image });
  await expect(page.getByText('Validating and preparing picture…', { exact: true })).toBeVisible();
  await expect.poll(() => Boolean(finish)).toBe(true);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'New character', exact: true }).click(); await page.getByLabel('Name', { exact: true }).fill('Picture new delayed draft');
  if (!finish) throw new Error('Missing delayed analysis'); await finish(); await page.unroute('**/api/pictures/preview');
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Picture new delayed draft'); await expect(page.getByRole('button', { name: 'Adjust crop', exact: true })).toHaveCount(0);
  await upload(page, image); await page.getByRole('button', { name: 'Save', exact: true }).click(); await expect(row(page, 'Picture new delayed draft')).toBeVisible();
  expect((await library(page)).characters.some(card => card.name === 'Picture old delayed draft')).toBe(false);
});

test('clamps a phone touch drag and keeps the crop footer reachable', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  try {
    await login(page); const image = await quadrantPicture();
    await page.getByRole('button', { name: 'New character', exact: true }).click(); await page.getByLabel('Name', { exact: true }).fill('Picture touch draft'); await upload(page, image);
    const dialog = await corner(page), horizontal = dialog.getByLabel('Horizontal position', { exact: true }), vertical = dialog.getByLabel('Vertical position', { exact: true });
    for (let step = 0; step < 10; step++) { await horizontal.press('ArrowRight'); await vertical.press('ArrowRight'); }
    const box = await dialog.locator('.crop-surface').boundingBox(); if (!box) throw new Error('Missing touch crop surface');
    const session = await context.newCDPSession(page);
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + 12, y: box.y + 12 }] });
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: box.x + box.width - 12, y: box.y + box.height - 12 }] });
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(horizontal).toHaveValue('0'); await expect(vertical).toHaveValue('0');
    await expect(dialog.getByRole('button', { name: 'Use crop', exact: true })).toBeInViewport();
    await dialog.getByRole('button', { name: 'Use crop', exact: true }).click();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect((await library(page)).characters.some(card => card.name === 'Picture touch draft')).toBe(false);
    await session.detach();
  } finally { await context.close(); }
});
