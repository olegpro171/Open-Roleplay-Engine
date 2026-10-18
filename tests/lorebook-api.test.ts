import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createApp } from '../src/server/app.js';
import type { Provider } from '../src/provider/openai.js';
import type { RequestPreview } from '../src/shared/contracts.js';
import { newLorebook, newLoreEntry } from '../src/shared/lorebook.js';
import fixtures from './fixtures/lorebooks.json';

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of disposers.splice(0)) await dispose(); });
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Expected a synthetic fixture record.');
  return value;
}
const idResponse = z.object({ id: z.string() });
const errorResponse = z.object({ code: z.string(), message: z.string() });
const connection = { name: 'Synthetic API', endpoint: 'http://localhost:1234/v1', model: 'synthetic-api', contextWindow: 100_000, maxOutputTokens: 100, customParameters: {} };
const characterFields = { name: 'API keeper', description: 'Keeper of the tower.', personality: '', scenario: '', first_mes: '', mes_example: '' };
const syntheticSecret = 'SYNTHETIC-LORE-API-CREDENTIAL-NEVER-EXPOSE';

async function fixture() {
  const calls: RequestPreview[] = [];
  const provider: Provider = { async stream(request, _key, _signal, onText) {
    calls.push(structuredClone(request));
    onText('The synthetic keeper responds.');
    return { finishReason: 'stop' };
  } };
  const instance = await createApp({ database: ':memory:', provider });
  disposers.push(() => instance.app.close());
  const setup = await instance.app.inject({ method: 'POST', url: '/api/setup', headers: { host: 'localhost', origin: 'http://localhost' }, payload: { password: 'synthetic-lore-api-password' } });
  expect(setup.statusCode).toBe(200);
  const cookie = String(setup.headers['set-cookie']).split(';')[0];
  const headers = { host: 'localhost', origin: 'http://localhost', cookie };
  const request = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: Record<string, unknown>) => instance.app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
  return { ...instance, request, headers, calls };
}

