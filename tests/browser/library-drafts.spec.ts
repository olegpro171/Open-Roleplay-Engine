import { selectLibraryCategory } from './library-card-helpers';
import { openNewChatSettings, openBlankChatFixture } from './chat-tools';
import { expect, type Dialog, type Page } from '@playwright/test';
import { test } from './appearance-test';
import { themeSchema } from '../../src/shared/appearance';
import type { LibrarySnapshot } from '../../src/shared/library';
import { startBrowserApp } from '../support/browser-app';
import { quadrantPicture } from '../support/pictures';

const workspace = (page: Page) => page.getByRole('navigation', { name: 'Workspace' });
const editorAction = (page: Page, name: string) => page.getByRole('group', { name: 'Editor actions' }).getByRole('button', { name, exact: true });
const leaveDialog = (page: Page) => page.getByRole('dialog', { name: 'Leave editor?' });
const leave = (page: Page) => leaveDialog(page).getByRole('button', { name: 'Leave editor', exact: true }).click();
const description = (page: Page) => page.getByRole('textbox', { name: 'Persona description', exact: true });

async function authenticate(page: Page) {
  const { setupRequired } = await page.request.get('/api/session').then(response => response.json());
  await page.getByLabel('Owner password').fill('browser-synthetic-password');
  await page.getByRole('button', { name: setupRequired ? 'Create owner account' : 'Sign in', exact: true }).click();
  await expect(workspace(page)).toBeVisible();
}

async function openCategory(page: Page, name: string) {
  await workspace(page).getByRole('button', { name: 'Libraries', exact: true }).click();
  await selectLibraryCategory(page, name);
}

async function library(page: Page): Promise<LibrarySnapshot> {
  return page.request.get('/api/library').then(response => response.json());
}

async function reloadWithWarning(page: Page) {
  const warnings: string[] = [];
  const accept = async (dialog: Dialog) => { warnings.push(dialog.type()); await dialog.accept(); };
  page.on('dialog', accept);
  try { await page.reload(); }
  finally { page.off('dialog', accept); }
  expect(warnings).toEqual(['beforeunload']);
}

test('guards category and header navigation and editor cancel across themes and viewports', async ({ page, setAppearance }, testInfo) => {
  await page.goto('/');
  await authenticate(page);
  await openCategory(page, 'Chats');
  await openBlankChatFixture(page);
  await openNewChatSettings(page);
  await page.getByRole('button', { name: 'Return without saving', exact: true }).click();
  await openCategory(page, 'Personas');
  const newPersona = page.getByRole('button', { name: 'New persona', exact: true });
  const settings = workspace(page).getByRole('button', { name: 'Settings', exact: true });
  const story = workspace(page).getByRole('button', { name: 'Story', exact: true });

  for (const theme of ['dark', 'light', 'midnight-black'] as const) {
    await setAppearance({ theme });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 840 });
      await newPersona.click();
      await description(page).fill(`Draft at ${width} in ${theme}.`);
      if (width === 390) {
        await selectLibraryCategory(page, 'Personas');
        await expect(leaveDialog(page)).toBeHidden();
        await expect(description(page)).toHaveValue(`Draft at ${width} in ${theme}.`);
      }
      const trigger = await selectLibraryCategory(page, 'Lorebooks');
      await expect(leaveDialog(page)).toBeVisible();
      await expect(leaveDialog(page).getByRole('button', { name: 'Go back', exact: true })).toBeInViewport();
      await expect(leaveDialog(page).getByRole('button', { name: 'Leave editor', exact: true })).toBeInViewport();
      expect(await leaveDialog(page).evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`warning-${theme}-${width}.png`) });
      await leaveDialog(page).getByRole('button', { name: 'Go back', exact: true }).click();
      await expect(trigger).toBeFocused();
      await expect(description(page)).toHaveValue(`Draft at ${width} in ${theme}.`);
      await settings.click();
      await page.keyboard.press('Escape');
      await expect(leaveDialog(page)).toBeHidden();
      await expect(description(page)).toBeVisible();
      await story.click();
      await expect(leaveDialog(page)).toBeVisible();
      await page.keyboard.press('Escape');
      await editorAction(page, 'Cancel').click();
      await leave(page);
      await expect(newPersona).toBeVisible();
    }
  }

  await newPersona.click();
  await description(page).fill('Reverted draft');
  await description(page).fill('');
  await selectLibraryCategory(page, 'Lorebooks');
  await expect(leaveDialog(page)).toBeHidden();
  await expect(page.getByRole('button', { name: 'New lorebook', exact: true })).toBeVisible();
  await selectLibraryCategory(page, 'Personas');
  await newPersona.click();
  await description(page).fill('Discard on Settings navigation');
  await settings.click();
  await leave(page);
  await expect(settings).toHaveAttribute('aria-current', 'page');
  await page.reload();
  await openCategory(page, 'Personas');
  await expect(newPersona).toBeVisible();
});

