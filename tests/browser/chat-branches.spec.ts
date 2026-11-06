import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect } from '@playwright/test';
import { test } from './isolated-app';
import { appearanceStatusSchema } from '../../src/shared/appearance';
import { defaultPrompt, type LibrarySnapshot } from '../../src/shared/library';
import { defaultContextPreset } from '../../src/shared/context';
import type { ChatSnapshot } from '../../src/shared/contracts';
import { openChatTool } from './chat-tools';
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
  const saved = await page.request.put('/api/__test/transcripts/main', { headers, data: {
    revision: story.revision,
    turns: [
      { user: 'Do you see the lighthouse?', assistant: 'Yes. Its light is **green**.', complete: true },
      { user: 'Later in the source', assistant: 'This event should stay in Main.', complete: true },
    ],
  } });
  expect(saved.ok(), await saved.text()).toBe(true);
  await page.getByLabel('Your next turn').fill('Draft for Main');
  const sourceTurn = page.locator('article').filter({ hasText: 'Do you see the lighthouse?' });
  const turnMore = sourceTurn.getByRole('button', { name: 'More turn actions', exact: true });
  const branchAction = page.getByRole('menu', { name: 'More turn actions', exact: true }).getByRole('menuitem', { name: 'Branch', exact: true });
  await turnMore.click();
  await branchAction.click();
  const fork = page.getByRole('dialog', { name: 'Branch through turn 1' });
  await fork.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(fork).toHaveCount(0);
  await expect(turnMore).not.toBeFocused();
  await turnMore.click();
  await branchAction.click();
  const branchTitle = 'Падение с 30-го этажа 123';
  await fork.getByLabel('Branch name').fill(branchTitle);
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
  const lighthouseButton = manager.getByRole('button', { name: branchTitle, exact: true });
  await expect(lighthouseButton).toHaveAttribute('aria-current', 'true');
  await manager.getByRole('searchbox', { name: 'Search branches' }).fill('ЭТАЖ');
  await expect(manager.getByPlaceholder('Search branches')).toHaveValue('ЭТАЖ');
  await expect(manager.getByRole('article')).toHaveCount(1);
  const menu = manager.getByRole('menu');
  async function openActions(name: string) {
    await manager.getByRole('button', { name: `Actions for ${name}`, exact: true }).click();
    await expect(menu).toBeVisible();
  }
  async function setTheme(theme: 'dark' | 'light' | 'midnight-black') {
    const path = '/api/application/appearance';
    const appearance = appearanceStatusSchema.parse(await page.request.get(path).then(response => response.json()));
    expect((await page.request.put(path, { headers, data: { revision: appearance.revision, settings: { ...appearance.settings, theme } } })).ok()).toBe(true);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  }
  const button = menu.getByRole('menuitem', { name: 'Export chat as JSONL' });
  for (const theme of ['dark', 'light', 'midnight-black'] as const) {
    await setTheme(theme);
    for (const width of [1280, 801, 800, 390, 320]) {
      await page.setViewportSize({ width, height: 850 });
      expect((await manager.boundingBox())?.width).toBeLessThanOrEqual(640);
      expect(await manager.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      const search = await manager.getByRole('searchbox').boundingBox();
      const action = await manager.getByRole('button', { name: 'Import', exact: true }).boundingBox();
      if (!search || !action) throw new Error('Missing branch toolbar controls');
      expect(search.x + search.width).toBeLessThan(action.x);
      expect(Math.abs(search.y + search.height / 2 - action.y - action.height / 2)).toBeLessThan(2);
      await openActions(branchTitle);
      await expect(button).toBeInViewport();
      if (width === 1280 || width === 390) await page.screenshot({ path: testInfo.outputPath(`branches-${theme}-${width}.png`) });
      await page.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);
      await expect(manager.getByRole('button', { name: `Actions for ${branchTitle}` })).toBeFocused();
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
  await openActions(branchTitle);
  const download = page.waitForEvent('download');
  await button.click();
  const file = await download;
  expect(file.suggestedFilename()).toBe(`${branchTitle}.jsonl`);
  const path = await file.path();
  if (!path) throw new Error('Missing transcript download');
  const [metadata, user, assistant] = (await readFile(path, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
  expect(metadata).toHaveProperty('chat_metadata');
  expect(user).toMatchObject({ mes: 'Do you see the lighthouse?', is_user: true });
  expect(assistant).toMatchObject({ mes: 'Yes. Its light is **green**.', is_user: false });
  await manager.getByRole('searchbox').clear();
  await openActions(branchTitle);
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
  const branchDeletes: string[] = [];
  page.on('request', request => {
    if (request.method() === 'DELETE' && request.url().endsWith('/branch')) branchDeletes.push(request.url());
  });
  const warning = page.getByRole('dialog', { name: 'Delete branch?', exact: true });
  const cancelDelete = warning.getByRole('button', { name: 'Cancel', exact: true });
  const confirmDelete = warning.getByRole('button', { name: 'Delete branch', exact: true });
  const duplicateActions = manager.getByRole('button', { name: 'Actions for Copy of lighthouse', exact: true });
  async function openDeleteWarning() {
    await openActions('Copy of lighthouse');
    await menu.getByRole('menuitem', { name: 'Delete branch', exact: true }).click();
    await expect(warning).toBeVisible();
  }
  for (const theme of ['dark', 'light', 'midnight-black'] as const) {
    await setTheme(theme);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 850 });
      await openDeleteWarning();
      await expect(warning.getByText('Copy of lighthouse', { exact: false })).toBeVisible();
      await expect(confirmDelete).toBeInViewport();
      await page.keyboard.press('Tab');
      await expect(cancelDelete).toBeFocused();
      await warning.screenshot({ path: testInfo.outputPath(`delete-branch-${theme}-${width}.png`) });
      if (width === 1280) await page.keyboard.press('Escape');
      else await cancelDelete.click();
      await expect(warning).toHaveCount(0);
      await expect(duplicateActions).toBeFocused();
      await expect(duplicateButton).toHaveAttribute('aria-current', 'true');
    }
  }
  expect(branchDeletes).toEqual([]);
  await openDeleteWarning();
  const deletion = page.waitForResponse(response => response.request().method() === 'DELETE' && response.url().endsWith('/branch'));
  await confirmDelete.click();
  const deletedBranch = await deletion;
  expect(deletedBranch.ok(), await deletedBranch.text()).toBe(true);
  const { id: remainingBranch } = await deletedBranch.json();
  expect(branchDeletes).toHaveLength(1);
  await expect(manager).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('roleplay-chat'))).toBe(remainingBranch);
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

