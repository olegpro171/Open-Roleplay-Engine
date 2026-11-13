import { readFile } from 'node:fs/promises';
import { expect } from '@playwright/test';
import { summaryFileSchema } from '../../src/shared/summary-file';
import { compactPrompt } from '../support/compact-prompt';
import { seedTranscript } from '../support/transcript-fixture';
import { openChatTool } from './chat-tools';
import { test } from './isolated-app';

test('downloads, reviews and replaces branch memory with edited JSON', async ({ page, browserApp }, testInfo) => {
  const { store, url } = browserApp;
  const headers = { Origin: url };
  const { endpoint } = await page.request.get('/__test/endpoint').then(response => response.json());
  const connectionId = store.saveLibrary(store.libraryRevision(), 'connections', {
    name: 'Synthetic', endpoint, model: 'synthetic-summary', contextWindow: 100_000, maxOutputTokens: 1_000, customParameters: {},
  });
  store.saveLibrary(store.libraryRevision(), 'prompts', compactPrompt, 'default');
  store.updateChat(store.chatHeader('main').revision, 'main', {
    title: 'Summary file story', targetInputTokens: 500, connectionId, promptId: 'default',
    contextPresetId: 'default-context', characterId: null, personaId: null, lorebookId: null,
  });
  seedTranscript(store, store.chatHeader('main').revision, 'main', Array.from({ length: 12 }, (_, index) => ({
    user: `Mira offers Leon a brass key in turn ${index + 1}. ${'Lanterns flicker along the passage. '.repeat(14)}`,
    assistant: 'Leon promises to return it by dawn.', complete: true,
  })));
  await page.goto('/');
  await page.getByLabel('Owner password').fill('browser-synthetic-password');
  await page.getByRole('button', { name: 'Create owner account', exact: true }).click();
  await openChatTool(page, 'Inspect memory');
  await page.getByRole('button', { name: 'Save next summary', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Inspect saved summary' })).toBeVisible();
  const before = store.engineSnapshot('main');
  expect(before.context.summaries).toHaveLength(1);
  const requests = async () => page.request.get('/__test/requests').then(response => response.json());
  const originalRequests = await requests();

  const download = page.waitForEvent('download');
  const exportButton = page.getByRole('button', { name: 'Export summaries', exact: true });
  await exportButton.click();
  const attachment = await download;
  expect(attachment.suggestedFilename()).toBe('Main-summaries.json');
  const file = summaryFileSchema.parse(JSON.parse(await readFile(await attachment.path(), 'utf8')));
  expect(file.summaries).toHaveLength(1);
  file.summaries[0].text = 'Mira lends Leon a silver key. He must return it before the first bell.';

  const importButton = page.getByRole('button', { name: 'Import summaries', exact: true });
  const input = page.getByLabel('Summary JSON file', { exact: true });
  const review = page.getByRole('dialog', { name: 'Replace saved summaries?' });
  const choose = async (contents: string, width: number) => {
    const chooser = page.waitForEvent('filechooser');
    await importButton.click();
    if (width > 800) await page.getByRole('button', { name: 'Drop file here or click to browse' }).click();
    await (await chooser).setFiles({ name: 'edited-summaries.json', mimeType: 'application/json', buffer: Buffer.from(contents) });
  };
  const appearancePath = '/api/application/appearance';
  for (const theme of ['dark', 'light', 'midnight-black']) {
    const appearance = await page.request.get(appearancePath).then(response => response.json());
    const changed = await page.request.put(appearancePath, { headers, data: {
      revision: appearance.revision, settings: { ...appearance.settings, theme },
    } });
    expect(changed.ok(), await changed.text()).toBe(true);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 850 });
      await expect(exportButton).toBeVisible();
      await expect(importButton).toBeVisible();
      await choose(JSON.stringify(file), width);
      await expect(review.getByText('Saved versions in this branch: 1. Versions in the file: 1.')).toBeVisible();
      await expect(review.getByText('3 turns will be covered by the selected summaries.')).toBeVisible();
      await expect(review.getByRole('button', { name: 'Replace summaries' })).toBeEnabled();
      const box = await review.boundingBox();
      expect(box?.x).toBeGreaterThanOrEqual(0);
      expect((box?.x ?? width) + (box?.width ?? width)).toBeLessThanOrEqual(width);
      await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`${theme}-${width}-summary-import.png`) });
      await review.getByRole('button', { name: 'Cancel' }).click();
      await expect(review).toHaveCount(0);
      expect(store.engineSnapshot('main').context).toEqual(before.context);
    }
  }
  await input.setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{') });
  await expect(review.getByRole('alert')).toContainText('Check its syntax');
  await expect(review.getByRole('button', { name: 'Replace summaries' })).toHaveCount(0);
  await review.getByRole('button', { name: 'Cancel' }).click();

  await choose(JSON.stringify(file), 390);
  await review.getByRole('button', { name: 'Replace summaries' }).click();
  await expect(review).toHaveCount(0);
  await expect(page.getByText('Summaries replaced.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Repair summaries', exact: true })).toBeDisabled();
  const after = store.engineSnapshot('main');
  expect(after.context.summaries.map(node => node.text)).toEqual([file.summaries[0].text]);
  expect(after.context.archivedTurnIds).toEqual(before.context.archivedTurnIds);
  expect(after.turns).toEqual(before.turns);
  expect(await requests()).toEqual(originalRequests);
});
