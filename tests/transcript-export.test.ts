import { expect, test, vi } from 'vitest';
import { importChat } from '../src/core/chat-import.js';
import { createApp } from '../src/server/app.js';
import { preparedDownloadSchema } from '../src/shared/downloads.js';

test('exports a consistent saved transcript for the requested story only', async () => {
  const { app, store } = await createApp({ database: ':memory:' });
  try {
    const host = { host: 'localhost', origin: 'http://localhost' };
    const setup = await app.inject({ method: 'POST', url: '/api/setup', headers: host, payload: { password: 'synthetic-export-password' } });
    expect(setup.statusCode).toBe(200);
    const headers = { ...host, cookie: String(setup.headers['set-cookie']).split(';')[0] };
    const { id, revision } = store.chatHeader();
    const story = [
      { user: '', assistant: 'Opening 👋', complete: true },
      { user: 'Earlier\r\nmessage', assistant: 'Selected **reply** ![alt](https://example.test/image.png)', complete: true },
      ...Array.from({ length: 16 }, (_, i) => ({ user: `Turn ${i}`, assistant: `Reply ${i}`, complete: true })),
      { user: 'Pending final question', assistant: '', complete: false },
    ];
    const savedRevision = store.replaceHistory(revision, id, story);
    const other = store.createChat({ title: 'Other', promptId: 'default', connectionId: null, characterId: null, personaId: null, targetInputTokens: 32000 });
    store.replaceHistory(0, other, [{ user: 'Other story only', assistant: '', complete: false }]);
    const savedTurn = store.readTurns(id)[1];
    if (!savedTurn) throw new Error('Missing synthetic turn');
    store.sqlite.prepare('INSERT INTO response_variants (id,turn_id,text,source_revision,created_at) VALUES (?,?,?,?,?)')
      .run('unselected', savedTurn.id, 'Unselected alternative', 1, new Date().toISOString());

    const prepare = (rev: number) => app.inject({ method: 'POST', url: `/api/chats/${id}/export`, headers, payload: { revision: rev } });
    expect((await prepare(revision)).statusCode).toBe(409);
    const prepared = await prepare(savedRevision);
    expect(prepared.statusCode).toBe(200);
    const file = preparedDownloadSchema.parse(prepared.json());
    expect(file.filename).toMatch(/\.jsonl$/);

    const download = () => app.inject({ method: 'GET', url: file.url, headers });
    expect((await app.inject({ method: 'GET', url: file.url, headers: host })).statusCode).toBe(401);
    store.replaceHistory(savedRevision, id, [{ user: 'Later edit', assistant: '', complete: false }]);
    const exported = await download();
    expect(exported.statusCode).toBe(200);
    expect(exported.headers['content-disposition']).toBe(`attachment; filename="${file.filename}"`);
    expect(exported.body).not.toMatch(/Other story only|Unselected alternative|Later edit/);
    async function* chunks() { yield exported.body; }
    expect((await importChat(chunks())).turns).toEqual(story);
    await vi.waitFor(async () => expect((await download()).statusCode).toBe(404));
  } finally {
    await app.close();
  }
});
