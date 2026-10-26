import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server/app.js';
import { AppearanceSettings } from '../src/server/appearance.js';
import { defaultAppearance, appearanceStatusSchema } from '../src/shared/appearance.js';

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
  const path = fs.mkdtempSync(join(tmpdir(), 'ore-appearance-'));
  folders.push(path);
  return path;
}

it('saves authenticated app-wide defaults without changing library/chat state and reloads them after restart', async () => {
  const database = join(directory(), 'test.sqlite');
  let instance = await createApp({ database });
  const headers = { host: 'localhost', origin: 'http://localhost' };
  try {
    expect((await instance.app.inject({ method: 'GET', url: '/api/application/appearance', headers })).statusCode).toBe(401);
    const login = await instance.app.inject({ method: 'POST', url: '/api/setup', headers, payload: { password: 'synthetic-appearance-password' } });
    const cookie = login.headers['set-cookie']?.toString().split(';')[0];
    if (!cookie) throw new Error('Missing session cookie');
    const auth = { ...headers, cookie };
    const initial = await instance.app.inject({ method: 'GET', url: '/api/application/appearance', headers: auth });
    expect(initial.json()).toEqual({ revision: 0, settings: defaultAppearance });
    const before = instance.store.snapshot();
    const libraryBefore = instance.store.libraries();
    const settings = { theme: 'light', characterSpeechColor: '#EEAA88', personaSpeechColor: '#88cc99', chatTextScale: 120, displayCharacterPicture: false };
    const saved = await instance.app.inject({ method: 'PUT', url: '/api/application/appearance', headers: auth, payload: { revision: 0, settings } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ revision: 1, settings: { ...settings, characterSpeechColor: '#eeaa88' } });
    expect(instance.store.snapshot()).toEqual(before);
    expect(instance.store.libraries()).toEqual(libraryBefore);
    const stale = await instance.app.inject({ method: 'PUT', url: '/api/application/appearance', headers: auth, payload: { revision: 0, settings: defaultAppearance } });
    expect(stale.statusCode).toBe(409);
    for (const characterSpeechColor of ['#abc', '#fffffff', 'red', 'url(example.com)']) {
      expect((await instance.app.inject({ method: 'PUT', url: '/api/application/appearance', headers: auth, payload: { revision: 1, settings: { ...defaultAppearance, characterSpeechColor } } })).statusCode).toBe(400);
    }
    for (const chatTextScale of [null, 80, 95, 130, '120']) {
      expect((await instance.app.inject({ method: 'PUT', url: '/api/application/appearance', headers: auth, payload: { revision: 1, settings: { ...defaultAppearance, chatTextScale } } })).statusCode).toBe(400);
    }
    for (const displayCharacterPicture of [null, 0, 1, 'false']) {
      expect((await instance.app.inject({ method: 'PUT', url: '/api/application/appearance', headers: auth, payload: { revision: 1, settings: { ...defaultAppearance, displayCharacterPicture } } })).statusCode).toBe(400);
    }
    expect((await instance.app.inject({ method: 'PUT', url: '/api/application/appearance', headers: { ...auth, origin: 'http://other.example' }, payload: { revision: 1, settings: defaultAppearance } })).statusCode).toBe(403);
    await instance.app.close();
    instance = await createApp({ database });
    const restored = await instance.app.inject({ method: 'GET', url: '/api/application/appearance', headers: auth });
    expect(appearanceStatusSchema.parse(restored.json())).toEqual(saved.json());
    expect(fs.statSync(`${database}.appearance.json`).mode & 0o777).toBe(0o600);
  } finally { await instance.app.close(); }
});

it('retains committed defaults on write/rename failure, removes temporary files and detects concurrent edits', () => {
  const folder = directory(), file = join(folder, 'settings.appearance.json');
  const settings = new AppearanceSettings(file);
  const committed = settings.save({ revision: 0, settings: defaultAppearance });
  const saved = fs.readFileSync(file, 'utf8');
  const next = { revision: 1, settings: { characterSpeechColor: '#112233', personaSpeechColor: '#445566', chatTextScale: 120, displayCharacterPicture: false } };
  vi.mocked(fs.writeFileSync).mockImplementationOnce(() => { throw new Error('Synthetic disk full'); });
  expect(() => settings.save(next)).toThrow('Previous settings were retained');
  vi.mocked(fs.renameSync).mockImplementationOnce(() => { throw new Error('Synthetic rename failure'); });
  expect(() => settings.save(next)).toThrow('Previous settings were retained');
  expect(fs.readFileSync(file, 'utf8')).toBe(saved);
  expect(fs.readdirSync(folder)).toEqual(['settings.appearance.json']);
  expect(settings.status()).toEqual(committed);
  const secondWindow = new AppearanceSettings(file);
  settings.save(next);
  expect(() => secondWindow.save({ revision: 1, settings: defaultAppearance })).toThrow('another window');
  fs.writeFileSync(file, 'invalid saved data');
  expect(() => settings.status()).toThrow('could not be read');
  expect(() => settings.save({ revision: 0, settings: defaultAppearance })).toThrow('could not be read');
  expect(fs.readFileSync(file, 'utf8')).toBe('invalid saved data');
});

