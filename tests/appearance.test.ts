import { createStoryApp } from './support/story-fixture.js';
import { expectPrivateFile } from './support/private-file.js';
import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server/app.js';
import { AppearanceSettings } from '../src/server/appearance.js';
import { defaultAppearance, appearanceStatusSchema, themeSchema } from '../src/shared/appearance.js';

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

it('validates app-wide defaults, preserves chat and library state, and reloads the saved appearance after restart', async () => {
  const database = join(directory(), 'test.sqlite');
  let instance = await createStoryApp({ database });
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
    const settings = { theme: 'light', appIconTheme: null, characterSpeechColor: '#EEAA88', personaSpeechColor: '#88cc99', chatTextScale: 120, displayCharacterPicture: false, showReasoningDuringGeneration: true };
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
    const restoredStatus = appearanceStatusSchema.parse(restored.json());
    expect(restoredStatus).toEqual(saved.json());
    expectPrivateFile(`${database}.appearance.json`);
    let revision = restoredStatus.revision;
    for (const theme of themeSchema.options.filter(theme => theme !== restoredStatus.settings.theme)) {
      const settings = { ...restoredStatus.settings, theme };
      const response = await instance.app.inject({ method: 'PUT', url: '/api/application/appearance', headers: auth, payload: { revision, settings } });
      expect(response.statusCode).toBe(200);
      revision += 1;
      const read = await instance.app.inject({ method: 'GET', url: '/api/application/appearance', headers: auth });
      expect(read.json()).toEqual({ revision, settings });
    }
  } finally { await instance.app.close(); }
});

it('retains committed defaults on write/rename failure, removes temporary files and detects concurrent edits', () => {
  const folder = directory(), file = join(folder, 'settings.appearance.json');
  const settings = new AppearanceSettings(file);
  const committed = settings.save({ revision: 0, settings: defaultAppearance });
  const saved = fs.readFileSync(file, 'utf8');
  const next = { revision: 1, settings: { appIconTheme: 'dark', characterSpeechColor: '#112233', personaSpeechColor: '#445566', chatTextScale: 120, displayCharacterPicture: false, showReasoningDuringGeneration: true } };
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
  expect(settings.status()).toEqual({ revision: 7, settings: { ...colors, theme: 'dark', appIconTheme: null, chatTextScale: 100, displayCharacterPicture: true, showReasoningDuringGeneration: false } });
  expect(fs.readFileSync(file, 'utf8')).toBe(legacy);
  settings.save({ revision: 7, settings: { ...colors, theme: 'dark', chatTextScale: 90 } });
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ version: 6, revision: 8, settings: { ...colors, theme: 'dark', appIconTheme: null, chatTextScale: 90, displayCharacterPicture: true, showReasoningDuringGeneration: false } });
  const reopened = new AppearanceSettings(file);
  expect(reopened.save({ revision: 8, settings: { ...colors, theme: 'dark', personaSpeechColor: '#abcdef' } })).toEqual({ revision: 9, settings: { ...colors, theme: 'dark', appIconTheme: null, personaSpeechColor: '#abcdef', chatTextScale: 90, displayCharacterPicture: true, showReasoningDuringGeneration: false } });
});