test('uses a native warning on refresh, Back and tab close and restores a Connection draft without its key', async ({ page }) => {
  await page.route('**/previous-document', route => route.fulfill({ contentType: 'text/html', body: '<title>Previous document</title>' }));
  await page.goto('/previous-document');
  await page.goto('/');
  await authenticate(page);
  await openCategory(page, 'Connections');
  await page.getByRole('button', { name: 'New Connection', exact: true }).click();
  const parameters = page.getByLabel('Custom request parameters');
  const parameterTab = page.getByRole('tab', { name: 'Request parameters', exact: true });
  const advanced = page.getByText('Advanced parameters', { exact: true });
  const apiKey = page.getByLabel('API key', { exact: true });
  const temperature = page.getByLabel('Temperature', { exact: true });
  const contextWindow = page.getByLabel('Model context window', { exact: true });
  const secret = 'synthetic-key-for-this-tab-only';
  await contextWindow.fill('incomplete');
  await reloadWithWarning(page);
  await expect(contextWindow).toHaveValue('incomplete');
  await contextWindow.click();
  await contextWindow.fill('128000');
  await apiKey.fill(secret);
  await parameterTab.click();
  await temperature.fill('0.');
  await advanced.click();
  await parameters.fill('{"temperature":');
  await reloadWithWarning(page);
  await expect(parameters).toBeHidden();
  await expect(apiKey).toHaveValue('');
  await parameterTab.click();
  await advanced.click();
  await expect(parameters).toHaveValue('{"temperature":');
  await expect(temperature).toHaveValue('0.');
  await expect(page.getByText('Enter the new API key again before saving.')).toBeVisible();
  expect(await page.evaluate(() => Object.values(sessionStorage))).not.toContainEqual(expect.stringContaining(secret));
  await parameters.click();
  await parameters.fill('{"top_p":');

  const backWarning = page.waitForEvent('dialog').then(async dialog => {
    expect(dialog.type()).toBe('beforeunload');
    await dialog.dismiss();
  });
  await Promise.all([backWarning, page.evaluate(() => history.back())]);
  await expect(parameters).toHaveValue('{"top_p":');
  const closeWarning = page.waitForEvent('dialog').then(async dialog => {
    expect(dialog.type()).toBe('beforeunload');
    await dialog.dismiss();
  });
  await Promise.all([closeWarning, page.close({ runBeforeUnload: true })]);
  await expect(parameters).toHaveValue('{"top_p":');
  await editorAction(page, 'Cancel').click();
  await leave(page);
  await expect(page.getByRole('button', { name: 'New Connection', exact: true })).toBeVisible();
  await page.reload();
  await expect(parameters).toHaveCount(0);
});

