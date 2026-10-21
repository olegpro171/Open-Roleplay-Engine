import { expect, test } from '@playwright/test';
import type { LibrarySnapshot } from '../../src/shared/library';
import type { ChatSnapshot } from '../../src/shared/contracts';
import { defaultAppearance, type AppearanceStatus } from '../../src/shared/appearance';

for (const width of [1440, 390]) test(`saves speech colors from both editors and updates existing chat presentation at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 900 });
  const session = await page.request.get('/api/session').then(response => response.json());
  await page.goto('/');
  await page.getByLabel('Owner password').fill('browser-synthetic-password');
  await page.getByRole('button', { name: session.setupRequired ? 'Create owner account' : 'Sign in', exact: true }).click();
  const library = (): Promise<LibrarySnapshot> => page.request.get('/api/library').then(response => response.json());
  const name = `Speech colors ${width}`;
  await page.getByRole('button', { name: 'Libraries', exact: true }).click();
  for (const kind of ['character', 'persona'] as const) {
    await page.getByRole('button', { name: kind === 'character' ? 'Characters' : 'Personas', exact: true }).click();
    await page.getByRole('button', { name: `New ${kind}`, exact: true }).click();
    await page.getByLabel('Name', { exact: true }).fill(name);
    const color = page.getByLabel('Speech color', { exact: true });
    await expect(page.getByText('Not set', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Set color', exact: true }).click();
    await expect(color).toHaveValue('#a8c9f0');
    await color.fill(kind === 'character' ? '#eeaa88' : '#88cc99');
    await color.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`${kind}-color-editor.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('button', { name: `Save ${kind}`, exact: true }).click();
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  }
  const savedLibrary = await library();
  const character = savedLibrary.characters.find(item => item.name === name);
  const persona = savedLibrary.personas.find(item => item.name === name);
  if (!character || !persona) throw new Error('Missing colored records');
  expect(character.speechColor).toBe('#eeaa88');
  expect(persona.speechColor).toBe('#88cc99');
  const headers = { Origin: 'http://127.0.0.1:4173' };
  const created = await page.request.post('/api/chats', { headers, data: { title: name, targetInputTokens: 32000, connectionId: null, promptId: 'default', characterId: character.id, personaId: persona.id } });
  expect(created.ok(), await created.text()).toBe(true);
  const { id } = await created.json();
  const state = (): Promise<ChatSnapshot> => page.request.get(`/api/chats/${id}`).then(response => response.json());
  const replaced = await page.request.put(`/api/chats/${id}/history`, { headers, data: { revision: (await state()).revision, turns: [{ user: 'I ask "Ready?"', assistant: 'She replies "Yes."\n— Привет!', complete: true }] } });
  expect(replaced.ok(), await replaced.text()).toBe(true);
  await page.evaluate(chatId => localStorage.setItem('roleplay-chat', chatId), id);
  await page.reload();
  const userSpeech = page.locator('.part.user .direct-speech');
  const assistantSpeech = page.locator('.part.assistant .direct-speech');
  await expect(userSpeech).toHaveCSS('color', 'rgb(136, 204, 153)');
  await expect(assistantSpeech.first()).toHaveCSS('color', 'rgb(238, 170, 136)');
  const before = await state();

  await page.getByRole('button', { name: 'Libraries', exact: true }).click();
  await page.getByRole('button', { name: 'Characters', exact: true }).click();
  await page.getByRole('button', { name: `Edit ${name}`, exact: true }).click();
  await expect(page.getByLabel('Speech color', { exact: true })).toHaveValue('#eeaa88');
  await page.getByLabel('Speech color', { exact: true }).fill('#cc99ff');
  await page.route(`**/api/library/${character.id}`, route => route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ message: 'Synthetic save rejection.' }) }), { times: 1 });
  await page.getByRole('button', { name: 'Save character', exact: true }).click();
  await expect(page.getByRole('alert').first()).toContainText('Synthetic save rejection.');
  await expect(page.getByLabel('Speech color', { exact: true })).toHaveValue('#cc99ff');
  expect((await library()).characters.find(item => item.id === character.id)?.speechColor).toBe('#eeaa88');
  await page.getByRole('button', { name: 'Save character', exact: true }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Story', exact: true }).click();
  await expect(assistantSpeech.first()).toHaveCSS('color', 'rgb(204, 153, 255)');
  await expect(userSpeech).toHaveCSS('color', 'rgb(136, 204, 153)');
  expect(await state()).toEqual(before);
  await page.reload();
  await expect(assistantSpeech.first()).toHaveCSS('color', 'rgb(204, 153, 255)');
  await page.screenshot({ path: testInfo.outputPath('speech-colors-chat.png'), fullPage: true });
  const current = await state();
  const deselected = await page.request.put(`/api/chats/${id}/selections`, { headers, data: { revision: current.revision, settings: { title: name, targetInputTokens: 32000, connectionId: null, promptId: 'default', characterId: null, personaId: null } } });
  expect(deselected.ok(), await deselected.text()).toBe(true);
  await page.reload();
  await expect(assistantSpeech.first()).toHaveCSS('color', 'rgb(168, 201, 240)');
  await expect(userSpeech).toHaveCSS('color', 'rgb(168, 201, 240)');
});

