import { openChatTool } from './chat-tools';
import { test, expect, type Page } from '@playwright/test';
import type { LibrarySnapshot } from '../../src/shared/library';

async function setup(page: Page) {
  const session = await page.request.get('/api/session').then(response => response.json());
  const { endpoint } = await page.request.get('/__test/endpoint').then(response => response.json());
  await page.request.post('/__test/mode', { data: { mode: 'normal' } });
  await page.goto('/');
  await page.getByLabel('Owner password').fill('browser-synthetic-password');
  await page.getByRole('button', { name: session.setupRequired ? 'Create owner account' : 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Libraries', exact: true })).toBeVisible();
  const library = await page.request.get('/api/library').then(response => response.json() as Promise<LibrarySnapshot>);
  const response = await page.request.post('/api/library', { headers: { Origin: 'http://127.0.0.1:4173' }, data: {
    revision: library.revision, kind: 'connections', data: { name: 'Draft model', endpoint, model: 'synthetic-roleplay', contextWindow: 100_000, maxOutputTokens: 1_000, customParameters: {} },
  } });
  expect(response.ok()).toBe(true);
  const { id: connectionId } = await response.json();
  const ids: string[] = [];
  for (const title of ['Draft story A', 'Draft story B']) {
    const created = await page.request.post('/api/chats', { headers: { Origin: 'http://127.0.0.1:4173' }, data: {
      title: `${title} ${test.info().testId}`, targetInputTokens: 20_000, connectionId, promptId: 'default', characterId: null, personaId: null, contextPresetId: null,
    } });
    expect(created.ok()).toBe(true);
    ids.push((await created.json()).id);
  }
  await open(page, 'Draft story A');
  return ids;
}
async function open(page: Page, title: string) {
  await page.getByRole('button', { name: 'Libraries', exact: true }).click();
  await page.getByRole('button', { name: 'Chats', exact: true }).click();
  await page.getByRole('article').filter({ has: page.getByRole('heading', { name: `${title} ${test.info().testId}`, exact: true }) }).last().getByRole('button', { name: 'Open chat', exact: true }).click();
  await expect(page.getByLabel('Your next turn')).toBeVisible();
}

for (const width of [1440, 390]) test(`composer fits its content at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await setup(page);
  const composer = page.getByLabel('Your next turn');
  const send = page.getByRole('button', { name: 'Send', exact: true });
  const height = () => composer.evaluate(field => field.getBoundingClientRect().height);
  const fits = () => composer.evaluate(field => field.scrollHeight <= field.clientHeight + 1);
  const minimum = await send.evaluate(button => button.getBoundingClientRect().height);
  await expect.poll(height).toBe(minimum);

  await composer.pressSequentially('Mira waits.');
  await composer.press('Enter');
  await composer.pressSequentially('Leon returns the key.');
  await expect.poll(height).toBeGreaterThan(minimum);
  await expect.poll(fits).toBe(true);
  const multilineHeight = await height();
  await page.reload();
  await expect(composer).toHaveValue('Mira waits.\nLeon returns the key.');
  await expect.poll(height).toBe(multilineHeight);
  await composer.fill('');
  await expect.poll(height).toBe(minimum);

  await composer.fill('Mira watches the lantern. '.repeat(12));
  await expect.poll(fits).toBe(true);
  const originalHeight = await height();
  await page.setViewportSize({ width: width === 1440 ? 390 : 1440, height: 900 });
  await expect.poll(async () => width === 1440 ? (await height()) > originalHeight : (await height()) < originalHeight).toBe(true);
  await expect.poll(fits).toBe(true);
  await page.setViewportSize({ width, height: 900 });
  await expect.poll(height).toBe(originalHeight);

  await composer.fill('A long draft line.\n'.repeat(60));
  await expect.poll(height).toBeLessThanOrEqual(270);
  await expect.poll(fits).toBe(false);
  await composer.press('ControlOrMeta+End');
  expect(await composer.evaluate(field => field.scrollTop)).toBeGreaterThan(0);
  await composer.pressSequentially('The story continues.');
  expect(await composer.evaluate(field => field.scrollTop)).toBeGreaterThan(0);
  await page.screenshot({ path: `test-results/composer-${width}.png`, fullPage: true });
  await composer.fill('I keep the key.');
  await expect.poll(height).toBe(minimum);
  await send.click();
  await expect(composer).toBeEnabled();
  await expect(composer).toHaveValue('');
  await expect.poll(height).toBe(minimum);
});

test('drafts survive menus, chat switches, reloads and closing the browser page', async ({ page, context }) => {
  await setup(page);
  const text = '\n  Mira holds the key.\nОна ждёт ответа.  \n';
  await page.getByLabel('Your next turn').fill(text);
  await page.getByRole('button', { name: 'Story', exact: true }).click();
  await openChatTool(page, 'Chat settings');
  await page.getByRole('button', { name: 'Story', exact: true }).click();
  await expect(page.getByLabel('Your next turn')).toHaveValue(text);
  await open(page, 'Draft story B');
  await expect(page.getByLabel('Your next turn')).toHaveValue('');
  await page.getByLabel('Your next turn').fill('Leon waits in the other story.');
  await open(page, 'Draft story A');
  await expect(page.getByLabel('Your next turn')).toHaveValue(text);
  await page.reload();
  await expect(page.getByLabel('Your next turn')).toHaveValue(text);
  await page.close();
  const reopened = await context.newPage();
  await reopened.goto('/');
  await expect(reopened.getByLabel('Your next turn')).toHaveValue(text);
  await open(reopened, 'Draft story B');
  await expect(reopened.getByLabel('Your next turn')).toHaveValue('Leon waits in the other story.');
  await reopened.getByLabel('Your next turn').fill('');
  await reopened.reload();
  await expect(reopened.getByLabel('Your next turn')).toHaveValue('');
});

test('failed sends retain exact drafts and retry identity across reload until acknowledged', async ({ page }) => {
  const [chatId] = await setup(page);
  const text = '\nMira refuses to lose this message.\n';
  await page.getByLabel('Your next turn').fill(text);
  const commands: unknown[] = [];
  await page.route(`**/api/chats/${chatId}/turns`, async route => {
    commands.push(route.request().postDataJSON());
    await route.abort('connectionrefused');
  });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByLabel('Your next turn')).toHaveValue(text);
  await page.reload();
  await expect(page.getByLabel('Your next turn')).toHaveValue(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => commands.length).toBe(2);
  expect(commands[1]).toEqual(commands[0]);
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
  await page.unroute(`**/api/chats/${chatId}/turns`);
  // The server saves the turn, but the acknowledgement is lost.
  await page.route(`**/api/chats/${chatId}/turns`, async route => {
    await route.fetch();
    await route.abort('failed');
  });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('article')).toHaveCount(1);
  await expect(page.getByLabel('Your next turn')).toBeEnabled();
  await expect(page.getByLabel('Your next turn')).toHaveValue(text);
  await page.reload();
  await expect(page.getByLabel('Your next turn')).toHaveValue(text);
  await page.unroute(`**/api/chats/${chatId}/turns`);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByLabel('Your next turn')).toHaveValue('');
  await expect(page.getByRole('article')).toHaveCount(1);
  await page.reload();
  await expect(page.getByLabel('Your next turn')).toHaveValue('');
});

test('late acknowledgement clears only the submitted chat draft', async ({ page }) => {
  const [chatId] = await setup(page);
  await open(page, 'Draft story B');
  await page.getByLabel('Your next turn').fill('Keep story B draft.');
  await open(page, 'Draft story A');
  await page.getByLabel('Your next turn').fill('Send from story A.');
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/chats/${chatId}/turns`, async route => {
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('article')).toHaveCount(1);
  await open(page, 'Draft story B');
  release();
  await expect(page.getByLabel('Your next turn')).toBeEnabled();
  await expect(page.getByLabel('Your next turn')).toHaveValue('Keep story B draft.');
  await open(page, 'Draft story A');
  await expect(page.getByLabel('Your next turn')).toHaveValue('');
  await open(page, 'Draft story B');
  await expect(page.getByLabel('Your next turn')).toHaveValue('Keep story B draft.');
});


test('storage failure warns without discarding the in-memory draft', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key.startsWith('roleplay-draft:')) throw new DOMException('Storage full', 'QuotaExceededError');
      original.call(this, key, value);
    };
  });
  await page.getByLabel('Your next turn').fill('Keep this even when storage is full.');
  await expect(page.getByRole('alert')).toContainText('Draft could not be saved');
  await open(page, 'Draft story B');
  await open(page, 'Draft story A');
  await expect(page.getByLabel('Your next turn')).toHaveValue('Keep this even when storage is full.');
  await expect(page.getByRole('alert')).toContainText('Draft could not be saved');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/phone-draft-storage-warning.png', fullPage: true });
});


