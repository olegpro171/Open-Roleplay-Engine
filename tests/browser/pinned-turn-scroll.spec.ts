import { expect } from '@playwright/test';
import { test } from './isolated-app';
import { openChatTool } from './chat-tools';
import type { StorySnapshot } from '../../src/shared/transcript';

test.use({ browserName: 'webkit' });

for (const width of [1280, 390]) {
  test(`keeps Story chrome fixed when jumping at ${width}px`, async ({ page, browserApp }) => {
    await page.setViewportSize({ width, height: 720 });
    await page.goto('/');
    await page.getByLabel('Owner password').fill('browser-synthetic-password');
    await page.getByRole('button', { name: 'Create owner account', exact: true }).click();
    await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible();

    const headers = { Origin: browserApp.url };
    const readStory = (limit: number) => page.request.get(`/api/chats/main/story?limit=${limit}`).then(response => response.json() as Promise<StorySnapshot>);
    const history = await page.request.put('/api/__test/transcripts/main', { headers, data: {
      revision: (await readStory(1)).revision,
      turns: Array.from({ length: 42 }, (_, index) => ({
        user: `I ask about the brass key at stop ${index + 1}.`,
        assistant: 'The keeper waits by the lantern. '.repeat(16), complete: true,
      })),
    } });
    expect(history.ok(), await history.text()).toBe(true);
    const before = await readStory(42);
    for (const ordinal of [34, 3]) {
      const pin = await page.request.put(`/api/chats/main/turns/${before.page.turns[ordinal - 1].id}/pin`, {
        headers, data: { revision: (await readStory(1)).revision, pinned: true },
      });
      expect(pin.ok(), await pin.text()).toBe(true);
    }
    await page.reload();
    const turn = (ordinal: number) => page.getByRole('article', { name: `Turn ${ordinal}`, exact: true });
    const draft = page.getByRole('textbox', { name: 'Your next turn' });
    await draft.fill('A draft to keep while reading.');
    await expect(turn(34)).toBeAttached();
    await expect(turn(3)).toHaveCount(0);
    await turn(42).getByText(/^The keeper waits by the lantern\./).click();
    await expect(turn(42), 'clicking the prose does not focus the turn').not.toBeFocused();

    const shellPosition = () => page.evaluate(() => ({
      documentScroll: [window.scrollX, window.scrollY, document.body.scrollTop, document.documentElement.scrollTop],
      headerTop: document.querySelector('.topbar')?.getBoundingClientRect().top,
      composerBottom: document.querySelector('.composer')?.getBoundingClientRect().bottom,
    }));
    const initial = await shellPosition();
    expect(initial.documentScroll).toEqual([0, 0, 0, 0]);
    const transcript = page.locator('.transcript');
    for (const ordinal of [34, 3]) {
      const previousTop = await transcript.evaluate(element => element.scrollTop);
      await openChatTool(page, 'Pinned turns');
      const manager = page.getByRole('dialog', { name: 'Pinned turns' });
      const excerpt = manager.getByText(`I ask about the brass key at stop ${ordinal}.`, { exact: true });
      await excerpt.scrollIntoViewIfNeeded();
      const box = await excerpt.boundingBox();
      if (!box) throw new Error('Missing pin excerpt');
      // Click the card's prose to exercise the stretched title button.
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await expect(manager).toHaveCount(0);
      await expect(turn(ordinal)).toBeAttached();
      await expect(turn(ordinal), 'jumping to a pin does not focus the turn').not.toBeFocused();
      if (width <= 800) {
        const details = page.getByRole('button', { name: 'Chat details' });
        await expect(details).toHaveAttribute('aria-expanded', 'false');
        await expect(details).toBeFocused();
      }
      expect(await shellPosition()).toEqual(initial);
      const transcriptTop = await transcript.evaluate(element => element.getBoundingClientRect().top);
      const targetTop = await turn(ordinal).evaluate(element => element.getBoundingClientRect().top);
      expect(Math.abs(targetTop - transcriptTop)).toBeLessThanOrEqual(1);
      expect(await transcript.evaluate(element => element.scrollTop)).not.toBe(previousTop);
      await expect(draft).toHaveValue('A draft to keep while reading.');
    }
    await page.getByRole('button', { name: 'Latest turn' }).click();
    await expect(turn(42)).toBeInViewport();
    expect(await shellPosition()).toEqual(initial);

    const version = turn(42).getByRole('textbox', { name: 'Response version' });
    await version.press('Enter');
    await expect(version).toBeFocused();
  });
}