it('reads version-1 colors with default text size and upgrades on save without losing revisions or older-client edits', () => {
  const file = join(directory(), 'settings.appearance.json');
  const colors = { characterSpeechColor: '#112233', personaSpeechColor: '#445566' };
  const legacy = JSON.stringify({ version: 1, revision: 7, settings: colors });
  fs.writeFileSync(file, legacy);
  const settings = new AppearanceSettings(file);
  expect(settings.status()).toEqual({ revision: 7, settings: { ...colors, theme: 'dark', chatTextScale: 100, displayCharacterPicture: true } });
  expect(fs.readFileSync(file, 'utf8')).toBe(legacy);
  settings.save({ revision: 7, settings: { ...colors, theme: 'dark', chatTextScale: 90 } });
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ version: 4, revision: 8, settings: { ...colors, theme: 'dark', chatTextScale: 90, displayCharacterPicture: true } });
  const reopened = new AppearanceSettings(file);
  expect(reopened.save({ revision: 8, settings: { ...colors, theme: 'dark', personaSpeechColor: '#abcdef' } })).toEqual({ revision: 9, settings: { ...colors, theme: 'dark', personaSpeechColor: '#abcdef', chatTextScale: 90, displayCharacterPicture: true } });
});

it('defaults version-2 pictures to visible and preserves a hidden preference across older-client saves', () => {
  const file = join(directory(), 'settings.appearance.json');
  const previous = { characterSpeechColor: '#112233', personaSpeechColor: '#445566', chatTextScale: 110 };
  const legacy = JSON.stringify({ version: 2, revision: 12, settings: previous });
  fs.writeFileSync(file, legacy);
  const settings = new AppearanceSettings(file);
  expect(settings.status()).toEqual({ revision: 12, settings: { ...previous, theme: 'dark', displayCharacterPicture: true } });
  expect(fs.readFileSync(file, 'utf8')).toBe(legacy);
  const hidden = settings.save({ revision: 12, settings: { ...previous, theme: 'dark', displayCharacterPicture: false } });
  expect(hidden.settings.displayCharacterPicture).toBe(false);
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ version: 4, ...hidden });
  const reopened = new AppearanceSettings(file);
  expect(reopened.status()).toEqual(hidden);
  expect(reopened.save({ revision: 13, settings: previous })).toEqual({ revision: 14, settings: { ...previous, theme: 'dark', displayCharacterPicture: false } });
  expect(reopened.save({ revision: 14, settings: { characterSpeechColor: '#abcdef', personaSpeechColor: previous.personaSpeechColor } })).toEqual({ revision: 15, settings: { ...previous, theme: 'dark', characterSpeechColor: '#abcdef', displayCharacterPicture: false } });
});

it('preserves version-3 colors and revisions, then saves theme defaults and retains theme for older clients', () => {
  const file = join(directory(), 'settings.appearance.json');
  const previous = { characterSpeechColor: '#a8c9f0', personaSpeechColor: '#445566', chatTextScale: 110, displayCharacterPicture: false };
  const legacy = JSON.stringify({ version: 3, revision: 12, settings: previous });
  fs.writeFileSync(file, legacy);
  const settings = new AppearanceSettings(file);
  expect(settings.status()).toEqual({ revision: 12, settings: { ...previous, theme: 'dark' } });
  expect(fs.readFileSync(file, 'utf8')).toBe(legacy);
  const light = settings.save({ revision: 12, settings: { ...previous, theme: 'light', characterSpeechColor: null } });
  expect(new AppearanceSettings(file).status()).toEqual(light);
  expect(light.settings).toEqual({ ...previous, theme: 'light', characterSpeechColor: null });
  const next = settings.save({ revision: 13, settings: { ...previous, characterSpeechColor: '#112233' } });
  expect(next.settings).toEqual({ ...previous, theme: 'light', characterSpeechColor: '#112233' });
  for (const theme of [null, 'system', '', 1]) {
    expect(() => settings.save({ revision: 14, settings: { ...next.settings, theme } })).toThrow();
    expect(settings.status()).toEqual(next);
  }
});

it('renders the current theme before login without exposing saved appearance overrides, and keeps malformed settings recoverable', async () => {
  const folder = directory();
  const database = join(folder, 'test.sqlite');
  const staticDirectory = join(folder, 'client');
  fs.mkdirSync(staticDirectory);
  fs.writeFileSync(join(staticDirectory, 'index.html'), '<!doctype html><html lang="en"><head></head><body></body></html>');
  const settings = new AppearanceSettings(`${database}.appearance.json`);
  settings.save({ revision: 0, settings: { ...defaultAppearance, theme: 'light', characterSpeechColor: '#123456' } });
  const instance = await createApp({ database, staticDirectory });
  try {
    for (const url of ['/', '/index.html']) {
      const response = await instance.app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).toContain('<html lang="en" data-theme="light">');
      expect(response.body).not.toContain('#123456');
      expect(response.headers['content-security-policy']).toContain("script-src 'self'");
    }
    fs.writeFileSync(`${database}.appearance.json`, 'malformed');
    const fallback = await instance.app.inject({ method: 'GET', url: '/' });
    expect(fallback.statusCode).toBe(200);
    expect(fallback.body).toContain('data-theme="dark"');
    expect(() => settings.status()).toThrow('could not be read');
    expect(fs.readFileSync(`${database}.appearance.json`, 'utf8')).toBe('malformed');
  } finally { await instance.app.close(); }
});
