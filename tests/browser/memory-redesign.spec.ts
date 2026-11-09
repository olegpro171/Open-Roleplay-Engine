import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { appearanceStatusSchema } from '../../src/shared/appearance';
import type { ChatSnapshot } from '../../src/shared/contracts';
import { defaultContextPreset } from '../../src/shared/context';
import type { LibrarySnapshot } from '../../src/shared/library';
import type { StorySnapshot } from '../../src/shared/transcript';
import { createCompactPrompt } from './compact-prompt';
import { openChatTool } from './chat-tools';
import { test } from './isolated-app';

async function inspectReview(page: Page, review: Locator, testInfo: TestInfo, url: string, cancelName = 'Cancel', screenshot = 'impact') {
  for (const theme of ['dark', 'light', 'midnight-black'] as const) {
    const current = appearanceStatusSchema.parse(await page.request.get('/api/application/appearance').then(response => response.json()));
    const response = await page.request.put('/api/application/appearance', {
      headers: { Origin: url }, data: { revision: current.revision, settings: { ...current.settings, theme } },
    });
    expect(response.ok(), await response.text()).toBe(true);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      const cancel = review.getByRole('button', { name: cancelName, exact: true });
      await cancel.scrollIntoViewIfNeeded();
      await expect(cancel).toBeInViewport();
      expect(await review.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
      await review.screenshot({ path: testInfo.outputPath(`${screenshot}-${theme}-${width}.png`) });
    }
  }
}

