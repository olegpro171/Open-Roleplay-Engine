import { expect, test, type Locator } from '@playwright/test';
import type { ChatSnapshot } from '../../src/shared/contracts';
import type { LibrarySnapshot } from '../../src/shared/library';
import { quadrantPicture } from '../support/pictures';
import { openChatTool } from './chat-tools';

async function expectInlinePortrait(option: Locator) {
  const avatar = await option.locator('.character-avatar').boundingBox();
  const text = await option.locator('.select-option-text').boundingBox();
  const bounds = await option.boundingBox();
  if (!avatar || !text || !bounds) throw new Error('Missing inline portrait geometry');
  expect(avatar.width).toBe(24);
  expect(avatar.height).toBe(24);
  expect(avatar.x + avatar.width).toBeLessThan(text.x);
  expect(text.x + text.width).toBeLessThanOrEqual(bounds.x + bounds.width);
  expect(Math.abs(avatar.y + avatar.height / 2 - text.y - text.height / 2)).toBeLessThanOrEqual(1);
}

test('character selectors show saved portraits and fallbacks while preserving selection at desktop and phone widths', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const session = await page.request.get('/api/session').then(response => response.json());
  await page.goto('/');
  await page.getByLabel('Owner password').fill('browser-synthetic-password');
  await page.getByRole('button', { name: session.setupRequired ? 'Create owner account' : 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Libraries', exact: true })).toBeVisible();
  const library = (): Promise<LibrarySnapshot> => page.request.get('/api/library').then(response => response.json());
  const base64 = (await quadrantPicture()).toString('base64');
  const names = ['Selector portrait', 'Selector unavailable', 'Selector unpictured'];
  const comment = 'A very long local title that should wrap beside the portrait on a narrow screen';
  for (const [index, name] of names.entries()) {
    const response = await page.request.post('/api/library', {
      headers: { Origin: 'http://127.0.0.1:4173' },
      data: {
        kind: 'characters', revision: (await library()).revision, requestId: crypto.randomUUID(),
        data: { name, titleComment: index === 2 ? comment : '', description: '', personality: '', scenario: '', first_mes: '', mes_example: '' },
        tagIds: [], expectedPicture: null,
        ...(index < 2 ? { picture: { mode: 'replace', base64, crop: { version: 1, x: 0.25, y: 0, width: 0.5, height: 1 } } } : {}),
      },
    });
    expect(response.ok(), await response.text()).toBe(true);
  }
  const saved = await library();
  const portrait = saved.characters.find(character => character.name === names[0]);
  const unavailable = saved.characters.find(character => character.name === names[1]);
  const unpictured = saved.characters.find(character => character.name === names[2]);
  const picture = saved.characterPictures.find(picture => picture.characterId === portrait?.id);
  const brokenPicture = saved.characterPictures.find(picture => picture.characterId === unavailable?.id);
  if (!portrait || !unavailable || !unpictured || !picture || !brokenPicture) throw new Error('Missing selector fixtures');
  await page.route(`**${brokenPicture.thumbnailUrl}`, route => route.abort());
  const longLabel = `${unpictured.name} · ${comment}`;
  await page.reload();

  for (const width of [1280, 801, 800, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.getByRole('button', { name: 'Libraries', exact: true }).click();
    await page.getByRole('button', { name: 'Chats', exact: true }).click();
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    const selector = page.getByRole('combobox', { name: 'Character', exact: true });
    await expect(selector).toHaveText('None selected');
    await expect(selector.locator('.character-avatar')).toHaveCount(0);
    await expect(page.getByRole('combobox', { name: 'Persona', exact: true }).locator('.character-avatar')).toHaveCount(0);
    await selector.click();
    const portraitOption = page.getByRole('option', { name: portrait.name, exact: true });
    const missingOption = page.getByRole('option', { name: longLabel, exact: true });
    await portraitOption.scrollIntoViewIfNeeded();
    await expect(portraitOption.locator('img')).toHaveAttribute('src', picture.thumbnailUrl);
    await expect.poll(() => portraitOption.locator('img').evaluate(image => image instanceof HTMLImageElement && image.naturalWidth > 0)).toBe(true);
    const unavailableOption = page.getByRole('option', { name: unavailable.name, exact: true });
    await unavailableOption.scrollIntoViewIfNeeded();
    await expect(unavailableOption.locator('.picture-placeholder')).toContainText('Picture unavailable');
    await missingOption.scrollIntoViewIfNeeded();
    await expect(missingOption.locator('.picture-placeholder')).toContainText('No picture');
    await expectInlinePortrait(portraitOption);
    await expectInlinePortrait(missingOption);
    await expect(page.getByRole('listbox', { name: 'Character', exact: true })).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: testInfo.outputPath(`new-chat-options-${width}.png`), fullPage: true });
    // Move to this exact option before exercising keyboard commit, independent of other saved fixtures.
    await portraitOption.hover();
    await selector.press('Enter');
    await expect(selector).toHaveText(portrait.name);
    await expect(selector.locator('img')).toHaveAttribute('src', picture.thumbnailUrl);
    await selector.press('ArrowDown');
    await expect(portraitOption).toHaveAttribute('aria-selected', 'true');
    await selector.press('Home');
    await selector.press('Enter');
    await expect(selector).toHaveText('None selected');
    await expect(selector.locator('.character-avatar')).toHaveCount(0);
    await selector.click();
    await portraitOption.locator('img').click();
    await expectInlinePortrait(selector);
    await expect(selector.locator('.select-option-text')).toHaveCSS('color', await selector.evaluate(node => getComputedStyle(node).color));
    await page.screenshot({ path: testInfo.outputPath(`new-chat-selection-${width}.png`), fullPage: true });
    await page.getByRole('button', { name: 'Create chat', exact: true }).click();

    await expect(page.getByLabel('Chat title')).toBeVisible();
    const chatId = await page.evaluate(() => localStorage.getItem('roleplay-chat'));
    const state = (): Promise<ChatSnapshot> => page.request.get(`/api/chats/${chatId}`).then(response => response.json());
    expect((await state()).settings.characterId).toBe(portrait.id);
    await expect(selector.locator('img')).toHaveAttribute('src', picture.thumbnailUrl);
    await expectInlinePortrait(selector);
    await selector.click();
    await page.getByRole('option', { name: unavailable.name, exact: true }).click();
    await expect(selector.locator('.picture-placeholder')).toContainText('Picture unavailable');
    await selector.click();
    await missingOption.click();
    await expect(selector.locator('.select-option-text')).toHaveText(longLabel);
    await expectInlinePortrait(selector);
    await selector.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`chat-settings-selection-${width}.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    // Changes remain drafts until Save, then survive reopening the settings.
    expect((await state()).settings.characterId).toBe(portrait.id);
    await page.getByRole('button', { name: 'Save and return', exact: true }).click();
    await expect(page.getByLabel('Your next turn')).toBeVisible();
    expect((await state()).settings.characterId).toBe(unpictured.id);
    await openChatTool(page, 'Chat settings');
    await expect(selector.locator('.select-option-text')).toHaveText(longLabel);
    await expect(selector.locator('.picture-placeholder')).toContainText('No picture');
    await selector.press('ArrowDown');
    await selector.press('Home');
    await selector.press('Enter');
    await expect(selector.locator('.character-avatar')).toHaveCount(0);
    await page.getByRole('button', { name: 'Return without saving', exact: true }).click();
    expect((await state()).settings.characterId).toBe(unpictured.id);
  }
});
