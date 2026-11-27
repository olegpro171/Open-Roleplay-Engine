import { expect } from '@playwright/test';
import { test } from './isolated-app';
import { setupScene } from './scene-fixture';

for (const width of [1440, 390]) {
  test(`Story scrolls to the window edge as the composer changes height at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 760 });
    const draft = page.getByRole('textbox', { name: 'Your next turn' });
    const scene = await setupScene(page);
    await scene.write(`/api/__test/transcripts/${scene.chatId}`, {
      revision: (await scene.state()).revision,
      turns: Array.from({ length: 5 }, (_, index) => ({
        user: `I ask about the brass key at stop ${index + 1}.`,
        assistant: 'The keeper waits by the lantern.\n\n'.repeat(24),
        complete: true,
      })),
    }, 'PUT');
    await page.reload();

    const transcript = page.locator('.transcript');
    const composer = page.locator('form.composer');
    const lastActions = page.getByRole('article', { name: 'Turn 5', exact: true })
      .getByRole('button', { name: 'More turn actions', exact: true });
    await expect(lastActions).toBeAttached();
    const edgeGaps = () => transcript.evaluate(node => {
      const rect = node.getBoundingClientRect();
      return [innerWidth - rect.right, innerHeight - rect.bottom].map(Math.round);
    });
    const scrollTop = () => transcript.evaluate(node => node.scrollTop);
    const distanceFromEnd = () => transcript.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop);
    const expectLastActionsClear = async () => {
      await expect.poll(edgeGaps).toEqual([0, 0]);
      await expect.poll(distanceFromEnd).toBeLessThanOrEqual(1);
      const fieldTop = await composer.evaluate(node => node.getBoundingClientRect().top);
      expect(await lastActions.evaluate(node => node.getBoundingClientRect().bottom)).toBeLessThan(fieldTop);
      await lastActions.click({ trial: true });
    };
    await expectLastActionsClear();

    const initialFieldHeight = await draft.evaluate(node => node.clientHeight);
    await draft.fill('I wait beside the lantern.\n'.repeat(10));
    expect(await draft.evaluate(node => node.clientHeight)).toBeGreaterThan(initialFieldHeight + 100);
    await expectLastActionsClear();

    const end = await scrollTop();
    await transcript.hover();
    await page.mouse.wheel(0, -400);
    await expect.poll(scrollTop).toBeLessThan(end - 300);
    const readingTop = await scrollTop();
    await draft.clear();
    await expect.poll(edgeGaps).toEqual([0, 0]);
    expect(await scrollTop()).toBeCloseTo(readingTop, 0);
    await page.getByRole('button', { name: 'Latest turn', exact: true }).click();
    await expectLastActionsClear();

    await page.getByRole('button', { name: 'Composer actions' }).click();
    await page.getByRole('menuitem', { name: 'Impersonate' }).click();
    const suggestion = page.getByRole('region', { name: 'Suggested turn' });
    await expect(suggestion.getByRole('button', { name: 'Use draft', exact: true })).toBeEnabled();
    await expectLastActionsClear();
    const suggestionTop = await suggestion.evaluate(node => node.getBoundingClientRect().top);
    expect(await lastActions.evaluate(node => node.getBoundingClientRect().bottom)).toBeLessThan(suggestionTop);
    await page.setViewportSize({ width, height: 360 });
    await draft.fill('I wait beside the lantern.\n'.repeat(15));
    await expect.poll(edgeGaps).toEqual([0, 0]);
    expect(await page.evaluate(() => [window.scrollX, window.scrollY])).toEqual([0, 0]);
  });
}
