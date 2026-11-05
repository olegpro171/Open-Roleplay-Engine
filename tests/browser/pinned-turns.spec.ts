import { expect } from '@playwright/test';
import { test } from './isolated-app';
import { openChatTool } from './chat-tools';
import { appearanceStatusSchema } from '../../src/shared/appearance';
import type { RequestEstimate } from '../../src/shared/contracts';
import { defaultContextPreset } from '../../src/shared/context';
import { defaultPrompt, type LibrarySnapshot } from '../../src/shared/library';
import type { StorySnapshot } from '../../src/shared/transcript';

test('manages and jumps to off-page pins with stable estimates and prompt warnings', async ({ page, browserApp }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await page.getByLabel('Owner password').fill('browser-synthetic-password');
  await page.getByRole('button', { name: 'Create owner account', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible();
  const headers = { Origin: browserApp.url };
  const command = async (method: string, url: string, data: unknown) => {
    const response = await page.request.fetch(url, { method, headers, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const library = () => page.request.get('/api/library').then(response => response.json() as Promise<LibrarySnapshot>);
  const { endpoint } = await page.request.get('/__test/endpoint').then(response => response.json());
  const connection = await command('POST', '/api/library', { revision: (await library()).revision, kind: 'connections',
    data: { name: 'Pin proof', endpoint, model: 'synthetic-roleplay', contextWindow: 20_000, maxOutputTokens: 100, customParameters: {} },
  });
  const savePrompt = async (name: string, state: 'enabled' | 'missing' | 'disabled') => command('POST', '/api/library', {
    revision: (await library()).revision, kind: 'prompts', data: { name, blocks: defaultPrompt.blocks
      .filter(block => block.id === 'messages' || block.id === 'pinned-messages' && state !== 'missing')
      .map(block => ({ ...block, enabled: block.id === 'messages' || state === 'enabled' })) },
  });
  const enabled = await savePrompt('With Pinned messages', 'enabled');
  const missing = await savePrompt('Without Pinned messages', 'missing');
  await savePrompt('Disabled Pinned messages', 'disabled');
  const { id } = await command('POST', '/api/chats', { title: 'Pin proof story', targetInputTokens: 6000, connectionId: connection.id,
    promptId: enabled.id, characterId: null, personaId: null, contextPresetId: null,
  });
  const story = () => page.request.get(`/api/chats/${id}/story`).then(response => response.json() as Promise<StorySnapshot>);
  const archivedPhrase = 'A silver key lies under the stairs.';
  await command('PUT', `/api/chats/${id}/history`, { revision: (await story()).revision, turns: Array.from({ length: 42 }, (_, index) => ({
    user: `Visit ${index + 1}`, assistant: index === 2 ? archivedPhrase : `Answer ${index + 1}`, complete: true,
  })) });
  const oldPage = await page.request.get(`/api/chats/${id}/story?limit=42`).then(response => response.json() as Promise<StorySnapshot>);
  const oldTurnId = oldPage.page.turns[2].id;
  const oldPinPath = `/api/chats/${id}/turns/${oldTurnId}/pin`;
  await command('PUT', oldPinPath, { revision: oldPage.revision, pinned: true });
  const fork = await command('POST', `/api/chats/${id}/branches`, { revision: (await story()).revision,
    through: oldPage.page.turns[1].id, name: 'Before the key', requestId: crypto.randomUUID() });
  await page.evaluate(chat => localStorage.setItem('roleplay-chat', chat), id);
  await page.reload();
  const turn = (ordinal: number) => page.getByRole('article', { name: `Turn ${ordinal}`, exact: true });
  await expect(turn(3)).toHaveCount(0);
  await turn(42).getByRole('button', { name: 'Pin', exact: true }).click();
  await expect(turn(42).getByRole('button', { name: 'Unpin', exact: true })).toBeVisible();

  const manager = page.getByRole('dialog', { name: 'Pinned turns', exact: true });
  const open = () => openChatTool(page, 'Pinned turns');
  const search = manager.getByRole('searchbox', { name: 'Search pinned turns' });
  const older = manager.getByRole('article').filter({ hasText: archivedPhrase });
  await open();
  await expect(manager.getByRole('heading', { name: 'Pinned turns' })).toBeFocused();
  await expect(manager.getByRole('article')).toHaveCount(2);
  const estimate = await command('POST', `/api/chats/${id}/preview`, { revision: (await story()).revision, detail: 'estimate', inspection: true }) as RequestEstimate;
  expect(estimate.allocations.pinned).toBeGreaterThan(0);
  await expect(manager.getByRole('meter')).toHaveAttribute('aria-valuenow', String(estimate.budget.inputTokens));
  await expect(manager.locator('.allocation-legend')).toContainText('Pinned turns');
  await search.fill('SILVER KEY');
  await expect(manager.getByRole('article')).toHaveCount(1);

  async function keepEstimateDuring(change: () => Promise<void>, pinned: boolean) {
    const meter = manager.getByRole('meter');
    const budget = manager.locator('.pinned-budget');
    const oldValue = await meter.getAttribute('aria-valuenow');
    const oldHeight = await budget.evaluate(node => node.getBoundingClientRect().height);
    let release = () => {};
    let requested = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route(`**/api/chats/${id}/preview`, async route => {
      const response = await route.fetch();
      requested = true;
      await gate;
      await route.fulfill({ response });
    }, { times: 1 });
    try {
      await change();
      await expect(older.getByRole('button', { name: pinned ? 'Unpin' : 'Pin', exact: true })).toBeVisible();
      await expect.poll(() => requested).toBe(true);
      await expect(meter).toHaveAttribute('aria-valuenow', oldValue ?? '', { timeout: 1000 });
      expect(await budget.evaluate(node => node.getBoundingClientRect().height)).toBe(oldHeight);
    } finally { release(); }
  }

  // Simulate the first mutation losing its revision race. Keep confirmed state
  // and retry the same desired change after the read reconciles.
  await page.route('**' + oldPinPath, async route => {
    await route.fulfill({ status: 409, json: { code: 'revision_conflict', message: 'This branch changed. Try the pin again.' } });
  }, { times: 1 });
  await older.getByRole('button', { name: 'Unpin', exact: true }).click();
  const failure = manager.getByRole('alert').filter({ hasText: 'This branch changed.' });
  await expect(failure).toBeVisible();
  await expect(older.getByRole('button', { name: 'Unpin', exact: true })).toBeVisible();
  await keepEstimateDuring(() => failure.getByRole('button', { name: 'Retry', exact: true }).click(), false);
  await expect(older.getByText('Unpinned', { exact: true })).toBeVisible();
  await expect.poll(async () => Number(await manager.getByRole('meter').getAttribute('aria-valuenow'))).toBeLessThan(estimate.budget.inputTokens);
  await keepEstimateDuring(() => older.getByRole('button', { name: 'Pin', exact: true }).press('Enter'), true);
  await expect(manager.getByRole('meter')).toHaveAttribute('aria-valuenow', String(estimate.budget.inputTokens));
  await older.getByRole('button', { name: 'Turn 3', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(manager).toHaveCount(0);
  await expect(turn(3)).toBeFocused();
  await expect(turn(3)).toBeInViewport();
  await expect(page.locator('.transcript .turn')).toHaveCount(15);

  const warning = page.getByRole('region', { name: 'Prompt configuration warnings' });
  const warningText = 'This branch has pinned turns, but the selected prompt has no enabled Pinned messages marker.';
  await openChatTool(page, 'Chat settings');
  const prompt = page.getByRole('combobox', { name: 'Prompt preset' });
  async function choose(name: string) {
    await prompt.click();
    await page.getByRole('option', { name, exact: true }).click();
  }
  await choose('Disabled Pinned messages');
  await expect(warning).toContainText(warningText);
  expect((await story()).settings.promptId).toBe(enabled.id);
  await choose('Without Pinned messages');
  await expect(warning).toContainText(warningText);
  await page.getByRole('button', { name: 'Save and return', exact: true }).click();
  await expect.poll(async () => (await story()).settings.promptId).toBe(missing.id);
  await expect(page.getByRole('button', { name: 'Chat settings', exact: true })).toContainText('(1)');
  await page.getByRole('textbox', { name: 'Your next turn' }).fill('I return to the stairs.');
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
  await page.getByRole('textbox', { name: 'Your next turn' }).clear();
  await open();
  await expect(older).toContainText('Omitted · marker unavailable');
  await manager.getByRole('button', { name: 'Close Pinned turns' }).click();
  await openChatTool(page, 'Chat settings');
  await expect(warning).toContainText(warningText);
  await choose('With Pinned messages');
  await page.getByRole('button', { name: 'Save and return', exact: true }).click();
  await expect.poll(async () => (await story()).settings.promptId).toBe(enabled.id);

  for (const theme of ['dark', 'light', 'midnight-black'] as const) {
    const appearance = appearanceStatusSchema.parse(await page.request.get('/api/application/appearance').then(response => response.json()));
    await command('PUT', '/api/application/appearance', { revision: appearance.revision, settings: { ...appearance.settings, theme } });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    for (const width of [1280, 801, 800, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await open();
      await expect(manager.getByRole('heading', { name: 'Pinned turns' })).toBeFocused();
      await expect(manager.getByRole('meter')).toBeVisible();
      await expect(older.getByText('Included in the pinned block', { exact: true })).toHaveCount(0);
      const title = older.getByRole('button', { name: 'Turn 3', exact: true });
      const action = older.getByRole('button', { name: 'Unpin', exact: true });
      await expect(action).toBeVisible();
      await expect(action.locator('svg')).toBeVisible();
      const [headingBox, actionBox] = await Promise.all([title.boundingBox(), action.boundingBox()]);
      if (!headingBox || !actionBox) throw new Error('Missing pin row controls');
      expect(Math.abs(headingBox.y + headingBox.height / 2 - actionBox.y - actionBox.height / 2)).toBeLessThan(1);
      expect(actionBox.x).toBeGreaterThan(headingBox.x);
      expect(await manager.evaluate(node => node.getBoundingClientRect().width <= innerWidth
        && node.querySelector('.branch-manager-results')!.scrollWidth <= node.querySelector('.branch-manager-results')!.clientWidth)).toBe(true);
      if (width === 1280 || width === 390) await page.screenshot({ path: testInfo.outputPath(`pins-${theme}-${width}.png`) });
      await page.keyboard.press('Escape');
      await expect(manager).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Pinned turns', exact: true })).toBeFocused();
    }
  }
  await open();
  await older.getByRole('button', { name: 'Unpin', exact: true }).click();
  await expect(older.getByText('Unpinned', { exact: true })).toBeVisible();
  await command('DELETE', `/api/chats/${id}/turns/${oldTurnId}`, { revision: (await story()).revision });
  await older.getByRole('button', { name: 'Turn 3', exact: true }).click();
  await expect(manager.getByRole('alert')).toContainText('Could not open this turn');
  await manager.getByRole('button', { name: 'Close Pinned turns' }).click();
  await open();
  await expect(older).toHaveCount(0);
  await expect(manager.getByRole('article')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await openChatTool(page, 'Chat branches');
  await page.getByRole('button', { name: 'Before the key', exact: true }).click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('roleplay-chat'))).toBe(fork.id);
  await open();
  await expect(manager.getByText('No pinned turns in this branch.')).toBeVisible();
  const calls = await page.request.get('/__test/requests').then(response => response.json());
  expect(calls).toEqual([]);
});

test('an over-target managed request with pins prepares on Send without a Story panel', async ({ page, browserApp }) => {
  await page.goto('/');
  await page.getByLabel('Owner password').fill('browser-synthetic-password');
  await page.getByRole('button', { name: 'Create owner account', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible();
  const headers = { Origin: browserApp.url };
  const command = async (method: string, url: string, data: unknown) => {
    const response = await page.request.fetch(url, { method, headers, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const libraryRevision = async () => (await page.request.get('/api/library').then(response => response.json() as Promise<LibrarySnapshot>)).revision;
  const { endpoint } = await page.request.get('/__test/endpoint').then(response => response.json());
  const connection = { name: 'Story model', endpoint, model: 'synthetic-roleplay', contextWindow: 20_000, maxOutputTokens: 100, customParameters: {} };
  const storyModel = await command('POST', '/api/library', { revision: await libraryRevision(), kind: 'connections', data: connection });
  const summaryModel = await command('POST', '/api/library', { revision: await libraryRevision(), kind: 'connections',
    data: { ...connection, name: 'Memory model', model: 'synthetic-summary' },
  });
  const context = await command('POST', '/api/library', { revision: await libraryRevision(), kind: 'contexts',
    data: { ...defaultContextPreset, name: 'Pinned context', batchSize: 2, minTail: 1, connectionId: summaryModel.id },
  });
  const prompt = await command('POST', '/api/library', { revision: await libraryRevision(), kind: 'prompts',
    data: { name: 'Managed pins', blocks: defaultPrompt.blocks.filter(block => ['summary', 'pinned-messages', 'messages'].includes(block.id)) },
  });
  const { id } = await command('POST', '/api/chats', { title: 'Managed pinned story', targetInputTokens: 400, connectionId: storyModel.id,
    promptId: prompt.id, contextPresetId: context.id, characterId: null, personaId: null,
  });
  const story = () => page.request.get(`/api/chats/${id}/story`).then(response => response.json() as Promise<StorySnapshot>);
  await command('PUT', `/api/chats/${id}/history`, { revision: (await story()).revision, turns: [
    { user: 'The keeper searches the cellar. '.repeat(100), assistant: 'The door is still locked.', complete: true },
    { user: 'I look for the missing key. '.repeat(100), assistant: 'The stairs are lit.', complete: true },
    { user: 'I hand you a brass key.', assistant: 'I promise to return it.', complete: true },
  ] });
  const before = await story();
  await command('PUT', `/api/chats/${id}/turns/${before.page.turns[2].id}/pin`, { revision: before.revision, pinned: true });
  await page.evaluate(branch => localStorage.setItem('roleplay-chat', branch), id);
  await page.reload();
  await page.getByRole('textbox', { name: 'Your next turn' }).fill('I open the door.');
  await expect(page.locator('.story-meta dd.over-limit')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Conversation' }).getByRole('status')).toHaveCount(0);
  await openChatTool(page, 'Request inspector');
  const inspector = page.getByRole('region', { name: 'Request inspector' });
  await expect(inspector.getByRole('meter')).toHaveClass(/overflow/);
  await expect(inspector.getByRole('button', { name: 'Pinned turns', exact: true })).toHaveCount(0);
  await inspector.getByRole('button', { name: 'Prompt peek', exact: true }).click();
  const peek = page.getByRole('dialog', { name: 'Prompt peek', exact: true });
  await expect(peek.locator('.allocation-legend')).toContainText('Pinned turns');
  await expect(peek.getByText('Pinned turns shows the dedicated block.', { exact: false })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Return to chat', exact: true }).click();

  const calls = () => page.request.get('/__test/requests').then(response => response.json() as Promise<{ body: { model: string } }[]>);
  expect(await calls()).toEqual([]);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(async () => (await story()).latestGeneration?.status).toBe('succeeded');
  expect((await calls()).map(call => call.body.model)).toEqual(['synthetic-summary', 'synthetic-roleplay']);
  expect((await story()).memory.archivedCount).toBe(2);
});
