import { test, expect, type Page } from '@playwright/test';
import type { GenerationPage, RequestPreview } from '../../src/shared/contracts';
import type { StorySnapshot } from '../../src/shared/transcript';
import { openChatTool } from './chat-tools';

async function fixture(page: Page, title: string) {
  const session = await page.request.get('/api/session').then(response => response.json());
  await page.request.post('/__test/mode', { data: { mode: 'normal' } });
  await page.goto('/');
  await page.getByLabel('Owner password').fill('browser-synthetic-password');
  await page.getByRole('button', { name: session.setupRequired ? 'Create owner account' : 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Libraries', exact: true })).toBeVisible();
  const command = async (path: string, data: unknown) => {
    const response = await page.request.post(`/api${path}`, { headers: { Origin: 'http://127.0.0.1:4173' }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const { endpoint } = await page.request.get('/__test/endpoint').then(response => response.json());
  const library = await page.request.get('/api/library').then(response => response.json());
  const connection = await command('/library', { revision: library.revision, kind: 'connections', data: { name: title, endpoint, model: 'synthetic-roleplay', contextWindow: 100_000, maxOutputTokens: 1000, customParameters: {} } });
  const chat = await command('/chats', { title, targetInputTokens: 32_000, connectionId: connection.id, promptId: 'default', characterId: null, personaId: null, contextPresetId: null });
  await page.evaluate(id => localStorage.setItem('roleplay-chat', id), chat.id);
  await page.reload();
  await expect(page.locator('.story-meta h1')).toHaveText(title);
  const estimate = page.locator('.story-meta dl div').filter({ hasText: 'Estimated input' }).locator('dd');
  await expect(estimate).not.toHaveText('—');
  return { id: chat.id as string, command, state: () => page.request.get(`/api/chats/${chat.id}/story`).then(response => response.json() as Promise<StorySnapshot>) };
}

test('stays idle across a real keepalive and scopes and coalesces change notifications', async ({ page }) => {
  test.setTimeout(45_000);
  const f = await fixture(page, 'Quiet refresh proof');
  const reads: string[] = [];
  page.on('request', request => { if (request.url().includes('/api/') && request.method() === 'GET') reads.push(new URL(request.url()).pathname); });
  // A negative assertion needs to span the actual server heartbeat interval.
  await page.waitForTimeout(16_000);
  expect(reads).toEqual([]);
  await page.request.post('/__test/change', { data: { kind: 'chat', chatId: 'another-chat', detail: 'stream' } });
  await page.request.post('/__test/change', { data: { kind: 'settings', setting: 'appearance' } });
  await expect.poll(() => reads).toEqual(['/api/application/appearance']);
  reads.length = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  let storyReads = 0;
  await page.route(`**/api/chats/${f.id}/story?*`, async route => {
    storyReads++;
    const response = await route.fetch();
    if (storyReads === 1) await gate;
    await route.fulfill({ response });
  });
  try {
    await page.request.post('/__test/change', { data: { kind: 'chat', chatId: f.id, detail: 'stream' } });
    await expect.poll(() => storyReads).toBe(1);
    for (let index = 0; index < 8; index++) await page.request.post('/__test/change', { data: { kind: 'chat', chatId: f.id, detail: 'stream' } });
    expect(storyReads).toBe(1);
  } finally { release(); }
  await expect.poll(() => storyReads).toBe(2);
  expect(reads.every(path => path === `/api/chats/${f.id}/story`)).toBe(true);
});

test('reconciles a settings notification superseded by transcript paging', async ({ page }) => {
  const f = await fixture(page, 'Settings during paging proof');
  const imported = await page.request.put(`/api/chats/${f.id}/history`, { headers: { Origin: 'http://127.0.0.1:4173' },
    data: { revision: (await f.state()).revision, turns: Array.from({ length: 100 }, (_, index) => ({ user: `Input ${index + 1}`, assistant: `Reply ${index + 1}`, complete: true })) } });
  expect(imported.ok()).toBe(true);
  await expect(page.locator('.turn')).toHaveCount(15);
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  let reads = 0;
  await page.route('**/api/application/appearance', async route => {
    reads++;
    const response = await route.fetch();
    if (reads === 1) await gate;
    await route.fulfill({ response });
  });
  try {
    await page.request.post('/__test/change', { data: { kind: 'settings', setting: 'appearance' } });
    await expect.poll(() => reads).toBe(1);
    await page.locator('.transcript').evaluate(node => { node.scrollTop = 0; });
    await expect(page.locator('.turn')).toHaveCount(55);
  } finally { release(); }
  await expect.poll(() => reads).toBe(2);
  await expect(page.locator('.turn')).toHaveCount(55);
});

test('keeps latest following when content grows just before a refresh commits', async ({ page }) => {
  await page.addInitScript(() => {
    const fetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await fetch(...args);
      const input = args[0];
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (new URL(url, location.href).pathname.endsWith('/story')) {
        const json = response.json.bind(response);
        response.json = async () => {
          const result = await json();
          if (document.documentElement.dataset.growBeforeRefresh) {
            delete document.documentElement.dataset.growBeforeRefresh;
            const prose = document.querySelector<HTMLElement>('.turn:last-of-type .part.assistant .prose');
            if (!prose) throw new Error('Missing synthetic growing response');
            prose.style.minHeight = `${prose.offsetHeight + 600}px`;
          }
          return result;
        };
      }
      return response;
    };
  });
  const f = await fixture(page, 'Following during refresh proof');
  const imported = await page.request.put(`/api/chats/${f.id}/history`, { headers: { Origin: 'http://127.0.0.1:4173' },
    data: { revision: (await f.state()).revision, turns: Array.from({ length: 30 }, (_, index) => ({ user: `Input ${index + 1}`, assistant: `Reply ${index + 1}`, complete: true })) } });
  expect(imported.ok()).toBe(true);
  await expect(page.getByRole('article', { name: 'Turn 30', exact: true })).toBeAttached();
  const gap = () => page.locator('.transcript').evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight);
  await expect.poll(gap).toBeLessThan(2);
  await page.evaluate(() => { document.documentElement.dataset.growBeforeRefresh = 'true'; });
  await page.request.post('/__test/change', { data: { kind: 'chat', chatId: f.id, detail: 'stream' } });
  await expect(page.locator('.turn').last().locator('.part.assistant .prose')).toHaveCSS('min-height', /6\d\dpx/);
  await expect.poll(gap).toBeLessThan(2);
});

for (const width of [1280, 390]) test(`ignores next-draft typing in pending previews and loads full input on demand at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 });
  const f = await fixture(page, `Pending preview proof ${width}`);
  const previews: { detail?: string; text?: string }[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname === `/api/chats/${f.id}/preview`) previews.push(request.postDataJSON()); });
  await page.request.post('/__test/mode', { data: { mode: 'hold-first-token' } });
  await page.getByLabel('Your next turn').fill('A committed input.');
  const pendingPreview = page.waitForResponse(response => response.url().endsWith(`/chats/${f.id}/preview`) && response.request().postDataJSON().text === undefined && response.ok());
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await pendingPreview;
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeEnabled();
  previews.length = 0;
  try {
    await page.getByLabel('Your next turn').pressSequentially('abcdefgh', { delay: 60 });
    await page.waitForTimeout(1200);
    expect(previews).toEqual([]);
    await openChatTool(page, 'Request inspector');
    await expect(page.getByRole('button', { name: 'Prompt peek', exact: true })).toBeEnabled();
    expect(previews).toEqual([{ revision: (await f.state()).revision, inspection: true, detail: 'full' }]);
    await page.getByText('Endpoint and request body', { exact: true }).click();
    await expect(page.getByTestId('request-body')).toContainText('A committed input.');
    await expect(page.getByTestId('request-body')).not.toContainText('abcdefgh');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally {
    const active = (await f.state()).latestGeneration;
    if (active?.status === 'running') await f.command(`/generations/${active.id}/cancel`, {});
    await page.request.post('/__test/finish', { data: {} });
  }
});

for (const width of [1280, 390, 320]) test(`pages saved requests and retains inspection after a failed page at ${width}px`, async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width, height: 844 });
  const f = await fixture(page, `Paged request proof ${width}`);
  for (let index = 0; index < 42; index++) {
    await f.command(`/chats/${f.id}/turns`, { revision: (await f.state()).revision, requestId: crypto.randomUUID(), text: `Saved input ${index + 1}.` });
    await expect.poll(async () => (await f.state()).latestGeneration?.status).toBe('succeeded');
  }
  const first: GenerationPage = await page.request.get(`/api/chats/${f.id}/generations`).then(response => response.json());
  const bodies: string[] = [];
  page.on('request', request => { if (/\/generations\/[^/]+\/request$/.test(new URL(request.url()).pathname)) bodies.push(request.url()); });
  await openChatTool(page, 'Request inspector');
  const selector = page.getByRole('combobox', { name: 'Inspect request', exact: true });
  await expect(selector).toBeEnabled();
  expect(bodies).toEqual([]);
  await selector.click();
  await expect(page.getByRole('option')).toHaveCount(21);
  const selected = first.items.at(-1);
  if (!selected) throw new Error('Missing historical fixture request');
  const selectedPath = `**/api/chats/${f.id}/generations/${selected.id}/request`;
  await page.route(selectedPath, route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Synthetic request failure.' }) }));
  await page.getByRole('option').last().click();
  await expect(page.getByRole('alert')).toContainText('Synthetic request failure.');
  await page.unroute(selectedPath);
  await page.getByRole('button', { name: 'Retry loading', exact: true }).click();
  const expected: RequestPreview = await page.request.get(`/api/chats/${f.id}/generations/${selected.id}/request`).then(response => response.json());
  await page.getByText('Endpoint and request body', { exact: true }).click();
  await expect.poll(async () => JSON.parse(await page.getByTestId('request-body').textContent() ?? '{}')).toEqual(expected.body);
  // A new attempt pushes the inspected record beyond this page's 20 rows.
  // Keep that one selected descriptor and immutable body available.
  await f.command(`/chats/${f.id}/turns`, { revision: (await f.state()).revision, requestId: crypto.randomUUID(), text: 'Saved input 43.' });
  await expect.poll(async () => (await f.state()).latestGeneration?.status).toBe('succeeded');
  await selector.click();
  await expect(page.getByRole('option')).toHaveCount(22);
  await selector.press('Escape');
  expect(JSON.parse(await page.getByTestId('request-body').textContent() ?? '{}')).toEqual(expected.body);
  const latestPage: GenerationPage = await page.request.get(`/api/chats/${f.id}/generations`).then(response => response.json());
  await page.route(`**/api/chats/${f.id}/generations?before=*`, route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Synthetic page failure.' }) }));
  await page.getByRole('button', { name: 'Older requests', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Synthetic page failure.');
  expect(JSON.parse(await page.getByTestId('request-body').textContent() ?? '{}')).toEqual(expected.body);
  await page.unroute(`**/api/chats/${f.id}/generations?before=*`);
  await page.getByRole('button', { name: 'Older requests', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Newer requests', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Older requests', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath(`requests-middle-${width}.png`) });
  const middle: GenerationPage = await page.request.get(`/api/chats/${f.id}/generations?before=${latestPage.nextBefore}`).then(response => response.json());
  await page.getByRole('button', { name: 'Older requests', exact: true }).click();
  await selector.click();
  await expect(page.getByRole('option')).toHaveCount(4);
  await page.getByRole('option').last().click();
  await expect(page.getByTestId('request-body')).toContainText('Saved input 1.');
  await expect(page.getByTestId('request-body')).not.toContainText('Saved input 2.');
  expect(bodies).toHaveLength(3);
  // Deleting this page's cursor invalidates it. Explicitly returning to the
  // latest page must recover without losing the inspected body on the failure.
  const cursor = middle.items.at(-1);
  if (!cursor) throw new Error('Missing historical cursor');
  const deleted = await page.request.delete(`/api/chats/${f.id}/turns/${cursor.turnId}`, { headers: { Origin: 'http://127.0.0.1:4173' }, data: { revision: (await f.state()).revision } });
  expect(deleted.ok()).toBe(true);
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByTestId('request-body')).toContainText('Saved input 1.');
  await page.getByRole('button', { name: 'Latest requests', exact: true }).click();
  await expect(selector).toHaveText('Next request');
  await expect(page.getByRole('button', { name: 'Newer requests', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath(`requests-${width}.png`) });
});