describe('authenticated lorebook API', () => {
  it.each(['v2', 'v3'] as const)('exports the current linked %s book, preserves metadata and honors explicit unlinking', async format => {
    const f = await fixture();
    const sourceBook = format === 'v2' ? fixtures.v2 : fixtures.v3.data;
    const source = { spec: format === 'v2' ? 'chara_card_v2' : 'chara_card_v3', spec_version: format === 'v2' ? '2.0' : '3.0',
      data: { ...characterFields, character_book: sourceBook, extensions: { preserved_card_extension: true } },
    };
    const imported = await f.request('POST', '/api/library/import', { kind: 'characters', revision: f.store.libraries().revision,
      requestId: randomUUID(), base64: Buffer.from(JSON.stringify(source)).toString('base64'),
    });
    expect(imported.statusCode).toBe(200);
    const result = z.object({ ids: z.array(z.string()).length(1), books: z.array(z.object({ id: z.string() })).length(1) }).parse(imported.json<unknown>());
    const characterId = required(result.ids[0]), bookId = required(result.books[0]).id;
    const original = required(f.store.libraries().lorebooks.find(book => book.id === bookId));
    const { id: _id, revision: _revision, ...book } = original;
    const save = await f.request('PUT', `/api/library/${bookId}`, { kind: 'lorebooks', revision: f.store.libraries().revision,
      data: { ...book, name: 'Edited linked book', entries: book.entries.map((entry, index) => index ? entry : { ...entry, name: 'Edited entry', keys: ['updated key'], content: 'The current linked lore.', enabled: false }) },
    });
    expect(save.statusCode).toBe(200);
    const exported = await f.request('GET', `/api/library/characters/${characterId}/export`);
    expect(exported.statusCode).toBe(200);
    expect(exported.json<unknown>()).toMatchObject({ spec: source.spec, data: { extensions: source.data.extensions, character_book: {
      name: 'Edited linked book', entries: expect.arrayContaining([expect.objectContaining({ name: 'Edited entry', keys: ['updated key'], content: 'The current linked lore.', enabled: false })]),
    } } });
    const metadata = z.object({ data: z.object({ character_book: z.object({ entries: z.array(z.record(z.string(), z.unknown())) }) }) }).parse(exported.json<unknown>());
    expect(metadata.data.character_book.entries).toHaveLength(sourceBook.entries.length);
    if (format === 'v3') expect(metadata.data.character_book.entries[1]).toEqual(fixtures.v3.data.entries[1]);
    expect(metadata.data.character_book.entries[0]).toMatchObject(format === 'v2' ? { id: 41, extensions: fixtures.v2.entries[0].extensions } : { id: 'external-entry-id', extensions: {} });
    expect(exported.body).not.toContain(original.entries[0]?.id);
    expect(exported.body).not.toContain('activationRevision');
    const currentCharacter = required(f.store.libraries().characters.find(card => card.id === characterId));
    const { id: _characterId, revision: _characterRevision, ...editableCharacter } = currentCharacter;
    expect((await f.request('PUT', `/api/library/${characterId}`, { kind: 'characters', revision: f.store.libraries().revision, data: { ...editableCharacter, lorebookId: null } })).statusCode).toBe(200);
    const unlinked = await f.request('GET', `/api/library/characters/${characterId}/export`);
    expect(unlinked.statusCode).toBe(200);
    expect(unlinked.body).not.toContain('character_book');
    expect(f.store.libraries().lorebooks).toHaveLength(1);
    expect(f.calls).toEqual([]);
  });

  it('returns useful invalid-import errors without mutation and preserves unexpected write failures as 500', async () => {
    const f = await fixture();
    const before = f.store.libraries(), chatBefore = f.store.snapshot();
    for (const value of [fixtures.malformedV3, { spec: 'lorebook_v3', entries: [], data: { entries: [], extensions: {} } }, { entries: [], scan_depth: -1 }]) {
      const preview = await f.request('POST', '/api/library/lorebooks/preview', { value });
      const imported = await f.request('POST', '/api/library/lorebooks/import', { revision: before.revision, requestId: randomUUID(), value });
      for (const response of [preview, imported]) {
        expect(response.statusCode).toBe(400);
        expect(errorResponse.parse(response.json<unknown>()).message).not.toBe('The request could not be completed.');
      }
      expect(f.store.libraries()).toEqual(before);
      expect(f.store.snapshot()).toEqual(chatBefore);
    }
    const validPreview = await f.request('POST', '/api/library/lorebooks/preview', { value: fixtures.worldInfo });
    expect(validPreview.statusCode).toBe(200);
    expect(validPreview.json<unknown>()).toMatchObject({ format: 'world_info', book: { entries: [{ externalId: 17 }] }, diagnostics: expect.any(Array) });
    expect(f.store.libraries()).toEqual(before);
    f.store.sqlite.exec("CREATE TRIGGER reject_api_import BEFORE INSERT ON lore_commands BEGIN SELECT RAISE(ABORT, 'SYNTHETIC-PRIVATE-DATABASE-DETAIL'); END");
    const failure = await f.request('POST', '/api/library/lorebooks/import', { revision: before.revision, requestId: randomUUID(), value: fixtures.v2 });
    expect(failure.statusCode).toBe(500);
    expect(failure.body).not.toContain('SYNTHETIC-PRIVATE-DATABASE-DETAIL');
    expect(f.store.libraries()).toEqual(before);
    expect(f.store.sqlite.prepare('SELECT * FROM lore_commands').all()).toEqual([]);
    expect(f.calls).toEqual([]);
  });

  it('enforces authentication, origin, one-book input and credential exclusion through public boundaries', async () => {
    const f = await fixture();
    const unauthorized = await f.app.inject({ method: 'POST', url: '/api/library/lorebooks/preview', headers: { host: 'localhost', origin: 'http://localhost' }, payload: { value: fixtures.v2 } });
    expect(unauthorized.statusCode).toBe(401);
    const wrongOrigin = await f.app.inject({ method: 'POST', url: '/api/library/lorebooks/preview', headers: { ...f.headers, origin: 'https://untrusted.invalid' }, payload: { value: fixtures.v2 } });
    expect(wrongOrigin.statusCode).toBe(403);
    const savedConnection = await f.request('POST', '/api/library', { kind: 'connections', revision: f.store.libraries().revision, data: connection, apiKey: syntheticSecret });
    expect(savedConnection.statusCode).toBe(200);
    const connectionId = idResponse.parse(savedConnection.json<unknown>()).id;
    const imported = await f.request('POST', '/api/library/lorebooks/import', { revision: f.store.libraries().revision, requestId: randomUUID(), value: fixtures.v2 });
    expect(imported.statusCode).toBe(200);
    const bookId = idResponse.parse(imported.json<unknown>()).id;
    const characterId = f.store.saveLibrary(f.store.libraries().revision, 'characters', { name: 'Keeper', description: 'The tower keeper.', personality: '', scenario: '', first_mes: '', mes_example: '' });
    const selections = { title: 'API lore selection', targetInputTokens: 90_000, connectionId, promptId: 'default', characterId, personaId: null, lorebookId: bookId };
    const before = f.store.libraries();
    expect((await f.request('POST', '/api/chats', { ...selections, lorebookId: [bookId, bookId] })).statusCode).toBe(400);
    expect((await f.request('POST', '/api/chats', { ...selections, lorebookIds: [bookId] })).statusCode).toBe(400);
    expect(f.store.libraries()).toEqual(before);
    const created = await f.request('POST', '/api/chats', selections);
    expect(created.statusCode).toBe(200);
    const chatId = idResponse.parse(created.json<unknown>()).id;
    const snapshot = f.store.snapshot(chatId);
    const invalidUpdate = await f.request('PUT', `/api/chats/${chatId}/selections`, { revision: snapshot.revision, settings: { ...selections, lorebookId: [bookId] } });
    expect(invalidUpdate.statusCode).toBe(400);
    expect(f.store.snapshot(chatId)).toEqual(snapshot);
    const preview = await f.request('POST', `/api/chats/${chatId}/preview`, { revision: snapshot.revision, text: 'I bring the tower key.' });
    expect(preview.statusCode).toBe(200);
    expect(preview.json<unknown>()).toMatchObject({ lore: { outcomes: [{ status: 'admitted', text: 'The tower door opens with a silver key.' }] } });
    for (const response of [await f.request('GET', '/api/library'), await f.request('GET', `/api/chats/${chatId}`), await f.request('GET', `/api/library/lorebooks/${bookId}/export`), preview]) {
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain(syntheticSecret);
    }
    expect(f.store.snapshot(chatId)).toEqual(snapshot);
    expect(f.calls).toEqual([]);
  });

  it('fails regex timeouts before transport and cancels a retry without committing activation state', async () => {
    const f = await fixture();
    const connectionId = f.store.saveLibrary(f.store.libraries().revision, 'connections', connection, undefined, syntheticSecret);
    const bookId = f.store.saveLibrary(f.store.libraries().revision, 'lorebooks', { ...newLorebook(), entries: [{ ...newLoreEntry(randomUUID()), placement: 'history', useRegex: true, keys: ['(a+)+$'], content: 'Regex lore.' }] });
    const chatId = f.store.createChat({ title: 'Regex API', targetInputTokens: 90_000, connectionId, promptId: 'default', characterId: null, personaId: null, lorebookId: bookId });
    const text = 'a'.repeat(40_000) + '!';
    const before = f.store.snapshot(chatId);
    const preview = await f.request('POST', `/api/chats/${chatId}/preview`, { revision: before.revision, text });
    expect(preview.statusCode).toBe(422);
    expect(errorResponse.parse(preview.json<unknown>())).toMatchObject({ code: 'lore_regex_timeout', message: expect.stringContaining('No model request was sent') });
    expect(f.store.snapshot(chatId)).toEqual(before);
    const submit = await f.request('POST', `/api/chats/${chatId}/turns`, { revision: before.revision, requestId: randomUUID(), text });
    expect(submit.statusCode).toBe(202);
    const generationId = z.object({ generationId: z.string() }).parse(submit.json<unknown>()).generationId;
    await expect.poll(() => f.store.generation(generationId)?.status).toBe('failed');
    expect(f.store.generation(generationId)).toMatchObject({ request: null, error: expect.stringContaining('No model request was sent') });
    const retry = await f.request('POST', `/api/chats/${chatId}/retry`, { revision: f.store.snapshot(chatId).revision, requestId: randomUUID() });
    expect(retry.statusCode).toBe(202);
    const retryId = z.object({ generationId: z.string() }).parse(retry.json<unknown>()).generationId;
    expect((await f.request('POST', `/api/generations/${retryId}/cancel`, {})).statusCode).toBe(200);
    await expect.poll(() => f.store.generation(retryId)?.status).toBe('cancelled');
    expect(f.store.snapshot(chatId).turns.at(-1)).toMatchObject({ complete: false, assistant: { text: '' } });
    expect(f.store.loreState(chatId, bookId).entries).toEqual({});
    expect(f.calls).toEqual([]);
  });
});
