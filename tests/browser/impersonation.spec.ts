import { devices, expect } from '@playwright/test';
import { themeSchema } from '../../src/shared/appearance';
import { defaultPrompt } from '../../src/shared/library';
import { test } from './isolated-app';
import { setupScene } from './scene-fixture';
import { selectLibraryCategory } from './library-card-helpers';

test('drafts, retries with edited guidance, replaces the draft and sends exactly once', async ({ page }) => {
  const f = await setupScene(page, 'Mira waits by the dock.');
  const composer = page.getByRole('textbox', { name: 'Your next turn' });
  const menu = page.getByRole('button', { name: 'Composer actions' });
  const panel = page.getByRole('region', { name: 'Suggested turn' });
  const reply = 'The lantern flickers. 🕯';
  const guidance = 'Stall Mira. Keep {{char}} literal.';
  await composer.fill(guidance);
  await f.setMode('hold');
  await menu.focus();
  await page.keyboard.press('ArrowUp');
  await page.getByRole('menuitem', { name: 'Impersonate' }).press('Enter');
  await expect(panel.getByText('The lantern', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await composer.fill('Ask what she wants.');
  await page.reload();
  await expect(panel.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
  await expect(composer).toHaveValue('Ask what she wants.');
  await f.write('/__test/finish', {});
  await expect(panel.getByText(reply, { exact: true })).toBeVisible();
  expect((await f.calls())[0].body.messages.at(-1)).toEqual({
    role: 'system', content: defaultPrompt.impersonateInstruction?.replaceAll('{{user}}', 'You').replace('{{draft}}', guidance),
  });
  expect((await f.state()).turns).toHaveLength(1);
  await f.setMode('empty');
  await panel.getByRole('button', { name: 'Next suggestion' }).click();
  await expect(panel.getByText('The model returned an empty suggestion.')).toBeVisible();
  await expect(panel.getByText(reply, { exact: true })).toBeVisible();
  await f.setMode('markdown');
  await panel.getByRole('button', { name: 'Next suggestion' }).click();
  await expect(panel.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
  await expect.poll(async () => (await f.calls()).length).toBe(3);
  await f.write('/__test/finish', {});
  await panel.getByRole('button', { name: 'Previous suggestion' }).click();
  await expect(panel.getByText(reply, { exact: true })).toBeVisible();
  const version = panel.getByRole('textbox', { name: 'Suggestion version', exact: true });
  await expect(version).toHaveValue('1');
  await panel.getByRole('button', { name: 'Next suggestion' }).click();
  await expect(version).toHaveValue('2');
  await expect(panel.getByText(/Mara says/)).toBeVisible();
  await version.fill('1');
  await version.press('Enter');
  await expect(panel.getByText(reply, { exact: true })).toBeVisible();
  expect(await f.calls()).toHaveLength(3);
  expect((await f.calls())[2].body.messages.at(-1)?.content).toContain('Ask what she wants.');
  await panel.getByRole('button', { name: 'Replace draft' }).click();
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue(reply);
  await expect(panel).toHaveCount(0);
  await page.reload();
  await expect(composer).toHaveValue(reply);
  await expect(panel).toHaveCount(0);
  expect((await f.state()).turns).toHaveLength(1);
  await composer.fill(reply + ' I wait.');
  await f.setMode('normal');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(async () => (await f.state()).turns.at(-1)?.complete).toBe(true);
  await expect(panel).toHaveCount(0);
  const saved = await f.state();
  expect(saved.turns.map(turn => turn.user.text)).toEqual(['', reply + ' I wait.']);
  expect(await f.calls()).toHaveLength(4);
});

test('keeps suggestions usable after a cancelled regeneration and after the story advances', async ({ page }) => {
  const f = await setupScene(page, 'Mira waits.');
  await page.getByRole('button', { name: 'Composer actions' }).click();
  await page.getByRole('menuitem', { name: 'Impersonate' }).click();
  const panel = page.getByRole('region', { name: 'Suggested turn' });
  await expect(panel.getByRole('button', { name: 'Use draft' })).toBeEnabled();
  const opening = page.getByRole('article', { name: 'Turn 1', exact: true });
  await f.setMode('hold-first-token');
  await opening.getByRole('button', { name: 'Regenerate', exact: true }).click();
  await opening.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Use draft' })).toBeEnabled({ timeout: 2000 });
  await f.setMode('normal');

  const branch = await f.state();
  await f.write(`/api/chats/${f.chatId}/turns`, { revision: branch.revision, requestId: crypto.randomUUID(), text: 'Sent from another device.' });
  await expect.poll(async () => (await f.state()).turns[1]?.complete).toBe(true);
  const calls = (await f.calls()).length;
  await panel.getByRole('button', { name: 'Next suggestion' }).click();
  await expect(panel.getByRole('textbox', { name: 'Suggestion version', exact: true })).toHaveValue('2');
  await expect(panel.getByRole('button', { name: 'Previous suggestion' })).toBeEnabled();
  expect((await f.calls())[calls]?.body.messages).toContainEqual({ role: 'user', content: 'Sent from another device.' });
  await panel.getByRole('button', { name: 'Previous suggestion' }).click();
  await expect(panel.getByText('The lantern flickers. 🕯', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Use draft' }).click();
  await expect(panel).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Your next turn' })).toHaveValue('The lantern flickers. 🕯');
  await expect(panel).toHaveCount(0);
  expect((await f.state()).turns).toHaveLength(2);
});

test('dismisses a suggestion across open devices and fresh client sessions', async ({ page, browser }) => {
  const f = await setupScene(page, 'Mira waits.');
  const title = 'Suggested turn';
  const panel = page.getByRole('region', { name: title });
  const generate = async () => {
    await page.getByRole('button', { name: 'Composer actions' }).click();
    await page.getByRole('menuitem', { name: 'Impersonate' }).click();
    await expect(panel.getByRole('button', { name: 'Use draft' })).toBeEnabled();
  };
  await generate();
  const auth = await page.context().storageState();
  const device = await browser.newContext({ storageState: auth });
  try {
    const other = await device.newPage();
    await other.goto(page.url());
    const otherPanel = other.getByRole('region', { name: title });
    await expect(otherPanel).toBeVisible();
    await panel.getByRole('button', { name: 'Dismiss' }).click();
    await expect(panel).toHaveCount(0);
    await expect(otherPanel).toHaveCount(0);
  } finally { await device.close(); }

  const restarted = await browser.newContext({ storageState: auth });
  try {
    const fresh = await restarted.newPage();
    await fresh.goto(page.url());
    await expect(fresh.getByRole('button', { name: 'Composer actions' })).toBeEnabled();
    await expect(fresh.getByRole('region', { name: title })).toHaveCount(0);
    expect(await f.calls()).toHaveLength(1);
    await generate();
    await expect(fresh.getByRole('region', { name: title })).toBeVisible();
    expect(await f.calls()).toHaveLength(2);
  } finally { await restarted.close(); }
});

test('edits the action instruction and displays the suggestion in every theme and layout', async ({ page }, info) => {
  const f = await setupScene(page);
  const more = page.getByRole('button', { name: 'Composer actions' });
  await more.click();
  await page.getByRole('menuitem', { name: 'Impersonate' }).click();
  const panel = page.getByRole('region', { name: 'Suggested turn' });
  const composer = page.getByRole('textbox', { name: 'Your next turn' });
  await page.setViewportSize({ width: 390, height: 360 });
  await composer.fill('I listen for footsteps.\n'.repeat(25));
  await expect(panel.getByRole('button', { name: 'Replace draft' })).toBeInViewport({ ratio: 1 });
  const panelBounds = (await panel.boundingBox())!;
  expect(panelBounds.y + panelBounds.height).toBeLessThan((await composer.boundingBox())!.y);
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeInViewport({ ratio: 1 });
  await composer.clear();
  for (const theme of themeSchema.options) {
    await f.setTheme(theme);
    for (const width of [1440, 801, 800, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(panel.getByRole('button', { name: 'Use draft' })).toBeInViewport();
      await expect(more).toBeInViewport();
      await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeInViewport();
      await composer.fill('I wait for the final note.\nThen I turn back to the stage.');
      const suggestion = (await panel.boundingBox())!;
      const surface = (await page.locator('.composer-surface').boundingBox())!;
      expect(surface.x).toBeCloseTo(suggestion.x);
      expect(surface.x + surface.width).toBeCloseTo(suggestion.x + suggestion.width);
      await composer.clear();
      if (width === 1440 || width === 390) await panel.screenshot({ path: info.outputPath(`controls-${theme}-${width}.png`) });
      await more.click();
      const action = page.getByRole('menuitem', { name: 'Impersonate' });
      await expect(action).toBeInViewport();
      if (width === 1440 || width === 390) await page.screenshot({ path: info.outputPath(`suggestion-${theme}-${width}.png`) });
      await action.press('Escape');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await f.setMode('reasoning');
    await panel.getByRole('button', { name: 'Next suggestion' }).click();
    await expect(panel.getByRole('status')).toHaveText('Reasoning…');
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(panel.getByRole('button', { name: 'Cancel', exact: true })).toBeInViewport();
      await panel.screenshot({ path: info.outputPath(`active-${theme}-${width}.png`) });
    }
    await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(panel.getByRole('status')).toHaveText('Suggestion cancelled.');
    await f.setMode('normal');
    await page.getByRole('button', { name: 'Libraries', exact: true }).click();
    await selectLibraryCategory(page, 'Prompts');
    await page.getByRole('button', { name: defaultPrompt.name, exact: true }).click();
    await page.getByRole('tab', { name: 'Action instructions' }).click();
    await page.getByRole('tabpanel', { name: 'Action instructions' }).getByText('Impersonate', { exact: true }).click();
    const instruction = page.getByRole('textbox', { name: 'Impersonation instruction' });
    await expect(instruction).toHaveValue(defaultPrompt.impersonateInstruction ?? '');
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 844 });
      await instruction.scrollIntoViewIfNeeded();
      await expect(instruction).toBeInViewport();
      await page.screenshot({ path: info.outputPath(`instruction-${theme}-${width}.png`) });
    }
    if (theme === themeSchema.options.at(-1)) {
      await instruction.fill('Player {{user}}. {{draft}}');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(instruction).toHaveCount(0);
    }
    await page.getByRole('button', { name: 'Story', exact: true }).click();
  }
  await page.getByRole('textbox', { name: 'Your next turn' }).fill('I stay.');
  await more.click();
  await page.getByRole('menuitem', { name: 'Impersonate' }).click();
  await expect.poll(async () => (await f.calls()).at(-1)?.body.messages.at(-1)).toEqual({ role: 'system', content: 'Player You. I stay.' });
});

test('reconciles a lost acknowledgement and keeps the last successful draft after an incomplete stream', async ({ page }) => {
  const f = await setupScene(page, 'Mira opens the door.');
  await page.route('**/api/chats/*/impersonate', async route => {
    const response = await route.fetch();
    expect(response.status()).toBe(202);
    await route.abort('failed');
  }, { times: 1 });
  await page.getByRole('button', { name: 'Composer actions' }).click();
  await page.getByRole('menuitem', { name: 'Impersonate' }).click();
  const panel = page.getByRole('region', { name: 'Suggested turn' });
  const again = panel.getByRole('button', { name: 'Next suggestion' });
  await expect(again).toBeEnabled();
  await page.reload();
  await expect(panel.getByText('The lantern flickers. 🕯', { exact: true })).toBeVisible();
  expect(await f.calls()).toHaveLength(1);
  await f.setMode('broken');
  await again.click();
  await expect.poll(async () => (await f.state()).generations[0].status).toBe('failed');
  await expect(panel.getByText(/stream ended/)).toBeVisible();
  await expect(panel.getByText('The lantern flickers. 🕯', { exact: true })).toBeVisible();
  expect(await f.calls()).toHaveLength(2);
  expect((await f.state()).turns).toHaveLength(1);
});

for (const width of [1440, 390]) test(`keeps suggestion controls anchored through reasoning, streaming and cancellation at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 844 });
  const f = await setupScene(page, 'Mira waits.');
  const panel = page.getByRole('region', { name: 'Suggested turn' });
  const version = panel.getByRole('textbox', { name: 'Suggestion version', exact: true });
  const cancel = panel.getByRole('button', { name: 'Cancel', exact: true });
  const next = panel.getByRole('button', { name: 'Next suggestion' });
  const preview = panel.getByLabel('Latest model reasoning');
  const composer = page.getByRole('textbox', { name: 'Your next turn' });
  const positions = () => panel.locator('button,input').evaluateAll(controls => controls.map(control => {
    const { x, y, width, height } = control.getBoundingClientRect();
    return [x, y, width, height].map(Math.round);
  }));

  await f.setMode('hold-first-token');
  await page.getByRole('button', { name: 'Composer actions' }).click();
  await page.getByRole('menuitem', { name: 'Impersonate' }).click();
  await expect(panel.getByRole('status')).toHaveText('Connecting…');
  await expect(panel.getByLabel('Generating', { exact: true })).toHaveCount(1);
  await expect(cancel).toBeEnabled();
  await expect(version).toHaveValue('1');
  await expect(next).toBeDisabled();
  await expect(panel.getByRole('button', { name: 'Dismiss' })).toBeDisabled();
  const apply = panel.getByRole('button', { name: 'Use draft' });
  const dismiss = panel.getByRole('button', { name: 'Dismiss' });
  await expect(apply).toBeVisible();
  await expect(dismiss).toBeVisible();
  const fixed = await positions();
  expect((await cancel.boundingBox())!.x).toBeLessThan((await apply.boundingBox())!.x);
  expect((await apply.boundingBox())!.x).toBeLessThan((await dismiss.boundingBox())!.x);
  await expect.poll(async () => (await f.calls()).length).toBe(1);
  await cancel.click();
  await expect(panel).toHaveCount(0, { timeout: 2000 });
  await page.reload();
  await expect(page.getByRole('button', { name: 'Composer actions' })).toBeEnabled();
  await expect(panel).toHaveCount(0);
  await f.setMode('normal');
  await page.getByRole('button', { name: 'Composer actions' }).click();
  await page.getByRole('menuitem', { name: 'Impersonate' }).click();
  await expect(panel.getByText('The lantern flickers. 🕯', { exact: true })).toBeVisible();
  await expect(version).toHaveValue('1');
  await composer.fill('Give Mira a moment.');
  await expect(next).toBeEnabled();
  expect(await positions()).toEqual(fixed);
  await f.setMode('reasoning');
  await next.click();
  await expect(panel.getByRole('status')).toHaveText('Reasoning…');
  await expect(preview).toHaveCount(0);
  await expect(version).toHaveValue('2');
  const appearance = await page.request.get('/api/application/appearance').then(response => response.json());
  await f.write('/api/application/appearance', { revision: appearance.revision, settings: {
    ...appearance.settings, showReasoningDuringGeneration: true,
  } }, 'PUT');
  await expect(preview).toContainText('Reasoning line 80');
  await page.reload();
  await expect(preview).toContainText('Reasoning line 80');
  await expect(version).toHaveValue('2');
  expect(await positions()).toEqual(fixed);
  await panel.screenshot({ path: info.outputPath(`reasoning-${width}.png`) });
  await f.write('/__test/finish', {});
  await expect(preview).toContainText('The newest thought');
  await f.write('/__test/finish', {});
  await expect(panel.getByText('The lantern', { exact: true })).toBeVisible();
  await expect(preview).toHaveCount(0);
  expect(await positions()).toEqual(fixed);
  await cancel.click();
  await expect(panel.getByRole('status')).toHaveText('Suggestion cancelled.');
  await expect(version).toHaveValue('1');
  await expect(cancel).toBeHidden();
  await expect(panel.getByText('The lantern flickers. 🕯', { exact: true })).toBeVisible();
  expect(await positions()).toEqual(fixed);
  await expect(composer).toHaveValue('Give Mira a moment.');
  expect(await f.calls()).toHaveLength(3);
});

test('recovers a failed version read through the selector without generating another suggestion', async ({ page }) => {
  const f = await setupScene(page, 'Mira waits.');
  const panel = page.getByRole('region', { name: 'Suggested turn' });
  await page.route('**/suggestions/*?version=1', route => route.fulfill({
    status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Suggestion read unavailable.' }),
  }), { times: 1 });
  await page.getByRole('button', { name: 'Composer actions' }).click();
  await page.getByRole('menuitem', { name: 'Impersonate' }).click();
  await expect(panel.getByRole('alert')).toContainText('Suggestion read unavailable.');
  await expect(panel.getByRole('button', { name: 'Use draft' })).toBeDisabled();
  await panel.getByRole('button', { name: 'Next suggestion' }).click();
  await expect(panel.getByText('The lantern flickers. 🕯', { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Use draft' })).toBeEnabled();
  expect(await f.calls()).toHaveLength(1);
});

test('keeps the suggestion open after a failed draft save and closes it after a successful paste', async ({ page }) => {
  const f = await setupScene(page, 'Mira waits.');
  const panel = page.getByRole('region', { name: 'Suggested turn' });
  const composer = page.getByRole('textbox', { name: 'Your next turn' });
  const paste = panel.getByRole('button', { name: 'Use draft' });
  await page.getByRole('button', { name: 'Composer actions' }).click();
  await page.getByRole('menuitem', { name: 'Impersonate' }).click();
  await expect(paste).toBeEnabled();
  await page.route(`**/api/chats/${f.chatId}/draft`, async route => {
    if (route.request().method() !== 'PUT') return route.continue();
    await route.fulfill({ status: 503, json: { message: 'Draft save unavailable.' } });
  });
  await paste.click();
  await expect(page.getByRole('alert')).toContainText('Draft save unavailable.');
  await expect(composer).toHaveValue('');
  await expect(panel).toBeVisible();

  await page.unroute(`**/api/chats/${f.chatId}/draft`);
  await paste.click();
  await expect(panel).toHaveCount(0);
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue('The lantern flickers. 🕯');
  const saved = await page.request.get(`/api/chats/${f.chatId}/draft`).then(response => response.json());
  expect(saved.text).toBe('The lantern flickers. 🕯');
  expect((await f.state()).turns).toHaveLength(1);
  expect(await f.calls()).toHaveLength(1);
});

test('follows streamed suggestion text, pauses on upward scroll and resumes at the end', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const f = await setupScene(page, 'Mira waits.');
  await f.setMode('scroll-stream');
  await page.getByRole('button', { name: 'Composer actions' }).click();
  await page.getByRole('menuitem', { name: 'Impersonate' }).click();
  const panel = page.getByRole('region', { name: 'Suggested turn' });
  const content = panel.locator('.suggestion-content');
  const distance = () => content.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop);
  const advance = () => f.write('/__test/finish', {});
  await expect(panel.getByRole('status')).toHaveText('Reasoning…');
  await advance();
  await advance();
  await expect(content).toContainText('First response section');
  await expect.poll(distance).toBeLessThanOrEqual(1);

  const readingTop = await content.evaluate(node => {
    node.scrollTop -= 100;
    return node.scrollTop;
  });
  await advance();
  await expect(content).toContainText('Second response section');
  expect(await content.evaluate(node => node.scrollTop)).toBeCloseTo(readingTop, 0);

  await content.evaluate(node => { node.scrollTop = node.scrollHeight; });
  // Allow the browser to report the return to the end before the next chunk.
  await content.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await advance();
  await expect(content).toContainText('Third response section');
  await expect.poll(distance).toBeLessThanOrEqual(1);

  const finalReadingTop = await content.evaluate(node => {
    node.scrollTop -= 100;
    return node.scrollTop;
  });
  await advance();
  await expect(content).toContainText('Fourth response section');
  await advance();
  await expect(panel.getByRole('button', { name: 'Use draft' })).toBeEnabled();
  expect(await content.evaluate(node => node.scrollTop)).toBeCloseTo(finalReadingTop, 0);
});

test('keeps the streamed suggestion visible while the saved version loads', async ({ page }) => {
  const f = await setupScene(page, 'Mira waits.');
  await f.setMode('hold');
  let release = () => {};
  const delayed = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/suggestions/*?version=1', async route => {
    await delayed;
    await route.continue();
  });
  await page.getByRole('button', { name: 'Composer actions' }).click();
  await page.getByRole('menuitem', { name: 'Impersonate' }).click();
  const panel = page.getByRole('region', { name: 'Suggested turn' });
  const text = 'The lantern';
  await expect(panel.getByText(text, { exact: true })).toBeVisible();
  const height = (await panel.boundingBox())!.height;
  try {
    const reading = page.waitForRequest('**/suggestions/*?version=1');
    await f.write('/__test/finish', {});
    await reading;
    await expect(panel.getByRole('button', { name: 'Cancel', exact: true })).toBeHidden();
    await expect(panel.getByText(text, { exact: true })).toBeVisible({ timeout: 1500 });
    expect((await panel.boundingBox())!.height).toBeCloseTo(height, 0);
    await expect(panel.getByRole('button', { name: 'Use draft' })).toBeDisabled();
  } finally {
    release();
  }
  await expect(panel.getByText('The lantern flickers. 🕯', { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Use draft' })).toBeEnabled();
});

test.describe('iPhone suggestion scrolling', () => {
  const { userAgent, viewport, isMobile, hasTouch } = devices['iPhone 13'];
  test.use({ userAgent, viewport, isMobile, hasTouch });

  test('lets a saved suggestion own vertical gestures at both scroll boundaries', async ({ page }) => {
    const f = await setupScene(page, 'Mira waits.');
    await f.setMode('scroll-stream');
    await page.getByRole('button', { name: 'Composer actions' }).click();
    await page.getByRole('menuitem', { name: 'Impersonate' }).click();
    const panel = page.getByRole('region', { name: 'Suggested turn' });
    await expect(panel.getByRole('status')).toHaveText('Reasoning…');
    // Advance the fixture from the initial reasoning chunk through the end of the reply.
    for (let step = 0; step < 6; step++) await f.write('/__test/finish', {});
    await expect(panel.getByRole('button', { name: 'Use draft' })).toBeEnabled();
    const content = panel.locator('.suggestion-content');
    await expect(content).toHaveCSS('overscroll-behavior-y', 'contain');
    expect(await content.evaluate(node => node.scrollHeight - node.clientHeight)).toBeGreaterThan(100);
    const prevented = await content.evaluate(node => {
      const target = node.querySelector('.suggestion-prose')!;
      const gesture = (dx: number, dy: number) => {
        // WebKit's desktop runner cannot construct a Touch. Supply the same
        // touch coordinates to exercise the guard's event-cancellation decision.
        const touch = (type: string, clientX: number, clientY: number) => Object.defineProperty(
          new Event(type, { bubbles: true, cancelable: true }), 'touches',
          { value: { length: 1, item: () => ({ clientX, clientY }) } },
        );
        target.dispatchEvent(touch('touchstart', 100, 150));
        const move = touch('touchmove', 100 + dx, 150 + dy);
        target.dispatchEvent(move);
        target.dispatchEvent(new Event('touchend', { bubbles: true }));
        return move.defaultPrevented;
      };
      node.scrollTop = 0;
      const top = gesture(0, 25);
      node.scrollTop = node.scrollHeight;
      return { top, bottom: gesture(0, -25), horizontal: gesture(25, 0) };
    });
    expect(prevented).toEqual({ top: false, bottom: false, horizontal: true });
  });
});
