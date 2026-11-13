import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { appearanceStatusSchema } from '../../src/shared/appearance';
import type { ChatSnapshot } from '../../src/shared/contracts';
import { defaultContextPreset, type ContextPlan } from '../../src/shared/context';
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

test('updates Memory and Chat Details while preparation is waiting on the next summary', async ({ page, browserApp }) => {
  const { path, state, read, write } = await memoryStory(page, browserApp.url, 'Live memory selection', 12);
  const plan = () => read<ContextPlan>(`${path}/context/plan`);
  const calls = () => read<unknown[]>('/__test/requests');
  const initial = await plan();
  await openChatTool(page, 'Inspect memory');
  const sidebarEstimate = page.locator('.chat-details dl > div').filter({ has: page.getByText('Estimated input', { exact: true }) }).locator('dd');
  const memoryEstimate = page.getByText(/^Estimated input: [\d,]+ \/ 200$/);
  const format = (input: number) => input.toLocaleString('en');
  await expect(sidebarEstimate).toHaveText(format(initial.inputTokens));
  await expect(memoryEstimate).toHaveText(`Estimated input: ${format(initial.inputTokens)} / 200`);

  await page.request.post('/__test/mode', { data: { mode: 'hold' } });
  await page.getByRole('button', { name: 'Prepare chat', exact: true }).click();
  await expect.poll(async () => (await calls()).length).toBe(1);
  await page.request.post('/__test/finish');
  await expect.poll(async () => (await calls()).length).toBe(2);
  const active = await state();
  const progress = await plan();
  expect(active.context.jobs[0].status).toBe('running');
  expect(active.context.archivedTurnIds).toEqual(active.turns.slice(0, 2).map(turn => turn.id));
  expect(progress.inputTokens).toBeLessThan(initial.inputTokens);
  expect(progress.inputTokens).toBeGreaterThan(progress.targetInputTokens);

  const toggle = page.getByRole('button', { name: 'Chat details', exact: true });
  for (const theme of ['dark', 'light', 'midnight-black'] as const) {
    const appearance = appearanceStatusSchema.parse(await read<unknown>('/api/application/appearance'));
    await write('PUT', '/api/application/appearance', { revision: appearance.revision, settings: { ...appearance.settings, theme } });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(memoryEstimate).toBeVisible();
      await expect(memoryEstimate).toHaveText(`Estimated input: ${format(progress.inputTokens)} / 200`);
      if (width === 390) await toggle.click();
      await expect(sidebarEstimate).toBeVisible();
      await expect(sidebarEstimate).toHaveText(format(progress.inputTokens));
      if (width === 390) await toggle.click();
    }
  }

  await page.getByRole('button', { name: 'Stop preparation', exact: true }).click();
  await expect.poll(async () => (await state()).context.jobs[0].status).toBe('cancelled');
  expect((await state()).context.selected).toEqual(active.context.selected);
  await expect(memoryEstimate).toHaveText(`Estimated input: ${format(progress.inputTokens)} / 200`);
  expect(await calls()).toHaveLength(2);
});

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
  await expect(progress.getByRole('status')).toHaveText(/^Preparing memory…\s*Estimated input [\d,]+ \/ 200 tokens\s*Connecting…$/);
  const popupInset = async () => {
    const notice = await progress.boundingBox(), scrollArea = await transcript.boundingBox();
    if (!notice || !scrollArea) throw new Error('Missing preparation popup or transcript');
    return notice.y - scrollArea.y;
  };
  await expect.poll(popupInset).toBeLessThan(24);
  await expect.poll(async () => (await calls()).length).toBe(1);
  const first = (await read<StorySnapshot>(`${path}/story`)).preparation?.working;
  expect(first?.inputTokens).toBeLessThan((await write<{ budget: { inputTokens: number } }>('POST', `${path}/preview`, {
    revision: (await state()).revision, inspection: true, detail: 'estimate',
  })).budget.inputTokens);

  await page.request.post('/__test/finish');
  await expect(progress).toContainText('Generating…');
  await page.request.post('/__test/finish');
  await expect.poll(async () => (await calls()).length).toBe(2);
  const second = (await read<StorySnapshot>(`${path}/story`)).preparation?.working;
  expect(second?.inputTokens).toBeLessThan(first?.inputTokens ?? 0);
  expect(second?.targetInputTokens).toBe(200);
  await expect(progress).toContainText(`Estimated input ${second?.inputTokens.toLocaleString('en')} / 200 tokens`);
  await expect(latestTurn).toHaveCount(0);
  await expect(progress.getByRole('button', { name: 'Stop', exact: true })).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('regeneration-preparation.png') });
  const storyRoute = '**/api/chats/*/story?*';
  await page.route(storyRoute, route => new URL(route.request().url()).searchParams.get('shift') === '-40'
    ? route.fulfill({ status: 503, json: { message: 'Synthetic history loading failure' } }) : route.continue());
  await transcript.evaluate(node => { node.scrollTop = 0; });
  await expect(page.getByRole('alert')).toContainText('Synthetic history loading failure');
  const loadOlder = transcript.getByRole('button', { name: 'Load older turns', exact: true });
  await loadOlder.click({ trial: true });
  await transcript.evaluate(node => { node.scrollTop = 300; });
  await expect.poll(popupInset).toBeLessThan(24);
  await page.unroute(storyRoute);
  await progress.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(progress).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: 'The selected response was kept' })).toHaveCount(0);
  await page.request.post('/__test/finish');
  const stopped = await state();
  expect(stopped.generations.find(generation => generation.id === generationId)?.status).toBe('cancelled');
  expect(stopped.turns.at(-1)?.assistant).toEqual(latest.assistant);
  expect(stopped.context.selected).toEqual(before.context.selected);
  expect(stopped.context.summaries).toHaveLength(1);
  expect(await calls()).toHaveLength(2);

  const summary = stopped.context.summaries[0];
  await openChatTool(page, 'Inspect memory');
  await expect(page.getByRole('button', { name: 'Save next summary', exact: true })).toBeEnabled();
  await expect(page.getByTestId('memory-status')).toHaveCount(0);
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

