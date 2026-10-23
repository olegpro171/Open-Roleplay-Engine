import { expect, test, type Page } from '@playwright/test';
import type { LibrarySnapshot } from '../../src/shared/library';
import type { ChatSnapshot } from '../../src/shared/contracts';
import { quadrantPicture } from '../support/pictures';

const row = (page: Page, title: string) => page.getByRole('article').filter({ has: page.getByRole('heading', { name: title, exact: true }) });

test('opens chat cards by pointer and keyboard, keeps deletion separate and shows reusable character avatars', async ({ page, browser }) => {
  test.setTimeout(60_000);
  const session = await page.request.get('/api/session').then(response => response.json());
  await page.goto('/');
  await page.getByLabel('Owner password').fill('browser-synthetic-password');
  await page.getByRole('button', { name: session.setupRequired ? 'Create owner account' : 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Libraries', exact: true })).toBeVisible();
  const library = () => page.request.get('/api/library').then(response => response.json() as Promise<LibrarySnapshot>);
  async function command(url: string, data: unknown, method = 'POST') {
    const response = await page.request.fetch(`/api${url}`, { method, data, headers: { Origin: 'http://127.0.0.1:4173' } });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  }
  const base64 = (await quadrantPicture()).toString('base64');
  const analysis = await command('/pictures/preview', { base64 });
  const characters: string[] = [];
  for (const name of ['Portrait', 'Unavailable', 'Unpictured']) {
    const result = await command('/library', {
      kind: 'characters', revision: (await library()).revision, requestId: crypto.randomUUID(),
      data: { name: `Chat card ${name}`, description: '', personality: '', scenario: '', first_mes: '', mes_example: '', lorebookId: null },
      tagIds: [], expectedPicture: null,
      ...(name !== 'Unpictured' ? { picture: { mode: 'replace', base64, crop: analysis.crop } } : {}),
    });
    characters.push(result.id);
  }
  const titles = ['Chat card portrait', 'Chat card unavailable', 'Chat card unpictured', 'Chat card unassigned', `Chat card ${'long title '.repeat(8)}`];
  const ids: string[] = [];
  for (const [index, title] of titles.entries()) {
    ids.push((await command('/chats', { title, characterId: characters[index] ?? null, personaId: null, promptId: 'default', connectionId: null, targetInputTokens: 32_000 })).id);
  }
  const pictures = (await library()).characterPictures;
  const portrait = pictures.find(picture => picture.characterId === characters[0]);
  const unavailable = pictures.find(picture => picture.characterId === characters[1]);
  if (!portrait || !unavailable) throw new Error('Missing synthetic portraits');
  await page.route(`**${unavailable.thumbnailUrl}`, route => route.abort());
  async function browse() {
    await page.getByRole('button', { name: 'Libraries', exact: true }).click();
    await page.getByRole('button', { name: 'Chats', exact: true }).click();
    await page.getByRole('searchbox', { name: 'Search chats', exact: true }).fill('Chat card');
    await expect(row(page, titles[0])).toBeVisible();
  }
  await browse();
  await expect(page.getByRole('button', { name: 'Open chat', exact: true })).toHaveCount(0);
  await expect(row(page, titles[0]).locator('img')).toHaveAttribute('src', portrait.thumbnailUrl);
  await expect.poll(() => row(page, titles[0]).locator('img').evaluate(image => image instanceof HTMLImageElement && image.naturalWidth > 0)).toBe(true);
  await expect(row(page, titles[1]).locator('.picture-placeholder')).toContainText('Picture unavailable');
  for (const title of titles.slice(2)) await expect(row(page, title).locator('.picture-placeholder')).toBeVisible();

  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 850 });
    const card = row(page, titles[0]);
    const details = await card.locator('.chat-card-details').boundingBox();
    const remove = await card.getByRole('button', { name: 'Delete chat', exact: true }).boundingBox();
    const avatar = await card.locator('.character-avatar').boundingBox();
    const heading = await card.getByRole('heading').boundingBox();
    if (!details || !remove || !avatar || !heading) throw new Error('Missing chat card geometry');
    expect(avatar.width).toBe(avatar.height);
    expect(avatar.x + avatar.width).toBeLessThan(heading.x);
    if (width >= 390) expect(Math.abs(remove.y + remove.height / 2 - details.y - details.height / 2)).toBeLessThan(1);
    else expect(remove.y).toBeGreaterThanOrEqual(details.y + details.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/chat-library-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 850 });
  await page.mouse.move(0, 0);
  const card = row(page, titles[0]);
  await expect(card).toHaveCSS('background-color', 'rgb(27, 33, 42)');
  const background = await card.evaluate(node => getComputedStyle(node).backgroundColor);
  await card.hover();
  await expect.poll(() => card.evaluate(node => getComputedStyle(node).backgroundColor)).not.toBe(background);
  // The portrait and empty card padding both activate the stretched title button.
  const portraitBounds = await card.locator('.character-avatar').boundingBox();
  if (!portraitBounds) throw new Error('Missing portrait');
  await page.mouse.click(portraitBounds.x + portraitBounds.width / 2, portraitBounds.y + portraitBounds.height / 2);
  await expect(page.getByLabel('Your next turn')).toBeVisible();
  await expect(page.locator('.story-meta h1')).toHaveText(titles[0]);
  const sidebar = page.locator('.chat-details');
  await expect(sidebar.locator('img')).toHaveAttribute('src', portrait.thumbnailUrl);
  await page.route(`**${portrait.originalUrl}`, route => route.abort());
  await sidebar.getByRole('button', { name: 'View original picture', exact: true }).click();
  const failedViewer = page.getByRole('dialog', { name: 'Original character picture', exact: true });
  await expect(failedViewer.getByRole('alert')).toContainText('Could not load the original picture');
  await page.unroute(`**${portrait.originalUrl}`);
  await failedViewer.click({ position: { x: 5, y: 5 } });
  await expect(failedViewer).toHaveCount(0);
  await sidebar.getByRole('button', { name: 'View original picture', exact: true }).click();
  await expect.poll(() => failedViewer.locator('img').evaluate(image => image instanceof HTMLImageElement && image.naturalWidth === 400)).toBe(true);
  await page.keyboard.press('Escape');
  for (const width of [1280, 801, 800, 390, 320]) {
    await page.setViewportSize({ width, height: 850 });
    if (width <= 800) await page.getByRole('button', { name: 'Chat details', exact: true }).click();
    const avatar = sidebar.locator('.character-avatar');
    await expect.poll(() => avatar.locator('img').evaluate(image => image instanceof HTMLImageElement && image.naturalWidth > 0)).toBe(true);
    const bounds = await avatar.boundingBox();
    const heading = await sidebar.locator('h1').boundingBox();
    if (!bounds || !heading) throw new Error('Missing sidebar portrait geometry');
    const content = await sidebar.evaluate(element => {
      const style = getComputedStyle(element);
      return element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    });
    expect(Math.abs(bounds.width - content * (width <= 800 ? .5 : .8))).toBeLessThanOrEqual(1);
    expect(Math.abs(bounds.width - bounds.height)).toBeLessThanOrEqual(1);
    const label = await sidebar.locator('.eyebrow').boundingBox();
    if (!label) throw new Error('Missing current chat label');
    expect(label.y + label.height).toBeLessThan(bounds.y);
    expect(bounds.y + bounds.height).toBeLessThan(heading.y);
    await expect(avatar).toHaveCSS('border-radius', '50%');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/chat-sidebar-portrait-${width}.png`, fullPage: true });
    const openPicture = sidebar.getByRole('button', { name: 'View original picture', exact: true });
    await openPicture.click();
    const viewer = page.getByRole('dialog', { name: 'Original character picture', exact: true });
    await expect(viewer).toBeVisible();
    await expect(viewer).toBeFocused();
    await expect(viewer.locator('img')).toHaveAttribute('src', portrait.originalUrl);
    await expect.poll(() => viewer.locator('img').evaluate(image => image instanceof HTMLImageElement ? [image.naturalWidth, image.naturalHeight] : [])).toEqual([400, 200]);
    await expect(viewer.getByRole('status')).toHaveCount(0);
    const viewerBounds = await viewer.boundingBox();
    expect(viewerBounds).toMatchObject({ x: 0, y: 0, width, height: 850 });
    const imageBounds = await viewer.locator('img').boundingBox();
    if (!imageBounds) throw new Error('Missing original picture');
    expect(Math.abs(imageBounds.x + imageBounds.width / 2 - width / 2)).toBeLessThanOrEqual(1);
    expect(Math.abs(imageBounds.y + imageBounds.height / 2 - 425)).toBeLessThanOrEqual(1);
    expect(Math.abs(imageBounds.width / imageBounds.height - 2)).toBeLessThan(.01);
    await viewer.locator('img').click();
    await expect(viewer).toBeVisible();
    await page.screenshot({ path: `test-results/chat-original-picture-${width}.png`, fullPage: true });
    await page.keyboard.press('Escape');
    await expect(viewer).toHaveCount(0);
    await expect(openPicture).toBeFocused();
    await openPicture.press('Enter');
    await viewer.click({ position: { x: width / 2, y: imageBounds.y / 2 } });
    await expect(viewer).toHaveCount(0);
    await expect(openPicture).toBeFocused();
    await openPicture.click();
    await viewer.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(openPicture).toBeFocused();
    if (width <= 800) await page.getByRole('button', { name: 'Chat details', exact: true }).click();
  }
  await page.setViewportSize({ width: 1280, height: 850 });
  const touchContext = await browser.newContext({ storageState: await page.context().storageState(), viewport: { width: 390, height: 850 }, isMobile: true, hasTouch: true });
  try {
    const phone = await touchContext.newPage();
    await phone.goto('/');
    await phone.getByRole('button', { name: 'Chat details', exact: true }).tap();
    await phone.getByRole('button', { name: 'View original picture', exact: true }).tap();
    const viewer = phone.getByRole('dialog', { name: 'Original character picture', exact: true });
    await expect(viewer.getByRole('status')).toHaveCount(0);
    await viewer.locator('img').tap();
    await expect(viewer).toBeVisible();
    const bounds = await viewer.locator('img').boundingBox();
    if (!bounds) throw new Error('Missing touch viewer picture');
    await phone.touchscreen.tap(195, bounds.y / 2);
    await expect(viewer).toHaveCount(0);
  } finally {
    await touchContext.close();
  }
  await browse();
  await row(page, titles[1]).getByRole('button', { name: titles[1], exact: true }).click();
  await expect(sidebar.locator('.picture-placeholder')).toContainText('Picture unavailable');
  await browse();
  await row(page, titles[2]).click({ position: { x: 6, y: 6 } });
  await expect(page.getByLabel('Your next turn')).toBeVisible();
  await expect(page.locator('.story-meta h1')).toHaveText(titles[2]);
  await expect(sidebar.locator('img')).toHaveCount(0);
  await expect(sidebar.locator('.chat-character-portrait')).toHaveCount(0);
  await expect(sidebar.getByRole('button', { name: 'View original picture', exact: true })).toHaveCount(0);
  await browse();
  await row(page, titles[3]).getByRole('button', { name: titles[3], exact: true }).click();
  await expect(page.locator('.story-meta h1')).toHaveText(titles[3]);
  await expect(sidebar.locator('.chat-character-portrait')).toHaveCount(0);
  for (const key of ['Enter', 'Space']) {
    await browse();
    const open = row(page, titles[0]).getByRole('button', { name: titles[0], exact: true });
    await open.focus();
    await page.keyboard.press('Tab');
    await expect(row(page, titles[0]).getByRole('button', { name: 'Delete chat', exact: true })).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(open).toBeFocused();
    await open.press(key);
    await expect(page.getByLabel('Your next turn')).toBeVisible();
    await expect(page.locator('.story-meta h1')).toHaveText(titles[0]);
  }
  await browse();
  const remove = row(page, titles[0]).getByRole('button', { name: 'Delete chat', exact: true });
  await remove.click();
  const confirmation = page.getByRole('dialog', { name: 'Delete chat?', exact: true });
  await expect(confirmation).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Chats', exact: true })).toBeVisible();
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(remove).toBeFocused();
  expect((await library()).chats.some(chat => chat.id === ids[0])).toBe(true);

  // Assignment changes arrive even when the library cache revision is unchanged.
  const snapshot = await page.request.get(`/api/chats/${ids[0]}`).then(response => response.json() as Promise<ChatSnapshot>);
  await command(`/chats/${ids[0]}/selections`, { revision: snapshot.revision, settings: { title: titles[0], targetInputTokens: 32_000, promptId: 'default', connectionId: null, characterId: null, personaId: null } }, 'PUT');
  await expect(row(page, titles[0]).locator('img')).toHaveCount(0);
  await expect(row(page, titles[0]).locator('.picture-placeholder')).toBeVisible();
  await remove.click();
  await confirmation.getByRole('button', { name: 'Delete chat', exact: true }).click();
  await expect(row(page, titles[0])).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Chats', exact: true })).toBeVisible();
  expect((await library()).chats.some(chat => chat.id === ids[0])).toBe(false);
});