it('defaults version-2 pictures to visible and preserves a hidden preference across older-client saves', () => {
  const file = join(directory(), 'settings.appearance.json');
  const previous = { characterSpeechColor: '#112233', personaSpeechColor: '#445566', chatTextScale: 110 };
  const legacy = JSON.stringify({ version: 2, revision: 12, settings: previous });
  fs.writeFileSync(file, legacy);
  const settings = new AppearanceSettings(file);
  expect(settings.status()).toEqual({ revision: 12, settings: { ...previous, theme: 'dark', appIconTheme: null, displayCharacterPicture: true, showReasoningDuringGeneration: false } });
  expect(fs.readFileSync(file, 'utf8')).toBe(legacy);
  const hidden = settings.save({ revision: 12, settings: { ...previous, theme: 'dark', displayCharacterPicture: false, showReasoningDuringGeneration: false } });
  expect(hidden.settings.displayCharacterPicture).toBe(false);
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ version: 6, ...hidden });
  const reopened = new AppearanceSettings(file);
  expect(reopened.status()).toEqual(hidden);
  expect(reopened.save({ revision: 13, settings: previous })).toEqual({ revision: 14, settings: { ...previous, theme: 'dark', appIconTheme: null, displayCharacterPicture: false, showReasoningDuringGeneration: false } });
  expect(reopened.save({ revision: 14, settings: { characterSpeechColor: '#abcdef', personaSpeechColor: previous.personaSpeechColor } })).toEqual({ revision: 15, settings: { ...previous, theme: 'dark', appIconTheme: null, characterSpeechColor: '#abcdef', displayCharacterPicture: false, showReasoningDuringGeneration: false } });
});

it('preserves version-3 colors and revisions, then saves theme defaults and retains theme for older clients', () => {
  const file = join(directory(), 'settings.appearance.json');
  const previous = { characterSpeechColor: '#a8c9f0', personaSpeechColor: '#445566', chatTextScale: 110, displayCharacterPicture: false };
  const legacy = JSON.stringify({ version: 3, revision: 12, settings: previous });
  fs.writeFileSync(file, legacy);
  const settings = new AppearanceSettings(file);
  expect(settings.status()).toEqual({ revision: 12, settings: { ...previous, theme: 'dark', appIconTheme: null, showReasoningDuringGeneration: false } });
  expect(fs.readFileSync(file, 'utf8')).toBe(legacy);
  const light = settings.save({ revision: 12, settings: { ...previous, theme: 'light', characterSpeechColor: null, showReasoningDuringGeneration: false } });
  expect(new AppearanceSettings(file).status()).toEqual(light);
  expect(light.settings).toEqual({ ...previous, theme: 'light', appIconTheme: null, characterSpeechColor: null, showReasoningDuringGeneration: false });
  const next = settings.save({ revision: 13, settings: { ...previous, characterSpeechColor: '#112233' } });
  expect(next.settings).toEqual({ ...previous, theme: 'light', appIconTheme: null, characterSpeechColor: '#112233', showReasoningDuringGeneration: false });
  for (const theme of [null, 'system', '', 1]) {
    expect(() => settings.save({ revision: 14, settings: { ...next.settings, theme } })).toThrow();
    expect(settings.status()).toEqual(next);
  }
});