async function memoryStory(page: Page, url: string, title: string, length: number) {
  const headers = { Origin: url };
  const read = async <T>(path: string): Promise<T> => {
    const response = await page.request.get(path);
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const write = async <T>(method: string, path: string, data: unknown): Promise<T> => {
    const response = await page.request.fetch(path, { method, headers, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  await page.goto('/');
  await page.getByLabel('Owner password').fill('browser-synthetic-password');
  await page.getByRole('button', { name: 'Create owner account', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible();
  const promptId = await createCompactPrompt(page);
  const { endpoint } = await read<{ endpoint: string }>('/__test/endpoint');
  const library = () => read<LibrarySnapshot>('/api/library');
  const connection = await write<{ id: string }>('POST', '/api/library', {
    revision: (await library()).revision, kind: 'connections',
    data: { name: title, endpoint, model: 'synthetic-roleplay', contextWindow: 100_000, maxOutputTokens: 1000, customParameters: {} },
  });
  const preset = await write<{ id: string }>('POST', '/api/library', {
    revision: (await library()).revision, kind: 'contexts',
    data: { ...defaultContextPreset, name: `${title} preset`, minTail: 2, batchSize: 2, promotionGroup: 2 },
  });
  const { id } = await write<{ id: string }>('POST', '/api/chats', {
    title, targetInputTokens: 200, connectionId: connection.id, contextPresetId: preset.id, promptId,
    characterId: null, personaId: null,
  });
  const path = `/api/chats/${id}`;
  const state = () => read<ChatSnapshot>(path);
  await write('PUT', `/api/__test/transcripts/${id}`, {
    revision: (await state()).revision,
    turns: Array.from({ length }, (_, index) => ({
      user: `Turn ${index + 1}. ${'Mira carries the silver key. '.repeat(8)}`,
      assistant: 'Leon waits beside the tower. '.repeat(12).trim(),
      complete: true,
    })),
  });
  await page.evaluate(chatId => localStorage.setItem('roleplay-chat', chatId), id);
  await page.reload();
  await expect(page.getByLabel('Your next turn')).toBeVisible();
  return { path, state, read, write, library, presetId: preset.id };
}

test('Story tracks and stops regeneration outside the transcript window and reviews a preset change', async ({ page, browserApp }, testInfo) => {
  const title = 'Regeneration memory';
  const { path, state, read, write, library, presetId } = await memoryStory(page, browserApp.url, title, 170);
  const transcript = page.locator('.transcript');
  const latestTurn = page.getByRole('article', { name: 'Turn 170', exact: true });
  await expect(latestTurn).toBeAttached();
  for (const ordinal of [116, 76, 36]) {
    await transcript.evaluate(node => { node.scrollTop = 0; });
    await expect(transcript.locator('.turn').first()).toHaveAttribute('aria-label', `Turn ${ordinal}`);
  }
  await expect(latestTurn).toHaveCount(0);
  const before = await state();
  const latest = before.turns.at(-1)!;
  await page.request.post('/__test/mode', { data: { mode: 'hold-first-token' } });
  const { generationId } = await write<{ generationId: string }>('POST', `${path}/turns/${latest.id}/regenerate`, {
    revision: before.revision, requestId: crypto.randomUUID(),
  });
  const progress = page.locator('.memory-preparation-status');
  const calls = () => read<unknown[]>('/__test/requests');
  await expect(progress).toContainText('Preparing memory for Regenerate');
  await expect(progress).toContainText(/Estimated committed input [\d,]+ tokens/);
  await expect(progress).toContainText('Step 1 · Summarize oldest turns');
  await expect.poll(async () => (await calls()).length).toBe(1);
  const first = (await read<StorySnapshot>(`${path}/story`)).preparation?.working;
  expect(first?.inputTokens).toBeLessThan((await write<{ budget: { inputTokens: number } }>('POST', `${path}/preview`, {
    revision: (await state()).revision, inspection: true, detail: 'estimate',
  })).budget.inputTokens);

  await page.request.post('/__test/finish');
  await expect(progress).toContainText('Generating…');
  await page.request.post('/__test/finish');
  await expect(progress).toContainText('Step 2 · Summarize oldest turns');
  await expect.poll(async () => (await calls()).length).toBe(2);
  const second = (await read<StorySnapshot>(`${path}/story`)).preparation?.working;
  expect(second?.inputTokens).toBeLessThan(first?.inputTokens ?? 0);
  expect(second?.targetInputTokens).toBe(200);
  await expect(progress).toContainText(`Estimated working input ${second?.inputTokens.toLocaleString('en')} / 200 target tokens`);
  await expect(latestTurn).toHaveCount(0);
  await expect(progress.getByRole('button', { name: 'Stop', exact: true })).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('regeneration-preparation.png') });
  await progress.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(progress).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: 'The selected response was kept' })).toBeVisible();
  await page.request.post('/__test/finish');
  const stopped = await state();
  expect(stopped.generations.find(generation => generation.id === generationId)?.status).toBe('cancelled');
  expect(stopped.turns.at(-1)?.assistant).toEqual(latest.assistant);
  expect(stopped.context.selected).toEqual(before.context.selected);
  expect(stopped.context.summaries).toHaveLength(1);
  expect(await calls()).toHaveLength(2);

  const summary = stopped.context.summaries[0];
  await openChatTool(page, 'Inspect memory');
  await expect(page.getByTestId('memory-status')).toHaveText('Next: reuse a saved level 1 summary.');
  const retained = page.locator(`[data-summary-id="${summary.id}"]`);
  const proposed = page.locator('.summary-span.preparing');
  await expect(retained).toHaveClass(/retained/);
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    const savedBox = await retained.boundingBox();
    const nextBox = await proposed.boundingBox();
    if (!savedBox || !nextBox) throw new Error('Missing the exact saved replacement and its next-step outline');
    expect(nextBox.x).toBeCloseTo(savedBox.x, 0);
    expect(nextBox.width).toBeCloseTo(savedBox.width, 0);
    expect(nextBox.y + nextBox.height / 2).toBeCloseTo(savedBox.y + savedBox.height / 2, 0);
  }
  const correction = 'The key was always copper, even before Leon arrived.';
  await write('PATCH', `${path}/context/summaries/${summary.id}`, {
    revision: stopped.revision, summaryRevision: summary.revision, text: correction,
  });
  await page.getByRole('button', { name: 'Edit context preset', exact: true }).click();
  const batch = page.getByLabel('Turns per batch', { exact: true });
  await batch.fill('3');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'Review memory changes', exact: true });
  await expect(review).toContainText(title);
  await expect(review).toContainText('1 summary will be discarded.');
  await expect(review).toContainText(correction);
  await inspectReview(page, review, testInfo, browserApp.url);
  await review.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(batch).toHaveValue('3');
  expect((await library()).contexts.find(item => item.id === presetId)?.batchSize).toBe(2);
  expect((await state()).context.summaries).toHaveLength(2);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await review.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(review).toHaveCount(0);
  await expect.poll(async () => (await library()).contexts.find(item => item.id === presetId)?.batchSize).toBe(3);
  expect((await state()).context.summaries).toEqual([]);
  expect(await calls()).toHaveLength(2);
});

