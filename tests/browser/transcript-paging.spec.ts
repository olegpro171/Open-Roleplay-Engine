import { test, expect } from '@playwright/test';

for (const width of [1380, 390]) test(`loads a bounded transcript window without moving the reader at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  const session = await page.request.get('/api/session').then(response => response.json());
  await page.goto('/');
  await page.getByLabel('Owner password').fill('browser-synthetic-password');
  await page.getByRole('button', { name: session.setupRequired ? 'Create owner account' : 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Libraries', exact: true })).toBeVisible();
  const created = await page.request.post('/api/chats', {
    headers: { Origin: 'http://127.0.0.1:4173' },
    data: { title: `Long transcript ${width}`, targetInputTokens: 32_000, connectionId: null, promptId: 'default', characterId: null, personaId: null, contextPresetId: null },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const { id } = await created.json();
  const needle = 'The silver key waits beneath the observatory stairs.';
  const turns = Array.from({ length: 438 }, (_, index) => ({
    user: `Visit ${index + 1}. ${'Mira asks about the lantern and the locked cellar. '.repeat(3 + index % 7)}`,
    assistant: `${index === 30 ? needle : 'Leon watches the doorway.'}\n\n${'The lantern throws **moving shadows** across the stone. '.repeat(8 + index % 15)}\n\n> “We should return before morning,” he says.`,
    complete: true,
  }));
  const imported = await page.request.put(`/api/chats/${id}/history`, {
    headers: { Origin: 'http://127.0.0.1:4173' }, data: { revision: 0, turns },
  });
  expect(imported.ok(), await imported.text()).toBe(true);
  await page.evaluate(chatId => localStorage.setItem('roleplay-chat', chatId), id);
  await page.reload();
  const transcript = page.locator('.transcript');
  await expect(transcript.locator('.turn')).toHaveCount(15);
  await expect(page.getByRole('article', { name: 'Turn 424', exact: true })).toBeAttached();
  await expect(page.getByRole('article', { name: 'Turn 31', exact: true })).toHaveCount(0);
  const bottomGap = () => transcript.evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight);
  await expect.poll(bottomGap).toBeLessThan(2);
  const refreshed = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === `/api/chats/${id}/story` && url.searchParams.get('limit') === '15';
  });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await refreshed;
  await expect(transcript.locator('.turn')).toHaveCount(15);
  const anchor = page.getByRole('article', { name: 'Turn 424', exact: true });
  let releasePage: () => void = () => {};
  let gate = new Promise<void>(resolve => { releasePage = resolve; });
  let olderRequested = false;
  await page.route('**/api/chats/*/story?*', async route => {
    const hold = new URL(route.request().url()).searchParams.get('shift') === '-40' && !olderRequested;
    const response = await route.fetch();
    if (hold) { olderRequested = true; await gate; }
    await route.fulfill({ response });
  });
  await transcript.evaluate(node => { node.scrollTop = 0; });
  await expect.poll(() => olderRequested).toBe(true);
  const anchorTop = await anchor.evaluate(node => node.getBoundingClientRect().top);
  releasePage();
  await expect(transcript.locator('.turn')).toHaveCount(55);
  await expect.poll(async () => Math.abs(await anchor.evaluate(node => node.getBoundingClientRect().top) - anchorTop)).toBeLessThan(2);
  for (const [ordinal, count] of [[344, 95], [304, 120], [264, 120]]) {
    await transcript.evaluate(node => { node.scrollTop = 0; });
    await expect(page.getByRole('article', { name: `Turn ${ordinal}`, exact: true })).toBeAttached();
    await expect(transcript.locator('.turn')).toHaveCount(count);
  }
  await expect(page.getByRole('article', { name: 'Turn 438', exact: true })).toHaveCount(0);
  // Starting an editor while a page is in flight also pins its turn.
  olderRequested = false;
  gate = new Promise<void>(resolve => { releasePage = resolve; });
  await page.getByRole('button', { name: 'Load older turns', exact: true }).evaluate(button => (button as HTMLButtonElement).click());
  await expect.poll(() => olderRequested).toBe(true);
  const pinned = page.getByRole('article', { name: 'Turn 383', exact: true });
  await pinned.getByRole('button', { name: 'Edit response', exact: true }).click();
  await page.getByLabel('Edit assistant text').fill('Recoverable unsaved prose.');
  releasePage();
  await expect(page.getByRole('button', { name: 'Load older turns', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Latest turn', exact: false })).toBeDisabled();
  await expect(transcript.locator('.turn').first()).toHaveAttribute('aria-label', 'Turn 264');
  await expect(page.getByLabel('Edit assistant text')).toHaveValue('Recoverable unsaved prose.');
  await page.getByRole('article', { name: 'Turn 300', exact: true }).evaluate(node => node.scrollIntoView({ block: 'center' }));
  await page.getByRole('button', { name: 'Cancel edit', exact: true }).evaluate(button => (button as HTMLButtonElement).click());
  await page.screenshot({ path: `test-results/transcript-history-${width}.png` });
  await transcript.evaluate(node => { node.scrollTop = node.scrollHeight; });
  await expect(transcript.locator('.turn').first()).toHaveAttribute('aria-label', 'Turn 304');
  await expect(transcript.locator('.turn')).toHaveCount(120);
  await page.getByRole('button', { name: 'Latest turn', exact: false }).click();
  await expect(page.getByRole('article', { name: 'Turn 438', exact: true })).toBeInViewport();
  await expect(transcript.locator('.turn')).toHaveCount(15);
  await expect.poll(bottomGap).toBeLessThan(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `test-results/transcript-latest-${width}.png` });

  // A failed history page leaves the current turns and draft intact for retry.
  await page.getByLabel('Your next turn').fill('Keep this composer draft.');
  await page.route('**/api/chats/*/story?*', async route => {
    if (new URL(route.request().url()).searchParams.get('shift') === '-40') {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Synthetic history outage.' }) });
    } else await route.fallback();
  });
  await transcript.evaluate(node => { node.scrollTop = 0; });
  await expect(page.getByRole('alert')).toContainText('Synthetic history outage.');
  await expect(transcript.locator('.turn')).toHaveCount(15);
  await expect(page.getByLabel('Your next turn')).toHaveValue('Keep this composer draft.');
  await page.unroute('**/api/chats/*/story?*');
  await page.getByRole('button', { name: 'Load older turns', exact: true }).click();
  await expect(transcript.locator('.turn')).toHaveCount(55);
});

test('rejects delayed stale pages, reconciles generation outside the window and ignores pages after chat switching', async ({ page }) => {
  const session = await page.request.get('/api/session').then(response => response.json());
  await page.goto('/');
  await page.getByLabel('Owner password').fill('browser-synthetic-password');
  await page.getByRole('button', { name: session.setupRequired ? 'Create owner account' : 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Libraries', exact: true })).toBeVisible();
  const headers = { Origin: 'http://127.0.0.1:4173' };
  const library = await page.request.get('/api/library').then(response => response.json());
  const { endpoint } = await page.request.get('/__test/endpoint').then(response => response.json());
  const connection = await page.request.post('/api/library', { headers, data: { revision: library.revision, kind: 'connections', data: { name: 'Paged generation', endpoint, model: 'synthetic', contextWindow: 100_000, maxOutputTokens: 1000, customParameters: {} } } });
  expect(connection.ok(), await connection.text()).toBe(true);
  const { id: connectionId } = await connection.json();
  const created = await page.request.post('/api/chats', { headers, data: { title: 'Concurrent paging', targetInputTokens: 90_000, connectionId, promptId: 'default', characterId: null, personaId: null, contextPresetId: null } });
  const { id } = await created.json();
  const imported = await page.request.put(`/api/chats/${id}/history`, { headers, data: { revision: 0, turns: Array.from({ length: 200 }, (_, index) => ({ user: `Input ${index + 1}`, assistant: `Reply ${index + 1}. ${'The keeper watches the lantern. '.repeat(15)}`, complete: true })) } });
  expect(imported.ok(), await imported.text()).toBe(true);
  const fullRequests: string[] = [];
  page.on('request', request => { if (request.method() === 'GET' && new URL(request.url()).pathname === `/api/chats/${id}`) fullRequests.push(request.url()); });
  await page.evaluate(chatId => localStorage.setItem('roleplay-chat', chatId), id);
  await page.reload();
  const transcript = page.locator('.transcript');
  await expect(transcript.locator('.turn')).toHaveCount(15);
  expect(fullRequests).toEqual([]);
  let release: () => void = () => {};
  let requested = false;
  let gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/chats/${id}/story?*`, async route => {
    const response = await route.fetch();
    if (new URL(route.request().url()).searchParams.get('shift') === '-40' && !requested) {
      requested = true; await gate;
    }
    await route.fulfill({ response });
  });
  await transcript.evaluate(node => { node.scrollTop = 0; });
  await expect.poll(() => requested).toBe(true);
  const saved = await page.request.get(`/api/chats/${id}`).then(response => response.json());
  const latest = saved.turns.at(-1);
  const edited = await page.request.patch(`/api/chats/${id}/turns/${latest.id}/user`, { headers, data: { revision: saved.revision, text: 'Changed on another device.' } });
  expect(edited.ok(), await edited.text()).toBe(true);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  release();
  await expect(page.getByRole('alert')).toContainText('chat changed');
  await expect(transcript.locator('.turn')).toHaveCount(15);
  await expect(transcript.locator('.turn').first()).toHaveAttribute('aria-label', 'Turn 186');
  await expect(page.getByRole('article', { name: 'Turn 200', exact: true })).toContainText('Changed on another device.');
  await page.getByRole('button', { name: 'Load older turns', exact: true }).click();
  for (const ordinal of [146, 106, 66]) {
    await expect(transcript.locator('.turn').first()).toHaveAttribute('aria-label', `Turn ${ordinal}`);
    if (ordinal !== 66) await transcript.evaluate(node => { node.scrollTop = 0; });
  }
  await expect(page.getByRole('article', { name: 'Turn 200', exact: true })).toHaveCount(0);
  await page.request.post('/__test/mode', { data: { mode: 'hold-first-token' } });
  const current = await page.request.get(`/api/chats/${id}`).then(response => response.json());
  const started = await page.request.post(`/api/chats/${id}/turns`, { headers, data: { revision: current.revision, text: 'Remote next input.', requestId: crypto.randomUUID() } });
  expect(started.status()).toBe(202);
  await expect(page.getByLabel('Your next turn')).toBeEnabled();
  await expect(transcript.locator('.turn').first()).toHaveAttribute('aria-label', 'Turn 66');
  await expect(page.getByRole('article', { name: 'Turn 201', exact: true })).toHaveCount(0);
  await page.reload();
  const pending = page.getByRole('article', { name: 'Turn 201', exact: true });
  await expect(pending).toBeInViewport();
  await expect(pending).toContainText('Connecting…');
  await pending.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(pending).toContainText('Generation cancelled.');
  await page.request.post('/__test/mode', { data: { mode: 'normal' } });

  // A page from the old chat cannot become the new chat's transcript.
  requested = false;
  gate = new Promise<void>(resolve => { release = resolve; });
  await transcript.evaluate(node => { node.scrollTop = 0; });
  await expect.poll(() => requested).toBe(true);
  const other = await page.request.post('/api/chats', { headers, data: { title: 'Other paging story', targetInputTokens: 32_000, connectionId: null, promptId: 'default', characterId: null, personaId: null, contextPresetId: null } });
  expect(other.ok(), await other.text()).toBe(true);
  await page.getByRole('button', { name: 'Libraries', exact: true }).click();
  await page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Other paging story', exact: true }) }).click();
  await expect(page.getByRole('heading', { name: 'Other paging story', exact: true })).toBeVisible();
  release();
  await expect(page.getByRole('heading', { name: 'Set up your story', exact: true })).toBeVisible();
  await expect(transcript.locator('.turn')).toHaveCount(0);
  await expect(page.getByLabel('Your next turn')).toBeEnabled();
});