test('a rejected command keeps its draft and permits a corrected explicit retry', async ({ page }) => {
  const [chatId] = await setup(page);
  await page.getByLabel('Your next turn').fill('Mira keeps her unsent response.');
  let rejectedId = '';
  await page.route(`**/api/chats/${chatId}/turns`, async route => {
    rejectedId = route.request().postDataJSON().requestId;
    await route.fulfill({ status: 422, json: { message: 'Synthetic command rejection' } });
  });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Synthetic command rejection');
  await expect(page.getByLabel('Your next turn')).toHaveValue('Mira keeps her unsent response.');
  await page.reload();
  await expect(page.getByLabel('Your next turn')).toHaveValue('Mira keeps her unsent response.');
  await page.unroute(`**/api/chats/${chatId}/turns`);
  const sent = page.waitForRequest(request => request.url().endsWith(`/api/chats/${chatId}/turns`) && request.method() === 'POST');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  expect((await sent).postDataJSON().requestId).not.toBe(rejectedId);
  await expect(page.getByLabel('Your next turn')).toHaveValue('');
  await expect(page.getByRole('article')).toHaveCount(1);
});

for (const width of [1440, 390]) test(`typed double dashes become em dashes in composer and turn editors at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  const [chatId] = await setup(page);
  const composer = page.getByLabel('Your next turn');
  await composer.pressSequentially('Wait--please - stay');
  await expect(composer).toHaveValue('Wait—please - stay');
  await page.reload();
  await expect(composer).toHaveValue('Wait—please - stay');

  // Replacing selected text in the middle must keep subsequent typing at the edit.
  // Existing double dashes elsewhere are left literal.
  await composer.fill('old--text / -X end');
  await composer.evaluate((field: HTMLTextAreaElement) => field.setSelectionRange(13, 14));
  await composer.pressSequentially('-here');
  await expect(composer).toHaveValue('old--text / —here end');
  expect(await composer.evaluate((field: HTMLTextAreaElement) => field.selectionStart)).toBe(17);

  // Composition input is left to the IME, and deletion must not trigger substitution.
  await composer.fill('--');
  await composer.evaluate((field: HTMLTextAreaElement) => {
    field.value = '---';
    field.setSelectionRange(3, 3);
    field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '-', isComposing: true }));
  });
  await expect(composer).toHaveValue('---');
  await composer.press('Backspace');
  await expect(composer).toHaveValue('--');

  await composer.fill('');
  await composer.pressSequentially('I wait--quietly.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const turn = page.getByRole('article', { name: 'Turn 1', exact: true });
  await expect(turn.getByRole('button', { name: 'Edit response', exact: true })).toBeEnabled();
  for (const [button, label, text] of [
    ['Edit input', 'Edit user text', 'Input—changed.'],
    ['Edit response', 'Edit assistant text', 'Response—changed.'],
  ]) {
    await turn.getByRole('button', { name: button, exact: true }).click();
    const editor = page.getByLabel(label);
    await editor.fill('');
    await editor.pressSequentially(text.replace('—', '--'));
    await expect(editor).toHaveValue(text);
    await page.getByRole('button', { name: 'Save edit', exact: true }).click();
    await expect(editor).toHaveCount(0);
  }
  await page.reload();
  const saved = await page.request.get(`/api/chats/${chatId}`).then(response => response.json());
  expect(saved.turns[0].user.text).toBe('Input—changed.');
  expect(saved.turns[0].assistant.text).toBe('Response—changed.');
  await turn.getByRole('button', { name: 'Edit response', exact: true }).click();
  const responseEditor = page.getByLabel('Edit assistant text');
  await responseEditor.fill('Leon remembers the corridor and the locked door. '.repeat(20));
  await expect.poll(() => responseEditor.evaluate(field => field.scrollHeight <= field.clientHeight + 1)).toBe(true);
  await responseEditor.fill('Response—changed.');
  await page.getByLabel('Edit assistant text').pressSequentially('--discard');
  await page.getByRole('button', { name: 'Cancel edit', exact: true }).click();
  await turn.getByRole('button', { name: 'Edit response', exact: true }).click();
  await expect(page.getByLabel('Edit assistant text')).toHaveValue('Response—changed.');
  const longResponse = 'Leon remembers the corridor and the locked door. '.repeat(20);
  await responseEditor.fill(longResponse);
  await page.getByRole('button', { name: 'Save edit', exact: true }).click();
  await turn.getByRole('button', { name: 'Edit response', exact: true }).click();
  await expect(responseEditor).toHaveValue(longResponse);
  await expect.poll(() => responseEditor.evaluate(field => field.scrollHeight <= field.clientHeight + 1)).toBe(true);
});
