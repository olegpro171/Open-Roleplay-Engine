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

test('drafts survive menus, chat switches, reloads and closing the browser page', async ({ page, context }) => {
  await setup(page);
  const text = '\n  Mira holds the key.\nОна ждёт ответа.  \n';
  await page.getByLabel('Your next turn').fill(text);
  await page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Setup', exact: true }).click();
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
