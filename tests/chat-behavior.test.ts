import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server/app.js';
import { ChatBehaviorSettings } from '../src/server/chat-behavior.js';
import { defaultChatBehavior } from '../src/shared/chat-behavior.js';
import { isComposerSendKey, isMacKeyboard, isPhoneOrTablet } from '../src/web/composer-shortcuts.js';

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
  const folder = fs.mkdtempSync(join(tmpdir(), 'ore-chat-behavior-'));
  folders.push(folder);
  return folder;
}

it('defaults to Ctrl+Enter, validates authenticated revisioned saves and restores preferences after restart without changing chats', async () => {
  const database = join(directory(), 'test.sqlite');
  let instance = await createApp({ database });
  const headers = { host: 'localhost', origin: 'http://localhost' };
  const url = '/api/application/chat-behavior';
  try {
    expect((await instance.app.inject({ method: 'GET', url, headers })).statusCode).toBe(401);
    expect((await instance.app.inject({ method: 'PUT', url, headers, payload: { revision: 0, settings: defaultChatBehavior } })).statusCode).toBe(401);
    const login = await instance.app.inject({ method: 'POST', url: '/api/setup', headers, payload: { password: 'synthetic-behavior-password' } });
    const cookie = login.headers['set-cookie']?.toString().split(';')[0];
    if (!cookie) throw new Error('Missing session cookie');
    const auth = { ...headers, cookie };
    expect((await instance.app.inject({ method: 'GET', url, headers: auth })).json()).toEqual({ revision: 0, settings: defaultChatBehavior });
    const before = instance.store.snapshot(), libraryBefore = instance.store.libraries();
    for (const enterKeyBehavior of ['enter', 'button-only', 'ctrl-enter']) {
      const revision = (await instance.app.inject({ method: 'GET', url, headers: auth })).json().revision;
      const saved = await instance.app.inject({ method: 'PUT', url, headers: auth, payload: { revision, settings: { enterKeyBehavior } } });
      expect(saved.statusCode).toBe(200);
      expect(saved.json()).toEqual({ revision: revision + 1, settings: { ...defaultChatBehavior, enterKeyBehavior } });
    }
    for (const payload of [
      { revision: 3, settings: { enterKeyBehavior: 'unknown' } },
      { revision: 3, settings: {} },
      { revision: 3, settings: { enterKeyBehavior: null } },
      { revision: -1, settings: defaultChatBehavior },
      { revision: 3, settings: { ...defaultChatBehavior, extra: true } },
      ...[{ maximumOvershootTokens: -1 }, { maximumOvershootTokens: 1.5 }, { maximumOvershootTokens: Number.MAX_SAFE_INTEGER + 1 }, { allowInputOvershoot: 'true' }, { memoryMaxRetries: -1 }, { autoRetryMemory: null }].map(patch => ({ revision: 3, settings: { ...defaultChatBehavior, ...patch } })),
    ]) expect((await instance.app.inject({ method: 'PUT', url, headers: auth, payload })).statusCode).toBe(400);
    expect((await instance.app.inject({ method: 'PUT', url, headers: auth, payload: { revision: 0, settings: { enterKeyBehavior: 'enter' } } })).statusCode).toBe(409);
    expect((await instance.app.inject({ method: 'PUT', url, headers: { ...auth, origin: 'http://elsewhere.example' }, payload: { revision: 3, settings: defaultChatBehavior } })).statusCode).toBe(403);
    expect(instance.store.snapshot()).toEqual(before);
    expect(instance.store.libraries()).toEqual(libraryBefore);
    const saved = (await instance.app.inject({ method: 'GET', url, headers: auth })).json();
    await instance.app.close();
    instance = await createApp({ database });
    expect((await instance.app.inject({ method: 'GET', url, headers: auth })).json()).toEqual(saved);
    expect(fs.statSync(`${database}.chat-behavior.json`).mode & 0o777).toBe(0o600);
  } finally { await instance.app.close(); }
});

