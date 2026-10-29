import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server/app.js';
import type { ChatToolsSnapshot, GenerationPage, RequestEstimate } from '../src/shared/contracts.js';
import { changeSchema, type Change } from '../src/shared/changes.js';
import { compactPrompt } from './support/compact-prompt.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dispose of cleanup.splice(0)) await dispose();
});

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ore-lightweight-reads-'));
  const f = await createApp({ database: join(directory, 'state.sqlite') });
  f.store.saveLibrary(f.store.libraryRevision(), 'prompts', compactPrompt, 'default');
  cleanup.push(async () => { try { await f.app.close(); } finally { rmSync(directory, { recursive: true, force: true }); } });
  const setup = await f.app.inject({ method: 'POST', url: '/api/setup', headers: { host: 'localhost', origin: 'http://localhost' }, payload: { password: 'synthetic-performance-password' } });
  const headers = { host: 'localhost', origin: 'http://localhost', cookie: String(setup.headers['set-cookie']).split(';')[0] };
  let state = f.store.snapshot();
  f.store.saveSettings(state.revision, { name: 'Synthetic', endpoint: 'http://localhost:1/v1', model: 'synthetic', contextWindow: 100_000, maxOutputTokens: 100, customParameters: {} }, state.settings, 'synthetic-private-key');
  state = f.store.snapshot();
  const attempt = f.store.begin(state.revision, randomUUID(), 'A traveler enters the village.');
  const request = { endpoint: 'http://localhost:1/v1/chat/completions', body: { model: 'synthetic', messages: [{ role: 'user' as const, content: 'historical-request-prose-' + 'old context '.repeat(10_000) }], stream: true as const, max_tokens: 100 }, coverage: [], budget: { inputTokens: 10, targetInputTokens: 32_000, reservedOutputTokens: 100, contextWindow: 100_000, method: 'synthetic', verified: false as const } };
  f.store.saveRequest(attempt.id, request);
  f.store.finish(attempt.id, 'succeeded', 'The lantern is lit.', null);
  return { ...f, headers, attempt, request };
}

it('does not deserialize historical request bodies while calculating a current preview', async () => {
  const f = await fixture();
  const revision = f.store.snapshot().revision;
  const parse = vi.spyOn(JSON, 'parse');
  const response = await f.app.inject({ method: 'POST', url: '/api/chats/main/preview', headers: f.headers, payload: { revision, inspection: true } });
  expect(response.statusCode).toBe(200);
  expect(parse.mock.calls.filter(([text]) => typeof text === 'string' && text.includes('historical-request-prose-'))).toHaveLength(0);
});

it('keeps tools and paged descriptors independent of request size and preserves exact inspection', async () => {
  const f = await fixture();
  const insert = f.store.sqlite.prepare('INSERT INTO generations (id,chat_id,request_id,command,turn_id,status,source_revision,request,partial_text,created_at,updated_at) SELECT ?,chat_id,?,command,turn_id,status,source_revision,request,partial_text,created_at,updated_at FROM generations WHERE id = ?');
  f.store.sqlite.transaction(() => {
    for (let index = 0; index < 54; index++) insert.run(randomUUID(), randomUUID(), f.attempt.id);
  })();
  const parse = vi.spyOn(JSON, 'parse');
  const tools = await f.app.inject({ url: '/api/chats/main/tools', headers: f.headers });
  expect(tools.statusCode).toBe(200);
  expect(tools.json<ChatToolsSnapshot>()).toMatchObject({ generating: false, turns: [{ user: { text: 'A traveler enters the village.' }, assistant: { text: 'The lantern is lit.' } }] });
  expect(tools.body.length).toBeLessThan(15_000);
  expect(tools.json()).not.toHaveProperty('generations');
  const visited = new Set<string>();
  let before: string | null = null;
  do {
    const url: string = `/api/chats/main/generations${before ? `?before=${before}` : ''}`;
    const response = await f.app.inject({ url, headers: f.headers });
    expect(response.statusCode).toBe(200);
    const page: GenerationPage = response.json();
    expect(page.items.length).toBeLessThanOrEqual(20);
    for (const item of page.items) {
      expect(visited.has(item.id)).toBe(false);
      visited.add(item.id);
      expect(item.requestAvailable).toBe(true);
      expect(item).not.toHaveProperty('request');
      expect(item).not.toHaveProperty('partialText');
    }
    expect(response.body).not.toContain('historical-request-prose-');
    expect(response.body).not.toContain('synthetic-private-key');
    before = page.nextBefore;
  } while (before);
  expect(visited.size).toBe(55);
  const pinned = await f.app.inject({ url: `/api/chats/main/generations?selected=${f.attempt.id}`, headers: f.headers });
  expect(pinned.json<GenerationPage>().items).toHaveLength(20);
  expect(pinned.json<GenerationPage>().selected).toMatchObject({ id: f.attempt.id, requestAvailable: true });
  expect(parse.mock.calls.filter(([text]) => typeof text === 'string' && text.includes('historical-request-prose-'))).toHaveLength(0);
  parse.mockRestore();
  const saved = await f.app.inject({ url: `/api/chats/main/generations/${f.attempt.id}/request`, headers: f.headers });
  expect(saved.json()).toEqual(f.request);
  expect(f.store.sqlite.prepare('SELECT count(*) AS n FROM generations').get()).toEqual({ n: 55 });
});

