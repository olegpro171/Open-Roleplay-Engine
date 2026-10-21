import { rowSchema } from '../src/persistence/backup-validation.js';
import { legacyRows, removeVariantSchema } from './support/legacy-variants.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { deflateSync } from 'node:zlib';
import { Store } from '../src/persistence/store.js';
import { PictureProcessor, pictureDigest, type PreparedPicture } from '../src/server/pictures.js';
import { createApp } from '../src/server/app.js';
import { cropFromControls } from '../src/shared/pictures.js';
import { selectionsSchema, type Character, type CharacterSaveCommand } from '../src/shared/library.js';
import { readCharacterCardFile } from '../src/server/card-import.js';
import { cardPng, pixel, pngChunk, quadrantPicture } from './support/pictures.js';
import { assembleRequest } from '../src/core/prompt.js';

const stores: Store[] = [], directories: string[] = [], processors: PictureProcessor[] = [];
afterEach(async () => { await Promise.all(processors.splice(0).map(p => p.close())); for (const store of stores.splice(0)) store.close(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function directory() { const path = mkdtempSync(join(tmpdir(), 'ore-pictures-')); directories.push(path); return path; }
function open(path = ':memory:') { const store = new Store(path); stores.push(store); return store; }
function required<T>(value: T | null | undefined): T { if (value === undefined || value === null) throw new Error('Missing fixture'); return value; }
const fields: Character = { name: 'Picture keeper', description: 'Original text', personality: '', scenario: '', first_mes: '', mes_example: '', lorebookId: null };
const source = { spec: 'chara_card_v3', data: { ...fields, tags: ['Portrait'], character_book: { name: 'Picture book', entries: [], extensions: {} } } };
function command(store: Store, data: Character = fields, id?: string): CharacterSaveCommand {
  return { kind: 'characters', revision: store.libraryRevision(), requestId: randomUUID(), data, tagIds: id ? store.tags.assigned(id) : [], expectedPicture: id ? store.pictures.get(id)?.key ?? null : null };
}
async function image() { const p = new PictureProcessor(); processors.push(p); return p.process(await quadrantPicture()); }
function withPicture(command: CharacterSaveCommand, image: PreparedPicture): CharacterSaveCommand { return { ...command, picture: { mode: 'replace', base64: image.original.toString('base64'), crop: image.crop } }; }
function rows(store: Store, excluded = ['runtime_owner', 'library_state', 'character_pictures', 'picture_assets'], legacy = false) {
  const tables = store.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
  return Object.fromEntries(tables.filter(table => !excluded.includes(table.name) && (!legacy || table.name !== 'response_variants')).map(table => [table.name, legacy ? legacyRows(store.sqlite, table.name) : store.sqlite.prepare(`SELECT * FROM "${table.name}" ORDER BY rowid`).all()]));
}

it('keeps whole PNG artwork, JSON bytes and expanded/base64 metadata limits independent', async () => {
  const pixels = Buffer.alloc(1024 * 768 * 4);
  let state = 17;
  for (let index = 0; index < pixels.length; index++) { state = (Math.imul(state,1664525) + 1013904223) >>> 0; pixels[index] = state >>> 24; }
  const image = await sharp(pixels, { raw: { width: 1024, height: 768, channels: 4 } }).png().toBuffer();
  const original = cardPng(image, source);
  expect(original.length).toBeGreaterThan(2_000_000); expect(original.length).toBeLessThan(10_000_000);
  const parsed = readCharacterCardFile(original.toString('base64')); expect(parsed.value).toEqual(source); expect(parsed.artwork?.equals(original)).toBe(true);
  const p = new PictureProcessor(); processors.push(p); const result = await p.process(original); expect(result.original).toEqual(original); expect(result).toMatchObject({ width: 1024, height: 768 });
  const json = Buffer.from(JSON.stringify({ ...source, padding: 'x'.repeat(1_600_000) }));
  expect(readCharacterCardFile(json.toString('base64')).artwork).toBeUndefined();
  expect(() => readCharacterCardFile(cardPng(image, { ...source, padding: 'x'.repeat(1_600_000) }).toString('base64'))).toThrow('before base64 decoding');
  const expanded = Buffer.from('A'.repeat(2_000_001));
  for (const type of ['zTXt', 'iTXt']) {
    const compressed = pngChunk(type, Buffer.concat([Buffer.from('chara\0'), type === 'zTXt' ? Buffer.from([0]) : Buffer.from([1,0,0,0]), deflateSync(expanded)]));
    const png = Buffer.concat([image.subarray(0,-12), compressed, image.subarray(-12)]);
    expect(() => readCharacterCardFile(png.toString('base64'))).toThrow('could not be decoded');
  }
  expect(() => readCharacterCardFile(Buffer.from(' '.repeat(2_000_001)).toString('base64'))).toThrow('JSON cards');
  expect(() => readCharacterCardFile(Buffer.alloc(10_000_001).toString('base64'))).toThrow('10 MB');
  const excessiveChunks = Buffer.concat([image.subarray(0,8), ...Array.from({ length: 20_001 }, () => pngChunk('tEXt', Buffer.from('unrelated\0x')))]);
  expect(() => readCharacterCardFile(excessiveChunks.toString('base64'))).toThrow('too many chunks');
}, 15000);

describe('picture storage and atomic character commands', () => {
  it('isolates image-only revisions, preserves prompts/state/history, has true no-ops and durable exact replay', async () => {
    const path = join(directory(), 'pictures.sqlite'); let store = open(path); const prepared = await image();
    const id = store.saveLibrary(store.libraryRevision(), 'characters', fields);
    const connectionId = store.saveLibrary(store.libraryRevision(), 'connections', { name: 'Mock', endpoint: 'http://localhost:9999/v1', model: 'mock', contextWindow: 50000, maxOutputTokens: 100, customParameters: {} }, undefined, 'synthetic-picture-secret');
    const chatId = store.createChat(selectionsSchema.parse({ title: 'Picture story', targetInputTokens: 10000, promptId: 'default', characterId: id, personaId: null, connectionId }));
    const generation = store.begin(store.snapshot(chatId).revision, randomUUID(), 'Original turn', chatId), snapshot = store.snapshot(chatId);
    const request = assembleRequest(required(snapshot.connection), snapshot.settings, snapshot.turns, snapshot.sources);
    store.saveRequest(generation.id, request); store.finish(generation.id, 'succeeded', 'Original response', null);
    const before = rows(store), beforeRequest = store.snapshot(chatId), revision = store.libraryRevision();
    const submitted = withPicture(command(store, fields, id), prepared);
    expect(store.saveCharacter(submitted, id, prepared)).toEqual({ id });
    expect(store.libraryRevision()).toBe(revision + 1);
    // Picture edits update organizational dates while preserving all source columns.
    const libraryRows = before.library.map(value => {
      const row = rowSchema.parse(value);
      return row.id === id ? { ...row, updated_at: expect.any(String) } : row;
    });
    expect(rows(store)).toEqual({ ...before, library: libraryRows, lore_commands: expect.any(Array) });
    expect(store.snapshot(chatId)).toEqual(beforeRequest);
    expect(assembleRequest(required(beforeRequest.connection), beforeRequest.settings, beforeRequest.turns, beforeRequest.sources)).toEqual(assembleRequest(required(store.snapshot(chatId).connection), store.snapshot(chatId).settings, store.snapshot(chatId).turns, store.snapshot(chatId).sources));
    const picture = required(store.pictures.get(id)); expect(store.pictures.resource(id, picture.key, 'original').bytes).toEqual(prepared.original);
    const noOp = withPicture(command(store, fields, id), prepared), savedRevision = store.libraryRevision();
    store.saveCharacter(noOp, id, prepared); expect(store.libraryRevision()).toBe(savedRevision); expect(store.pictures.get(id)).toEqual(picture);
    store.saveCharacter({ ...command(store, fields, id), picture: { mode: 'remove' } }, id); expect(store.pictures.get(id)).toBeNull();
    store.close(); store = open(path);
    expect(store.saveCharacter(submitted, id)).toEqual({ id }); expect(store.pictures.get(id)).toBeNull();
    expect(() => store.replayCharacterSave({ ...submitted, data: { ...fields, name: 'Changed command' } }, id)).toThrow('different command');
    expect(JSON.stringify(store.libraries())).not.toContain(prepared.original.toString('base64')); expect(JSON.stringify(store.libraries())).not.toContain('synthetic-picture-secret');
    const ledger = store.sqlite.prepare('SELECT * FROM lore_commands').all(); expect(JSON.stringify(ledger)).not.toContain(prepared.original.toString('base64'));
  });
  it('shares immutable originals on duplicate but owns crops/removal independently and cleans only unreferenced assets', async () => {
    const store = open(), prepared = await image(), id = store.saveCharacter(withPicture(command(store), prepared), undefined, prepared).id;
    const copy = store.duplicateCharacter(store.libraryRevision(), id), picture = required(store.pictures.get(id)), copied = required(store.pictures.get(copy));
    expect(copied.crop).toEqual(picture.crop); expect(copied.key).not.toBe(picture.key);
    expect(store.sqlite.prepare('SELECT count(*) AS n FROM picture_assets').get()).toEqual({ n: 1 });
    const p = new PictureProcessor(); processors.push(p); const recropped = await p.process(prepared.original, cropFromControls(prepared, 2, 0, 0));
    store.saveCharacter({ ...command(store, { ...fields, name: 'Picture keeper copy' }, copy), picture: { mode: 'keep', key: copied.key, crop: recropped.crop } }, copy, recropped);
    expect(await pixel(store.pictures.resource(copy, required(store.pictures.get(copy)).key, 'thumbnail').bytes, 160, 160)).toEqual([240,30,30,255]);
    expect(store.pictures.get(id)).toEqual(picture);
    store.saveCharacter({ ...command(store, fields, copy), picture: { mode: 'remove' } }, copy);
    expect(store.sqlite.prepare('SELECT count(*) AS n FROM picture_assets').get()).toEqual({ n: 1 });
    store.deleteLibrary(store.libraryRevision(), 'characters', id);
    expect(store.sqlite.prepare('SELECT count(*) AS n FROM picture_assets').get()).toEqual({ n: 0 });
  });
  it('rolls text/tags/pictures/receipts back on failure and rejects stale or foreign picture dependencies', async () => {
    const store = open(), prepared = await image(); const id = store.saveCharacter(withPicture(command(store), prepared), undefined, prepared).id;
    const tag = store.tags.create(store.libraryRevision(), 'Picture tag'), picture = required(store.pictures.get(id));
    const before = rows(store, ['runtime_owner']), revision = store.libraryRevision();
    store.sqlite.exec("CREATE TRIGGER picture_rollback BEFORE DELETE ON character_pictures BEGIN SELECT RAISE(ABORT, 'synthetic picture rollback'); END");
    const submitted = { ...command(store, { ...fields, description: 'Changed' }, id), tagIds: [tag], picture: { mode: 'remove' as const } };
    expect(() => store.saveCharacter(submitted, id)).toThrow('synthetic picture rollback'); expect(rows(store, ['runtime_owner'])).toEqual(before); expect(store.libraryRevision()).toBe(revision);
    store.sqlite.exec('DROP TRIGGER picture_rollback');
    const other = store.saveLibrary(store.libraryRevision(), 'characters', { ...fields, name: 'Other' });
    expect(() => store.saveCharacter({ ...command(store, fields, other), picture: { mode: 'keep', key: picture.key, crop: picture.crop } }, other, prepared)).toThrow('saved picture changed');
    expect(() => store.saveCharacter(submitted, id)).toThrow('library changed');
    store.saveSettings(store.snapshot().revision, { name: 'Mock', endpoint: 'http://localhost:9999/v1', model: 'mock', contextWindow: 50000, maxOutputTokens: 100, customParameters: {} }, store.snapshot().settings);
    const running = store.begin(store.snapshot().revision, randomUUID(), 'Pending');
    expect(() => store.saveCharacter({ ...command(store, fields, id), picture: { mode: 'remove' } }, id)).toThrow('current response'); store.finish(running.id, 'cancelled', '', null);
    expect(store.pictures.get(id)).toEqual(picture);
  });
  it('atomically imports book/tags/art and distinguishes picture intent while preserving all legacy receipts', async () => {
    const store = open(), prepared = await image(), intent = { mode: 'retain' as const, digest: prepared.digest }, requestId = randomUUID();
    const imported = store.importCard(store.libraryRevision(), requestId, source, 'all', intent, prepared), id = required(imported.ids[0]);
    expect(imported.picture).toEqual({ saved: true }); expect(imported.tags).toMatchObject({ assigned: 1, created: 1 }); expect(imported.books).toHaveLength(1); expect(store.pictures.get(id)).not.toBeNull();
    expect(() => store.replayCard(requestId, source, 'all', { ...intent, digest: 'different' })).toThrow('different command');
    expect(() => store.replayCard(requestId, source, 'all', { ...intent, mode: 'none' })).toThrow('different command');
    store.deleteLibrary(store.libraryRevision(), 'characters', id);
    expect(store.importCard(0, requestId, source, 'all', intent)).toEqual(imported); expect(store.pictures.list()).toEqual([]);
    for (const preTags of [false, true]) {
      const legacyId = randomUUID(), legacyCommand = preTags ? { kind: 'character', value: source } : { kind: 'character', value: source, tagPolicy: 'all' };
      const result = { ids: ['deleted-legacy-character'], books: [], diagnostics: [] };
      store.sqlite.prepare('INSERT INTO lore_commands VALUES (?,?,?)').run(legacyId, createHash('sha256').update(JSON.stringify(legacyCommand)).digest('hex'), JSON.stringify(result));
      expect(store.replayCard(legacyId, source, preTags ? 'none' : 'all', intent)).toEqual({ found: true, result });
      if (preTags) expect(() => store.replayCard(legacyId, source, 'all', intent)).toThrow('different command');
    }
    const before = rows(store, ['runtime_owner']);
    store.sqlite.exec("CREATE TRIGGER reject_picture BEFORE INSERT ON character_pictures BEGIN SELECT RAISE(ABORT, 'synthetic import rollback'); END");
    expect(() => store.importCard(store.libraryRevision(), randomUUID(), { ...source, data: { ...source.data, tags: ['New failed tag'] } }, 'all', intent, prepared)).toThrow('synthetic import rollback');
    expect(rows(store, ['runtime_owner'])).toEqual(before);
  });
});

describe('migration 10', () => {
  it.each([false, true])('preserves populated version 9 and safely restarts (injected rollback: %s)', fail => {
    const path = join(directory(), 'upgrade.sqlite'); let store = open(path);
    const imported = store.importCard(store.libraryRevision(), randomUUID(), source, 'all');
    store.createChat(selectionsSchema.parse({ title: 'Preserved', targetInputTokens: 10000, promptId: 'default', connectionId: null, characterId: imported.ids[0], personaId: null }));
    const before = rows(store, undefined, true), revision = store.libraryRevision();
    removeVariantSchema(store.sqlite);
    store.sqlite.exec('DROP TABLE character_pictures; DROP TABLE picture_assets'); store.sqlite.pragma('user_version = 9');
    if (fail) store.sqlite.exec("CREATE TRIGGER reject_picture_migration BEFORE UPDATE ON library_state BEGIN SELECT RAISE(ABORT, 'synthetic upgrade failure'); END");
    store.close();
    if (fail) {
      expect(() => new Store(path)).toThrow('synthetic upgrade failure'); const db = new Database(path);
      expect(db.pragma('user_version', { simple: true })).toBe(9); expect(db.prepare("SELECT name FROM sqlite_master WHERE name='picture_assets'").get()).toBeUndefined(); expect(db.prepare('SELECT revision FROM library_state').get()).toEqual({ revision }); db.exec('DROP TRIGGER reject_picture_migration'); db.close();
    }
    store = open(path); expect(store.sqlite.pragma('user_version', { simple: true })).toBe(14); expect(rows(store, undefined, true)).toEqual(before); expect(store.pictures.list()).toEqual([]); expect(store.libraryRevision()).toBe(revision + 2);
    const saved = store.libraries(); store.close(); store = open(path); expect(store.libraries()).toEqual(saved);
  });
});

it('delivers private versioned raster resources, exact downloads and metadata-only exports; invalid art has an explicit escape', async () => {
  const { app, store } = await createApp({ database: ':memory:' });
  try {
    const setup = await app.inject({ method: 'POST', url: '/api/setup', headers: { origin: 'http://localhost:80', 'content-type': 'application/json' }, payload: { password: 'synthetic-picture-password' } });
    const cookie = required(setup.headers['set-cookie']?.toString()).split(';')[0];
    const send = (url: string, payload: unknown, method: 'POST' | 'PUT' = 'POST') => app.inject({ method, url, headers: { cookie, origin: 'http://localhost:80', 'content-type': 'application/json' }, payload: JSON.stringify(payload) });
    const original = cardPng(await quadrantPicture(), source), base64 = original.toString('base64');
    expect(readCharacterCardFile(base64).artwork).toEqual(original);
    const preview = await send('/api/library/characters/preview', { base64 }); expect(preview.json()).toMatchObject({ picture: { status: 'ready', image: { width: 400, height: 200 } }, tags: { newTags: [{ name: 'Portrait' }] } });
    const result = await send('/api/library/import', { revision: store.libraryRevision(), kind: 'characters', requestId: randomUUID(), tagPolicy: 'all', base64 }); expect(result.statusCode).toBe(200);
    const id = result.json().ids[0] as string, picture = required(store.pictures.get(id));
    for (const url of [picture.thumbnailUrl, picture.previewUrl, picture.originalUrl]) {
      expect((await app.inject({ url })).statusCode).toBe(401);
      const response = await app.inject({ url, headers: { cookie } }); expect(response.statusCode).toBe(200); expect(response.headers['x-content-type-options']).toBe('nosniff'); expect(response.headers['content-type']).toMatch(/^image\/png/);
      if (url === picture.originalUrl) { expect(response.rawPayload).toEqual(original); expect(response.headers['content-disposition']).toContain('attachment'); expect(response.headers['cache-control']).toBe('no-store'); }
      else { expect(response.headers['cache-control']).toBe('private, no-cache'); expect((await app.inject({ url, headers: { cookie, 'if-none-match': response.headers.etag } })).statusCode).toBe(304); expect((await app.inject({ url, headers: { 'if-none-match': response.headers.etag } })).statusCode).toBe(401); }
    }
    const exported = (await app.inject({ url: `/api/library/characters/${id}/export`, headers: { cookie } })).json();
    expect(exported.data.name).toBe(fields.name); expect(JSON.stringify(exported)).not.toContain(picture.key); expect(JSON.stringify(exported)).not.toContain('thumbnail');
    const bad = Buffer.concat([original.subarray(0,8), pngChunk('tEXt', Buffer.from(`chara\0${Buffer.from(JSON.stringify(source)).toString('base64')}`))]).toString('base64');
    const badPreview = await send('/api/library/characters/preview', { base64: bad }); expect(badPreview.statusCode).toBe(200); expect(badPreview.json().picture.status).toBe('error');
    const requestId = randomUUID(), payload = { revision: store.libraryRevision(), requestId, kind: 'characters', base64: bad, tagPolicy: 'none' };
    expect((await send('/api/library/import', payload)).statusCode).toBe(422);
    const without = await send('/api/library/import', { ...payload, pictureMode: 'none' }); expect(without.json().picture).toEqual({ saved: false });
    // A successful old header-only receipt must replay before today's decoder.
    const legacyId = randomUUID(), legacyResult = store.importCard(store.libraryRevision(), legacyId, source);
    const historical = await send('/api/library/import', { ...payload, revision: 0, requestId: legacyId }); expect(historical.statusCode).toBe(200); expect(historical.json()).toEqual(legacyResult); expect(historical.json().picture).toBeUndefined();
    const before = store.pictures.get(id), beforeRevision = store.libraryRevision();
    expect((await send(`/api/library/${id}`, { ...command(store, fields, id), picture: { mode: 'replace', base64: bad, crop: picture.crop } }, 'PUT')).statusCode).toBe(422); expect(store.pictures.get(id)).toEqual(before); expect(store.libraryRevision()).toBe(beforeRevision);
    expect((await send(`/api/library/${id}`, { ...command(store, fields, id), picture: { mode: 'unknown' } }, 'PUT')).statusCode).toBe(400);
    await send(`/api/library/${id}`, { ...command(store, fields, id), picture: { mode: 'remove' } }, 'PUT');
    expect((await app.inject({ url: picture.thumbnailUrl, headers: { cookie, 'if-none-match': `"${picture.key}-thumbnail"` } })).statusCode).toBe(404);
  } finally { await app.close(); }
}, 15000);