it.each(themeSchema.options)('renders %s before login without exposing saved appearance overrides, and keeps malformed settings recoverable', async theme => {
  const folder = directory();
  const database = join(folder, 'test.sqlite');
  const staticDirectory = join(folder, 'client');
  fs.mkdirSync(staticDirectory);
  fs.writeFileSync(join(staticDirectory, 'index.html'), '<!doctype html><html lang="en"><head></head><body></body></html>');
  const settings = new AppearanceSettings(`${database}.appearance.json`);
  settings.save({ revision: 0, settings: { ...defaultAppearance, theme, characterSpeechColor: '#123456' } });
  const instance = await createApp({ database, staticDirectory });
  try {
    for (const url of ['/', '/index.html']) {
      const response = await instance.app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).toContain(`<html lang="en" data-theme="${theme}">`);
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

it('upgrades version-4 preferences with reasoning hidden and preserves explicit visibility for older clients', () => {
  const file = join(directory(), 'settings.appearance.json');
  const { showReasoningDuringGeneration: omitted, appIconTheme, ...previous } = defaultAppearance;
  expect(omitted).toBe(false);
  expect(appIconTheme).toBeNull();
  const legacy = JSON.stringify({ version: 4, revision: 12, settings: { ...previous, theme: 'light', characterSpeechColor: '#123456' } });
  fs.writeFileSync(file, legacy);
  const settings = new AppearanceSettings(file);
  const loaded = settings.status();
  expect(loaded).toEqual({ revision: 12, settings: { ...defaultAppearance, theme: 'light', characterSpeechColor: '#123456' } });
  expect(fs.readFileSync(file, 'utf8')).toBe(legacy);
  const enabled = settings.save({ revision: 12, settings: { ...loaded.settings, showReasoningDuringGeneration: true } });
  expect(enabled.settings.showReasoningDuringGeneration).toBe(true);
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ version: 6, ...enabled });
  const reopened = new AppearanceSettings(file);
  expect(reopened.status()).toEqual(enabled);
  const olderSave = reopened.save({ revision: 13, settings: previous });
  expect(olderSave.settings.showReasoningDuringGeneration).toBe(true);
  for (const invalid of [null, 0, 1, 'false']) {
    expect(() => reopened.save({ revision: 14, settings: { ...olderSave.settings, showReasoningDuringGeneration: invalid } })).toThrow();
    expect(reopened.status()).toEqual(olderSave);
  }
  const disabled = reopened.save({ revision: 14, settings: { ...olderSave.settings, showReasoningDuringGeneration: false } });
  expect(new AppearanceSettings(file).status()).toEqual(disabled);
  expect(disabled.settings.showReasoningDuringGeneration).toBe(false);
});

it('pins the install artwork across theme changes, older-client saves and server restart', async () => {
  const folder = directory();
  const database = join(folder, 'test.sqlite');
  const appearanceFile = `${database}.appearance.json`;
  const staticDirectory = join(folder, 'client');
  fs.mkdirSync(staticDirectory);
  fs.copyFileSync(new URL('../index.html', import.meta.url), join(staticDirectory, 'index.html'));
  const previous = { theme: 'light', characterSpeechColor: '#123456', personaSpeechColor: null, chatTextScale: 110, displayCharacterPicture: false, showReasoningDuringGeneration: true };
  const legacy = JSON.stringify({ version: 5, revision: 6, settings: previous });
  fs.writeFileSync(appearanceFile, legacy);
  const appearance = new AppearanceSettings(appearanceFile);
  let instance = await createApp({ database, staticDirectory });
  try {
    expect(appearance.status()).toEqual({ revision: 6, settings: { ...previous, appIconTheme: null } });
    expect(fs.readFileSync(appearanceFile, 'utf8')).toBe(legacy);
    const pinned = appearance.save({ revision: 6, settings: { ...previous, appIconTheme: 'light' } });
    expect(pinned).toEqual({ revision: 7, settings: { ...previous, appIconTheme: 'light' } });
    for (const invalid of ['system', false, 1]) {
      expect(() => appearance.save({ revision: 7, settings: { ...previous, appIconTheme: invalid } })).toThrow();
      expect(appearance.status()).toEqual(pinned);
    }
    const changed = appearance.save({ revision: 7, settings: { ...previous, theme: 'porcelain' } });
    expect(changed).toEqual({ revision: 8, settings: { ...previous, theme: 'porcelain', appIconTheme: 'light' } });
    await instance.app.close();
    instance = await createApp({ database, staticDirectory });
    const html = await instance.app.inject({ method: 'GET', url: '/' });
    expect(html.statusCode).toBe(200);
    expect(html.body).toContain('data-theme="porcelain"');
    expect(html.body).toContain('href="/icons/favicon-porcelain-bold.svg?v=4"');
    expect(html.body).toContain('href="/site-light.webmanifest"');
    expect(html.body).toContain('href="/icons/app-light-bold-touch-180.png"');
    expect(new AppearanceSettings(appearanceFile).status()).toEqual(changed);
    appearance.save({ revision: 8, settings: { ...changed.settings, appIconTheme: null } });
    const following = await instance.app.inject({ method: 'GET', url: '/' });
    expect(following.statusCode).toBe(200);
    expect(following.body).toContain('href="/site-porcelain.webmanifest"');
  } finally { await instance.app.close(); }
});