test('recovers an unfinished Lorebook entry and Character prose with picture changes omitted', async ({ page }) => {
  await page.goto('/');
  await authenticate(page);
  await openCategory(page, 'Lorebooks');
  await page.getByRole('button', { name: 'New lorebook', exact: true }).click();
  await page.getByLabel('Book name', { exact: true }).fill('');
  await page.getByRole('button', { name: 'Add entry', exact: true }).click();
  await page.getByLabel('Lore content', { exact: true }).fill('First entry');
  await page.getByRole('button', { name: 'Add entry', exact: true }).click();
  await page.getByLabel('Lore content', { exact: true }).fill('Second entry\nwith prose');
  await reloadWithWarning(page);
  await expect(page.getByLabel('Book name', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Lore content', { exact: true })).toHaveValue('Second entry\nwith prose');
  await page.getByLabel('Book name', { exact: true }).fill('Recovered watchkeeper lore');
  await editorAction(page, 'Save').click();
  await expect(page.getByRole('button', { name: 'Recovered watchkeeper lore', exact: true })).toBeVisible();

  await selectLibraryCategory(page, 'Characters');
  await page.getByRole('button', { name: 'New character', exact: true }).click();
  await page.getByLabel('Character description', { exact: true }).fill('An unnamed watchkeeper.');
  await page.getByLabel('Choose picture', { exact: true }).setInputFiles({ name: 'draft.png', mimeType: 'image/png', buffer: await quadrantPicture() });
  await page.getByRole('button', { name: 'Adjust crop', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Use crop', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Adjust crop', exact: true })).toBeVisible();
  await reloadWithWarning(page);
  await expect(page.getByLabel('Character description', { exact: true })).toHaveValue('An unnamed watchkeeper.');
  await expect(page.getByText('Unsaved picture changes could not be restored.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Adjust crop', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Choose picture', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Lore & tags', exact: true }).click();
  await page.getByRole('combobox', { name: 'Default lorebook', exact: true }).click();
  await page.getByRole('option', { name: 'Recovered watchkeeper lore', exact: true }).click();
  const openBook = page.getByRole('button', { name: 'Open book', exact: true });
  await openBook.click();
  await leaveDialog(page).getByRole('button', { name: 'Go back', exact: true }).click();
  await expect(page.getByLabel('Character description', { exact: true })).toHaveValue('An unnamed watchkeeper.');
  await openBook.click();
  await leave(page);
  await expect(page.getByLabel('Book name', { exact: true })).toHaveValue('Recovered watchkeeper lore');
});

test('keeps two tab drafts independent and preserves a stale draft after another browser saves', async ({ page, context, browser, baseURL, setAppearance }, testInfo) => {
  await page.goto('/');
  await authenticate(page);
  const headers = { Origin: new URL(page.url()).origin };
  const title = 'Shared editor draft record';
  const response = await page.request.post('/api/library', {
    headers, data: { kind: 'personas', revision: (await library(page)).revision, data: { name: title, description: 'Original' } },
  });
  expect(response.ok()).toBe(true);
  const sibling = await context.newPage();
  const otherContext = await browser.newContext({ baseURL });
  try {
    await sibling.goto('/');
    const other = await otherContext.newPage();
    await other.goto('/');
    await authenticate(other);
    for (const tab of [page, sibling, other]) {
      await openCategory(tab, 'Personas');
      await tab.getByRole('button', { name: title, exact: true }).click();
      await expect(description(tab)).toHaveValue('Original');
    }
    await description(page).fill('First tab\nwith a second line');
    await description(sibling).fill('Sibling tab draft');
    await reloadWithWarning(sibling);
    await expect(description(sibling)).toHaveValue('Sibling tab draft');
    await reloadWithWarning(page);
    await expect(description(page)).toHaveValue('First tab\nwith a second line');
    await description(page).click();
    const restored = page.getByText('Draft restored from this tab.', { exact: false });
    for (const theme of ['dark', 'light', 'midnight-black'] as const) {
      await setAppearance({ theme });
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 840 });
        await restored.scrollIntoViewIfNeeded();
        await expect(restored).toBeInViewport();
        await page.screenshot({ path: testInfo.outputPath(`recovered-${theme}-${width}.png`) });
      }
    }

    await description(other).fill('Saved from another browser');
    await editorAction(other, 'Save').click();
    await expect(other.getByRole('button', { name: title, exact: true })).toBeVisible();
    const staleWarning = page.getByRole('dialog', { name: 'Warning', exact: true });
    const dismissWarning = staleWarning.getByRole('button', { name: 'Dismiss', exact: true });
    await expect(staleWarning).toContainText('The library changed. Close this editor and reopen it before saving.');
    await expect(staleWarning.getByRole('heading')).toBeFocused();
    for (const theme of themeSchema.options) {
      await setAppearance({ theme });
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 840 });
        await expect(staleWarning).toBeInViewport();
        await expect(dismissWarning).toBeInViewport();
        expect(await staleWarning.evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth)).toBe(true);
        await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`live-stale-warning-${theme}-${width}.png`) });
      }
    }
    await dismissWarning.click();
    await expect(staleWarning).toBeHidden();
    await expect(page.getByRole('button', { name: 'Library changed', exact: true })).toHaveCount(0);

    await other.getByRole('button', { name: title, exact: true }).click();
    await description(other).fill('Saved again from another browser');
    const libraryRefresh = page.waitForResponse(response => response.ok()
      && response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/library');
    await Promise.all([libraryRefresh, editorAction(other, 'Save').click()]);
    await expect(editorAction(page, 'Save')).toBeDisabled();
    await expect(description(page)).toHaveValue('First tab\nwith a second line');
    const liveCopy = page.getByText('Show draft fields to copy', { exact: true });
    await liveCopy.click();
    await expect(page.getByRole('textbox', { name: 'Draft fields', exact: true })).toHaveValue(/First tab\nwith a second line/);
    await expect(staleWarning).toHaveCount(0);
    await reloadWithWarning(page);
    await expect(page.getByText('The Library changed since this draft was opened.', { exact: false })).toBeVisible();
    await expect(editorAction(page, 'Save')).toHaveCount(0);
    await page.getByText('Show draft fields to copy', { exact: true }).click();
    const draftFields = page.getByRole('textbox', { name: 'Draft fields', exact: true });
    await expect(draftFields).toHaveValue(/First tab\nwith a second line/);
    for (const theme of ['dark', 'light', 'midnight-black'] as const) {
      await setAppearance({ theme });
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 840 });
        await expect(draftFields).toBeInViewport();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`stale-${theme}-${width}.png`) });
      }
    }
    await page.getByRole('button', { name: 'Discard draft', exact: true }).click();
    await leave(page);
    await page.getByRole('button', { name: title, exact: true }).click();
    await expect(description(page)).toHaveValue('Saved again from another browser');
    await expect(description(sibling)).toHaveValue('Sibling tab draft');
    await other.reload();
    await expect(description(other)).toHaveCount(0);
  } finally {
    await sibling.close();
    await otherContext.close();
  }
});

