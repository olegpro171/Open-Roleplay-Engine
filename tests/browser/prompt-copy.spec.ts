import { expect, type Locator } from '@playwright/test';
import { appearanceStatusSchema } from '../../src/shared/appearance';
import type { ChatSnapshot } from '../../src/shared/contracts';
import type { LibrarySnapshot } from '../../src/shared/library';
import { openChatTool } from './chat-tools';
import { test } from './isolated-app';

function copyButtonLayout(button: Locator) {
  return button.evaluate(node => {
    const bounds = node.getBoundingClientRect();
    const icon = node.querySelector('svg');
    if (!icon) throw new Error('Missing copy icon');
    return { left: bounds.left, width: bounds.width, iconLeft: icon.getBoundingClientRect().left };
  });
}

test('copies the whole assembled prompt and offers selection when the browser denies copying', async ({ page, browserApp, context }, testInfo) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: browserApp.url });
  await page.goto('/');
  await page.getByLabel('Owner password').fill('browser-synthetic-password');
  await page.getByRole('button', { name: 'Create owner account', exact: true }).click();
  await expect(page.getByLabel('Your next turn')).toBeVisible();
  const command = async (url: string, data: object, method = 'POST') => {
    const response = await page.request.fetch(url, { method, headers: { Origin: browserApp.url }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response;
  };
  const library = async (): Promise<LibrarySnapshot> => page.request.get('/api/library').then(response => response.json());
  const { endpoint } = await page.request.get('/__test/endpoint').then(response => response.json());
  const connection = await command('/api/library', {
    revision: (await library()).revision, kind: 'connections', data: {
      name: 'Prompt copy connection', endpoint, model: 'synthetic-copy', contextWindow: 100_000, maxOutputTokens: 1_000, customParameters: {},
    },
  });
  const prompt = await command('/api/library', {
    revision: (await library()).revision, kind: 'prompts', data: {
      name: 'Prompt copy preset', blocks: [
        { id: 'instruction', name: 'Editor-only label', kind: 'text', role: 'system', enabled: true, text: 'Keep the line breaks.\n\n  A literal <tag>.' },
        { id: 'messages', name: 'Messages', kind: 'marker', role: 'user', enabled: true, marker: 'messages' },
      ],
    },
  });
  const { id: chatId }: { id: string } = await command('/api/chats', {
    title: 'Prompt copy chat', connectionId: (await connection.json()).id, promptId: (await prompt.json()).id,
    targetInputTokens: 20_000, characterId: null, personaId: null, contextPresetId: null,
  }).then(response => response.json());
  const chat: ChatSnapshot = await page.request.get(`/api/chats/${chatId}`).then(response => response.json());
  await command(`/api/__test/transcripts/${chatId}`, { revision: chat.revision, turns: [
    { user: 'I open the gate.', assistant: 'The gate creaks.\nA light flickers.', complete: true },
  ] }, 'PUT');
  await page.evaluate(id => localStorage.setItem('roleplay-chat', id), chatId);
  await page.reload();
  await page.getByLabel('Your next turn').fill('I follow the light.');
  await openChatTool(page, 'Request inspector');
  const openPeek = () => page.getByRole('region', { name: 'Request inspector' }).getByRole('button', { name: 'Prompt peek' }).click();
  const peek = page.getByRole('dialog', { name: 'Prompt peek' });
  const copy = peek.getByRole('button', { name: 'Copy prompt', exact: true });
  const copiedButton = peek.getByRole('button', { name: 'Copied', exact: true });
  const closePeek = () => peek.getByRole('button', { name: 'Close peek' }).click();
  const copied = '[system]\nKeep the line breaks.\n\n  A literal <tag>.\n\n[user]\nI open the gate.\n\n[assistant]\nThe gate creaks.\nA light flickers.\n\n[user]\nI follow the light.';
  await openPeek();
  await copy.click();
  await expect(copiedButton).toBeVisible();
  const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
  // Chromium writes native CRLF line endings to the Windows clipboard.
  expect(clipboardText.replace(/\r\n/g, '\n')).toBe(copied);
  await closePeek();

  // Exercise the path used by plain HTTP LAN origins without granting clipboard access.
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { value: undefined }));
  await page.evaluate(() => {
    document.execCommand = command => {
      const field = document.activeElement;
      if (command !== 'copy' || !(field instanceof HTMLTextAreaElement)) return false;
      sessionStorage.setItem('test-copy', field.value.slice(field.selectionStart, field.selectionEnd));
      return true;
    };
  });
  for (const theme of ['dark', 'light', 'midnight-black'] as const) {
    const appearance = appearanceStatusSchema.parse(await page.request.get('/api/application/appearance').then(response => response.json()));
    await command('/api/application/appearance', { revision: appearance.revision, settings: { ...appearance.settings, theme } }, 'PUT');
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    for (const width of [1280, 801, 800, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await openPeek();
      await copy.scrollIntoViewIfNeeded();
      await expect(copy).toBeInViewport();
      const initialLayout = await copyButtonLayout(copy);
      await page.screenshot({ path: testInfo.outputPath(`${theme}-${width}-prompt-copy.png`) });
      await copy.click();
      await expect(copiedButton).toBeInViewport();
      await expect(copiedButton).toBeFocused();
      expect(await copyButtonLayout(copiedButton)).toEqual(initialLayout);
      expect(await page.evaluate(() => sessionStorage.getItem('test-copy'))).toBe(copied);
      expect(await peek.evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`${theme}-${width}-prompt-copied.png`) });
      await closePeek();
    }
  }

  await page.evaluate(() => { document.execCommand = () => false; });
  await openPeek();
  await copy.click();
  const manual = peek.getByRole('textbox', { name: /Copy the selected prompt text manually/ });
  await expect(manual).toHaveValue(copied);
  await expect(manual).toBeFocused();
  expect(await manual.evaluate(field => field instanceof HTMLTextAreaElement
    && field.readOnly && field.selectionStart === 0 && field.selectionEnd === field.value.length)).toBe(true);
  expect(await page.request.get('/__test/requests').then(response => response.json())).toEqual([]);
});