it('validates and scopes request pages and individual requests', async () => {
  const f = await fixture();
  expect((await f.app.inject('/api/chats/main/generations')).statusCode).toBe(401);
  expect((await f.app.inject('/api/chats/main/tools')).statusCode).toBe(401);
  for (const query of ['limit=51', 'limit=0', 'before=', 'extra=1']) {
    expect((await f.app.inject({ url: `/api/chats/main/generations?${query}`, headers: f.headers })).statusCode).toBe(400);
  }
  const other = f.store.createChat({ title: 'Other', targetInputTokens: 32_000, connectionId: null, promptId: 'default', characterId: null, personaId: null, contextPresetId: null });
  expect((await f.app.inject({ url: `/api/chats/${other}/generations?before=${f.attempt.id}`, headers: f.headers })).statusCode).toBe(404);
  expect((await f.app.inject({ url: `/api/chats/${other}/generations/${f.attempt.id}/request`, headers: f.headers })).statusCode).toBe(404);
  expect((await f.app.inject({ url: `/api/chats/${other}/generations?selected=${f.attempt.id}`, headers: f.headers })).json<GenerationPage>().selected).toBeNull();
  expect((await f.app.inject({ url: '/api/chats/missing/generations', headers: f.headers })).statusCode).toBe(404);
});

it('pages and inspects preserved opaque generation identities', async () => {
  const f = await fixture();
  const id = 'legacy/request ?&id';
  f.store.sqlite.prepare('INSERT INTO generations (id,chat_id,request_id,command,turn_id,status,source_revision,request,partial_text,created_at,updated_at) SELECT ?,chat_id,?,command,turn_id,status,source_revision,request,partial_text,created_at,updated_at FROM generations WHERE id = ?').run(id, randomUUID(), f.attempt.id);
  const first = await f.app.inject({ url: '/api/chats/main/generations?limit=1', headers: f.headers });
  expect(first.json<GenerationPage>().nextBefore).toBe(id);
  const older = await f.app.inject({ url: `/api/chats/main/generations?${new URLSearchParams({ before: id })}`, headers: f.headers });
  expect(older.statusCode).toBe(200);
  expect(older.json<GenerationPage>().items.map(item => item.id)).toEqual([f.attempt.id]);
  const request = await f.app.inject({ url: `/api/chats/main/generations/${encodeURIComponent(id)}/request`, headers: f.headers });
  expect(request.statusCode).toBe(200);
  expect(request.json()).toEqual(f.request);
});

it('announces individual settings and shared Connection edits with their actual scopes', async () => {
  const f = await fixture();
  const changes: Change[] = [];
  f.coordinator.events.on('changed', value => changes.push(changeSchema.parse(value)));
  const appearance = (await f.app.inject({ url: '/api/application/appearance', headers: f.headers })).json();
  const saved = await f.app.inject({ method: 'PUT', url: '/api/application/appearance', headers: f.headers, payload: { revision: appearance.revision, settings: { ...appearance.settings, chatTextScale: 110 } } });
  expect(saved.statusCode).toBe(200);
  expect(changes).toEqual([{ kind: 'settings', setting: 'appearance' }]);
  const state = f.store.engineSnapshot();
  const connection = state.connection;
  if (!connection) throw new Error('Missing synthetic Connection');
  const edited = await f.app.inject({ method: 'PUT', url: '/api/chats/main/settings', headers: { ...f.headers, prefer: 'return=minimal' }, payload: { revision: state.revision, connection: { ...connection, model: 'another-synthetic-model' }, settings: state.settings } });
  expect(edited.statusCode).toBe(200);
  expect(changes.at(-1)).toEqual({ kind: 'library' });
});

it('returns authoritative estimates without prose and acknowledges edits without reading old requests', async () => {
  const f = await fixture();
  const state = f.store.engineSnapshot();
  const parse = vi.spyOn(JSON, 'parse');
  const response = await f.app.inject({ method: 'POST', url: '/api/chats/main/preview', headers: f.headers, payload: { revision: state.revision, inspection: true, detail: 'estimate', text: 'Continue the scene.' } });
  const estimate = response.json<RequestEstimate>();
  expect(response.statusCode).toBe(200);
  expect(estimate.budget.inputTokens).toBeGreaterThan(0);
  expect(estimate.allocations.history).toBeGreaterThan(0);
  expect(estimate.history?.verbatimTurns).toBe(1);
  expect(response.body).not.toContain('The lantern is lit.');
  expect(response.body).not.toContain('Continue the scene.');
  const complete = await f.app.inject({ method: 'POST', url: '/api/chats/main/preview', headers: f.headers, payload: { revision: state.revision, inspection: true, text: 'Continue the scene.' } });
  expect(estimate.budget).toEqual(complete.json().budget);
  expect(response.body.length).toBeLessThan(2000);
  const edited = await f.app.inject({ method: 'PATCH', url: `/api/chats/main/turns/${state.turns[0]?.id}/user`, headers: { ...f.headers, prefer: 'return=minimal' }, payload: { revision: state.revision, text: 'The traveler returns.' } });
  expect(edited.statusCode).toBe(200);
  expect(edited.json()).toEqual({ ok: true, revision: state.revision + 1 });
  expect(parse.mock.calls.filter(([text]) => typeof text === 'string' && text.includes('historical-request-prose-'))).toHaveLength(0);
  parse.mockRestore();
  const full = await f.app.inject({ method: 'POST', url: '/api/chats/main/preview', headers: f.headers, payload: { revision: state.revision + 1, inspection: true, text: 'Continue the scene.' } });
  expect(full.json().body.messages.at(-1).content).toBe('Continue the scene.');
  expect(f.store.generation(f.attempt.id)?.request).toEqual(f.request);
});
