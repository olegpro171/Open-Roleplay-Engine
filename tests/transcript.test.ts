import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/server/app.js';
import { StoryReader } from '../src/persistence/story-reader.js';
import { transcriptQuerySchema, type StorySnapshot } from '../src/shared/transcript.js';
import { sourceOf } from '../src/core/context.js';
import { newLorebook, newLoreEntry } from '../src/shared/lorebook.js';
import type { RequestPreview } from '../src/shared/contracts.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const dispose of cleanup.splice(0)) await dispose(); });
async function fixture(length = 438) {
  const calls: RequestPreview[] = [];
  const f = await createApp({ database: ':memory:', provider: { async stream(request, _key, _signal, text) {
    calls.push(structuredClone(request)); text('A synthetic continuation.'); return { finishReason: 'stop' };
  } } });
  cleanup.push(() => f.app.close());
  const setup = await f.app.inject({ method: 'POST', url: '/api/setup', headers: { host: 'localhost', origin: 'http://localhost' }, payload: { password: 'synthetic-transcript-password' } });
  const headers = { host: 'localhost', origin: 'http://localhost', cookie: String(setup.headers['set-cookie']).split(';')[0] };
  f.store.replaceHistory(0, 'main', Array.from({ length }, (_, index) => ({ user: `Input ${index + 1}`, assistant: `Reply ${index + 1}`, complete: true })));
  const reader = new StoryReader(f.store);
  const read = (query: Parameters<typeof transcriptQuerySchema.parse>[0] = {}) => reader.read('main', transcriptQuerySchema.parse(query));
  return { ...f, headers, calls, read };
}

it('reads bounded whole-turn windows without loading a full engine snapshot or changing saved state', async () => {
  const f = await fixture();
  const before = f.store.snapshot();
  const fullRead = vi.spyOn(f.store, 'snapshot').mockImplementation(() => { throw new Error('Paged reading must not load full history.'); });
  const engineRead = vi.spyOn(f.store, 'engineSnapshot').mockImplementation(() => { throw new Error('Paged reading must not load full engine history.'); });
  let page = f.read();
  expect(page.totalTurns).toBe(438);
  expect(page.page.turns.map(turn => turn.ordinal)).toEqual(Array.from({ length: 15 }, (_, i) => 424 + i));
  expect(page.page).toMatchObject({ hasOlder: true, hasNewer: false });
  const all = new Set(page.page.turns.map(turn => turn.id));
  for (let step = 0; page.page.hasOlder; step++) {
    const first = page.page.turns[0];
    if (!first || step > 20) throw new Error('Paging did not reach the beginning.');
    const previous = page;
    page = f.read({ anchor: first.id, shift: -40, limit: Math.min(120, page.page.turns.length + 40), revision: page.revision });
    expect(page.page.turns.length).toBeLessThanOrEqual(120);
    expect(page.page.turns.some(turn => turn.id === first.id)).toBe(true);
    expect(page.page.turns[0]?.ordinal).toBeLessThan(previous.page.turns[0]?.ordinal ?? 0);
    page.page.turns.forEach(turn => all.add(turn.id));
  }
  expect(page.page.turns[0]?.ordinal).toBe(1);
  expect(all.size).toBe(438);
  while (page.page.hasNewer) {
    const first = page.page.turns[0];
    if (!first) throw new Error('Missing forward anchor.');
    page = f.read({ anchor: first.id, shift: 40, limit: 120, revision: page.revision });
  }
  expect(page.page.turns.at(-1)?.ordinal).toBe(438);
  expect(f.calls).toEqual([]);
  fullRead.mockRestore();
  engineRead.mockRestore();
  expect(f.store.snapshot()).toEqual(before);
});

it('validates cursors, bounds, authentication and stale revisions without returning other chats', async () => {
  const f = await fixture(80);
  expect((await f.app.inject('/api/chats/main/story')).statusCode).toBe(401);
  for (const query of ['limit=121', 'limit=-1', 'shift=-41', 'shift=-40', 'revision=NaN', 'extra=1']) {
    expect((await f.app.inject({ url: `/api/chats/main/story?${query}`, headers: f.headers })).statusCode).toBe(400);
  }
  const initial = f.read();
  const turn = initial.page.turns[0];
  if (!turn) throw new Error('Missing turn.');
  f.store.deleteTurn(initial.revision, turn.id);
  expect((await f.app.inject({ url: `/api/chats/main/story?anchor=${turn.id}&revision=${initial.revision}`, headers: f.headers })).statusCode).toBe(409);
  expect((await f.app.inject({ url: `/api/chats/main/story?anchor=${turn.id}`, headers: f.headers })).statusCode).toBe(409);
  expect((await f.app.inject({ url: '/api/chats/missing/story', headers: f.headers })).statusCode).toBe(404);
  const fresh = f.read();
  expect(fresh.totalTurns).toBe(79);
  expect(fresh.page.turns[0]?.ordinal).toBe(65);
  expect(fresh.page.turns.at(-1)?.ordinal).toBe(79);
});

