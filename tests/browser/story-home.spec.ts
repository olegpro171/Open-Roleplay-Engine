import { expect, type Locator, type Page } from '@playwright/test';
import { test } from './isolated-app';
import type { ChatSnapshot } from '../../src/shared/contracts';
import { defaultPrompt, type LibrarySnapshot } from '../../src/shared/library';
import { appearanceStatusSchema } from '../../src/shared/appearance';
import { quadrantPicture } from '../support/pictures';
import { openChatCreation } from './chat-tools';

test.use({ starterChat: false });

const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const home = (page: Page) => page.getByRole('main', { name: 'New chat' });
const library = async (page: Page): Promise<LibrarySnapshot> => (await page.request.get('/api/library')).json();

async function expectActionAtPanelBottom(panel: Locator, label: string) {
  const extraSpace = await panel.getByRole('button', { name: label, exact: true }).evaluate(action => {
    const section = action.closest('section');
    if (!section) throw new Error('Missing panel');
    const style = getComputedStyle(section);
    return section.getBoundingClientRect().bottom - action.getBoundingClientRect().bottom
      - parseFloat(style.paddingBottom) - parseFloat(style.borderBottomWidth);
  });
  expect(extraSpace, `extra space below ${label}`).toBeCloseTo(0);
}

async function expectPanelBorder(panel: Locator, role: '--line' | '--danger-border') {
  const expected = await panel.evaluate((element, role) => {
    const sample = document.createElement('span');
    sample.style.color = `var(${role})`;
    element.append(sample);
    const color = getComputedStyle(sample).color;
    sample.remove();
    return color;
  }, role);
  await expect(panel).toHaveCSS('border-top-color', expected);
}

async function addCharacter(page: Page, origin: string, name: string, first_mes = '', pictured = false) {
  const response = await page.request.post('/api/library', { headers: { Origin: origin }, data: {
    kind: 'characters', revision: (await library(page)).revision,
    data: { name, first_mes, description: 'A guide who knows the paths by heart.', personality: '', scenario: '', mes_example: '' },
    ...(pictured ? { requestId: crypto.randomUUID(), expectedPicture: null, picture: {
      mode: 'replace', base64: (await quadrantPicture()).toString('base64'),
      crop: { version: 1, x: 0.25, y: 0, width: 0.5, height: 1 } } } : {}),
  } });
  expect(response.ok(), await response.text()).toBe(true);
}

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByLabel('Owner password').fill('browser-synthetic-password');
  await button(page, 'Create owner account').click();
  await expect(home(page)).toBeVisible();
  await expect(button(page, 'New chat')).toHaveAttribute('aria-current', 'page');
}

async function addConnection(page: Page) {
  const endpoint = (await (await page.request.get('/__test/endpoint')).json()).endpoint;
  await button(page, 'Add a Connection').click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('First model');
  await page.getByLabel('API base URL').fill(endpoint);
  await button(page, 'Model identifier').click();
  await page.getByLabel('Search or enter model identifier').fill('mock');
  await button(page, 'Submit').click();
  await button(page, 'Save').click();
  await expect(home(page).getByRole('region', { name: 'Connection' })).toContainText('First model');
}

