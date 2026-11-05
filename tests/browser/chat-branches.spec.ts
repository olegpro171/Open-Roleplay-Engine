import { readFile } from 'node:fs/promises';
import { expect } from '@playwright/test';
import { test } from './isolated-app';
import { appearanceStatusSchema } from '../../src/shared/appearance';
import type { LibrarySnapshot } from '../../src/shared/library';
import type { StorySnapshot } from '../../src/shared/transcript';

test('forks, remembers the branch in the Chats library, and exports its transcript', async ({ page, browserApp }, testInfo) => {
  async function openBranches() {
    const button = page.getByRole('button', { name: 'Chat branches', exact: true });
    if (!(await button.isVisible())) await page.getByRole('button', { name: 'Chat details', exact: true }).click();
    await button.click();
  }
  await page.goto('/');
  await page.getByLabel('Owner password').fill('browser-synthetic-password');
  await page.getByRole('button', { name: 'Create owner account', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Chat settings', exact: true })).toBeVisible();
  const details = page.getByRole('complementary', { name: 'Current chat' });
  const settingsIcon = await details.getByRole('button', { name: 'Chat settings' }).locator('svg').boundingBox();
  const branchesIcon = await details.getByRole('button', { name: 'Chat branches' }).locator('svg').boundingBox();
  expect(branchesIcon).toMatchObject({ width: settingsIcon?.width, height: settingsIcon?.height });
  const story = await page.request.get('/api/chats/main/story').then(response => response.json() as Promise<StorySnapshot>);
  const headers = { Origin: browserApp.url };
  const saved = await page.request.put('/api/chats/main/history', { headers, data: {
    revision: story.revision,
    turns: [
      { user: 'Do you see the lighthouse?', assistant: 'Yes. Its light is **green**.', complete: true },
      { user: 'Later in the source', assistant: 'This event should stay in Main.', complete: true },
    ],
  } });
  expect(saved.ok(), await saved.text()).toBe(true);
  await page.getByLabel('Your next turn').fill('Draft for Main');
  const sourceTurn = page.locator('article').filter({ hasText: 'Do you see the lighthouse?' });
  await sourceTurn.getByRole('button', { name: 'Branch', exact: true }).click();
  const fork = page.getByRole('dialog', { name: 'Branch through turn 1' });
  await fork.getByLabel('Branch name').fill('Lighthouse');
  await fork.getByRole('button', { name: 'Create branch' }).click();
  const conversation = page.getByRole('region', { name: 'Conversation' });
  const lighthouseTurn = conversation.getByText('Do you see the lighthouse?');
  await expect(fork).toHaveCount(0);
  await expect(lighthouseTurn).toBeVisible();
  await expect(page.getByText('Later in the source')).toHaveCount(0);
  await expect(page.getByLabel('Your next turn')).toHaveValue('');
  const other = await page.request.post('/api/chats', { headers, data: { title: 'Another story',
    targetInputTokens: 32000, characterId: null, personaId: null, connectionId: null } });
  expect(other.ok(), await other.text()).toBe(true);
  async function openChats() {
    await page.getByRole('button', { name: 'Libraries', exact: true }).click();
    await page.getByRole('button', { name: 'Chats', exact: true }).click();
  }
  const chatCard = (title: string) => page.getByRole('article').filter({
    has: page.getByRole('button', { name: title, exact: true }),
  });
  const sourceCard = chatCard(story.settings.title);
  await openChats();
  await expect(sourceCard).toContainText('1 turns · Current chat');
  await chatCard('Another story').getByRole('button', { name: 'Another story', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Another story' })).toBeVisible();
  await openChats();
  await expect(sourceCard).toContainText('1 turns');
  await expect(sourceCard).not.toContainText('Current chat');
  await page.reload();
  await openChats();
  await expect(sourceCard).toContainText('1 turns');
  await sourceCard.getByRole('button', { name: story.settings.title, exact: true }).click();
  await expect(lighthouseTurn).toBeVisible();
  await openBranches();
  const manager = page.getByRole('dialog', { name: 'Chat branches' });
  const lighthouseButton = manager.getByRole('button', { name: 'Lighthouse', exact: true });
  await expect(lighthouseButton).toHaveAttribute('aria-current', 'true');
  await manager.getByRole('searchbox', { name: 'Search branches' }).fill('LIGHT');
  await expect(manager.getByPlaceholder('Search branches')).toHaveValue('LIGHT');
  await expect(manager.getByRole('article')).toHaveCount(1);
  const menu = manager.getByRole('menu');
  async function openActions(name: string) {
    await manager.getByRole('button', { name: `Actions for ${name}`, exact: true }).click();
    await expect(menu).toBeVisible();
  }
  const button = menu.getByRole('menuitem', { name: 'Export chat as JSONL' });
  for (const theme of ['dark', 'light', 'midnight-black'] as const) {
    const path = '/api/application/appearance';
    const appearance = appearanceStatusSchema.parse(await page.request.get(path).then(response => response.json()));
    expect((await page.request.put(path, { headers, data: { revision: appearance.revision, settings: { ...appearance.settings, theme } } })).ok()).toBe(true);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    for (const width of [1280, 801, 800, 390, 320]) {
      await page.setViewportSize({ width, height: 850 });
      expect((await manager.boundingBox())?.width).toBeLessThanOrEqual(640);
      expect(await manager.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await openActions('Lighthouse');
      await expect(button).toBeInViewport();
      if (width === 1280 || width === 390) await page.screenshot({ path: testInfo.outputPath(`branches-${theme}-${width}.png`) });
      await page.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);
      await expect(manager.getByRole('button', { name: 'Actions for Lighthouse' })).toBeFocused();
    }
    await page.keyboard.press('Escape');
    await expect(manager).toHaveCount(0);
    for (const width of [1280, 801, 800, 390]) {
      await page.setViewportSize({ width, height: 850 });
      await expect(lighthouseTurn).toBeInViewport();
      await expect(conversation.getByText(/^Current branch · /)).toHaveCount(0);
      if (width === 1280 || width === 390) await page.screenshot({ path: testInfo.outputPath(`story-${theme}-${width}.png`) });
    }
    await openChats();
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 850 });
      await expect(sourceCard.getByText('1 turns · Current chat')).toBeInViewport();
      await sourceCard.screenshot({ path: testInfo.outputPath(`chat-card-${theme}-${width}.png`) });
    }
    await sourceCard.getByRole('button', { name: story.settings.title, exact: true }).click();
    await expect(lighthouseTurn).toBeVisible();
    await openBranches();
    await expect(lighthouseButton).toHaveAttribute('aria-current', 'true');
  }
  await openActions('Lighthouse');
  const download = page.waitForEvent('download');
  await button.click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/\.jsonl$/);
  const path = await file.path();
  if (!path) throw new Error('Missing transcript download');
  const [metadata, user, assistant] = (await readFile(path, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
  expect(metadata).toHaveProperty('chat_metadata');
  expect(user).toMatchObject({ mes: 'Do you see the lighthouse?', is_user: true });
  expect(assistant).toMatchObject({ mes: 'Yes. Its light is **green**.', is_user: false });
  await manager.getByRole('searchbox').clear();
  await openActions('Lighthouse');
  await menu.getByRole('menuitem', { name: 'Rename branch' }).click();
  await manager.getByLabel('Branch name').fill('Green lighthouse');
  await manager.locator('form').getByRole('button', { name: 'Rename branch' }).click();
  await openActions('Green lighthouse');
  await menu.getByRole('menuitem', { name: 'Duplicate branch' }).click();
  await manager.getByLabel('Branch name').fill('Copy of lighthouse');
  await manager.getByRole('button', { name: 'Create branch' }).click();
  await expect(manager).toHaveCount(0);
  await expect(lighthouseTurn).toBeVisible();
  await openBranches();
  const duplicateButton = manager.getByRole('button', { name: 'Copy of lighthouse', exact: true });
  await expect(duplicateButton).toHaveAttribute('aria-current', 'true');
  await openActions('Copy of lighthouse');
  await menu.getByRole('menuitem', { name: 'Delete branch' }).click();
  await manager.locator('form').getByRole('button', { name: 'Delete branch' }).click();
  await expect(manager).toHaveCount(0);
  await openBranches();
  await expect(duplicateButton).toHaveCount(0);
  await manager.getByRole('button', { name: 'Main', exact: true }).click();
  await expect(page.getByText('Later in the source')).toBeVisible();
  await expect(page.getByLabel('Your next turn')).toHaveValue('Draft for Main');
  await openBranches();
  await page.mouse.click(2, 2);
  await expect(manager).toHaveCount(0);
  await page.setViewportSize({ width: 1280, height: 850 });
  await openBranches();
  await manager.getByRole('button', { name: 'Green lighthouse', exact: true }).click();
  await expect(manager).toHaveCount(0);
  await expect(lighthouseTurn).toBeVisible();
  await expect(page.getByText('Later in the source')).toHaveCount(0);
  await openChats();
  await chatCard('Another story').getByRole('button', { name: 'Another story', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Another story' })).toBeVisible();
  const library = await page.request.get('/api/library').then(response => response.json() as Promise<LibrarySnapshot>);
  const lighthouse = library.chats.find(branch => branch.branchName === 'Green lighthouse');
  if (!lighthouse) throw new Error('Missing Green lighthouse branch');
  const deleted = await page.request.delete(`/api/chats/${lighthouse.id}/branch`, { headers, data: { revision: lighthouse.revision } });
  expect(deleted.ok(), await deleted.text()).toBe(true);
  await openChats();
  await expect(sourceCard).toContainText('2 turns');
  await sourceCard.getByRole('button', { name: story.settings.title, exact: true }).click();
  await expect(page.getByText('Later in the source')).toBeVisible();
});
