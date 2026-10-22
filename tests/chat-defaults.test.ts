import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server/app.js';
import { ChatDefaultsSettings } from '../src/server/chat-defaults.js';
import { Store } from '../src/persistence/store.js';
import { defaultPrompt } from '../src/shared/library.js';
import { defaultContextPreset } from '../src/shared/context.js';
import { initialChatDefaults, type ChatDefaultKind } from '../src/shared/chat-defaults.js';

vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync), renameSync: vi.fn(actual.renameSync) };
});
const folders: string[] = [];
afterEach(() => {
  vi.clearAllMocks();
  for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});
function directory() {
  const path = fs.mkdtempSync(join(tmpdir(), 'ore-chat-defaults-'));
  folders.push(path);
  return path;
}
const connection = { name: 'Synthetic', endpoint: 'http://localhost:1234/v1', model: 'synthetic', contextWindow: 100_000, maxOutputTokens: 100, customParameters: {} };
const newChat = { title: 'New story', targetInputTokens: 32000, characterId: null, personaId: null };

it('applies current authenticated defaults only to new chats, preserves overrides and survives restart', async () => {
  const database = join(directory(), 'test.sqlite');
  let instance = await createApp({ database });
  const headers = { host: 'localhost', origin: 'http://localhost' };
  try {
    const url = '/api/application/chat-defaults';
    expect((await instance.app.inject({ method: 'GET', url, headers })).statusCode).toBe(401);
    expect((await instance.app.inject({ method: 'PUT', url, headers, payload: {} })).statusCode).toBe(401);
    const login = await instance.app.inject({ method: 'POST', url: '/api/setup', headers, payload: { password: 'synthetic-defaults-password' } });
    const cookie = login.headers['set-cookie']?.toString().split(';')[0];
    if (!cookie) throw new Error('Missing session cookie');
    const auth = { ...headers, cookie };
    const cmd = (kind: ChatDefaultKind, id: string | null, revision: number, libraryRevision = instance.store.libraryRevision()) =>
      instance.app.inject({ method: 'PUT', url, headers: auth, payload: { kind, id, revision, libraryRevision } });
    const create = async (settings: object = newChat) => {
      const result = await instance.app.inject({ method: 'POST', url: '/api/chats', headers: auth, payload: settings });
      expect(result.statusCode, result.body).toBe(200);
      return instance.store.snapshot(result.json().id);
    };
    const first = instance.store.saveLibrary(instance.store.libraryRevision(), 'connections', connection);
    const selected = instance.store.saveLibrary(instance.store.libraryRevision(), 'connections', { ...connection, name: 'Chosen connection' }, undefined, 'synthetic-secret');
    const prompt = instance.store.saveLibrary(instance.store.libraryRevision(), 'prompts', { ...defaultPrompt, name: 'Chosen prompt' });
    const context = instance.store.saveLibrary(instance.store.libraryRevision(), 'contexts', { ...defaultContextPreset, name: 'Chosen context', connectionId: selected });
    const existing = await create();
    expect(existing.settings).toMatchObject({ promptId: 'default', connectionId: first, contextPresetId: null });
    const libraryBefore = instance.store.libraries();
    expect((await cmd('prompts', prompt, 0)).statusCode).toBe(200);
    expect((await cmd('connections', selected, 1)).statusCode).toBe(200);
    expect((await cmd('contexts', context, 2)).statusCode).toBe(200);
    expect(instance.store.libraries()).toEqual(libraryBefore);
    expect(instance.store.snapshot(existing.id)).toEqual(existing);
    const current = await instance.app.inject({ method: 'GET', url, headers: auth });
    expect(current.body).not.toContain('synthetic-secret');
    expect(current.json()).toEqual({ revision: 3, settings: { prompts: prompt, connections: selected, contexts: context } });
    expect((await cmd('prompts', 'default', 2)).statusCode).toBe(409);
    expect((await cmd('prompts', 'default', 3, libraryBefore.revision - 1)).statusCode).toBe(409);
    expect((await cmd('contexts', prompt, 3)).statusCode).toBe(404);
    expect((await cmd('connections', 'missing', 3)).statusCode).toBe(404);
    expect((await instance.app.inject({ method: 'PUT', url, headers: { ...auth, origin: 'http://other.example' }, payload: { kind: 'prompts', id: prompt, revision: 3, libraryRevision: libraryBefore.revision } })).statusCode).toBe(403);
    expect((await instance.app.inject({ method: 'PUT', url, headers: auth, payload: { kind: 'characters', id: prompt, revision: 3, libraryRevision: libraryBefore.revision } })).statusCode).toBe(400);
    await instance.app.close();
    instance = await createApp({ database });
    // No client-supplied defaults: even a tab opened earlier receives current choices.
    const created = await create();
    expect(created.settings).toMatchObject({ promptId: prompt, connectionId: selected, contextPresetId: context });
    expect(created.context.preset?.connectionId).toBe(selected);
    const overridden = await create({ ...newChat, promptId: 'default', connectionId: null, contextPresetId: null });
    expect(overridden.settings).toMatchObject({ promptId: 'default', connectionId: null, contextPresetId: null });
    expect((await cmd('contexts', null, 3)).statusCode).toBe(200);
    expect((await cmd('connections', null, 4)).statusCode).toBe(200);
    expect((await cmd('prompts', null, 5)).statusCode).toBe(200);
    expect((await create()).settings).toMatchObject({ promptId: 'default', connectionId: first, contextPresetId: null });
    expect(instance.store.snapshot(created.id)).toEqual(created);
  } finally { await instance.app.close(); }
});

