import { test, expect } from '@playwright/test';
import type { ChatSnapshot } from '../../src/shared/contracts';
import type { LibraryCharacter, LibrarySnapshot } from '../../src/shared/library';
import { markdownReplyStart, markdownReplyEnd } from '../support/mock-provider';
import { russianDialogueRegressions } from '../support/russian-dialogue-fixtures';

for (const width of [1440, 390]) test(`renders Markdown and speech without changing saved input at ${width}px`, async ({ page, request }, testInfo) => {
  await page.setViewportSize({ width, height: 900 });
  const session = await request.get('/api/session').then(response => response.json());
  await page.goto('/');
  await page.getByLabel('Owner password').fill('browser-synthetic-password');
  await page.getByRole('button', { name: session.setupRequired ? 'Create owner account' : 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Libraries', exact: true })).toBeVisible();
  const library = (): Promise<LibrarySnapshot> => page.request.get('/api/library').then(response => response.json());
  const command = async (url: string, data: unknown) => {
    const response = await page.request.post(url, { headers: { Origin: 'http://127.0.0.1:4173' }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const { endpoint } = await request.get('/__test/endpoint').then(response => response.json());
  const connection = await command('/api/library', { revision: (await library()).revision, kind: 'connections', data: { name: `Markdown ${width}`, endpoint, model: 'synthetic-roleplay', contextWindow: 100000, maxOutputTokens: 1000, customParameters: {} } });
  const greeting = '*Mara smiles.*\n\nMara asked "How are **you**?"\n\n— Здесь мне лучше, — сказала девушка.\n\n- A lantern\n- A key\n\n> Keep the gate closed.\n\n| Place | Keeper |\n| --- | --- |\n| Tower | Mara |\n\n```text\n' + 'long-code-'.repeat(25) + '\n"literal quote"\n```\n\n[Map](https://example.com/map) [unsafe](javascript:alert%281%29)\n\n![portrait](https://example.com/tracker.png)\n\n<img src="https://example.com/hidden.png" onerror="alert(1)">';
  const characterData: LibraryCharacter = { name: `Mara ${width}`, description: '', personality: '', scenario: '', first_mes: greeting, mes_example: '', alternate_greetings: ['**Another opening.** «Добро пожаловать».', ...russianDialogueRegressions.map(fixture => fixture.text)], lorebookId: null, titleComment: '' };
  const character = await command('/api/library', { revision: (await library()).revision, kind: 'characters', data: characterData });
  const chat = await command('/api/chats', { title: `Markdown proof ${width}`, targetInputTokens: 10000, connectionId: connection.id, promptId: 'default', characterId: character.id, personaId: null });
  const state = (): Promise<ChatSnapshot> => page.request.get(`/api/chats/${chat.id}`).then(response => response.json());
  const externalImages: string[] = [];
  page.on('request', request => { if (request.resourceType() === 'image' && request.url().startsWith('https://example.com/')) externalImages.push(request.url()); });
  await page.evaluate(id => localStorage.setItem('roleplay-chat', id), chat.id);
  await page.reload();
  const opening = page.getByRole('article', { name: 'Turn 1', exact: true });
  const prose = opening.locator('.part.assistant .prose');
  await expect(prose.locator('em')).toHaveText('Mara smiles.');
  await expect(prose.locator('.direct-speech')).toHaveText(['"How are ', 'you', '?"', ' Здесь мне лучше,']);
  await expect(prose).toContainText(' — сказала девушка.');
  await expect(prose.getByRole('listitem')).toHaveCount(2);
  await expect(prose.getByRole('table')).toBeVisible();
  await expect(prose.locator('blockquote')).toHaveText('Keep the gate closed.');
  await expect(prose.locator('pre code')).toContainText('"literal quote"');
  await expect(prose.locator('pre .direct-speech')).toHaveCount(0);
  await expect(prose.getByRole('link', { name: 'Map', exact: true })).toHaveAttribute('href', 'https://example.com/map');
  await expect(prose.getByRole('link', { name: 'unsafe', exact: true })).toHaveCount(0);
  await expect(prose.locator('img, script')).toHaveCount(0);
  await expect(prose).toContainText('[Image: portrait]');
  const speech = prose.locator('.direct-speech').first();
  await expect(speech).toHaveCSS('font-weight', '700');
  expect(await speech.evaluate(node => getComputedStyle(node).color)).not.toBe(await prose.evaluate(node => getComputedStyle(node).color));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await prose.locator('pre').scrollIntoViewIfNeeded();
  expect(await prose.locator('pre').evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('markdown-greeting.png'), fullPage: true });
  expect(externalImages).toEqual([]);
  expect((await state()).turns[0].assistant.text).toBe(greeting);

  // Edits and variant changes use the original Markdown, including after reload.
  await opening.getByRole('button', { name: 'Edit response', exact: true }).click();
  await expect(page.getByLabel('Edit assistant text')).toHaveValue(greeting);
  await page.getByRole('button', { name: 'Cancel edit', exact: true }).click();
  await opening.getByRole('button', { name: 'Next response', exact: true }).click();
  await expect(prose.locator('strong').first()).toHaveText('Another opening.');
  await page.reload();
  await expect(prose.locator('.direct-speech')).toHaveText('«Добро пожаловать»');
  for (const [index, fixture] of russianDialogueRegressions.entries()) {
    await opening.getByRole('button', { name: 'Next response', exact: true }).click();
    await expect(prose.locator('.direct-speech')).toHaveText(fixture.speech.map(speech => speech.slice(1)));
    expect(await prose.locator('.direct-speech').allTextContents()).not.toEqual(expect.arrayContaining([expect.stringContaining('—')]));
    await expect(prose).toContainText(fixture.narration);
    await expect(prose).toHaveText(fixture.text);
    await page.screenshot({ path: testInfo.outputPath(`russian-dialogue-${index + 1}.png`), fullPage: true });
  }
  await page.reload();
  await expect(prose.locator('.direct-speech')).toHaveText([' А ты чего тут делаешь?']);
  await opening.getByLabel('Response version', { exact: true }).fill('1');
  await opening.getByLabel('Response version', { exact: true }).press('Enter');
  await expect(prose.locator('em')).toHaveText('Mara smiles.');

  const input = '*I enter.* "Is anyone there?"';
  await request.post('/__test/mode', { data: { mode: 'markdown' } });
  try {
    await page.getByLabel('Your next turn').fill(input);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const turn = page.getByRole('article', { name: 'Turn 2', exact: true });
    const reply = turn.locator('.part.assistant .prose');
    await expect(turn.locator('.part.user em')).toHaveText('I enter.');
    await expect(reply).toHaveText(markdownReplyStart);
    await expect(reply.locator('.direct-speech')).toHaveCount(0);
    await expect(turn.getByLabel('Generating', { exact: true })).toBeVisible();
    await request.post('/__test/finish', { data: {} });
    await expect(reply.locator('em')).toHaveText('Stay close');
    await expect(reply.locator('.direct-speech')).toHaveText(['"', 'Stay close', ', traveler."', ' Послушайте!', ' Я ведь не знал.']);
    await expect(turn.getByLabel('Generating', { exact: true })).toHaveCount(0);
    await page.reload();
    await expect(reply.locator('em')).toHaveText('Stay close');
    const saved = await state();
    expect(saved.turns[1].user.text).toBe(input);
    expect(saved.turns[1].assistant.text).toBe(markdownReplyStart + markdownReplyEnd);
    // Inspect the server's immutable outgoing request, not a presentation-derived approximation.
    const historical = await page.request.get(`/api/chats/${chat.id}/generations/${saved.generations[0].id}/request`).then(response => response.json());
    expect(historical.body.messages).toContainEqual({ role: 'user', content: input });
    expect(historical.body.messages).toContainEqual({ role: 'assistant', content: greeting });
    await reply.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('markdown-conversation.png'), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally {
    await request.post('/__test/finish', { data: {} });
    await request.post('/__test/mode', { data: { mode: 'normal' } });
  }
});