test('keeps inactive summaries when Story deletes an unrelated latest turn', async ({ page, browserApp }) => {
  const { path, state, read, write } = await memoryStory(page, browserApp.url, 'Keep saved memory', 7);
  const prepare = async (mode: 'step' | 'prepare') => {
    const { jobId } = await write<{ jobId: string }>('POST', `${path}/context/prepare`, {
      revision: (await state()).revision, requestId: crypto.randomUUID(), mode,
    });
    await expect.poll(async () => (await state()).context.jobs.find(job => job.id === jobId)?.status).toBe('succeeded');
  };
  await prepare('step');
  await prepare('step');
  const prepared = await state();
  expect(prepared.context.selected).toHaveLength(2);
  const { title, connectionId, promptId, characterId, personaId, contextPresetId, lorebookId } = prepared.settings;
  await write('PUT', `${path}/selections`, {
    revision: prepared.revision,
    settings: { title, connectionId, promptId, characterId, personaId, contextPresetId, lorebookId, targetInputTokens: 20_000 },
  });
  await prepare('prepare');
  const before = await state();
  expect(before.context.selected).toEqual([]);
  expect(before.context.summaries).toEqual(prepared.context.summaries);
  await page.reload();

  const last = page.getByRole('article', { name: 'Turn 7', exact: true });
  await last.getByRole('button', { name: 'More turn actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Delete turn', exact: true }).click();
  await page.getByRole('dialog', { name: 'Delete turn?', exact: true }).getByRole('button', { name: 'Delete turn', exact: true }).click();
  await expect(last).toHaveCount(0);
  const after = await state();
  expect(after.turns).toEqual(before.turns.slice(0, -1));
  expect(after.context.summaries).toEqual(before.context.summaries);
  expect(await read<unknown[]>('/__test/requests')).toHaveLength(2);
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
    await menuButton.press('Enter');
    await page.keyboard.press('End');
    await expect(page.getByRole('menuitem', { name: 'Delete turn', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(review).toContainText('2 surviving turns will return to verbatim history.');
    await expect(review).toContainText('1 summary will be discarded.');
    await expect(review).toContainText(correction);
  };
  await openReview();
  await review.getByRole('button', { name: 'Cancel', exact: true }).press('Enter');
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
  const { path, state, read, write, library, presetId } = await memoryStory(page, browserApp.url, 'Preparation deletion', 8);
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
  const lib = await library();
  const savedPreset = lib.contexts.find(item => item.id === presetId);
  if (!savedPreset) throw new Error('Missing preparation preset');
  const { id: _id, revision: _revision, ...preset } = savedPreset;
  // The correction intersects the protected tail, so replay requires explicit review.
  await write('PUT', `/api/library/${presetId}`, { revision: lib.revision, kind: 'contexts', data: { ...preset, minTail: 8 } });
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
  await expect(page.locator('.memory-preparation-status').getByRole('status')).toContainText('Preparation is waiting for deletion review.');
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

test('keeps the Memory view in place when switching summaries and localizes authority', async ({ page, browserApp }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 950 });
  const { state, write } = await memoryStory(page, browserApp.url, 'Memory inspection switch', 120);
  await openChatTool(page, 'Inspect memory');
  const saveNext = page.getByRole('button', { name: 'Save next summary', exact: true });
  for (const count of [1, 2]) {
    await saveNext.click();
    await expect.poll(async () => (await state()).context.selected.length).toBe(count);
  }
  const picker = page.getByRole('combobox', { name: 'Inspect saved summary', exact: true });
  await picker.click();
  const list = page.getByRole('listbox', { name: 'Inspect saved summary', exact: true });
  await list.getByRole('option').nth(1).click();
  const authority = page.getByTestId('summary-authority');
  await expect(authority).toHaveText('Represented directly in the saved model input.');
  await page.getByRole('button', { name: 'Edit summary', exact: true }).click();
  const edit = page.getByRole('textbox', { name: 'Summary text', exact: true });
  const original = await edit.inputValue();
  await edit.fill('Unsaved edit in the first summary.');
  await picker.click();
  const before = await page.locator('.memory-panel').evaluate(node => node.scrollTop);
  await list.getByRole('option').nth(2).click();
  await expect(edit).toHaveCount(0);
  expect(Math.abs(await page.locator('.memory-panel').evaluate(node => node.scrollTop) - before)).toBeLessThanOrEqual(2);
  const timeline = page.getByLabel('Layered memory timeline', { exact: true });
  await timeline.getByRole('button').first().click();
  await expect(timeline.getByRole('button').first()).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('region', { name: 'Summary text', exact: true })).toHaveText(original);

  for (const theme of ['dark', 'light', 'midnight-black'] as const) {
    const response = await page.request.get('/api/application/appearance');
    const appearance = appearanceStatusSchema.parse(await response.json());
    await write('PUT', '/api/application/appearance', { revision: appearance.revision, settings: { ...appearance.settings, theme } });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const settings = page.getByRole('group', { name: 'Preparation settings', exact: true });
    const save = settings.getByRole('button', { name: 'Save', exact: true });
    const inputTarget = settings.getByLabel('Input target', { exact: true });
    await expect(save).toBeDisabled();
    for (const width of [1280, 801, 800, 390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      const close = page.getByRole('button', { name: 'Return to chat', exact: true });
      await expect(close).toBeInViewport();
      if (width <= 800) {
        const heading = page.getByRole('region', { name: 'Memory', exact: true }).getByRole('heading', { level: 1 });
        const textRight = await heading.evaluate(element => {
          const range = document.createRange();
          range.selectNodeContents(element);
          return range.getBoundingClientRect().right;
        });
        const bounds = await close.boundingBox();
        expect(textRight).toBeLessThanOrEqual(bounds?.x ?? 0);
      }
      await expect.poll(async () => {
        const [inputBox, saveBox] = await Promise.all([inputTarget.boundingBox(), save.boundingBox()]);
        if (!inputBox || !saveBox) return false;
        return Math.abs(saveBox.x + saveBox.width - inputBox.x - inputBox.width) < 2;
      }).toBe(width <= 800);
      await settings.screenshot({ path: testInfo.outputPath(`memory-settings-${theme}-${width}.png`) });
    }
    await page.setViewportSize({ width: 620, height: 844 });
    await expect(timeline.getByRole('img', { name: /^Turns 1–4/ })).toBeVisible();
    await expect(timeline.getByRole('button').first()).toHaveCSS('border-top-width', '1px');
    await expect(timeline.getByRole('button').last()).toHaveCSS('border-top-width', '1px');
    await timeline.screenshot({ path: testInfo.outputPath(`summary-timeline-${theme}-620.png`) });

    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      if (width === 390) {
        await expect(timeline.locator('.summary-band')).toHaveCount(1);
        await expect(timeline.getByRole('button')).toHaveCount(2);
        const zoom = page.getByRole('checkbox', { name: 'Zoom timeline', exact: true });
        await zoom.check();
        await expect(timeline.getByRole('button').first()).toHaveText('1–2');
        await zoom.uncheck();
        await expect(timeline.locator('.summary-band')).toHaveCount(1);
      } else {
        await expect(timeline.getByRole('button').first()).toHaveCSS('border-top-width', '1px');
      }
      await page.getByRole('button', { name: 'Edit summary', exact: true }).click();
      expect((await edit.boundingBox())?.height).toBeGreaterThanOrEqual(300);
      await page.screenshot({ path: testInfo.outputPath(`summary-editor-${theme}-${width}.png`) });
      await page.getByRole('button', { name: 'Cancel edit', exact: true }).click();
      const clear = page.locator('details.restore-memory');
      await clear.locator('summary').click();
      const deleteMemory = clear.getByRole('button', { name: 'Clear memory', exact: true });
      await page.mouse.move(0, 0);
      const background = await deleteMemory.evaluate(button => {
        const probe = document.createElement('span');
        probe.style.backgroundColor = 'var(--danger-button)';
        button.append(probe);
        const color = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return color;
      });
      await expect(deleteMemory).toHaveCSS('background-color', background);
      await deleteMemory.click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('button', { name: 'Clear memory', exact: true })).toHaveCSS('background-color', background);
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await clear.locator('summary').click();
    }
  }
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('combobox', { name: 'Interface language', exact: true }).click();
  await page.getByRole('option', { name: 'Русский', exact: true }).click();
  await page.getByRole('button', { name: 'История', exact: true }).click();
  await page.getByRole('button', { name: 'О чате', exact: true }).click();
  await page.getByRole('button', { name: 'Просмотр памяти', exact: true }).click();
  const settings = page.getByRole('group', { name: 'Настройки подготовки', exact: true });
  const save = settings.getByRole('button', { name: 'Сохранить', exact: true });
  const editPreset = settings.getByRole('button', { name: 'Изменить пресет', exact: true });
  await page.setViewportSize({ width: 320, height: 844 });
  await expect(save).toBeDisabled();
  const [saveBox, editBox] = await Promise.all([save.boundingBox(), editPreset.boundingBox()]);
  if (!saveBox || !editBox) throw new Error('Missing the memory settings buttons');
  expect(saveBox.y).toBeLessThan(editBox.y + editBox.height);
  await settings.screenshot({ path: testInfo.outputPath('russian-memory-settings-320.png') });
  const summaryPicker = page.getByRole('combobox', { name: 'Просмотр сохранённой сводки', exact: true });
  await summaryPicker.click();
  await page.getByRole('listbox', { name: 'Просмотр сохранённой сводки', exact: true }).getByRole('option').nth(1).click();
  await expect(authority).toHaveText('Входит напрямую в сохранённый вход модели.');
});