test('latest-turn deletion previews restored turns and an approved correction', async ({ page, browserApp }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { path, state, read, write } = await memoryStory(page, browserApp.url, 'Review turn deletion', 4);
  await write('POST', `${path}/context/prepare`, { revision: (await state()).revision, requestId: crypto.randomUUID(), mode: 'step' });
  await expect.poll(async () => (await state()).context.jobs[0]?.status).toBe('succeeded');
  const before = await state();
  const summary = before.context.summaries[0];
  const correction = 'Mira carried the brass lantern through the gate.';
  await write('PATCH', `${path}/context/summaries/${summary.id}`, {
    revision: before.revision, summaryRevision: summary.revision, text: correction,
  });
  const turn = page.getByRole('article', { name: 'Turn 4', exact: true });
  const menuButton = turn.getByRole('button', { name: 'More turn actions', exact: true });
  const review = page.getByRole('dialog', { name: 'Delete turn?', exact: true });
  const openReview = async () => {
    await menuButton.click();
    await page.getByRole('menuitem', { name: 'Delete turn', exact: true }).click();
    await expect(review).toContainText('2 surviving turns will return to verbatim history.');
    await expect(review).toContainText('1 summary will be discarded.');
    await expect(review).toContainText(correction);
  };
  await openReview();
  await review.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(menuButton).toBeFocused();
  expect((await state()).turns).toHaveLength(4);
  expect((await state()).context.archivedTurnIds).toEqual(before.context.archivedTurnIds);
  await openReview();
  await inspectReview(page, review, testInfo, browserApp.url);
  await review.getByRole('button', { name: 'Delete turn', exact: true }).click();
  await expect(turn).toHaveCount(0);
  expect((await state()).turns).toHaveLength(3);
  expect((await state()).context.archivedTurnIds).toEqual([]);
  expect((await state()).context.summaries).toEqual([]);
  expect(await read<unknown[]>('/__test/requests')).toHaveLength(1);
});

test('Send pauses for deletion review, survives reload, and resumes only after confirmation', async ({ page, browserApp }, testInfo) => {
  const { path, state, read, write } = await memoryStory(page, browserApp.url, 'Preparation deletion', 8);
  const before = await state();
  const calls = () => read<unknown[]>('/__test/requests');
  await page.request.post('/__test/mode', { data: { mode: 'hold-first-token' } });
  await write('POST', `${path}/turns/${before.turns.at(-1)?.id}/regenerate`, {
    revision: before.revision, requestId: crypto.randomUUID(),
  });
  await expect.poll(async () => (await calls()).length).toBe(1);
  await page.request.post('/__test/finish');
  await expect(page.locator('.memory-preparation-status')).toContainText('Generating…');
  await page.request.post('/__test/finish');
  await expect.poll(async () => (await calls()).length).toBe(2);
  await page.locator('.memory-preparation-status').getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.locator('.memory-preparation-status')).toHaveCount(0);
  await page.request.post('/__test/mode', { data: { mode: 'normal' } });

  const stopped = await state();
  const [summary] = stopped.context.summaries;
  const correction = 'Mira promised Ada the spare key.';
  await write('PATCH', `${path}/context/summaries/${summary.id}`, {
    revision: stopped.revision, summaryRevision: summary.revision, text: correction,
  });
  const edited = await state();
  const { title, connectionId, promptId, characterId, personaId, contextPresetId, lorebookId } = edited.settings;
  await write('PUT', `${path}/selections`, { revision: edited.revision, settings: {
    title, connectionId, promptId, characterId, personaId, contextPresetId, lorebookId, targetInputTokens: 20_000,
  } });
  await page.reload();
  await page.getByLabel('Your next turn').fill('Leon asks for the key.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const reviewLink = page.getByRole('button', { name: 'Review deletion', exact: true });
  await expect(reviewLink).toBeVisible();
  expect(await calls()).toHaveLength(2);
  await page.reload();
  await inspectReview(page, page.locator('.memory-preparation-status'), testInfo, browserApp.url, 'Review deletion', 'waiting');
  await reviewLink.click();
  const review = page.getByRole('region', { name: 'Summary deletion preview', exact: true });
  await expect(review).toContainText(correction);
  await expect(page.locator(`[data-summary-id="${summary.id}"]`)).toHaveClass(/deleting/);
  await inspectReview(page, review, testInfo, browserApp.url, 'Decline and stop');
  await review.getByRole('button', { name: 'Decline and stop', exact: true }).click();
  await expect(review).toHaveCount(0);
  expect((await state()).context.summaries.map(node => node.id)).toContain(summary.id);
  expect((await state()).turns.at(-1)?.complete).toBe(false);
  expect(await calls()).toHaveLength(2);

  await page.getByRole('button', { name: 'Return to chat', exact: true }).click();
  await page.getByRole('button', { name: 'Retry response', exact: true }).click();
  await reviewLink.click();
  await review.getByRole('button', { name: 'Delete and continue', exact: true }).click();
  await expect(review).toHaveCount(0);
  await expect.poll(async () => (await state()).turns.at(-1)?.complete).toBe(true);
  expect((await state()).context.summaries).toEqual([]);
  expect(await calls()).toHaveLength(3);
});