it('derives archived/stale status from all source revisions even when those turns are outside the page', async () => {
  const f = await fixture(100);
  const full = f.store.snapshot();
  const sources = full.turns.slice(0, 3).map(sourceOf);
  const node = { id: 'saved-memory', revision: 0, level: 1, text: 'Private memory text', turns: sources, children: [], prior: [], approved: true, manual: false, createdAt: '' };
  f.store.sqlite.prepare('INSERT INTO summaries (id,revision,chat_id,data) VALUES (?,?,?,?)').run(node.id, 0, 'main', JSON.stringify(node));
  f.store.sqlite.prepare('INSERT INTO context_states (chat_id,revision,data) VALUES (?,?,?)').run('main', 1, JSON.stringify({ selected: [{ id: node.id, revision: 0 }], archivedTurnIds: sources.map(source => source.turnId) }));
  expect(f.read().memory).toEqual({ revision: 1, archivedCount: 3, selectedCount: 1, stale: false, refusalCount: 0, refusalBlocked: false });
  f.store.sqlite.prepare('UPDATE turns SET user_revision = user_revision + 1 WHERE id = ?').run(sources[0]?.turnId);
  const result = f.read();
  expect(result.memory.stale).toBe(true);
  expect(JSON.stringify(result)).not.toContain('Private memory text');
  expect(result.page.turns.every(turn => !turn.archived)).toBe(true);
  const oldest = f.read({ anchor: full.turns[0]?.id, limit: 40 });
  expect(oldest.page.turns.filter(turn => turn.archived)).toHaveLength(3);
});

it('keeps preview and actual provider input complete regardless of paging and omits saved request bodies from Story', async () => {
  const f = await fixture();
  const current = f.store.snapshot();
  f.store.saveSettings(current.revision, { name: 'Synthetic', endpoint: 'http://localhost:1234/v1', model: 'synthetic', contextWindow: 100_000, maxOutputTokens: 100, customParameters: {} }, { ...current.settings, targetInputTokens: 90_000 }, 'synthetic-transcript-secret');
  const snapshot = f.store.snapshot();
  f.read({ anchor: snapshot.turns[0]?.id, limit: 120 });
  const preview = await f.app.inject({ method: 'POST', url: '/api/chats/main/preview', headers: f.headers, payload: { revision: snapshot.revision, text: 'Next input' } });
  expect(preview.statusCode).toBe(200);
  const request = preview.json<RequestPreview>();
  expect(request.coverage).toHaveLength(439);
  expect(request.body.messages.some(message => message.content === 'Input 1')).toBe(true);
  expect(request.body.messages.some(message => message.content === 'Reply 200')).toBe(true);
  const accepted = await f.app.inject({ method: 'POST', url: '/api/chats/main/turns', headers: f.headers, payload: { revision: snapshot.revision, text: 'Next input', requestId: randomUUID() } });
  expect(accepted.statusCode).toBe(202);
  await vi.waitFor(() => expect(f.store.snapshot().generations[0]?.status).toBe('succeeded'));
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]?.body).toEqual(request.body);
  const response = await f.app.inject({ url: '/api/chats/main/story', headers: f.headers });
  expect(response.statusCode).toBe(200);
  const story = response.json<StorySnapshot>();
  expect(story.latestGeneration?.requestAvailable).toBe(true);
  expect(story.page.turns).toHaveLength(15);
  expect(response.body).not.toContain('synthetic-transcript-secret');
  expect(response.body).not.toContain('"request":');
  expect(response.body).not.toContain('Input 1"');
  expect(f.store.snapshot().turns).toHaveLength(439);
});

it('preserves complete prompt diagnostics before removing private lorebook details from the Story projection', async () => {
  const f = await fixture(50);
  const bookId = f.store.saveLibrary(f.store.libraries().revision, 'lorebooks', {
    ...newLorebook(), name: 'Warning parity',
    entries: [{ ...newLoreEntry('missing-anchor'), name: 'Unavailable personality', content: 'Private lore text', constant: true, placement: 'personality' }],
  });
  const current = f.store.snapshot();
  const selected = await f.app.inject({ method: 'PUT', url: '/api/chats/main/selections', headers: f.headers, payload: {
    revision: current.revision, settings: { title: current.settings.title, targetInputTokens: 32_000, connectionId: null, promptId: 'default', characterId: null, personaId: null, contextPresetId: null, lorebookId: bookId },
  } });
  expect(selected.statusCode).toBe(200);
  const story = await f.app.inject({ url: '/api/chats/main/story', headers: f.headers });
  const complete = await f.app.inject({ url: '/api/chats/main', headers: f.headers });
  const expected = complete.json<{ promptDiagnostics: unknown[] }>().promptDiagnostics;
  expect(expected).toEqual([expect.objectContaining({ code: 'unavailable_lore_destinations', message: expect.stringContaining('Unavailable personality') })]);
  expect(story.json<StorySnapshot>().promptDiagnostics).toEqual(expected);
  expect(story.body).not.toContain('Private lore text');
});
