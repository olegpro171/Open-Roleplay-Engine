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
    const settings = { characterSpeechColor: '#EEAA88', personaSpeechColor: '#88cc99' };
    const saved = await instance.app.inject({ method: 'PUT', url: '/api/application/appearance', headers: auth, payload: { revision: 0, settings } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ revision: 1, settings: { characterSpeechColor: '#eeaa88', personaSpeechColor: '#88cc99' } });
    expect(instance.store.snapshot()).toEqual(before);
    expect(instance.store.libraries()).toEqual(libraryBefore);
    const stale = await instance.app.inject({ method: 'PUT', url: '/api/application/appearance', headers: auth, payload: { revision: 0, settings: defaultAppearance } });
    expect(stale.statusCode).toBe(409);
    for (const characterSpeechColor of [null, '#abc', '#fffffff', 'red', 'url(example.com)']) {
      expect((await instance.app.inject({ method: 'PUT', url: '/api/application/appearance', headers: auth, payload: { revision: 1, settings: { ...defaultAppearance, characterSpeechColor } } })).statusCode).toBe(400);
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
  const next = { revision: 1, settings: { characterSpeechColor: '#112233', personaSpeechColor: '#445566' } };
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