for (const width of [1440, 390]) test(`uses app defaults for unset cards and clears overrides safely at ${width}px`, async ({ page, context }, testInfo) => {
  await page.setViewportSize({ width, height: 900 });
  const session = await page.request.get('/api/session').then(response => response.json());
  await page.goto('/');
  await page.getByLabel('Owner password').fill('browser-synthetic-password');
  await page.getByRole('button', { name: session.setupRequired ? 'Create owner account' : 'Sign in', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Libraries', exact: true })).toBeVisible();
  const headers = { Origin: 'http://127.0.0.1:4173' };
  const library = (): Promise<LibrarySnapshot> => page.request.get('/api/library').then(response => response.json());
  const appearance = (): Promise<AppearanceStatus> => page.request.get('/api/application/appearance').then(response => response.json());
  const name = `Default colors ${width}`;
  // Populate optional prompt fields so opening the editor adds no normalization changes.
  const createdCharacter = await page.request.post('/api/library', { headers, data: { kind: 'characters', revision: (await library()).revision, data: { name, description: '', personality: '', scenario: '', first_mes: '', mes_example: '', alternate_greetings: [], system_prompt: '', post_history_instructions: '', depth_prompt: { prompt: '', role: 'system', depth: 2 }, speechColor: '#cc99ff' } } });
  expect(createdCharacter.ok(), await createdCharacter.text()).toBe(true);
  const character = await createdCharacter.json();
  const createdPersona = await page.request.post('/api/library', { headers, data: { kind: 'personas', revision: (await library()).revision, data: { name, description: '' } } });
  expect(createdPersona.ok()).toBe(true);
  const persona = await createdPersona.json();
  const createdChat = await page.request.post('/api/chats', { headers, data: { title: name, targetInputTokens: 32000, connectionId: null, promptId: 'default', characterId: character.id, personaId: persona.id } });
  expect(createdChat.ok()).toBe(true);
  const { id } = await createdChat.json();
  const state = (): Promise<ChatSnapshot> => page.request.get(`/api/chats/${id}`).then(response => response.json());
  const replaced = await page.request.put(`/api/chats/${id}/history`, { headers, data: { revision: (await state()).revision, turns: [{ user: '"Ready?"', assistant: '"Yes."', complete: true }] } });
  expect(replaced.ok()).toBe(true);
  await page.evaluate(chatId => localStorage.setItem('roleplay-chat', chatId), id);
  await page.route('**/api/application/appearance', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Synthetic appearance load failure.' }) }));
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('Synthetic appearance load failure.');
  await expect(page.locator('.part.user .direct-speech')).toHaveCSS('color', 'rgb(168, 201, 240)');
  await page.unroute('**/api/application/appearance');
  await page.getByRole('button', { name: 'Retry chat appearance', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry chat appearance', exact: true })).toHaveCount(0);
  const observer = await context.newPage();
  await observer.setViewportSize({ width, height: 900 });
  await observer.goto('/');
  const before = await state();
  try {
    await page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('region', { name: 'Chat appearance', exact: true });
    await page.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'Chat appearance', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Chat appearance', exact: true })).toBeFocused();
    const slider = settings.getByRole('slider', { name: 'Text scale' });
    const preview = settings.getByRole('region', { name: 'Chat text preview' }).locator('.chat-markdown');
    const saveButton = settings.getByRole('button', { name: 'Save chat appearance', exact: true });
    const buttonFontSize = await saveButton.evaluate(element => getComputedStyle(element).fontSize);
    await expect(slider).toHaveValue('100');
    await slider.focus();
    await slider.press('Home');
    for (const [scale, pixels] of [[90, 13.5], [100, 15], [110, 16.5], [120, 18]]) {
      await expect(slider).toHaveValue(String(scale));
      await expect(preview).toHaveCSS('font-size', `${pixels}px`);
      await expect(preview).toHaveCSS('line-height', `${Number((pixels * 1.85).toFixed(3))}px`);
      if (scale < 120) await slider.press('ArrowRight');
    }
    await expect(saveButton).toHaveCSS('font-size', buttonFontSize);
    await expect(observer.locator('.part.user .chat-markdown')).toHaveCSS('font-size', '15px');
    await page.getByLabel('Default character speech color', { exact: true }).fill('#eeaa88');
    await page.getByLabel('Default persona speech color', { exact: true }).fill('#88cc99');
    await page.route('**/api/application/appearance', route => route.request().method() === 'PUT'
      ? route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ message: 'Synthetic appearance save failure.' }) }) : route.continue());
    await settings.getByRole('button', { name: 'Save chat appearance', exact: true }).click();
    await expect(settings.getByRole('alert')).toContainText('Synthetic appearance save failure.');
    await expect(page.getByLabel('Default persona speech color', { exact: true })).toHaveValue('#88cc99');
    expect((await appearance()).settings).toEqual(defaultAppearance);
    await expect(slider).toHaveValue('120');
    await expect(preview).toHaveCSS('font-size', '18px');
    await page.unroute('**/api/application/appearance');
    await settings.getByRole('button', { name: 'Save chat appearance', exact: true }).click();
    await expect(settings.getByRole('status')).toHaveText('Chat appearance saved.');
    await expect(observer.locator('.part.user .chat-markdown')).toHaveCSS('font-size', '18px');
    await expect(observer.locator('.part.assistant .chat-markdown')).toHaveCSS('font-size', '18px');
    await expect(observer.locator('.part.user .direct-speech')).toHaveCSS('color', 'rgb(136, 204, 153)');
    await expect(observer.locator('.part.assistant .direct-speech')).toHaveCSS('color', 'rgb(204, 153, 255)');
    await settings.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('chat-appearance.png'), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    // An external save must retain local drafts and reject stale writes.
    await page.getByLabel('Default persona speech color', { exact: true }).fill('#ffffff');
    const currentAppearance = await appearance();
    const external = await page.request.put('/api/application/appearance', { headers, data: { revision: currentAppearance.revision, settings: { characterSpeechColor: '#eeaa88', personaSpeechColor: '#99bbdd' } } });
    expect(external.ok()).toBe(true);
    await expect(settings.getByRole('alert')).toContainText('another window');
    await expect(page.getByLabel('Default persona speech color', { exact: true })).toHaveValue('#ffffff');
    await expect(settings.getByRole('button', { name: 'Save chat appearance', exact: true })).toBeDisabled();
    await settings.getByRole('button', { name: 'Reload chat appearance', exact: true }).click();
    await expect(page.getByLabel('Default persona speech color', { exact: true })).toHaveValue('#99bbdd');
    await expect(observer.locator('.part.user .direct-speech')).toHaveCSS('color', 'rgb(153, 187, 221)');

    await page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Libraries', exact: true }).click();
    for (const kind of ['character', 'persona'] as const) {
      await page.getByRole('button', { name: kind === 'character' ? 'Characters' : 'Personas', exact: true }).click();
      if (kind === 'character') await page.getByRole('button', { name: `Edit ${name}`, exact: true }).click();
      else await page.getByRole('article').filter({ has: page.getByRole('heading', { name, exact: true }) }).getByRole('button', { name: 'Edit', exact: true }).click();
      if (kind === 'persona') {
        await expect(page.getByText('Not set', { exact: true })).toBeVisible();
        await page.getByRole('button', { name: 'Set color', exact: true }).click();
        await page.getByLabel('Speech color', { exact: true }).fill('#ffffff');
      }
      await page.getByRole('button', { name: 'Clear color', exact: true }).click();
      await expect(page.getByText('Not set', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: `Save ${kind}`, exact: true }).click();
      await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
    }
    await expect(observer.locator('.part.assistant .direct-speech')).toHaveCSS('color', 'rgb(238, 170, 136)');
    expect((await library()).characters.find(item => item.id === character.id)).not.toHaveProperty('speechColor');
    expect((await library()).personas.find(item => item.id === persona.id)).not.toHaveProperty('speechColor');
    expect(await state()).toEqual(before);
    await page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Story', exact: true }).click();
    await page.reload();
    await expect(page.locator('.part.assistant .direct-speech')).toHaveCSS('color', 'rgb(238, 170, 136)');
    await expect(page.locator('.part.user .direct-speech')).toHaveCSS('color', 'rgb(153, 187, 221)');
    await expect(page.locator('.part.user .chat-markdown')).toHaveCSS('font-size', '18px');
    await expect(page.locator('.part.assistant .chat-markdown')).toHaveCSS('font-size', '18px');
    await page.screenshot({ path: testInfo.outputPath('default-speech-colors.png'), fullPage: true });
  } finally {
    await observer.close();
    const current = await appearance();
    const restored = await page.request.put('/api/application/appearance', { headers, data: { revision: current.revision, settings: defaultAppearance } });
    expect(restored.ok()).toBe(true);
  }
});