test('imports a downloaded branch into its group and as a standalone chat', async ({ page, browserApp }, testInfo) => {
  test.setTimeout(90_000);
  const headers = { Origin: browserApp.url };
  async function command(path: string, data: unknown, method = 'POST') {
    const response = await page.request.fetch(path, { method, headers, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  }
  const library = () => page.request.get('/api/library').then(response => response.json() as Promise<LibrarySnapshot>);
  const state = (id: string) => page.request.get(`/api/chats/${id}`).then(response => response.json() as Promise<ChatSnapshot>);
  const providerRequests = () => page.request.get('/__test/requests').then(response => response.json() as Promise<unknown[]>);
  await page.goto('/');
  await page.getByLabel('Owner password').fill('browser-synthetic-password');
  await page.getByRole('button', { name: 'Create owner account' }).click();
  await expect(page.getByRole('button', { name: 'Libraries', exact: true })).toBeVisible();
  const { endpoint } = await page.request.get('/__test/endpoint').then(response => response.json());
  const { id: connectionId } = await command('/api/library', {
    revision: (await library()).revision, kind: 'connections',
    data: { name: 'Import test model', endpoint, model: 'mock', contextWindow: 100_000, maxOutputTokens: 1_000, customParameters: {} },
  });
  const { id: promptId } = await command('/api/library', {
    revision: (await library()).revision, kind: 'prompts', data: {
      name: 'Transcript and memory',
      blocks: defaultPrompt.blocks.filter(block => block.kind === 'marker' && ['summary', 'messages'].includes(block.marker)),
    },
  });
  const { id: contextPresetId } = await command('/api/library', {
    revision: (await library()).revision, kind: 'contexts',
    data: { ...defaultContextPreset, name: 'Import archive', batchSize: 2, minTail: 1, summaryTokens: 100 },
  });
  const settings = { title: 'Lighthouse archive', targetInputTokens: 32_000, connectionId, promptId, contextPresetId, characterId: null, personaId: null };
  const { id: sourceId } = await command('/api/chats', settings);
  const turns = [
    { user: '', assistant: 'Привет, путешественник 🌙\r\n\r\nEnter the lighthouse.', complete: true },
    ...Array.from({ length: 5 }, (_, i) => ({
      user: `Visit ${i + 1}. ${'I carry the silver key. '.repeat(38)}`,
      assistant: `Original reply ${i + 1}. ${'The keeper lights the lantern. '.repeat(30)}`, complete: true,
    })),
  ];
  await command(`/api/__test/transcripts/${sourceId}`, { revision: 0, turns }, 'PUT');
  const last = (await state(sourceId)).turns.at(-1);
  if (!last) throw new Error('Missing synthetic last turn');
  await command(`/api/chats/${sourceId}/turns/${last.id}/regenerate`, { revision: (await state(sourceId)).revision, requestId: randomUUID() });
  await expect.poll(async () => (await state(sourceId)).turns.at(-1)?.assistant.text).toContain('The lantern flickers.');
  await command(`/api/chats/${sourceId}/selections`, { revision: (await state(sourceId)).revision, settings: { ...settings, targetInputTokens: 700 } }, 'PUT');
  await command(`/api/chats/${sourceId}/context/prepare`, { revision: (await state(sourceId)).revision, requestId: randomUUID(), mode: 'step' });
  await expect.poll(async () => (await state(sourceId)).context.jobs[0]?.status).not.toBe('running');
  expect((await state(sourceId)).context.jobs[0]).toMatchObject({ status: 'succeeded', error: null });
  expect((await state(sourceId)).context.archivedTurnIds.length).toBeGreaterThan(0);
  await command(`/api/chats/${sourceId}/selections`, { revision: (await state(sourceId)).revision, settings }, 'PUT');
  await command(`/api/chats/${sourceId}/author-note`, { revision: (await state(sourceId)).revision, settings: { prompt: 'Keep the light burning', role: 'system', depth: 0 } }, 'PUT');
  const source = await state(sourceId);
  const plainTurns = (snapshot: ChatSnapshot) => snapshot.turns.map(turn => ({ user: turn.user.text, assistant: turn.assistant.text, complete: turn.complete }));
  const before = (await providerRequests()).length;
  const openChats = async () => {
    await page.getByRole('button', { name: 'Libraries', exact: true }).click();
    await page.getByRole('button', { name: 'Chats', exact: true }).click();
  };
  await openChats();
  const sourceCard = page.getByRole('button', { name: settings.title, exact: true });
  await sourceCard.click();
  await openChatTool(page, 'Chat branches');
  const manager = page.getByRole('dialog', { name: 'Chat branches' });
  await manager.getByRole('button', { name: 'Actions for Main' }).click();
  const download = page.waitForEvent('download');
  await manager.getByRole('menuitem', { name: 'Export chat as JSONL' }).click();
  const file = await download;
  const path = await file.path();
  if (!path) throw new Error('Missing transcript download');
  const buffer = await readFile(path);
  const filename = file.suggestedFilename();
  expect(filename).toBe('Main.jsonl');
  expect(buffer.toString()).not.toContain('Original reply 5.');
  const importButtonFor = (kind: 'branch' | 'chat') => kind === 'branch'
    ? manager.getByRole('button', { name: 'Import', exact: true })
    : page.getByRole('button', { name: 'Import chat from JSONL', exact: true });
  const chooseDownload = async (kind: 'branch' | 'chat', pickerScreenshot?: string) => {
    const name = `Import ${kind} from JSONL`;
    const button = importButtonFor(kind);
    const review = page.getByRole('dialog', { name });
    if ((page.viewportSize()?.width ?? 0) > 800) {
      await button.click();
      const drop = review.getByRole('button', { name: 'Drop file here or click to browse' });
      await expect(drop).toBeVisible();
      if (pickerScreenshot) await page.screenshot({ path: pickerScreenshot });
      const transfer = await page.evaluateHandle(({ filename, bytes }) => {
        const files = new DataTransfer();
        files.items.add(new File([Uint8Array.from(bytes)], filename, { type: 'application/jsonl' }));
        return files;
      }, { filename, bytes: Array.from(buffer) });
      try { await drop.dispatchEvent('drop', { dataTransfer: transfer }); }
      finally { await transfer.dispose(); }
    } else {
      const picker = page.waitForEvent('filechooser');
      await button.click();
      await (await picker).setFiles({ name: filename, mimeType: 'application/jsonl', buffer });
    }
    await expect(review.getByText(filename, { exact: true })).toBeVisible();
    await expect(review.getByText('11 messages · 6 turns')).toBeVisible();
    return review;
  };

  const appearanceUrl = '/api/application/appearance';
  async function checkReviewSizes(kind: 'branch' | 'chat') {
    const importButton = importButtonFor(kind);
    for (const theme of ['dark', 'light', 'midnight-black'] as const) {
      const current = appearanceStatusSchema.parse(await page.request.get(appearanceUrl).then(response => response.json()));
      await command(appearanceUrl, { revision: current.revision, settings: { ...current.settings, theme } }, 'PUT');
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      for (const width of [1280, 801, 800, 390, 320]) {
        await page.setViewportSize({ width, height: 850 });
        if (width === 1280) {
          await importButton.click();
          await expect(page.getByRole('button', { name: 'Drop file here or click to browse' })).toBeVisible();
          await page.mouse.click(2, 2);
          if (kind === 'branch') await expect(manager).toBeVisible();
          await expect(importButton).toBeFocused();
        }
        const review = await chooseDownload(kind, width === 1280 ? testInfo.outputPath(`picker-${kind}-${theme}.png`) : undefined);
        await expect(review.getByRole('heading')).toBeFocused();
        await expect(review.getByRole('button', { name: 'Import', exact: true })).toBeInViewport();
        expect(await review.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
        if (width === 1280 || width === 390) await page.screenshot({ path: testInfo.outputPath(`import-${kind}-${theme}-${width}.png`) });
        if (width === 1280 || width === 390) await page.mouse.click(2, 2);
        else await page.keyboard.press('Escape');
        await expect(review).toHaveCount(0);
        if (kind === 'branch') await expect(manager).toBeVisible();
        await expect(importButton).toBeFocused();
      }
    }
    await page.setViewportSize({ width: 1280, height: 850 });
  }
  await checkReviewSizes('branch');
  expect((await library()).chats.filter(branch => branch.groupId === sourceId)).toHaveLength(1);
  const branchReview = await chooseDownload('branch');
  await expect(branchReview.getByText(settings.title, { exact: false }).first()).toBeVisible();
  await branchReview.getByLabel('Branch name').fill('Imported lighthouse');
  let lostId: string | undefined;
  let requestId: string | undefined;
  await page.route('**/api/chat-groups/*/branches/import', async route => {
    const response = await route.fetch();
    if (lostId) {
      expect(route.request().postDataJSON().requestId).toBe(requestId);
      await route.fulfill({ response });
    } else {
      expect(response.ok()).toBe(true);
      lostId = (await response.json()).id;
      requestId = route.request().postDataJSON().requestId;
      await route.abort();
    }
  });
  await branchReview.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(branchReview.getByRole('alert')).toContainText('Could not confirm');
  await expect(branchReview.getByLabel('Branch name')).toBeDisabled();
  await branchReview.getByRole('button', { name: 'Retry import' }).click();
  await expect(branchReview).toHaveCount(0);
  const conversation = page.getByRole('region', { name: 'Conversation' });
  await expect(conversation).toContainText('The lantern flickers.');
  const siblings = (await library()).chats.filter(branch => branch.groupId === sourceId);
  expect(siblings).toHaveLength(2);
  const branchId = siblings.find(branch => branch.branchName === 'Imported lighthouse')?.id;
  if (!branchId) throw new Error('Missing imported branch');
  expect(branchId).toBe(lostId);
  const savedBranch = await state(branchId);
  expect(plainTurns(savedBranch)).toEqual(plainTurns(source));
  expect(savedBranch.generations).toEqual([]);
  expect(savedBranch.settings.authorNote).toBeUndefined();
  expect(savedBranch.context.archivedTurnIds).toEqual([]);
  expect(await state(sourceId)).toEqual(source);
  await openChats();
  await expect(sourceCard).toHaveCount(1);
  await sourceCard.click();
  await openChatTool(page, 'Chat branches');
  await expect(manager.getByRole('button', { name: 'Imported lighthouse', exact: true })).toHaveAttribute('aria-current', 'true');
  await page.keyboard.press('Escape');

  await openChats();
  await checkReviewSizes('chat');
  const chatReview = await chooseDownload('chat');
  await expect(chatReview.getByLabel('Chat title')).toHaveValue(filename.replace(/\.jsonl$/, ''));
  await chatReview.getByLabel('Chat title').fill('A new lighthouse');
  await chatReview.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.getByLabel('Chat title')).toHaveValue('A new lighthouse');
  const savedChats = (await library()).chats.filter(branch => branch.title === 'A new lighthouse');
  expect(savedChats).toHaveLength(1);
  expect(savedChats[0]).toMatchObject({ groupId: savedChats[0].id, branchName: null });
  expect(plainTurns(await state(savedChats[0].id))).toEqual(plainTurns(source));
  expect(await providerRequests()).toHaveLength(before);
  await page.getByRole('button', { name: 'Story', exact: true }).click();
  await page.getByLabel('Your next turn').fill('I open the shutters.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(async () => (await state(savedChats[0].id)).turns.at(-1)?.complete).toBe(true);
  expect((await state(savedChats[0].id)).turns).toHaveLength(turns.length + 1);
  await openChats();
  await sourceCard.click();
  await expect(conversation).toContainText('The lantern flickers.');
  await page.getByLabel('Your next turn').fill('I climb the stairs.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(async () => (await state(branchId)).turns.length).toBe(turns.length + 1);
  await expect.poll(async () => (await state(branchId)).turns.at(-1)?.complete).toBe(true);
  expect(await state(sourceId)).toEqual(source);
});
