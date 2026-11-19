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
const intro = 'Welcome to ORE. Choose a Character and an optional Persona to start a chat.';

async function expectChatsShortcutBesideHeading(setup: Locator, label: string) {
  const shortcut = setup.getByRole('button', { name: label, exact: true });
  await expect(shortcut).toBeInViewport({ ratio: 1 });
  await expect(shortcut).toHaveCSS('text-decoration-line', 'none');
  const [heading, action] = await Promise.all([setup.getByRole('heading', { level: 1 }).boundingBox(), shortcut.boundingBox()]);
  if (!heading || !action) throw new Error('Missing New chat heading or All chats action');
  expect(action.x).toBeGreaterThan(heading.x + heading.width);
  expect(action.y + action.height / 2).toBeCloseTo(heading.y + heading.height / 2, 0);
  expect(action.height).toBeGreaterThanOrEqual(44);
  expect(action.width).toBeGreaterThanOrEqual(44);
}

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

async function addConnection(page: Page, actionName: 'Add a Connection' | 'Create Connection' = 'Add a Connection') {
  const endpoint = (await (await page.request.get('/__test/endpoint')).json()).endpoint;
  await button(page, actionName).click();
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
  await expect(home(page).getByText(intro, { exact: true })).toBeVisible();
  expect((await library(page)).chats).toEqual([]);
  await expect(button(page, 'All chats')).toHaveCount(0);
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
  await expect(home(page).getByRole('heading', { level: 1 })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(button(page, 'All chats')).toBeFocused();
  await page.keyboard.press('Enter');
  const chats = page.getByRole('region', { name: 'Chats', exact: true });
  await chats.getByRole('button', { name: 'Keeper', exact: true }).click();
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
  await button(page, 'All chats').click();
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
  await button(page, 'Characters').click();
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
  await expect(button(page, 'Create Connection')).toBeVisible();
  await expect(button(page, 'Start chat')).toBeDisabled();
  await addConnection(page, 'Create Connection');
  await expect(button(page, 'Create Connection')).toHaveCount(0);

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
  await button(page, 'Connections').click();
  await page.getByRole('combobox', { name: 'Sort connections', exact: true }).click();
  await page.getByRole('option', { name: 'Name A–Z', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Connections', exact: true }).getByRole('heading', { level: 2 }).first()).toHaveText('A second model');
  await button(page, 'New chat').click();
  await expect(panel).toContainText('First model');
  await button(page, 'Connections').click();
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
  await button(page, 'Prompts').click();
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
  await button(page, 'Prompts').click();
  await button(page, `Clear ${promptName} as default`).click();
  await expect(button(page, `Set ${promptName} as default`)).toBeVisible();
  await button(page, 'New chat').click();
  await expect(promptPanel.getByRole('status')).toContainText('Default prompt');
});

test('edits selected cards from New chat and returns there after saving and recovering a draft', async ({ page, browserApp }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await addCharacter(page, browserApp.url, 'Unselected guide');
  await addCharacter(page, browserApp.url, 'Forest guide', '', true);
  const character = home(page).getByRole('region', { name: 'Character', exact: true });
  await character.getByRole('combobox').click();
  await page.getByRole('option', { name: 'Forest guide', exact: true }).click();
  await button(page, 'Create persona').click();
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

  const renderedStyle = (card: Locator) => card.evaluate(element => {
    const body = element.querySelector('.library-card-body');
    const title = element.querySelector('.library-card-title');
    const description = element.querySelector('.library-card-description>p');
    const picture = element.querySelector('.picture-square');
    if (!body || !title || !description) throw new Error('Missing Library card content');
    return {
      background: getComputedStyle(element).backgroundColor,
      cornerRadius: getComputedStyle(element).borderRadius,
      padding: getComputedStyle(body).padding,
      gap: getComputedStyle(body).gap,
      titleSize: getComputedStyle(title).fontSize,
      titleLines: getComputedStyle(title).getPropertyValue('-webkit-line-clamp'),
      descriptionSize: getComputedStyle(description).fontSize,
      descriptionLineHeight: getComputedStyle(description).lineHeight,
      descriptionWrapping: getComputedStyle(description).whiteSpace,
      pictureSize: picture?.getBoundingClientRect().width ?? null,
    };
  });
  for (const [panel, category, title] of [
    [character, 'Characters', 'Forest guide'], [persona, 'Personas', 'Traveller'],
  ] as const) {
    const preview = panel.getByRole('article');
    await button(page, category).click();
    const card = page.getByRole('region', { name: category, exact: true }).getByRole('article')
      .filter({ has: page.getByRole('heading', { name: title, exact: true }) });
    await page.mouse.move(0, 0);
    const libraryStyle = await renderedStyle(card);
    await button(page, 'New chat').click();
    await page.mouse.move(0, 0);
    await expect.poll(() => renderedStyle(preview), { message: `${category} preview uses Library card styling` }).toEqual(libraryStyle);
  }

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

  await character.getByRole('combobox').click();
  await page.getByRole('option', { name: 'Grove guide', exact: true }).click();
  await expect(character.getByRole('article')).toContainText('Grove guide');
  await persona.getByRole('button', { name: 'Create persona', exact: true }).click();
  await expect(name).toHaveValue('');
  await button(page, 'Cancel').click();
  await expect(persona.getByRole('article')).toContainText('Wanderer');
  await expect(character.getByRole('article')).toContainText('Grove guide');
  expect((await library(page)).personas).toEqual(saved.personas);
});

const participantLayout = (panel: Locator) => panel.evaluate(element => {
  const heading = element.querySelector('h2');
  const card = element.querySelector('.library-card');
  if (!heading || !card) throw new Error('Missing participant heading or preview');
  const bounds = element.getBoundingClientRect();
  const cardBounds = card.getBoundingClientRect();
  const picture = card.querySelector('.picture-square')?.getBoundingClientRect();
  const body = card.querySelector('.library-card-body');
  if (!body) throw new Error('Missing participant card body');
  const bodyStyle = getComputedStyle(body);
  const pictureSpace = body.getBoundingClientRect().height - parseFloat(bodyStyle.paddingTop) - parseFloat(bodyStyle.paddingBottom);
  return {
    panelHeight: bounds.height,
    titleOffset: heading.getBoundingClientRect().top - bounds.top,
    cardOffset: cardBounds.top - bounds.top,
    cardHeight: cardBounds.height,
    picture: picture ? {
      width: picture.width,
      height: picture.height,
      availableHeight: pictureSpace,
      topInset: picture.top - cardBounds.top,
      bottomInset: cardBounds.bottom - picture.bottom,
    } : null,
  };
});

const compactActions = ['Create character', 'Characters', 'Create persona', 'Personas', 'Create Connection', 'Connections', 'Prompts'];
const desktopActions = ['New character', 'Manage Characters', 'New persona', 'Manage Personas', 'Add a Connection', 'Manage Connections', 'Manage Prompts'];

test('New chat fits desktop and phone in each approved theme and updates when switched to Russian', async ({ page, browserApp }, testInfo) => {
  await signIn(page);
  const welcome = home(page).getByRole('heading', { level: 1 });
  const welcomeFont = await welcome.evaluate(element => getComputedStyle(element).fontFamily);
  const connectionPanel = home(page).getByRole('region', { name: /^(Connection|No Connection selected\.)$/ });
  const promptPanel = home(page).getByRole('region', { name: 'Prompt', exact: true });
  const characterPanel = home(page).getByRole('region', { name: 'Character', exact: true });
  const personaPanel = home(page).getByRole('region', { name: 'Persona', exact: true });
  const previews = async () => Promise.all([participantLayout(characterPanel), participantLayout(personaPanel)]);
  const emptyLayout = new Map<number, Awaited<ReturnType<typeof previews>>>();
  const emptyConnectionLayout = new Map<number, { height: number; leftInset: number; topInset: number }>();
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
      const compact = width <= 800;
      await expect(home(page).getByText(intro, { exact: true })).toHaveCount(compact ? 0 : 1);
      await expect(personaPanel.getByText('Optional', { exact: true })).toHaveCount(compact ? 1 : 0);
      await expect(connectionPanel.getByRole('heading', { name: compact ? 'No Connection selected.' : 'Connection', exact: true })).toBeVisible();
      for (const label of compact ? compactActions : desktopActions) {
        const bounds = await button(page, label).boundingBox();
        if (!bounds) throw new Error(`Missing ${label}`);
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
        if (label !== 'Create Connection') expect(bounds.height).toBeGreaterThanOrEqual(44);
      }
      expect(await home(page).evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
      const [connection, prompt, character, persona] = await Promise.all([
        connectionPanel.boundingBox(), promptPanel.boundingBox(), characterPanel.boundingBox(), personaPanel.boundingBox(),
      ]);
      if (!connection || !prompt || !character || !persona) throw new Error('Expected all New chat panels');
      const layouts = await previews();
      if (!compact) {
        expect(connection.y).toBe(prompt.y);
        expect(prompt.x).toBeGreaterThan(connection.x + connection.width);
        expect(character.width).toBe(prompt.x + prompt.width - connection.x);
        expect(character.y).toBeGreaterThan(prompt.y + prompt.height);
        await expectActionAtPanelBottom(connectionPanel, 'Manage Connections');
        await expectActionAtPanelBottom(promptPanel, 'Manage Prompts');
      } else {
        const create = connectionPanel.getByRole('button', { name: 'Create Connection', exact: true });
        await expect(create).toHaveText(/Create$/);
        await expect(create).toHaveCSS('text-decoration-line', 'none');
        const add = await create.boundingBox();
        const heading = await connectionPanel.getByRole('heading').boundingBox();
        if (!add || !heading) throw new Error('Missing empty Connection heading or add action');
        expect(add.x).toBe(heading.x);
        expect(add.y).toBeGreaterThanOrEqual(heading.y + heading.height);
        emptyConnectionLayout.set(width, { height: connection.height, leftInset: add.x - connection.x, topInset: add.y - connection.y });
        expect(connection.y).toBeGreaterThan(persona.y + persona.height);
        expect(prompt.y).toBeCloseTo(connection.y + connection.height);
        expect(connection.width).toBe(character.width);
        expect(prompt.width).toBe(connection.width);
        for (const [panel, label] of [[connectionPanel, 'Connections'], [promptPanel, 'Prompts']] as const) {
          const heading = await panel.getByRole('heading').boundingBox();
          const manage = await panel.getByRole('button', { name: label, exact: true }).boundingBox();
          if (!heading || !manage) throw new Error('Missing summary heading or action');
          expect(manage.x).toBeGreaterThan(heading.x + heading.width);
        }
        const [characterPreview, personaPreview] = layouts;
        expect(characterPreview.cardHeight).toBe(personaPreview.cardHeight);
        const picture = characterPreview.picture;
        if (!picture) throw new Error('Missing Character picture placeholder');
        expect(picture.width).toBe(picture.height);
        expect(picture.height).toBeCloseTo(picture.availableHeight);
        expect(picture.topInset).toBeCloseTo(picture.bottomInset);
        expect(personaPreview.picture).toBeNull();
      }
      expect(persona.y).toBeGreaterThan(character.y + character.height);
      expect(persona.width).toBe(character.width);
      emptyLayout.set(width, layouts);
      if (width === 1440 || width === 390) {
        await page.screenshot({ path: testInfo.outputPath(`home-${theme}-${width}.png`), animations: 'disabled' });
        await button(page, compact ? 'Personas' : 'Manage Personas').scrollIntoViewIfNeeded();
        await page.screenshot({ path: testInfo.outputPath(`home-${theme}-${width}-bottom.png`), animations: 'disabled' });
        await home(page).evaluate(element => { element.scrollTop = 0; });
      }
      if (theme === 'dark' && width === 390) {
        const create = button(page, 'Create Connection');
        await create.scrollIntoViewIfNeeded();
        const hasTouchTarget = await create.evaluate(action => {
          const bounds = action.getBoundingClientRect();
          return bounds.width >= 44 && document.elementFromPoint(bounds.x + bounds.width / 2, bounds.bottom - 43) === action;
        });
        expect(hasTouchTarget).toBe(true);
        await welcome.focus();
        for (const label of compactActions) {
          await page.keyboard.press('Tab');
          await expect(button(page, label)).toBeFocused();
        }
        await welcome.focus();
      }
    }
  }
  await addConnection(page, 'Create Connection');
  await page.setViewportSize({ width: 1440, height: 844 });
  await expect(home(page).getByText(intro, { exact: true })).toBeVisible();
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
      await expect(button(page, 'Start chat')).toBeDisabled();
      for (const actionWidth of width === 1440 ? [801, 800, 1440] : [width]) {
        await page.setViewportSize({ width: actionWidth, height: 844 });
        const compact = actionWidth <= 800;
        await expect(home(page).getByText(intro, { exact: true })).toHaveCount(compact ? 0 : 1);
        await expectChatsShortcutBesideHeading(home(page), 'All chats');
        if (compact) {
          const start = await button(page, 'Start chat').boundingBox();
          const panel = await characterPanel.boundingBox();
          if (!start || !panel) throw new Error('Missing Start chat action or Character panel');
          expect(start.x).toBe(panel.x);
          expect(start.width).toBe(panel.width);
        }
      }
      const compact = width <= 800;
      await expect(characterPanel.getByRole('button')).toHaveText(compact ? [/Create$/, 'Characters'] : ['New character', 'Manage Characters']);
      await expect(button(page, compact ? 'Characters' : 'Manage Characters')).toHaveCSS('font-size',
        await button(page, compact ? 'Personas' : 'Manage Personas').evaluate(element => getComputedStyle(element).fontSize));
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
      if (width <= 800) {
        for (const summaryPanel of [connectionPanel, promptPanel]) {
          const bottomInset = await summaryPanel.getByRole('status').evaluate(summary => {
            const section = summary.closest('section');
            if (!section) throw new Error('Missing summary panel');
            return section.getBoundingClientRect().bottom - summary.getBoundingClientRect().bottom
              - parseFloat(getComputedStyle(section).borderBottomWidth);
          });
          expect(bottomInset, `${await summaryPanel.getByRole('heading').innerText()} bottom inset`).toBeCloseTo(5);
        }
        const panel = await connectionPanel.boundingBox();
        const summary = await connectionPanel.getByRole('status').boundingBox();
        if (!panel || !summary) throw new Error('Missing selected Connection summary');
        expect({ height: panel.height, leftInset: summary.x - panel.x, topInset: summary.y - panel.y }).toEqual(emptyConnectionLayout.get(width));
        await expect(characterPanel.getByRole('button', { name: 'Create character', exact: true })).toBeVisible();
        await expect(personaPanel.getByRole('button', { name: 'Create persona', exact: true })).toBeVisible();
      }
      expect(await home(page).evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
      await home(page).evaluate(element => { element.scrollTop = 0; });
      if (width <= 800) {
        await expect(button(page, 'Start chat')).toBeInViewport({ ratio: 1 });
      }
      await page.screenshot({ path: testInfo.outputPath(`ready-${theme}-${width}-top.png`), animations: 'disabled' });
      await button(page, 'Start chat').scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath(`ready-${theme}-${width}-bottom.png`), animations: 'disabled' });
      for (const panel of [characterPanel, personaPanel]) {
        await panel.getByRole('combobox').click();
        await page.getByRole('option', { name: 'None selected', exact: true }).click();
        await expect(panel.getByRole('article')).toHaveCount(0);
      }
      expect(await previews()).toEqual(emptyLayout.get(width));
      await expect(button(page, 'Start chat')).toBeDisabled();
      await expectPanelBorder(characterPanel, '--danger-border');
      await button(page, 'All chats').click();
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
  const russianHome = page.getByRole('main', { name: 'Новый чат', exact: true });
  const categories = ['Персонажи', 'Персоны', 'Подключения', 'Промпты'];
  for (const category of categories) {
    await russianHome.getByRole('button', { name: category, exact: true }).click();
    const destination = page.getByRole('region', { name: category, exact: true });
    await expect(destination.getByRole('heading', { level: 1, name: category, exact: true })).toBeVisible();
    if (category === 'Персонажи') await expect(destination.getByRole('button', { name: 'Импортировать персонажа', exact: true })).toBeVisible();
    await button(page, 'Новый чат').click();
  }
  for (const [name, editor] of [['Создать персонажа', 'Персонаж: Создать'], ['Создать персону', 'Новая персона']]) {
    await expect(button(page, name)).toContainText('Создать');
    await button(page, name).click();
    await expect(page.getByRole('group', { name: editor, exact: true }).getByRole('textbox', { name: 'Имя', exact: true })).toHaveValue('');
    await button(page, 'Отмена').click();
    await expect(russianHome).toBeVisible();
  }
  await expect(page.getByRole('region', { name: 'Персона', exact: true }).getByText('По желанию', { exact: true })).toBeVisible();
  for (const theme of themes) {
    await setTheme(theme);
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await russianHome.evaluate(panel => { panel.scrollTop = 0; });
      await expectChatsShortcutBesideHeading(russianHome, 'Все чаты');
      expect(await russianHome.evaluate(panel => panel.scrollWidth <= panel.clientWidth)).toBe(true);
      if (width <= 800) {
        for (const label of ['Создать персонажа', 'Создать персону', ...categories]) {
          const action = russianHome.getByRole('button', { name: label, exact: true });
          await expect(action).toHaveCSS('text-decoration-line', 'none');
          const bounds = await action.boundingBox();
          if (!bounds) throw new Error(`Missing ${label}`);
          expect(bounds.height).toBeGreaterThanOrEqual(44);
          expect(bounds.width).toBeGreaterThanOrEqual(44);
          expect(bounds.x).toBeGreaterThanOrEqual(0);
          expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
        }
      }
      await page.screenshot({ path: testInfo.outputPath(`home-russian-${theme}-${width}.png`), animations: 'disabled' });
    }
  }

  const russianConnectionPanel = page.getByRole('region', { name: 'Подключение', exact: true });
  const connectionHeight = await russianConnectionPanel.evaluate(panel => panel.getBoundingClientRect().height);
  const saved = await library(page);
  const { id, endpoint } = saved.connections[0];
  const model = 'provider/long-model-identifier-for-the-context-and-roleplay-preview';
  const updated = await page.request.put(`/api/library/${id}`, { headers: { Origin: browserApp.url }, data: {
    kind: 'connections', revision: saved.revision, data: {
      name: 'Model for long stories with the extended context window', model, endpoint,
      contextWindow: 64_000, maxOutputTokens: 1000, customParameters: {},
    },
  } });
  expect(updated.ok(), await updated.text()).toBe(true);
  await expect(russianConnectionPanel.getByRole('status')).toContainText(model);
  expect(await russianConnectionPanel.evaluate(panel => panel.getBoundingClientRect().height)).toBe(connectionHeight);

  await button(page, 'Все чаты').click();
  await button(page, 'Forest guide').click();
  await expect(button(page, 'История')).toHaveAttribute('aria-current', 'page');
});