test('first run guides setup, preserves a closed chat and lets an in-flight reply finish', async ({ page, browserApp }) => {
  await signIn(page);
  const intro = 'Welcome to ORE. Choose a Character and an optional Persona to start a chat.';
  await expect(home(page).getByText(intro, { exact: true })).toBeVisible();
  expect((await library(page)).chats).toEqual([]);
  await expect(button(page, 'Start chat')).toBeDisabled();
  await expect(page.getByLabel('Your next turn')).toHaveCount(0);
  const connectionPanel = home(page).getByRole('region', { name: 'Connection', exact: true });
  const addLink = connectionPanel.getByRole('button', { name: 'Add a Connection', exact: true });
  await expect(connectionPanel.getByText('No Connection selected.', { exact: true })).toBeVisible();
  await expect(addLink).toHaveCSS('text-decoration-line', 'underline');
  await addLink.click();
  await expect(page.getByLabel('API base URL')).toBeVisible();
  await button(page, 'Cancel').click();
  await expect(home(page)).toBeVisible();
  await addConnection(page);
  await expect(home(page).getByText(intro, { exact: true })).toBeVisible();
  await expect(addLink).toHaveCount(0);
  await expect(button(page, 'Start chat')).toBeDisabled();

  await button(page, 'New persona').click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Visitor');
  await page.getByLabel('Title / comment').fill('Tower traveller');
  await page.getByLabel('Persona description').fill('A traveller visiting the tower.');
  await button(page, 'Save').click();
  await expect(button(page, 'Manage Personas')).toBeVisible();
  const personaPanel = home(page).getByRole('region', { name: 'Persona', exact: true });
  const personaCard = personaPanel.getByRole('article');
  await expect(personaCard.getByRole('heading')).toHaveText('Visitor · Tower traveller');
  await expect(personaCard).toContainText('A traveller visiting the tower.');

  await expect(home(page).getByText('None selected.', { exact: true })).toBeVisible();
  await button(page, 'New character').click();
  await expect(page.getByText('Start with a name and a short description.', { exact: false })).toBeVisible();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Keeper');
  await page.getByLabel('Character description').fill('Keeps watch over a quiet tower.');
  await page.getByLabel('Greeting', { exact: true }).fill('Welcome, {{user}}. The tower is open.');
  await page.route('**/api/library', route => route.request().method() === 'POST'
    ? route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ message: 'Synthetic save failure.' }) })
    : route.fallback(), { times: 1 });
  await button(page, 'Save').click();
  await expect(page.getByText('Synthetic save failure.').first()).toBeVisible();
  await expect(page.getByLabel('Greeting', { exact: true })).toHaveValue('Welcome, {{user}}. The tower is open.');
  page.once('dialog', dialog => void dialog.accept());
  await page.reload();
  await expect(page.getByText('Draft restored from this tab.', { exact: false })).toBeVisible();
  await expect(page.getByLabel('Greeting', { exact: true })).toHaveValue('Welcome, {{user}}. The tower is open.');
  await button(page, 'Save').click();
  await expect(home(page)).toBeVisible();
  expect((await library(page)).chats).toEqual([]);
  const characterPanel = home(page).getByRole('region', { name: 'Character', exact: true });
  const characterCard = characterPanel.getByRole('article');
  await expect(characterCard).toContainText('Keeps watch over a quiet tower.');
  await addCharacter(page, browserApp.url, 'Another character', '', true);
  const homeCharacter = characterPanel.getByRole('combobox', { name: 'Character', exact: true });
  await homeCharacter.click();
  await page.getByRole('option', { name: 'Another character', exact: true }).click();
  await expect(characterCard.getByRole('heading')).toHaveText('Another character');
  const [picture] = (await library(page)).characterPictures;
  await expect(characterCard.locator('img')).toHaveAttribute('src', picture.thumbnailUrl);
  await homeCharacter.click();
  await page.getByRole('option', { name: 'Keeper', exact: true }).click();
  await expect(button(page, 'Start chat')).toBeEnabled();
  await homeCharacter.click();
  await page.getByRole('option', { name: 'None selected', exact: true }).click();
  await expect(characterCard).toHaveCount(0);
  await expect(button(page, 'Start chat')).toBeDisabled();
  await homeCharacter.click();
  await page.getByRole('option', { name: 'Keeper', exact: true }).click();

  const homePersona = personaPanel.getByRole('combobox', { name: 'Persona', exact: true });
  await homePersona.click();
  await page.getByRole('option', { name: 'Visitor · Tower traveller', exact: true }).click();

  let rejectCreation = () => {};
  const pendingCreation = new Promise<void>(resolve => { rejectCreation = resolve; });
  await page.route('**/api/chats', async route => {
    await pendingCreation;
    await route.fulfill({ status: 422, json: { message: 'Synthetic chat creation failure.' } });
  }, { times: 1 });
  try {
    await button(page, 'Start chat').click();
    await expect(button(page, 'Start chat')).toBeDisabled();
  } finally {
    rejectCreation();
  }
  await expect(page.getByRole('alert')).toContainText('Synthetic chat creation failure.');
  await expect(button(page, 'Start chat')).toBeEnabled();
  await expect(characterCard.getByRole('heading')).toHaveText('Keeper');
  await expect(personaCard.getByRole('heading')).toHaveText('Visitor · Tower traveller');
  expect((await library(page)).chats).toHaveLength(0);
  await button(page, 'Start chat').dblclick();
  const conversation = page.getByRole('region', { name: 'Conversation' });
  await expect(conversation).toContainText('Welcome, Visitor. The tower is open.');
  await expect(button(page, 'Story')).toHaveAttribute('aria-current', 'page');
  const [chat] = (await library(page)).chats;
  expect((await library(page)).chats).toHaveLength(1);
  expect(chat?.title).toBe('Keeper');
  expect(await (await page.request.get('/__test/requests')).json()).toHaveLength(0);
  await page.reload();
  await expect(conversation).toContainText('Welcome, Visitor. The tower is open.');

  await page.request.post('/__test/mode', { data: { mode: 'hold' } });
  const composer = page.getByLabel('Your next turn');
  await composer.fill('I enter.');
  await button(page, 'Send').click();
  await expect(conversation).toContainText('The lantern');
  await composer.fill('My next draft.');
  await button(page, 'Close chat').click();
  await expect(home(page)).toBeVisible();
  await page.request.post('/__test/finish');
  const readChat = async (): Promise<ChatSnapshot> => (await page.request.get(`/api/chats/${chat.id}`)).json();
  await expect.poll(async () => (await readChat()).turns.at(-1)?.complete).toBe(true);
  await expect(home(page)).toBeVisible();
  await page.reload();
  await expect(home(page)).toBeVisible();
  await expect(button(page, 'New chat')).toHaveAttribute('aria-current', 'page');
  await button(page, 'Open Chats').click();
  await button(page, 'Keeper').click();
  await expect(conversation).toContainText('The lantern flickers.');
  await expect(composer).toHaveValue('My next draft.');
  expect((await library(page)).chats.map(item => item.id)).toEqual([chat.id]);

  await button(page, 'Edit response').first().click();
  const turnEdit = page.getByLabel('Edit assistant text', { exact: true });
  await turnEdit.fill('Unsaved greeting edit.');
  await button(page, 'Libraries').click();
  await openChatCreation(page);
  await expect(home(page).getByText(intro, { exact: true })).toBeVisible();
  await homeCharacter.click();
  await page.getByRole('option', { name: 'Keeper', exact: true }).click();
  await button(page, 'Start chat').click();
  const startConfirm = page.getByRole('dialog', { name: 'Start chat', exact: true });
  await startConfirm.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect((await library(page)).chats.map(item => item.id)).toEqual([chat.id]);
  await button(page, 'Open Chats').click();
  await button(page, 'Keeper').click();
  await expect(turnEdit).toHaveValue('Unsaved greeting edit.');
  await button(page, 'Close chat').click();
  const confirm = page.getByRole('dialog', { name: 'Close chat', exact: true });
  await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(turnEdit).toHaveValue('Unsaved greeting edit.');
  await button(page, 'Close chat').click();
  await confirm.getByRole('button', { name: 'Close chat', exact: true }).click();
  await expect(home(page)).toBeVisible();
  expect((await readChat()).turns[0]?.assistant.text).toBe('Welcome, Visitor. The tower is open.');
});

