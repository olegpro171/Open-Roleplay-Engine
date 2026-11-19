import { expect, mergeTests, type Locator } from '@playwright/test';
import { test as appearanceTest } from './appearance-test';
import { test as isolatedTest } from './isolated-app';
import type { Appearance } from '../../src/shared/appearance';

export const test = mergeTests(isolatedTest, appearanceTest);
const scrollTop = (scroller: Locator) => scroller.evaluate(node => node.scrollTop);
const distanceFromEnd = (scroller: Locator) => scroller.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop);

export function checkStoryScroll(theme: Appearance['theme'], width: number) {
  test(`Story releases scroll follow during reasoning and reply in ${theme} at ${width}px`, async ({ page, request, setAppearance, browserApp }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/');
    await page.getByLabel('Owner password').fill('browser-synthetic-password');
    await page.getByRole('button', { name: 'Create owner account', exact: true }).click();
    await setAppearance({ theme, showReasoningDuringGeneration: true });
    const command = async (url: string, data: unknown) => {
      const response = await page.request.post(url, { headers: { Origin: browserApp.url }, data });
      expect(response.ok(), await response.text()).toBe(true);
      return response.json();
    };
    const { revision } = await page.request.get('/api/library').then(response => response.json());
    const { endpoint } = await request.get('/__test/endpoint').then(response => response.json());
    const connection = await command('/api/library', { revision, kind: 'connections', data: {
      name: 'Stream scroll test', model: 'synthetic-roleplay', endpoint, contextWindow: 100000, maxOutputTokens: 1000, customParameters: {},
    } });
    const chat = await command('/api/chats', { title: 'Stream scroll test', targetInputTokens: 10000,
      connectionId: connection.id, promptId: 'default', characterId: null, personaId: null });
    await page.evaluate(id => localStorage.setItem('roleplay-chat', id), chat.id);
    await page.reload();
    await request.post('/__test/mode', { data: { mode: 'scroll-stream' } });
    await page.getByLabel('Your next turn').fill('I look for the lantern.\n\n'.repeat(30));
    await page.getByRole('button', { name: 'Send', exact: true }).click();

    const story = page.locator('.transcript');
    const reasoning = page.getByLabel('Latest model reasoning', { exact: true });
    const reply = story.locator('.part.assistant > .prose');
    const latest = page.getByRole('button', { name: 'Latest turn', exact: true });
    const advance = async () => { expect((await request.post('/__test/finish')).ok()).toBe(true); };
    const scrollUp = async (pixels: number) => {
      const readingTop = await scrollTop(story) - pixels;
      await story.hover();
      await page.mouse.wheel(0, -pixels);
      await expect.poll(() => scrollTop(story)).toBeCloseTo(readingTop, 0);
      return readingTop;
    };

    await expect(reasoning).toContainText('Reasoning line 80');
    await expect.poll(() => distanceFromEnd(story)).toBeLessThan(2);
    const reasoningTop = await scrollUp(16);
    await advance();
    await expect(reasoning).toContainText('The newest thought');
    expect(await scrollTop(story)).toBeCloseTo(reasoningTop, 0);
    await story.getByRole('button', { name: 'More turn actions', exact: true }).click({ trial: true });
    await page.screenshot({ path: testInfo.outputPath('paused-reasoning.png') });

    await advance();
    await expect(reply).toContainText('First response section');
    await expect(reasoning).toHaveCount(0);
    expect(await scrollTop(story)).toBeCloseTo(reasoningTop, 0);
    await expect(latest).toBeInViewport();
    await latest.click();

    await advance();
    await expect(reply).toContainText('Second response section');
    await expect.poll(() => distanceFromEnd(story)).toBeLessThan(2);
    const responseTop = await scrollUp(24);
    await advance();
    await expect(reply).toContainText('Third response section');
    expect(await scrollTop(story)).toBeCloseTo(responseTop, 0);
    await expect(latest).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath('paused-reply.png') });

    await story.hover();
    await page.mouse.wheel(0, 4000);
    await expect.poll(() => distanceFromEnd(story)).toBeLessThan(2);
    await expect(latest).toHaveCount(0);
    await advance();
    await expect(reply).toContainText('Fourth response section');
    await expect.poll(() => distanceFromEnd(story)).toBeLessThan(2);
    await advance();
    await expect(story.getByRole('button', { name: 'Regenerate', exact: true })).toBeEnabled();
    await expect.poll(() => distanceFromEnd(story)).toBeLessThan(2);
  });
}
