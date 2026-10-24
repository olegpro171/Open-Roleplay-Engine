import { test, expect, devices, type Page } from '@playwright/test';
import type { ChatSnapshot, RequestPreview } from '../../src/shared/contracts';
import { chatBehaviorStatusSchema, defaultChatBehavior } from '../../src/shared/chat-behavior';
import { defaultContextPreset } from '../../src/shared/context';
import { openChatTool } from './chat-tools';

const headers = { Origin: 'http://127.0.0.1:4173' };
const behaviorUrl = '/api/application/chat-behavior';
async function preferences(page: Page) {
  return chatBehaviorStatusSchema.parse(await page.request.get(behaviorUrl).then(response => response.json()));
}

for (const device of ['desktop', 'phone'] as const) test.describe(`automatic memory ${device}`, () => {
  if (device === 'phone') {
    const { userAgent, viewport, isMobile, hasTouch } = devices['iPhone 13'];
    test.use({ userAgent, viewport, isMobile, hasTouch });
  }
  test('prepares after replies, preserves drafts while Send is locked, and uses the response status before generation', async ({ page }) => {
    const session = await page.request.get('/api/session').then(response => response.json());
    await page.goto('/');
    await page.getByLabel('Owner password').fill('browser-synthetic-password');
    await page.getByRole('button', { name: session.setupRequired ? 'Create owner account' : 'Sign in', exact: true }).click();
    await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible();
    const initial = await preferences(page);
    const updateBehavior = async (settings: typeof initial.settings) => {
      const current = await preferences(page);
      const response = await page.request.put(behaviorUrl, { headers, data: { revision: current.revision, settings } });
      expect(response.ok(), await response.text()).toBe(true);
    };
    const post = async (url: string, data: unknown) => {
      const response = await page.request.post(url, { headers, data });
      expect(response.ok(), await response.text()).toBe(true);
      return response.json();
    };
    let chatId: string | undefined;
    try {
      await updateBehavior({ ...defaultChatBehavior, autoRetryMemory: false });
      await page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'Chat behavior', exact: true }).click();
      const region = page.getByRole('region', { name: 'Chat behavior', exact: true });
      await expect(region.getByRole('checkbox', { name: 'Allow input size to overshoot target' })).toBeChecked();
      const threshold = region.getByLabel('Overshoot threshold (tokens)', { exact: true });
      await expect(threshold).toHaveValue('100');
      await threshold.fill('200');
      await expect.poll(async () => (await preferences(page)).settings.maximumOvershootTokens).toBe(200);
      await region.getByRole('checkbox', { name: 'Allow input size to overshoot target' }).uncheck();
      await expect(threshold).toBeDisabled();
      await region.getByRole('checkbox', { name: 'Allow input size to overshoot target' }).check();
      await expect(threshold).toHaveValue('200');
      await expect.poll(async () => (await preferences(page)).settings.allowInputOvershoot).toBe(true);

      const { endpoint } = await page.request.get('/__test/endpoint').then(response => response.json());
      const libraryRevision = async () => (await page.request.get('/api/library').then(response => response.json())).revision;
      const connection = { name: `Auto memory ${device}`, endpoint, model: 'synthetic-roleplay', contextWindow: 100_000, maxOutputTokens: 1_000, customParameters: {} };
      const story = await post('/api/library', { revision: await libraryRevision(), kind: 'connections', data: connection });
      const summary = await post('/api/library', { revision: await libraryRevision(), kind: 'connections', data: { ...connection, name: `Auto summaries ${device}`, model: 'synthetic-summary' } });
      const preset = await post('/api/library', { revision: await libraryRevision(), kind: 'contexts', data: { ...defaultContextPreset, name: `Automatic ${device}`, connectionId: summary.id, minTail: 2, batchSize: 2, promotionGroup: 2, retainedPerLevel: 1 } });
      const selections = { title: `Automatic memory ${device}`, targetInputTokens: 20_000, connectionId: story.id, contextPresetId: preset.id, promptId: 'default', characterId: null, personaId: null };
      const chat = await post('/api/chats', selections);
      chatId = chat.id;
      const state = () => page.request.get(`/api/chats/${chat.id}`).then(response => response.json() as Promise<ChatSnapshot>);
      const imported = await page.request.put(`/api/chats/${chat.id}/history`, { headers, data: { revision: (await state()).revision, turns: Array.from({ length: 8 }, (_, index) => ({ user: `Mira offers the key, turn ${index}. ` + 'The cellar remains closed. '.repeat(12), assistant: 'Leon waits by the door. '.repeat(12), complete: true })) } });
      expect(imported.ok(), await imported.text()).toBe(true);
      const text = 'Mira opens the door.';
      const preview: RequestPreview = await post(`/api/chats/${chat.id}/preview`, { revision: (await state()).revision, text, inspection: true });
      const setTarget = async (targetInputTokens: number) => {
        const response = await page.request.put(`/api/chats/${chat.id}/selections`, { headers, data: { revision: (await state()).revision, settings: { ...selections, targetInputTokens } } });
        expect(response.ok(), await response.text()).toBe(true);
      };
      await setTarget(preview.budget.inputTokens - 10);
      // Use the ordinary library selection to open the newly created chat.
      await page.reload();
      await page.getByRole('button', { name: 'Libraries', exact: true }).click();
      await page.getByRole('button', { name: 'Chats', exact: true }).click();
      await page.getByRole('article').filter({ has: page.getByRole('heading', { name: selections.title, exact: true }) }).click();
      await page.getByRole('button', { name: 'Story', exact: true }).click();
      const composer = page.getByRole('textbox', { name: 'Your next turn', exact: true });
      const send = page.getByRole('button', { name: 'Send', exact: true });
      expect((await state()).context.jobs).toEqual([]);
      await page.request.post('/__test/mode', { data: { mode: 'hold' } });
      await composer.fill(text);
      await send.click();
      await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
      await expect(page.locator('.memory-preparation-status')).toHaveCount(0);
      await page.request.post('/__test/finish');
      await expect(page.locator('.memory-preparation-status')).toHaveText('Preparing memory…');
      await expect(send).toBeDisabled();
      await expect(composer).toBeEditable();
      await composer.fill('My next draft stays available.');
      const saved = await state();
      expect(saved.generations[0].status).toBe('succeeded');
      expect(saved.context.jobs[0]).toMatchObject({ automatic: true, generationId: null, status: 'running' });
      await page.screenshot({ path: `test-results/${device}-background-memory.png` });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await openChatTool(page, 'Inspect memory');
      await page.getByRole('button', { name: 'Stop preparation', exact: true }).click();
      await page.getByRole('button', { name: 'Return to chat', exact: true }).click();
      await expect(page.locator('.memory-preparation-status')).toHaveCount(0);
      await expect(send).toBeEnabled();
      await expect(composer).toHaveValue('My next draft stays available.');
      expect((await state()).generations[0].status).toBe('succeeded');

      await updateBehavior({ ...defaultChatBehavior, allowInputOvershoot: false, autoRetryMemory: false });
      await page.request.post('/__test/mode', { data: { mode: 'hold-first-token' } });
      await send.click();
      await expect(page.locator('.part.assistant').last()).toContainText('Preparing memory…');
      await expect(page.locator('.memory-preparation-status')).toHaveCount(0);
      await expect(page.locator('.composer')).not.toContainText('Preparing memory');
      await expect(page.locator('.composer').locator(':scope > *')).toHaveCount(2);
      await expect(composer).toBeEditable();
      await composer.fill('Draft during preparation.');
      await page.screenshot({ path: `test-results/${device}-before-response-memory.png` });
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(page.locator('.part.assistant').last()).not.toContainText('Preparing memory…');
      await expect(composer).toHaveValue('Draft during preparation.');
    } finally {
      if (chatId) {
        const state: ChatSnapshot = await page.request.get(`/api/chats/${chatId}`).then(response => response.json());
        for (const generation of state.generations.filter(value => value.status === 'running')) await page.request.post(`/api/generations/${generation.id}/cancel`, { headers, data: {} });
        for (const job of state.context.jobs.filter(value => value.status === 'running' && !value.generationId)) await page.request.post(`/api/context/jobs/${job.id}/cancel`, { headers, data: {} });
      }
      await page.request.post('/__test/finish');
      await page.request.post('/__test/mode', { data: { mode: 'normal' } });
      await updateBehavior(initial.settings);
    }
  });
});