test('can reopen and edit a collapsed prompt block after a conflicting save', async ({ page }) => {
  await page.goto('/');
  await authenticate(page);
  const headers = { Origin: new URL(page.url()).origin };
  const prompt = {
    name: 'Concurrent prompt draft',
    blocks: [{ id: 'text-block', name: 'Opening instructions', enabled: true, kind: 'text', role: 'system', text: 'Saved prompt text.' }],
  };
  const created = await page.request.post('/api/library', {
    headers, data: { revision: (await library(page)).revision, kind: 'prompts', data: prompt },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const { id } = await created.json();
  await openCategory(page, 'Prompts');
  await page.getByRole('button', { name: prompt.name, exact: true }).click();
  const expand = page.getByRole('button', { name: /Expand block 1$/ });
  const blockText = page.getByRole('textbox', { name: 'Block text', exact: true });
  await expand.click();
  await blockText.fill('Local prompt draft.');
  await page.getByRole('button', { name: 'Collapse block 1', exact: true }).click();
  await expect(blockText).toHaveCount(0);

  const remoteBlocks = prompt.blocks.map(block => ({ ...block, text: 'Saved from the other editor.' }));
  const conflict = await page.request.put(`/api/library/${id}`, {
    headers, data: { revision: (await library(page)).revision, kind: 'prompts', data: { ...prompt, blocks: remoteBlocks } },
  });
  expect(conflict.ok(), await conflict.text()).toBe(true);
  await page.getByRole('dialog', { name: 'Warning', exact: true }).getByRole('button', { name: 'Dismiss', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 840 });
  await expect(expand).toBeEnabled();
  await expand.press('Enter');
  await expect(blockText).toHaveValue('Local prompt draft.');
  await blockText.fill('Updated local prompt draft.');
  await expect(editorAction(page, 'Save')).toBeDisabled();

  const writes: string[] = [];
  await page.route(`**/api/library/${id}`, async route => {
    if (route.request().method() === 'PUT') writes.push(route.request().url());
    await route.continue();
  });
  await page.getByRole('textbox', { name: 'Name', exact: true }).evaluate((input: HTMLInputElement) => input.form?.requestSubmit());
  await reloadWithWarning(page);
  await page.getByText('Show draft fields to copy', { exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Draft fields', exact: true })).toHaveValue(/Updated local prompt draft\./);
  expect(writes).toEqual([]);
  expect((await library(page)).prompts.find(item => item.id === id)?.blocks).toEqual(remoteBlocks);
});

test('keeps the editor and warning usable when session storage rejects the draft', async ({ page }) => {
  await page.addInitScript(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (this === window.sessionStorage) throw new DOMException('Synthetic quota failure', 'QuotaExceededError');
      setItem.call(this, key, value);
    };
  });
  await page.goto('/');
  await authenticate(page);
  await openCategory(page, 'Personas');
  await page.getByRole('button', { name: 'New persona', exact: true }).click();
  await description(page).fill('Available to save while storage is full');
  await expect(page.getByRole('alert')).toContainText('The latest draft could not be kept for reload.');
  await selectLibraryCategory(page, 'Characters');
  await leaveDialog(page).getByRole('button', { name: 'Go back', exact: true }).click();
  await expect(description(page)).toHaveValue('Available to save while storage is full');
  await page.getByLabel('Name', { exact: true }).fill('Saved without draft storage');
  await editorAction(page, 'Save').click();
  await expect(page.getByRole('button', { name: 'Saved without draft storage', exact: true })).toBeVisible();
});

test('preserves a copyable draft when a dataset wipe revokes the editing session', async ({ browser }) => {
  const app = await startBrowserApp();
  const editorBrowser = await browser.newContext({ baseURL: app.url });
  const ownerBrowser = await browser.newContext({ baseURL: app.url });
  try {
    const editor = await editorBrowser.newPage();
    const owner = await ownerBrowser.newPage();
    await editor.goto('/');
    await authenticate(editor);
    await owner.goto('/');
    await authenticate(owner);
    await openCategory(editor, 'Personas');
    await editor.getByRole('button', { name: 'New persona', exact: true }).click();
    await description(editor).fill('Preserve these edits across the wipe.');

    const preview = await owner.request.get('/api/data/wipe-preview').then(response => response.json());
    const wiped = await owner.request.post('/api/data/wipe', {
      headers: { Origin: app.url }, data: { ...preview, overwrite: true, requestId: crypto.randomUUID() },
    });
    expect(wiped.ok(), await wiped.text()).toBe(true);
    await editor.getByLabel('Owner password').fill('browser-synthetic-password');
    await editor.getByRole('button', { name: 'Sign in', exact: true }).click();
    await editor.getByRole('button', { name: 'Reload current data', exact: true }).click();
    await expect(editor.getByText('The Library changed since this draft was opened.', { exact: false })).toBeVisible();
    await expect(editorAction(editor, 'Save')).toHaveCount(0);
    await editor.getByText('Show draft fields to copy', { exact: true }).click();
    await expect(editor.getByRole('textbox', { name: 'Draft fields', exact: true })).toHaveValue(/Preserve these edits across the wipe/);
    expect((await library(editor)).personas).toEqual([]);
  } finally {
    await editorBrowser.close();
    await ownerBrowser.close();
    await app.close();
  }
});

test('keeps drafts on failed save and sign-out and clears only the signing-out tab on success', async ({ page, context }) => {
  await page.goto('/');
  await authenticate(page);
  const sibling = await context.newPage();
  try {
    await sibling.goto('/');
    for (const tab of [page, sibling]) {
      await openCategory(tab, 'Personas');
      await tab.getByRole('button', { name: 'New persona', exact: true }).click();
      await tab.getByLabel('Name', { exact: true }).fill(tab === page ? 'Main tab' : 'Sibling tab');
      await description(tab).fill(tab === page ? 'Keep on failure' : 'Keep after sibling sign-out');
    }
    await page.route('**/api/library', route => route.request().method() === 'POST'
      ? route.fulfill({ status: 422, json: { message: 'Synthetic save rejected' } }) : route.continue());
    await editorAction(page, 'Save').click();
    await expect(page.getByRole('alert').filter({ hasText: 'Synthetic save rejected' })).toBeVisible();
    await expect(editorAction(page, 'Save')).toBeEnabled();
    await reloadWithWarning(page);
    await expect(description(page)).toHaveValue('Keep on failure');

    const signOut = page.getByRole('button', { name: 'Sign out', exact: true });
    await page.route('**/api/logout', route => route.fulfill({ status: 503, json: { message: 'Synthetic sign-out failed' } }), { times: 1 });
    await signOut.click();
    await leaveDialog(page).getByRole('button', { name: 'Go back', exact: true }).click();
    await expect(description(page)).toHaveValue('Keep on failure');
    await signOut.click();
    await leave(page);
    await expect(page.getByRole('alert').filter({ hasText: 'Synthetic sign-out failed' })).toBeVisible();
    await expect(description(page)).toHaveValue('Keep on failure');
    await signOut.click();
    await leave(page);
    await expect(page.getByLabel('Owner password')).toBeVisible();
    await expect(sibling.getByLabel('Owner password')).toBeVisible();
    await authenticate(sibling);
    await expect(description(sibling)).toHaveValue('Keep after sibling sign-out');
    await page.reload();
    await openCategory(page, 'Personas');
    await expect(page.getByRole('button', { name: 'New persona', exact: true })).toBeVisible();
  } finally {
    await sibling.close();
  }
});

test('recovers one context preset draft and reveals invalid fields across both tabs', async ({ page }) => {
  await page.goto('/');
  await authenticate(page);
  await openCategory(page, 'Context presets');
  await page.getByRole('button', { name: 'New context preset', exact: true }).click();
  const memory = page.getByRole('tab', { name: 'Memory settings', exact: true });
  const prompts = page.getByRole('tab', { name: 'Prompts', exact: true });
  const tail = page.getByLabel('Minimum verbatim turns', { exact: true });
  const repair = page.getByRole('textbox', { name: 'Repair prompt', exact: true });
  const revision = (await library(page)).revision;
  await page.getByLabel('Name', { exact: true }).fill('Across context tabs');
  await tail.fill('-1');
  await memory.press('ArrowRight');
  await expect(prompts).toBeFocused();
  await page.getByText('Summary repair', { exact: true }).click();
  await repair.fill('');
  await page.getByText('Summary repair', { exact: true }).click();
  await reloadWithWarning(page);
  await expect(tail).toHaveValue('-1');
  await prompts.click();
  await editorAction(page, 'Save').click();
  await expect(tail).toBeFocused();
  await tail.fill('14');
  await editorAction(page, 'Save').click();
  await expect(repair).toBeFocused();
  await expect(repair).toHaveValue('');
  expect((await library(page)).revision).toBe(revision);
  const edited = 'Keep the original wording about {{char}} where the facts still agree.';
  await repair.fill(edited);
  await memory.click();
  await editorAction(page, 'Save').click();
  await expect(page.getByRole('heading', { name: 'Across context tabs', exact: true })).toBeVisible();
  const saved = (await library(page)).contexts.find(preset => preset.name === 'Across context tabs');
  expect(saved).toMatchObject({ minTail: 14, repairPrompt: edited });
});

test('keeps one Character draft across sections and returns to an invalid profile field', async ({ page, setAppearance }, testInfo) => {
  await page.goto('/');
  await authenticate(page);
  await openCategory(page, 'Characters');
  await page.getByRole('button', { name: 'New character', exact: true }).click();
  const profile = page.getByRole('tab', { name: 'Profile', exact: true });
  const greetings = page.getByRole('tab', { name: 'Greetings', exact: true });
  const lore = page.getByRole('tab', { name: 'Lore & tags', exact: true });
  const depth = page.getByLabel('Character note depth', { exact: true });
  const title = 'The mountain guide';
  await page.getByLabel('Name', { exact: true }).fill(title);
  await page.getByLabel('Character description').fill('She knows the winter trail.');
  await page.getByText('Card instructions', { exact: true }).click();
  await depth.fill('1001');
  await profile.press('ArrowRight');
  await expect(greetings).toBeFocused();
  await page.getByLabel('Greeting', { exact: true }).fill('Follow my tracks, {{user}}.');
  await greetings.press('End');
  await expect(lore).toBeFocused();
  await reloadWithWarning(page);
  await expect(depth).toHaveValue('1001');
  await lore.click();
  const revision = (await library(page)).revision;
  await editorAction(page, 'Save').click();
  await expect(profile).toHaveAttribute('aria-selected', 'true');
  await expect(depth).toBeFocused();
  expect((await library(page)).revision).toBe(revision);
  await depth.fill('3');

  for (const theme of themeSchema.options) {
    await setAppearance({ theme });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      for (const tab of [profile, greetings, lore]) {
        await tab.click();
        const panel = page.getByRole('tabpanel');
        await expect(panel).toHaveAccessibleName(await tab.innerText());
        expect(await panel.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
        await page.getByLabel('Name', { exact: true }).scrollIntoViewIfNeeded();
        await page.screenshot({ path: testInfo.outputPath(`${theme}-${width}-${await tab.innerText()}.png`), animations: 'disabled' });
      }
    }
  }
  await editorAction(page, 'Save').click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  expect((await library(page)).characters.find(card => card.name === title)).toMatchObject({
    description: 'She knows the winter trail.', first_mes: 'Follow my tracks, {{user}}.', depth_prompt: { depth: 3 },
  });
});
