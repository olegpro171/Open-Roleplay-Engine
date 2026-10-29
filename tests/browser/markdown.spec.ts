import { appearanceStatusSchema } from '../../src/shared/appearance';
import { test, expect } from '@playwright/test';
import type { ChatSnapshot } from '../../src/shared/contracts';
import type { LibraryCharacter, LibrarySnapshot } from '../../src/shared/library';
import { markdownReplyStart, markdownReplyEnd } from '../support/mock-provider';
import { russianDialogueRegressions } from '../support/russian-dialogue-fixtures';

for (const width of [1440, 390]) test(`renders Markdown and speech without changing saved input at ${width}px`, async ({ page, request }, testInfo) => {
  await page.setViewportSize({ width, height: 900 });
  let releaseReplyImage = () => {};
  const replyImageReady = new Promise<void>(resolve => { releaseReplyImage = resolve; });
  // Keep image loading deterministic and offline, including a failed remote image.
  await page.route('https://example.com/**', async route => {
    if (route.request().url().endsWith('/broken.png')) return route.abort();
    if (route.request().url().endsWith('/reply.png')) await replyImageReady;
    await route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="600"><rect width="1600" height="600" fill="#405d78"/><circle cx="800" cy="300" r="180" fill="#d7b977"/></svg>' });
  });
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
  const greeting = '*Mara smiles.*\n\nMara asked "How are **you** — really?"\n\n— Здесь мне лучше, — сказала девушка.\n\n- A lantern\n- A key\n\n> Keep the gate closed.\n\n| Place | Keeper |\n| --- | --- |\n| Tower | Mara |\n\n```text\n' + 'long-code-'.repeat(25) + '\n"literal quote"\n```\n\n[Map](https://example.com/map) [unsafe](javascript:alert%281%29)\n\n![portrait](https://example.com/tracker.png)\n\n<img src="https://example.com/hidden.png" onerror="alert(1)">';
  const imageGreeting = greeting + '\n\n![](https://example.com/empty-alt.png)\n\n![scene][image]\n\n[image]: https://example.com/reference.png\n\n![unavailable](https://example.com/broken.png)\n\n![local](/api/logout)';
  const characterData: LibraryCharacter = { name: `Mara ${width}`, description: '', personality: '', scenario: '', first_mes: imageGreeting, mes_example: '', alternate_greetings: ['**Another opening.** «Добро пожаловать».', ...russianDialogueRegressions.map(fixture => fixture.text)], lorebookId: null, titleComment: '', speechColor: '#eeaa88' };
  const character = await command('/api/library', { revision: (await library()).revision, kind: 'characters', data: characterData });
  const persona = await command('/api/library', { revision: (await library()).revision, kind: 'personas', data: { name: `Alex ${width}`, description: '', speechColor: '#88cc99' } });
  const chat = await command('/api/chats', { title: `Markdown proof ${width}`, targetInputTokens: 10000, connectionId: connection.id, promptId: 'default', characterId: character.id, personaId: persona.id });
  const state = (): Promise<ChatSnapshot> => page.request.get(`/api/chats/${chat.id}`).then(response => response.json());
  const externalImages: string[] = [];
  page.on('request', request => { if (request.resourceType() === 'image' && request.url().startsWith('https://example.com/')) externalImages.push(request.url()); });
  await page.evaluate(id => localStorage.setItem('roleplay-chat', id), chat.id);
  await page.reload();
  const opening = page.getByRole('article', { name: 'Turn 1', exact: true });
  const prose = opening.locator('.part.assistant .prose');
  await expect(prose.locator('em')).toHaveText('Mara smiles.');
  await expect(prose.locator('.direct-speech')).toHaveText(['"How are ', 'you', ' — really?"', '— Здесь мне лучше,']);
  await expect(prose).toContainText(' — сказала девушка.');
  await expect(prose.getByRole('listitem')).toHaveCount(2);
  await expect(prose.getByRole('table')).toBeVisible();
  await expect(prose.locator('blockquote')).toHaveText('Keep the gate closed.');
  await expect(prose.locator('pre code')).toContainText('"literal quote"');
  await expect(prose.locator('pre .direct-speech')).toHaveCount(0);
  await expect(prose.getByRole('link', { name: 'Map', exact: true })).toHaveAttribute('href', 'https://example.com/map');
  await expect(prose.getByRole('link', { name: 'unsafe', exact: true })).toHaveCount(0);
  await expect(prose.locator('script')).toHaveCount(0);
  const portrait = prose.getByRole('img', { name: 'portrait', exact: true });
  await portrait.scrollIntoViewIfNeeded();
  await expect.poll(() => portrait.evaluate(node => node instanceof HTMLImageElement && node.complete && node.naturalWidth === 1600)).toBe(true);
  await expect(portrait).toHaveAttribute('referrerpolicy', 'no-referrer');
  expect(await portrait.evaluate(node => node.getBoundingClientRect().width <= (node.parentElement?.getBoundingClientRect().width ?? 0))).toBe(true);
  await prose.locator('img[src="https://example.com/broken.png"]').or(prose.getByText('[Image: unavailable]', { exact: true })).scrollIntoViewIfNeeded();
  await expect(prose).toContainText('[Image: unavailable]');
  await expect(prose.locator('img')).toHaveCount(3);
  await expect(prose).toContainText('[Image: local]');
  const speech = prose.locator('.direct-speech').first();
  await expect(speech).toHaveCSS('font-weight', '700');
  await expect(speech).toHaveCSS('color', 'rgb(238, 170, 136)');
  expect(await speech.evaluate(node => getComputedStyle(node).color)).not.toBe(await prose.evaluate(node => getComputedStyle(node).color));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await prose.locator('pre').scrollIntoViewIfNeeded();
  expect(await prose.locator('pre').evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('markdown-greeting.png'), fullPage: true });
  expect(externalImages).toContain('https://example.com/tracker.png');
  expect(externalImages).not.toContain('https://example.com/hidden.png');
  expect((await state()).turns[0].assistant.text).toBe(imageGreeting);

  // Edits and variant changes use the original Markdown, including after reload.
  await opening.getByRole('button', { name: 'Edit response', exact: true }).click();
  await expect(page.getByLabel('Edit assistant text')).toHaveValue(imageGreeting);
  await page.getByRole('button', { name: 'Cancel edit', exact: true }).click();
  await opening.getByRole('button', { name: 'Next response', exact: true }).click();
  await expect(prose.locator('strong').first()).toHaveText('Another opening.');
  await page.reload();
  await expect(prose.locator('.direct-speech')).toHaveText('«Добро пожаловать»');
  for (const [index, fixture] of russianDialogueRegressions.entries()) {
    await opening.getByRole('button', { name: 'Next response', exact: true }).click();
    await expect(prose.locator('.direct-speech')).toHaveText(fixture.speech);
    await expect(prose).toContainText(fixture.narration);
    await expect(prose).toHaveText(fixture.text);
    await page.screenshot({ path: testInfo.outputPath(`russian-dialogue-${index + 1}.png`), fullPage: true });
    if (index === 0) {
      const original = appearanceStatusSchema.parse(await page.request.get('/api/application/appearance').then(response => response.json()));
      try {
        for (const theme of ['dark', 'light', 'midnight-black'] as const) {
          const current = appearanceStatusSchema.parse(await page.request.get('/api/application/appearance').then(response => response.json()));
          const saved = await page.request.put('/api/application/appearance', {
            headers: { Origin: 'http://127.0.0.1:4173' }, data: { revision: current.revision, settings: { ...current.settings, theme } },
          });
          expect(saved.ok()).toBe(true);
          await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
          await expect(prose.locator('.direct-speech')).toHaveText(fixture.speech);
          await prose.screenshot({ path: testInfo.outputPath(`interrupted-dialogue-${theme}.png`) });
        }
      } finally {
        const current = appearanceStatusSchema.parse(await page.request.get('/api/application/appearance').then(response => response.json()));
        const restored = await page.request.put('/api/application/appearance', {
          headers: { Origin: 'http://127.0.0.1:4173' }, data: { revision: current.revision, settings: original.settings },
        });
        expect(restored.ok()).toBe(true);
      }
    }
  }
  await page.reload();
  await expect(prose.locator('.direct-speech')).toHaveText(['— А ты чего тут делаешь?']);
  await opening.getByLabel('Response version', { exact: true }).fill('1');
  await opening.getByLabel('Response version', { exact: true }).press('Enter');
  await expect(prose.locator('em')).toHaveText('Mara smiles.');
  await expect(prose.locator('img[src="https://example.com/empty-alt.png"]')).toHaveCount(1);

  const input = '*I enter.* "You say that like they sell \'em at the gas station."\n\n![](https://example.com/input.png)';
  await request.post('/__test/mode', { data: { mode: 'markdown' } });
  const originalAppearance = appearanceStatusSchema.parse(await page.request.get('/api/application/appearance').then(response => response.json()));
  try {
    const scaleSaved = await page.request.put('/api/application/appearance', {
      headers: { Origin: 'http://127.0.0.1:4173' },
      data: { revision: originalAppearance.revision, settings: { ...originalAppearance.settings, chatTextScale: 120 } },
    });
    expect(scaleSaved.ok()).toBe(true);
    await expect(prose.locator('.chat-markdown')).toHaveCSS('font-size', '18px');
    await expect(prose.locator('pre')).toHaveCSS('font-size', '14.4px');
    await page.getByLabel('Your next turn').fill(input);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const turn = page.getByRole('article', { name: 'Turn 2', exact: true });
    const reply = turn.locator('.part.assistant .prose');
    await expect(turn.locator('.part.user em')).toHaveText('I enter.');
    await expect(turn.locator('.part.user .direct-speech')).toHaveText(`"You say that like they sell 'em at the gas station."`);
    await expect(turn.locator('.part.user .direct-speech')).toHaveCSS('color', 'rgb(136, 204, 153)');
    await expect(turn.locator('.part.user img')).toHaveAttribute('src', 'https://example.com/input.png');
    await expect(reply).toHaveText(markdownReplyStart);
    await expect(reply.locator('.chat-markdown')).toHaveCSS('font-size', '18px');
    await expect(turn.locator('.part.user .chat-markdown')).toHaveCSS('font-size', '18px');
    await expect(reply.locator('.direct-speech')).toHaveCount(0);
    await expect(turn.getByLabel('Generating', { exact: true })).toBeVisible();
    await request.post('/__test/finish', { data: {} });
    await expect(reply.locator('em')).toHaveText('Stay close');
    await expect(reply.locator('.chat-markdown')).toHaveCSS('font-size', '18px');
    await expect(reply.locator('.direct-speech').first()).toHaveCSS('color', 'rgb(238, 170, 136)');
    await expect(reply.locator('.direct-speech')).toHaveText(['"', 'Stay close', ', traveler."', '— Послушайте!', '— Я ведь не знал.']);
    await expect(reply.locator('img')).toHaveAttribute('src', 'https://example.com/reply.png');
    await expect(turn.getByLabel('Generating', { exact: true })).toHaveCount(0);
    const atEnd = () => page.locator('.transcript').evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight < 5);
    await expect.poll(atEnd).toBe(true);
    releaseReplyImage();
    await expect.poll(() => reply.locator('img').evaluate(node => node instanceof HTMLImageElement && node.complete && node.naturalWidth === 1600)).toBe(true);
    await expect.poll(atEnd).toBe(true);
    await page.reload();
    await expect(reply.locator('em')).toHaveText('Stay close');
    await expect(reply.locator('.chat-markdown')).toHaveCSS('font-size', '18px');
    await expect(reply.locator('.direct-speech').first()).toHaveCSS('color', 'rgb(238, 170, 136)');
    const saved = await state();
    expect(saved.turns[1].user.text).toBe(input);
    expect(saved.turns[1].assistant.text).toBe(markdownReplyStart + markdownReplyEnd);
    // Inspect the server's immutable outgoing request, not a presentation-derived approximation.
    const historical = await page.request.get(`/api/chats/${chat.id}/generations/${saved.generations[0].id}/request`).then(response => response.json());
    expect(historical.body.messages).toContainEqual({ role: 'user', content: '*I enter.* "You say that like they sell \'em at the gas station."' });
    const outgoingGreeting = historical.body.messages.find((message: { role: string }) => message.role === 'assistant').content;
    expect(outgoingGreeting).toContain('*Mara smiles.*');
    expect(outgoingGreeting).not.toContain('tracker.png');
    expect(outgoingGreeting).not.toContain('empty-alt.png');
    expect(outgoingGreeting).not.toContain('reference.png');
    // Raw HTML remains literal prose, as it is never an active image in Story.
    expect(outgoingGreeting).toContain('<img src="https://example.com/hidden.png"');
    const actualRequests = await request.get('/__test/requests').then(response => response.json());
    expect(actualRequests.at(-1).body.messages).toEqual(historical.body.messages);
    await reply.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('markdown-conversation.png'), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally {
    releaseReplyImage();
    const currentAppearance = appearanceStatusSchema.parse(await page.request.get('/api/application/appearance').then(response => response.json()));
    const restored = await page.request.put('/api/application/appearance', {
      headers: { Origin: 'http://127.0.0.1:4173' }, data: { revision: currentAppearance.revision, settings: originalAppearance.settings },
    });
    expect(restored.ok()).toBe(true);
    await request.post('/__test/finish', { data: {} });
    await request.post('/__test/mode', { data: { mode: 'normal' } });
  }
});
