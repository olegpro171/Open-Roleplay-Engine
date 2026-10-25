import { expect, test, type Page } from '@playwright/test';
import { authorNoteStatusSchema } from '../../src/shared/author-note';
import type { RequestPreview, ChatSnapshot } from '../../src/shared/contracts';
import { defaultContextPreset } from '../../src/shared/context';

const headers = { Origin: 'http://127.0.0.1:4173' };
async function setup(page: Page) {
  const session = await page.request.get('/api/session').then(response => response.json());
  await page.goto('/');
  await page.getByLabel('Owner password').fill('browser-synthetic-password');
  await page.getByRole('button', { name: session.setupRequired ? 'Create owner account' : 'Sign in', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible();
  await page.request.post('/__test/mode', { data: { mode: 'normal' } });
  const { endpoint } = await page.request.get('/__test/endpoint').then(response => response.json());
  const library = await page.request.get('/api/library').then(response => response.json());
  const connection = await page.request.post('/api/library', { headers, data: { revision: library.revision, kind: 'connections', data: {
    name: `Note ${test.info().testId}`, endpoint, model: 'synthetic-roleplay', contextWindow: 100_000, maxOutputTokens: 1000, customParameters: {},
  } } });
  expect(connection.ok()).toBe(true);
  const connectionId = (await connection.json()).id;
  const response = await page.request.post('/api/chats', { headers, data: {
    title: `Note ${test.info().testId}`, connectionId, promptId: 'default', characterId: null, personaId: null, contextPresetId: null, targetInputTokens: 20_000,
  } });
  expect(response.ok()).toBe(true);
  const id: string = (await response.json()).id;
  await page.evaluate(id => localStorage.setItem('roleplay-chat', id), id);
  await page.reload();
  await expect(page.getByLabel('Your next turn')).toBeVisible();
  return id;
}
async function state(page: Page, id: string): Promise<ChatSnapshot> { return page.request.get(`/api/chats/${id}`).then(response => response.json()); }
async function note(page: Page, id: string) { return authorNoteStatusSchema.parse(await page.request.get(`/api/chats/${id}/author-note`).then(response => response.json())); }
async function openNote(page: Page) {
  await expect(page.getByLabel('Your next turn')).toBeVisible();
  const details = page.getByRole('button', { name: 'Chat details', exact: true });
  if (await details.isVisible() && await details.getAttribute('aria-expanded') === 'false') await details.click();
  await page.getByRole('button', { name: 'Author’s note', exact: true }).click();
  return page.getByRole('dialog', { name: 'Author’s note', exact: true });
}

for (const width of [1280, 390]) test(`autosaves the per-chat note and sends it at history depth at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 900 });
  const id = await setup(page);
  const composer = page.getByLabel('Your next turn');
  const send = page.getByRole('button', { name: 'Send', exact: true });
  await composer.fill('Continue the scene.');
  const dialog = await openNote(page);
  await expect(dialog.getByLabel('Depth', { exact: true })).toHaveValue('2');
  const role = dialog.getByRole('combobox', { name: 'Role', exact: true });
  await expect(role).toHaveText('system');
  await role.click();
  await expect(dialog.getByRole('listbox', { name: 'Role', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('author-note-role-menu.png') });
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(role).toHaveAttribute('aria-expanded', 'false');
  await role.press('ArrowDown');
  await role.press('ArrowDown');
  await role.press('Enter');
  await expect.poll(async () => (await note(page, id)).settings.role).toBe('user');
  await dialog.getByLabel('Note text').fill('Let {{char}} trust {{user}}.');
  await dialog.getByLabel('Depth', { exact: true }).fill('1');
  await role.click();
  await dialog.getByRole('option', { name: 'assistant', exact: true }).click();
  await expect(role).toHaveText('assistant');
  await expect.poll(async () => (await note(page, id)).settings).toEqual({ prompt: 'Let {{char}} trust {{user}}.', depth: 1, role: 'assistant' });
  await page.screenshot({ path: testInfo.outputPath('author-note.png') });
  expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await dialog.getByRole('button', { name: 'Close Author’s note' }).click();
  // Phone Chat details can remain open after dismissing its modal.
  const details = page.getByRole('button', { name: 'Chat details', exact: true });
  if (await details.isVisible() && await details.getAttribute('aria-expanded') === 'true') await details.click();
  await expect(send).toBeEnabled();
  const current = await state(page, id);
  const previewResponse = await page.request.post(`/api/chats/${id}/preview`, { headers, data: { revision: current.revision, text: 'Continue the scene.' } });
  expect(previewResponse.ok()).toBe(true);
  const preview: RequestPreview = await previewResponse.json();
  expect(preview.body.messages.slice(-2)).toEqual([{ role: 'assistant', content: 'Let Character trust You.' }, { role: 'user', content: 'Continue the scene.' }]);
  await page.request.post('/__test/mode', { data: { mode: 'hold' } });
  await send.click();
  await expect.poll(async () => (await state(page, id)).generations[0]?.status).toBe('running');
  const locked = await openNote(page);
  await expect(locked.getByLabel('Note text')).toBeDisabled();
  await expect(locked.getByLabel('Depth', { exact: true })).toBeDisabled();
  await expect(locked.getByLabel('Role', { exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(locked).not.toBeVisible();
  await page.request.post('/__test/finish');
  await expect.poll(async () => (await state(page, id)).generations[0]?.status).toBe('succeeded');
  expect((await state(page, id)).generations[0].request?.body).toEqual(preview.body);
  await page.reload();
  const reopened = await openNote(page);
  await expect(reopened.getByLabel('Note text')).toHaveValue('Let {{char}} trust {{user}}.');
  await reopened.getByLabel('Note text').fill('');
  await expect.poll(async () => (await note(page, id)).settings).toEqual({ prompt: '', depth: 1, role: 'assistant' });
  await page.mouse.click(3, 3);
  await expect(reopened).not.toBeVisible();
});

test('retains failed edits across dismissal/reload and releases Send after retry or a reconciled acknowledgement', async ({ page }) => {
  const id = await setup(page);
  const path = `**/api/chats/${id}/author-note`;
  await page.getByLabel('Your next turn').fill('Keep my draft.');
  await page.route(path, route => route.request().method() === 'PUT'
    ? route.fulfill({ status: 500, json: { message: 'Synthetic note save failure.' } }) : route.continue());
  const dialog = await openNote(page);
  await dialog.getByLabel('Note text').fill('Recover this note.');
  await expect(dialog.getByRole('alert')).toContainText('Synthetic note save failure.');
  await dialog.getByRole('button', { name: 'Close Author’s note' }).click();
  const send = page.getByRole('button', { name: 'Send', exact: true });
  await expect(send).toBeDisabled();
  await expect(page.getByRole('alert')).toContainText('Retry saving before sending.');
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('Synthetic note save failure.');
  const restored = await openNote(page);
  await expect(restored.getByLabel('Note text')).toHaveValue('Recover this note.');
  await page.unroute(path);
  await restored.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect.poll(async () => (await note(page, id)).settings.prompt).toBe('Recover this note.');
  await restored.getByRole('button', { name: 'Close Author’s note' }).click();
  await expect(send).toBeEnabled();

  // The server commits but the acknowledgement is lost. Retry must recognize the saved value.
  // Hold the observer offline so an SSE refresh cannot acknowledge this write first.
  await page.route('**/api/events', route => route.abort());
  await page.reload();
  await expect(page.getByLabel('Your next turn')).toBeVisible();
  let puts = 0;
  await page.route(path, async route => {
    if (route.request().method() !== 'PUT') return route.continue();
    puts++;
    await route.fetch();
    await route.abort('failed');
  });
  const uncertain = await openNote(page);
  await uncertain.getByLabel('Note text').fill('Already committed.');
  await expect(uncertain.getByRole('alert')).toBeVisible();
  await uncertain.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(uncertain.getByRole('alert')).not.toBeVisible();
  await uncertain.getByRole('button', { name: 'Close Author’s note' }).click();
  await expect(send).toBeEnabled();
  expect(puts).toBe(1);
});

test('a stalled save becomes retryable and cannot leave Send permanently locked', async ({ page }) => {
  const id = await setup(page);
  await page.clock.install();
  const path = `**/api/chats/${id}/author-note`;
  await page.getByLabel('Your next turn').fill('Wait for the note.');
  await page.route(path, route => route.request().method() === 'PUT' ? undefined : route.continue());
  const dialog = await openNote(page);
  await dialog.getByLabel('Note text').fill('Stalled note.');
  await page.clock.runFor(1100);
  await expect(dialog.getByRole('alert')).toContainText('taking longer');
  await page.clock.runFor(15000);
  await expect(dialog.getByRole('alert')).toContainText('timed out');
  await expect(dialog.getByRole('button', { name: 'Retry', exact: true })).toBeEnabled();
  await page.unroute(path);
  await dialog.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect.poll(async () => (await note(page, id)).settings.prompt).toBe('Stalled note.');
  await dialog.getByRole('button', { name: 'Close Author’s note' }).click();
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
});

test('keeps an unresolved save with its chat while another chat remains usable', async ({ page }) => {
  const id = await setup(page);
  const original = await state(page, id);
  const otherResponse = await page.request.post('/api/chats', { headers, data: {
    title: 'Independent note chat', connectionId: original.settings.connectionId, promptId: 'default',
    characterId: null, personaId: null, contextPresetId: null, targetInputTokens: 20_000,
  } });
  expect(otherResponse.ok()).toBe(true);
  const otherId: string = (await otherResponse.json()).id;
  const path = `**/api/chats/${id}/author-note`;
  await page.route(path, route => route.request().method() === 'PUT'
    ? route.fulfill({ status: 500, json: { message: 'First chat save failed.' } }) : route.continue());
  const dialog = await openNote(page);
  await dialog.getByLabel('Note text').fill('Only the first chat.');
  await expect(dialog.getByRole('alert')).toContainText('First chat save failed.');
  await dialog.getByRole('button', { name: 'Close Author’s note' }).click();
  await page.getByRole('button', { name: 'Libraries', exact: true }).click();
  await page.getByRole('button', { name: 'Independent note chat', exact: true }).click();
  await page.getByLabel('Your next turn').fill('Second chat can send.');
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
  const independent = await openNote(page);
  await expect(independent.getByLabel('Note text')).toHaveValue('');
  await independent.getByLabel('Note text').fill('Only the second chat.');
  await expect.poll(async () => (await note(page, otherId)).settings.prompt).toBe('Only the second chat.');
  await independent.getByRole('button', { name: 'Close Author’s note' }).click();
  await page.getByRole('button', { name: 'Libraries', exact: true }).click();
  await page.getByRole('button', { name: original.settings.title, exact: true }).click();
  const recovered = await openNote(page);
  await expect(recovered.getByLabel('Note text')).toHaveValue('Only the first chat.');
  await page.unroute(path);
  await recovered.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect.poll(async () => (await note(page, id)).settings.prompt).toBe('Only the first chat.');
  expect((await note(page, otherId)).settings.prompt).toBe('Only the second chat.');
});

test('a note acknowledgement releases a superseded transcript load and keeps response refreshes working', async ({ page }) => {
  const id = await setup(page);
  const imported = await page.request.put(`/api/chats/${id}/history`, { headers, data: { revision: (await state(page, id)).revision,
    turns: Array.from({ length: 80 }, (_, index) => ({ user: `Input ${index + 1}`, assistant: `Reply ${index + 1}`, complete: true })),
  } });
  expect(imported.ok()).toBe(true);
  await page.reload();
  await expect(page.locator('.turn')).toHaveCount(15);
  let requested = false;
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/chats/${id}/story?*`, async route => {
    if (new URL(route.request().url()).searchParams.get('shift') === '-40' && !requested) {
      const response = await route.fetch();
      requested = true;
      await gate;
      await route.fulfill({ response });
    } else await route.continue();
  });
  try {
    await page.getByRole('button', { name: 'Load older turns', exact: true }).evaluate(button => { if (button instanceof HTMLButtonElement) button.click(); });
    await expect.poll(() => requested).toBe(true);
    const dialog = await openNote(page);
    await dialog.getByLabel('Note text').fill('Keep refreshes working.');
    await expect.poll(async () => (await note(page, id)).settings.prompt).toBe('Keep refreshes working.');
    release();
    await dialog.getByRole('button', { name: 'Close Author’s note' }).click();
    await expect(page.getByRole('button', { name: 'Load older turns', exact: true })).toBeEnabled();
    await page.getByLabel('Your next turn').fill('Respond after the note save.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(async () => (await state(page, id)).generations[0]?.status).toBe('succeeded');
    await expect(page.getByLabel('Your next turn')).toHaveValue('');
    await expect(page.locator('.turn').last()).toContainText('The lantern flickers.');
    await expect(page.getByLabel('Your next turn')).toBeEnabled();
  } finally { release(); }
});

test('an unresolved note never disables Stop for memory work started by another device', async ({ page }) => {
  const id = await setup(page);
  const library = await page.request.get('/api/library').then(response => response.json());
  const presetResponse = await page.request.post('/api/library', { headers, data: { revision: library.revision, kind: 'contexts',
    data: { ...defaultContextPreset, name: 'Note cancellation proof', minTail: 1, batchSize: 2, summaryTokens: 100 },
  } });
  expect(presetResponse.ok()).toBe(true);
  const contextPresetId: string = (await presetResponse.json()).id;
  const current = await state(page, id);
  const selection = await page.request.put(`/api/chats/${id}/selections`, { headers, data: { revision: current.revision, settings: {
    title: current.settings.title, connectionId: current.settings.connectionId, promptId: 'default', characterId: null, personaId: null,
    contextPresetId, targetInputTokens: 600,
  } } });
  expect(selection.ok()).toBe(true);
  const imported = await page.request.put(`/api/chats/${id}/history`, { headers, data: { revision: (await state(page, id)).revision,
    turns: Array.from({ length: 6 }, (_, index) => ({ user: `Turn ${index + 1}. ` + 'Mira carries the silver key. '.repeat(20), assistant: 'Leon waits beside the old tower. '.repeat(20), complete: true })),
  } });
  expect(imported.ok()).toBe(true);
  await page.reload();
  await page.route(`**/api/chats/${id}/author-note`, route => route.request().method() === 'PUT'
    ? route.fulfill({ status: 500, json: { message: 'Retained note failure.' } }) : route.continue());
  const dialog = await openNote(page);
  await dialog.getByLabel('Note text').fill('Save after the other device finishes.');
  await expect(dialog.getByRole('alert')).toContainText('Retained note failure.');
  await dialog.getByRole('button', { name: 'Close Author’s note' }).click();
  await page.request.post('/__test/mode', { data: { mode: 'hold' } });
  let jobId: string | null = null;
  try {
    const started = await page.request.post(`/api/chats/${id}/context/prepare`, { headers, data: {
      revision: (await state(page, id)).revision, requestId: await page.evaluate(() => crypto.randomUUID()), mode: 'prepare',
    } });
    expect(started.ok()).toBe(true);
    jobId = (await started.json()).jobId;
    await expect.poll(async () => (await state(page, id)).context.jobs.some(job => job.status === 'running')).toBe(true);
    await page.getByRole('button', { name: 'Inspect memory', exact: true }).click();
    const stop = page.getByRole('button', { name: 'Stop preparation', exact: true });
    await expect(stop).toBeEnabled();
    await stop.click();
    await expect.poll(async () => (await state(page, id)).context.jobs.find(job => job.id === jobId)?.status).toBe('cancelled');
  } finally {
    if (jobId) await page.request.post(`/api/context/jobs/${jobId}/cancel`, { headers, data: {} });
    await page.request.post('/__test/mode', { data: { mode: 'normal' } });
  }
});

test('preserves a queued revert through reload after the earlier write loses its acknowledgement', async ({ page }) => {
  const id = await setup(page);
  await page.route('**/api/events', route => route.abort());
  await page.reload();
  await expect(page.getByLabel('Your next turn')).toBeVisible();
  await page.getByLabel('Your next turn').fill('Send with the cleared note.');
  const path = `**/api/chats/${id}/author-note`;
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(path, async route => {
    if (route.request().method() !== 'PUT') return route.continue();
    await route.fetch();
    await gate;
    await route.abort('failed');
  });
  try {
    const dialog = await openNote(page);
    await dialog.getByLabel('Note text').fill('Temporary note.');
    await expect.poll(async () => (await note(page, id)).settings.prompt).toBe('Temporary note.');
    await dialog.getByLabel('Note text').fill('');
    release();
    await expect(dialog.getByRole('alert')).toBeVisible();
    await dialog.getByRole('button', { name: 'Close Author’s note' }).click();
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
    await page.unroute(path);
    await page.reload();
    await expect.poll(async () => (await note(page, id)).settings.prompt).toBe('');
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
    const restored = await openNote(page);
    await expect(restored.getByLabel('Note text')).toHaveValue('');
  } finally { release(); }
});