it('preserves committed preferences on failed writes and concurrent saves, and never overwrites malformed files', () => {
  const folder = directory(), file = join(folder, 'settings.json');
  const preferences = new ChatBehaviorSettings(file);
  const saved = preferences.save({ revision: 0, settings: { enterKeyBehavior: 'button-only' } });
  const original = fs.readFileSync(file, 'utf8');
  const next = { revision: 1, settings: { enterKeyBehavior: 'enter' } };
  vi.mocked(fs.writeFileSync).mockImplementationOnce(() => { throw new Error('Synthetic disk full'); });
  expect(() => preferences.save(next)).toThrow('Previous settings were retained');
  vi.mocked(fs.renameSync).mockImplementationOnce(() => { throw new Error('Synthetic rename failure'); });
  expect(() => preferences.save(next)).toThrow('Previous settings were retained');
  expect(fs.readdirSync(folder)).toEqual(['settings.json']);
  expect(fs.readFileSync(file, 'utf8')).toBe(original);
  expect(new ChatBehaviorSettings(file).status()).toEqual(saved);
  preferences.save(next);
  expect(() => new ChatBehaviorSettings(file).save(next)).toThrow('another window');
  fs.writeFileSync(file, '{malformed');
  expect(() => preferences.status()).toThrow('could not be read');
  expect(() => preferences.save(next)).toThrow('could not be read');
  expect(fs.readFileSync(file, 'utf8')).toBe('{malformed');
});

const enter = { key: 'Enter', code: 'Enter', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, isComposing: false, keyCode: 13 };
it('limits sending to the selected chord, excludes composition, and preserves phone Return even with a physical-looking code', () => {
  expect(isComposerSendKey(enter, 'ctrl-enter', false, false)).toBe(false);
  expect(isComposerSendKey({ ...enter, ctrlKey: true }, 'ctrl-enter', false, false)).toBe(true);
  expect(isComposerSendKey({ ...enter, metaKey: true }, 'ctrl-enter', false, true)).toBe(true);
  expect(isComposerSendKey({ ...enter, metaKey: true }, 'ctrl-enter', false, false)).toBe(false);
  expect(isComposerSendKey(enter, 'enter', false, false)).toBe(true);
  expect(isComposerSendKey(enter, 'enter', true, true)).toBe(false);
  expect(isComposerSendKey({ ...enter, ctrlKey: true }, 'ctrl-enter', true, false)).toBe(true);
  for (const changes of [{ shiftKey: true }, { altKey: true }, { isComposing: true }, { keyCode: 229 }, { code: '' }, { ctrlKey: true, metaKey: true }]) {
    expect(isComposerSendKey({ ...enter, ctrlKey: true, ...changes }, 'ctrl-enter', false, true)).toBe(false);
  }
  for (const changes of [{}, { ctrlKey: true }, { metaKey: true }]) {
    expect(isComposerSendKey({ ...enter, ...changes }, 'button-only', false, true)).toBe(false);
  }
  expect(isComposerSendKey({ ...enter, ctrlKey: true }, 'enter', false, false)).toBe(false);
});

it('recognizes phones, Android tablets and desktop-mode iPads without classifying touch laptops as phones', () => {
  expect(isPhoneOrTablet({ userAgent: 'iPhone', platform: 'iPhone', maxTouchPoints: 5 })).toBe(true);
  expect(isPhoneOrTablet({ userAgent: 'Android', platform: 'Linux', maxTouchPoints: 5 })).toBe(true);
  expect(isPhoneOrTablet({ userAgent: 'Macintosh', platform: 'MacIntel', maxTouchPoints: 5 })).toBe(true);
  expect(isPhoneOrTablet({ userAgent: 'Windows NT', platform: 'Win32', maxTouchPoints: 5 })).toBe(false);
  expect(isMacKeyboard({ platform: 'MacIntel', userAgent: 'Macintosh' })).toBe(true);
  expect(isMacKeyboard({ platform: 'Win32', userAgent: 'Windows NT' })).toBe(false);
});


it('reads legacy version-1 preferences without rewriting them, and persists overshoot and retry preferences in version 2', () => {
  const file = join(directory(), 'legacy.json');
  const legacy = JSON.stringify({ version: 1, revision: 7, settings: { enterKeyBehavior: 'enter' } });
  fs.writeFileSync(file, legacy);
  const preferences = new ChatBehaviorSettings(file);
  expect(preferences.status()).toEqual({ revision: 7, settings: { ...defaultChatBehavior, enterKeyBehavior: 'enter' } });
  expect(fs.readFileSync(file, 'utf8')).toBe(legacy);
  const settings = { ...defaultChatBehavior, enterKeyBehavior: 'button-only', allowInputOvershoot: false, maximumOvershootTokens: Number.MAX_SAFE_INTEGER, autoRetryMemory: false, memoryMaxRetries: 3 };
  const saved = preferences.save({ revision: 7, settings });
  expect(saved).toEqual({ revision: 8, settings });
  expect(new ChatBehaviorSettings(file).status()).toEqual(saved);
  expect(JSON.parse(fs.readFileSync(file, 'utf8')).version).toBe(2);
  const keyboardOnly = preferences.save({ revision: saved.revision, settings: { enterKeyBehavior: 'enter' } });
  expect(keyboardOnly.settings).toEqual({ ...saved.settings, enterKeyBehavior: 'enter' });
});