test('imports a card before Connection setup and tracks bookmarks independently of library sorting', async ({ page, browserApp }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await button(page, 'Manage Characters').click();
  const characters = page.getByRole('region', { name: 'Characters', exact: true });
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), button(page, 'Import character').click()]);
  await chooser.setFiles({ name: 'card.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ name: 'Imported guide', description: 'Greets visitors.', first_mes: 'Welcome to the grove.' })) });
  await expect(characters.getByRole('heading', { name: 'Review Imported guide' })).toBeVisible();
  expect((await library(page)).characters).toEqual([]);
  await button(page, 'Import').click();
  await expect(characters.getByRole('button', { name: 'Imported guide', exact: true })).toBeVisible();
  await button(page, 'New chat').click();
  await expect(home(page)).toContainText('Imported guide');
  await expect(button(page, 'Add a Connection')).toBeVisible();
  await expect(button(page, 'Start chat')).toBeDisabled();
  await addConnection(page);

  const saved = await library(page);
  const first = saved.connections[0];
  const headers = { Origin: browserApp.url };
  const added = await page.request.post('/api/library', { headers, data: {
    kind: 'connections', revision: saved.revision, data: {
      name: 'A second model', endpoint: first.endpoint, model: 'second', contextWindow: 64_000, maxOutputTokens: 1000, customParameters: {},
    },
  } });
  expect(added.ok(), await added.text()).toBe(true);
  const panel = home(page).getByRole('region', { name: 'Connection' });
  await expect(panel).toContainText('First model');
  await button(page, 'Manage Connections').click();
  await page.getByRole('combobox', { name: 'Sort connections', exact: true }).click();
  await page.getByRole('option', { name: 'Name A–Z', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Connections', exact: true }).getByRole('heading', { level: 2 }).first()).toHaveText('A second model');
  await button(page, 'New chat').click();
  await expect(panel).toContainText('First model');
  await button(page, 'Manage Connections').click();
  await button(page, 'Set A second model as default').click();
  await expect(button(page, 'Clear A second model as default')).toBeVisible();
  await button(page, 'New chat').click();
  await expect(panel).toContainText('A second model');

  const promptPanel = home(page).getByRole('region', { name: 'Prompt', exact: true });
  await expect(promptPanel.getByRole('status')).toContainText('Default prompt');
  const promptName = 'Grove stories for travellers, wandering storytellers, and the keepers of the old forest';
  const addedPrompt = await page.request.post('/api/library', { headers, data: {
    kind: 'prompts', revision: (await library(page)).revision, data: { ...defaultPrompt, name: promptName },
  } });
  expect(addedPrompt.ok(), await addedPrompt.text()).toBe(true);
  await button(page, 'Manage Prompts').click();
  await button(page, `Set ${promptName} as default`).click();
  await expect(button(page, `Clear ${promptName} as default`)).toBeVisible();
  await button(page, 'New chat').click();
  await expect(promptPanel.getByRole('status')).toContainText(promptName);
  await page.setViewportSize({ width: 801, height: 844 });
  await expectActionAtPanelBottom(panel, 'Manage Connections');
  await page.setViewportSize({ width: 390, height: 844 });

  await expect(home(page).getByRole('heading', { name: 'Imported guide', exact: true })).toBeVisible();
  await button(page, 'Start chat').click();
  await expect(page.getByRole('region', { name: 'Conversation' })).toContainText('Welcome to the grove.');
  const [chat] = (await library(page)).chats;
  const snapshot: ChatSnapshot = await (await page.request.get(`/api/chats/${chat.id}`)).json();
  expect(snapshot.settings.connectionId).toBe((await added.json()).id);
  expect(snapshot.settings.promptId).toBe((await addedPrompt.json()).id);
  await button(page, 'Chat details').click();
  await button(page, 'Close chat').click();
  await expect(home(page)).toBeVisible();
  await button(page, 'Manage Prompts').click();
  await button(page, `Clear ${promptName} as default`).click();
  await expect(button(page, `Set ${promptName} as default`)).toBeVisible();
  await button(page, 'New chat').click();
  await expect(promptPanel.getByRole('status')).toContainText('Default prompt');
});

test('edits selected cards from New chat and returns there after saving and recovering a draft', async ({ page, browserApp }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await addCharacter(page, browserApp.url, 'Unselected guide');
  await addCharacter(page, browserApp.url, 'Forest guide');
  const character = home(page).getByRole('region', { name: 'Character', exact: true });
  await character.getByRole('combobox').click();
  await page.getByRole('option', { name: 'Forest guide', exact: true }).click();
  await button(page, 'New persona').click();
  const name = page.getByRole('textbox', { name: 'Name', exact: true });
  await name.fill('Traveller');
  await button(page, 'Save').click();
  await expect(home(page)).toBeVisible();
  const persona = home(page).getByRole('region', { name: 'Persona', exact: true });
  await expect(persona.getByRole('article')).toContainText('Traveller');
  const before = await library(page);
  const priorCharacter = before.characters.find(item => item.name === 'Forest guide');
  const [priorPersona] = before.personas;
  if (!priorCharacter || !priorPersona) throw new Error('Missing selected records');

  await character.getByRole('article').click({ position: { x: 30, y: 80 } });
  await expect(name).toHaveValue('Forest guide');
  await name.fill('Grove guide');
  await page.getByLabel('Character description').fill('Knows the paths through the grove.');
  await page.route(`**/api/library/${priorCharacter.id}`, route => route.fulfill({
    status: 422, json: { message: 'Synthetic character save rejection.' },
  }), { times: 1 });
  await button(page, 'Save').click();
  await expect(page.getByText('Synthetic character save rejection.').first()).toBeVisible();
  await expect(name).toHaveValue('Grove guide');
  expect((await library(page)).characters).toEqual(before.characters);
  await button(page, 'Save').click();
  await expect(character.getByRole('article')).toContainText('Knows the paths through the grove.');
  await expect(character.getByRole('combobox')).toContainText('Grove guide');
  await expect(persona.getByRole('article')).toContainText('Traveller');

  await persona.getByRole('button', { name: 'Traveller', exact: true }).press('Enter');
  await expect(name).toHaveValue('Traveller');
  await name.fill('Wanderer');
  await page.getByLabel('Persona description').fill('A wanderer with a worn map.');
  page.once('dialog', dialog => void dialog.accept());
  await page.reload();
  await expect(page.getByText('Draft restored from this tab.', { exact: false })).toBeVisible();
  await expect(name).toHaveValue('Wanderer');
  await button(page, 'Save').click();
  await expect(persona.getByRole('combobox')).toHaveText('Wanderer');
  await expect(persona.getByRole('article')).toContainText('A wanderer with a worn map.');
  const saved = await library(page);
  expect(saved.characters.map(item => item.id).sort()).toEqual(before.characters.map(item => item.id).sort());
  expect(saved.characters.find(item => item.id === priorCharacter.id)?.name).toBe('Grove guide');
  expect(saved.personas).toEqual([expect.objectContaining({ id: priorPersona.id, name: 'Wanderer' })]);
});

const participantLayout = (panel: Locator) => panel.evaluate(element => {
  const heading = element.querySelector('h2');
  const card = element.querySelector('.library-card');
  if (!heading || !card) throw new Error('Missing participant heading or preview');
  const bounds = element.getBoundingClientRect();
  return {
    panelHeight: bounds.height,
    titleOffset: heading.getBoundingClientRect().top - bounds.top,
    cardOffset: card.getBoundingClientRect().top - bounds.top,
    cardHeight: card.getBoundingClientRect().height,
  };
});

test('New chat fits desktop and phone in each approved theme and updates when switched to Russian', async ({ page, browserApp }, testInfo) => {
  await signIn(page);
  const welcome = home(page).getByRole('heading', { level: 1 });
  const welcomeFont = await welcome.evaluate(element => getComputedStyle(element).fontFamily);
  const connectionPanel = home(page).getByRole('region', { name: 'Connection', exact: true });
  const promptPanel = home(page).getByRole('region', { name: 'Prompt', exact: true });
  const characterPanel = home(page).getByRole('region', { name: 'Character', exact: true });
  const personaPanel = home(page).getByRole('region', { name: 'Persona', exact: true });
  const previews = async () => Promise.all([participantLayout(characterPanel), participantLayout(personaPanel)]);
  const emptyLayout = new Map<number, Awaited<ReturnType<typeof previews>>>();
  const themes = ['dark', 'light', 'midnight-black'] as const;
  const setTheme = async (theme: typeof themes[number]) => {
    const state = appearanceStatusSchema.parse(await (await page.request.get('/api/application/appearance')).json());
    const response = await page.request.put('/api/application/appearance', { headers: { Origin: browserApp.url },
      data: { revision: state.revision, settings: { ...state.settings, theme } } });
    expect(response.ok(), await response.text()).toBe(true);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  };
  for (const theme of themes) {
    await setTheme(theme);
    await expectPanelBorder(connectionPanel, '--danger-border');
    await expectPanelBorder(characterPanel, '--danger-border');
    await expectPanelBorder(promptPanel, '--line');
    await expectPanelBorder(personaPanel, '--line');
    for (const width of [1440, 801, 800, 390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      for (const label of ['Add a Connection', 'Manage Connections', 'Manage Prompts', 'New character', 'Manage Characters', 'New persona', 'Manage Personas']) {
        const bounds = await button(page, label).boundingBox();
        expect(bounds).not.toBeNull();
        if (bounds) { expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(width); }
      }
      expect(await home(page).evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
      const [connection, prompt, character, persona] = await Promise.all([
        connectionPanel.boundingBox(), promptPanel.boundingBox(), characterPanel.boundingBox(), personaPanel.boundingBox(),
      ]);
      if (!connection || !prompt || !character || !persona) throw new Error('Expected all New chat panels');
      if (width > 800) {
        expect(connection.y).toBe(prompt.y);
        expect(prompt.x).toBeGreaterThan(connection.x + connection.width);
        expect(character.width).toBe(prompt.x + prompt.width - connection.x);
      } else {
        expect(prompt.y).toBeGreaterThan(connection.y + connection.height);
        expect(character.width).toBe(connection.width);
      }
      expect(character.y).toBeGreaterThan(prompt.y + prompt.height);
      expect(persona.y).toBeGreaterThan(character.y + character.height);
      expect(persona.width).toBe(character.width);
      await expectActionAtPanelBottom(connectionPanel, 'Manage Connections');
      await expectActionAtPanelBottom(promptPanel, 'Manage Prompts');
      emptyLayout.set(width, await previews());
      if (width === 1440 || width === 390) {
        await page.screenshot({ path: testInfo.outputPath(`home-${theme}-${width}.png`), animations: 'disabled' });
        await button(page, 'Manage Personas').scrollIntoViewIfNeeded();
        await page.screenshot({ path: testInfo.outputPath(`home-${theme}-${width}-bottom.png`), animations: 'disabled' });
        await home(page).evaluate(element => { element.scrollTop = 0; });
      }
    }
  }
  await addConnection(page);
  for (const panel of [connectionPanel, promptPanel]) {
    const [title, selection, action] = await Promise.all([
      panel.getByRole('heading').boundingBox(), panel.getByRole('status').boundingBox(), panel.getByRole('button').boundingBox(),
    ]);
    if (!title || !selection || !action) throw new Error('Missing summary panel content');
    expect(selection.y - (title.y + title.height)).toBe(action.y - (selection.y + selection.height));
    await expect(panel).not.toContainText('Used for new chats');
  }
  await addCharacter(page, browserApp.url, 'Forest guide', 'Welcome to the forest.', true);
  await addCharacter(page, browserApp.url, 'Tower guide');
  await button(page, 'New persona').click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Woodland traveller');
  await page.getByLabel('Persona description').fill('An explorer with a well-worn map.');
  await button(page, 'Save').click();
  const chooseForestGuide = async () => {
    await characterPanel.getByRole('combobox', { name: 'Character', exact: true }).click();
    await page.getByRole('option', { name: 'Forest guide', exact: true }).click();
  };
  await chooseForestGuide();
  await button(page, 'Start chat').click();
  await expect(page.getByRole('region', { name: 'Conversation' })).toContainText('Welcome to the forest.');
  for (const theme of themes) {
    await setTheme(theme);
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      if (width <= 800) await button(page, 'Chat details').click();
      await expect(button(page, 'Close chat')).toBeInViewport();
      expect(await page.getByRole('heading', { name: 'Forest guide', level: 1 }).evaluate(element => getComputedStyle(element).fontFamily)).toBe(welcomeFont);
      await button(page, 'Close chat').click();
      await expect(button(page, 'Start chat')).toBeVisible();
      await expect(button(page, 'Open Chats')).toBeVisible();
      await expect(characterPanel.getByRole('button')).toHaveText(['New character', 'Manage Characters']);
      await expect(button(page, 'Manage Characters')).toHaveCSS('font-size',
        await button(page, 'Manage Personas').evaluate(element => getComputedStyle(element).fontSize));
      await expect(characterPanel.getByRole('article')).toHaveCount(0);
      await expect(personaPanel.getByRole('article')).toHaveCount(0);
      await expectPanelBorder(connectionPanel, '--line');
      await expectPanelBorder(characterPanel, '--danger-border');
      await expectPanelBorder(personaPanel, '--line');
      expect(await previews()).toEqual(emptyLayout.get(width));
      await chooseForestGuide();
      await expect(button(page, 'Start chat')).toBeEnabled();
      await expectPanelBorder(characterPanel, '--line');
      await personaPanel.getByRole('combobox', { name: 'Persona', exact: true }).click();
      await page.getByRole('option', { name: 'Woodland traveller', exact: true }).click();
      await expect(characterPanel.getByRole('article').locator('img')).toBeVisible();
      await expect(personaPanel.getByRole('article')).toContainText('An explorer with a well-worn map.');
      expect(await previews()).toEqual(emptyLayout.get(width));
      expect(await home(page).evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
      await home(page).evaluate(element => { element.scrollTop = 0; });
      await page.screenshot({ path: testInfo.outputPath(`ready-${theme}-${width}-top.png`), animations: 'disabled' });
      await button(page, 'Open Chats').scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath(`ready-${theme}-${width}-bottom.png`), animations: 'disabled' });
      for (const panel of [characterPanel, personaPanel]) {
        await panel.getByRole('combobox').click();
        await page.getByRole('option', { name: 'None selected', exact: true }).click();
        await expect(panel.getByRole('article')).toHaveCount(0);
      }
      expect(await previews()).toEqual(emptyLayout.get(width));
      await expect(button(page, 'Start chat')).toBeDisabled();
      await expectPanelBorder(characterPanel, '--danger-border');
      await button(page, 'Open Chats').click();
      await button(page, 'Forest guide').click();
      await expect(page.getByRole('region', { name: 'Conversation' })).toContainText('Welcome to the forest.');
    }
  }
  await button(page, 'Chat details').click();
  await button(page, 'Close chat').click();
  await button(page, 'Settings').click();
  await button(page, 'Language').click();
  await page.getByRole('combobox', { name: 'Interface language' }).click();
  await page.getByRole('option', { name: 'Русский', exact: true }).click();
  await button(page, 'Новый чат').click();
  await expect(button(page, 'Новый чат')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('heading', { name: 'Новый чат' })).toBeVisible();
  await expect(button(page, 'Начать чат')).toBeDisabled();
  await expect(page.getByRole('region', { name: 'Промпт', exact: true })).toContainText('Промпт по умолчанию');
  await expect(button(page, 'Управление промптами')).toBeVisible();
  await expect(button(page, 'Управление персонажами')).toBeVisible();
  await expect(button(page, 'Новый персонаж')).toBeVisible();
  await expect(button(page, 'Новая персона')).toBeVisible();
  await button(page, 'Открыть чаты').click();
  await button(page, 'Forest guide').click();
  await expect(button(page, 'История')).toHaveAttribute('aria-current', 'page');
});
