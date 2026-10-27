import { expect, test } from '@playwright/test';
import { appearanceStatusSchema } from '../../src/shared/appearance';
import type { LibrarySnapshot } from '../../src/shared/library';
import { quadrantPicture } from '../support/pictures';

for (const width of [1280, 801, 800, 390]) test(`saves chat picture visibility without changing library pictures at ${width}px`, async ({ page, context }, testInfo) => {
  await page.setViewportSize({ width, height: 850 });
  const session = await page.request.get('/api/session').then(response => response.json());
  await page.goto('/');
  await page.getByLabel('Owner password').fill('browser-synthetic-password');
  await page.getByRole('button', { name: session.setupRequired ? 'Create owner account' : 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Libraries', exact: true })).toBeVisible();
  const headers = { Origin: 'http://127.0.0.1:4173' };
  const library = (): Promise<LibrarySnapshot> => page.request.get('/api/library').then(response => response.json());
  const appearance = async () => appearanceStatusSchema.parse(await page.request.get('/api/application/appearance').then(response => response.json()));
  const initial = await appearance();
  expect(initial.settings.displayCharacterPicture).toBe(true);
  const name = `Picture visibility ${width} — A long journey beneath the northern stars`;
  const base64 = (await quadrantPicture()).toString('base64');
  const characterResponse = await page.request.post('/api/library', { headers, data: {
    kind: 'characters', revision: (await library()).revision, requestId: crypto.randomUUID(),
    data: { name, description: '', personality: '', scenario: '', first_mes: '', mes_example: '' },
    tagIds: [], expectedPicture: null,
    picture: { mode: 'replace', base64, crop: { version: 1, x: 0.25, y: 0, width: 0.5, height: 1 } },
  } });
  expect(characterResponse.ok(), await characterResponse.text()).toBe(true);
  const character = (await library()).characters.find(item => item.name === name);
  if (!character) throw new Error('Missing synthetic character');
  const chatResponse = await page.request.post('/api/chats', { headers, data: {
    title: name, characterId: character.id, personaId: null, promptId: 'default', connectionId: null, targetInputTokens: 32_000,
  } });
  expect(chatResponse.ok(), await chatResponse.text()).toBe(true);
  const chat = (await library()).chats.find(item => item.title === name);
  if (!chat) throw new Error('Missing synthetic chat');
  await page.evaluate(id => localStorage.setItem('roleplay-chat', id), chat.id);
  await page.reload();
  if (width <= 800) await page.getByRole('button', { name: 'Chat details', exact: true }).click();
  const portrait = page.locator('.chat-character-portrait');
  await expect(portrait).toBeVisible();
  const title = page.locator('.chat-details h1');
  const inspectTitle = async (pictured: boolean) => {
    for (const theme of ['dark', 'light', 'midnight-black'] as const) {
      const current = await appearance();
      const saved = await page.request.put('/api/application/appearance', { headers, data: {
        revision: current.revision, settings: { ...current.settings, theme },
      } });
      expect(saved.ok()).toBe(true);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(title).toHaveCSS('text-align', pictured ? 'center' : /^(start|left)$/);
      const heading = await title.boundingBox();
      if (!heading) throw new Error('Missing chat title');
      if (pictured) {
        const picture = await portrait.boundingBox();
        if (!picture) throw new Error('Missing chat portrait');
        expect(heading.y).toBeGreaterThan(picture.y + picture.height);
        expect(Math.abs(heading.x + heading.width / 2 - picture.x - picture.width / 2)).toBeLessThanOrEqual(1);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`title-${pictured ? 'pictured' : 'hidden'}-${theme}.png`) });
    }
  };
  if (width <= 800) await page.getByRole('button', { name: 'Chat details', exact: true }).click();
  const before = await page.request.get(`/api/chats/${chat.id}`).then(response => response.json());
  const picturesBefore = (await library()).characterPictures;
  const observer = await context.newPage();
  await observer.goto('/');
  await expect(observer.locator('.chat-character-portrait')).toBeVisible();
  try {
    if (width <= 800) await page.getByRole('button', { name: 'Chat details', exact: true }).click();
    await inspectTitle(true);
    if (width <= 800) await page.getByRole('button', { name: 'Chat details', exact: true }).click();
    await page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'Chat appearance', exact: true }).click();
    const settings = page.getByRole('region', { name: 'Chat appearance', exact: true });
    const checkbox = settings.getByRole('checkbox', { name: 'Display character picture in chat.', exact: true });
    await expect(checkbox).toBeChecked();
    await page.route('**/api/application/appearance', route => route.request().method() === 'PUT'
      ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'Synthetic appearance save failure.' }) }) : route.continue());
    await checkbox.focus();
    await checkbox.press('Space');
    await expect(settings.getByRole('alert')).toContainText('Synthetic appearance save failure.');
    await expect(checkbox).not.toBeChecked();
    expect((await appearance()).settings.displayCharacterPicture).toBe(true);
    await expect(observer.locator('.chat-character-portrait')).toBeVisible();
    await expect(observer.locator('.chat-details h1')).toHaveCSS('text-align', 'center');
    await page.unroute('**/api/application/appearance');
    await page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Libraries', exact: true }).click();
    await page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(checkbox).not.toBeChecked();
    await expect(settings.getByRole('alert')).toContainText('Synthetic appearance save failure.');
    await settings.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(settings.getByRole('alert')).toHaveCount(0);
    await expect(observer.locator('.chat-character-portrait')).toHaveCount(0);
    await checkbox.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('picture-setting.png'), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Story', exact: true }).click();
    await page.reload();
    await expect(page.getByLabel('Your next turn')).toBeVisible();
    await expect(portrait).toHaveCount(0);
    if (width <= 800) await page.getByRole('button', { name: 'Chat details', exact: true }).click();
    await page.getByRole('button', { name: 'Inspect memory', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Return to chat', exact: true })).toBeVisible();
    await expect(portrait).toHaveCount(0);
    if (width <= 800) await page.getByRole('button', { name: 'Chat details', exact: true }).click();
    await inspectTitle(false);
    await page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Libraries', exact: true }).click();
    await page.getByRole('button', { name: 'Chats', exact: true }).click();
    const card = page.getByRole('article').filter({ has: page.getByRole('heading', { name, exact: true }) });
    await expect(card.locator('.character-avatar img')).toBeVisible();
    await page.getByRole('button', { name: 'Characters', exact: true }).click();
    await expect(page.getByRole('article').filter({ has: page.getByRole('heading', { name, exact: true }) }).locator('.picture-square img')).toBeVisible();
    await page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(checkbox).not.toBeChecked();
    await checkbox.check();
    await expect.poll(async () => (await appearance()).settings.displayCharacterPicture).toBe(true);
    await expect(observer.locator('.chat-character-portrait')).toBeVisible();
    expect(await page.request.get(`/api/chats/${chat.id}`).then(response => response.json())).toEqual(before);
    expect((await library()).characterPictures).toEqual(picturesBefore);
  } finally {
    await observer.close();
    await page.unroute('**/api/application/appearance');
    const current = await appearance();
    const restored = await page.request.put('/api/application/appearance', { headers, data: { revision: current.revision, settings: initial.settings } });
    expect(restored.ok()).toBe(true);
  }
});