it('retains committed defaults on write failure and rejects malformed settings without overwriting them', () => {
  const folder = directory();
  const file = join(folder, 'defaults.json');
  const store = new Store(join(folder, 'test.sqlite'));
  const settings = new ChatDefaultsSettings(file);
  const save = () => settings.save({ revision: settings.status().revision, libraryRevision: store.libraryRevision(), kind: 'prompts', id: 'default' }, store);
  try {
    expect(settings.status()).toEqual(initialChatDefaults);
    fs.writeFileSync(file, JSON.stringify({ version: 1, ...initialChatDefaults }));
    const before = fs.readFileSync(file);
    for (const operation of ['write', 'rename']) {
      if (operation === 'write') vi.mocked(fs.writeFileSync).mockImplementationOnce(() => { throw new Error('Synthetic disk full'); });
      else vi.mocked(fs.renameSync).mockImplementationOnce(() => { throw new Error('Synthetic rename failure'); });
      expect(save).toThrow('Previous defaults were retained');
      expect(fs.readFileSync(file)).toEqual(before);
      expect(fs.readdirSync(folder).filter(name => name.endsWith('.tmp'))).toEqual([]);
    }
    const committed = save();
    expect(new ChatDefaultsSettings(file).status()).toEqual(committed);
    expect(save()).toEqual(committed); // Repeated selection is idempotent.
    fs.writeFileSync(file, '{invalid json');
    expect(() => settings.status()).toThrow('could not be read');
    expect(save).toThrow('could not be read');
    expect(fs.readFileSync(file, 'utf8')).toBe('{invalid json');
  } finally { store.close(); }
});

it('falls back safely after unused defaults are deleted without changing other saved choices', async () => {
  const database = join(directory(), 'test.sqlite');
  const { app, store } = await createApp({ database });
  try {
    const settings = new ChatDefaultsSettings(`${database}.chat-defaults.json`);
    const first = store.saveLibrary(store.libraryRevision(), 'connections', connection);
    const selected = store.saveLibrary(store.libraryRevision(), 'connections', { ...connection, name: 'Default to delete' });
    const prompt = store.saveLibrary(store.libraryRevision(), 'prompts', { ...defaultPrompt, name: 'Default to delete' });
    const context = store.saveLibrary(store.libraryRevision(), 'contexts', { ...defaultContextPreset, name: 'Default to delete' });
    const choices = { prompts: prompt, connections: selected, contexts: context };
    for (const kind of ['prompts', 'connections', 'contexts'] as const) {
      settings.save({ revision: settings.status().revision, libraryRevision: store.libraryRevision(), kind, id: choices[kind] }, store);
      store.deleteLibrary(store.libraryRevision(), kind, choices[kind]);
    }
    const headers = { host: 'localhost', origin: 'http://localhost' };
    const login = await app.inject({ method: 'POST', url: '/api/setup', headers, payload: { password: 'synthetic-defaults-password' } });
    const cookie = login.headers['set-cookie']?.toString().split(';')[0];
    const result = await app.inject({ method: 'POST', url: '/api/chats', headers: { ...headers, cookie }, payload: newChat });
    expect(result.statusCode).toBe(200);
    expect(store.snapshot(result.json().id).settings).toMatchObject({ promptId: 'default', connectionId: first, contextPresetId: null });
  } finally { await app.close(); }
});
