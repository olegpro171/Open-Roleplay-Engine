import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Languages } from '../src/server/languages.js';
import { englishPack, extendTranslation, languagePackSchema, localeSchema, message, translationTemplate, validateTranslations } from '../src/shared/localization.js';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/persistence/store.js';
import { assembleRequest } from '../src/core/prompt.js';
import Database from 'better-sqlite3';

vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync), renameSync: vi.fn(actual.renameSync) };
});
const directories: string[] = [];
function directory() { const path = fs.mkdtempSync(join(tmpdir(), 'ore-languages-')); directories.push(path); return path; }
const russian = { formatVersion: 1, locale: 'ru', nativeName: 'Русский', direction: 'ltr', messages: { 'language.heading': 'Язык' } } as const;
afterEach(() => { vi.restoreAllMocks(); for (const path of directories.splice(0)) fs.rmSync(path, { recursive: true, force: true }); });

it('extends partial translations without changing existing values, metadata or unknown keys', () => {
  const source = { ...russian, messages: {
    ...russian.messages,
    'language.coverage': '{{translated}} из {{total}} переводов',
    'counts.turns_one': '{{count}} ход', 'counts.turns_few': '{{count}} хода',
    'counts.turns_many': '{{count}} ходов', 'counts.turns_other': '{{count}} хода',
    'future.feature': 'Сохранить',
  } };
  const before = structuredClone(source);
  const extended = extendTranslation(source);
  expect(extended).toMatchObject(source);
  expect(source).toEqual(before);
  expect(extended.messages['language.reload']).toBe(englishPack.messages['language.reload']);
  expect(extended.messages['counts.summaries_few']).toBe(englishPack.messages['counts.summaries_other']);
  expect(() => validateTranslations(languagePackSchema.parse(extended))).not.toThrow();
  expect(extendTranslation(extended)).toEqual(extended);
});

it('extends empty and right-to-left packs using their own locale and plural requirements', () => {
  for (const pack of [russian, { ...russian, locale: 'ar', nativeName: 'العربية', direction: 'rtl' as const }]) {
    const extended = extendTranslation({ ...pack, messages: {} });
    expect(extended).toMatchObject({ locale: pack.locale, nativeName: pack.nativeName, direction: pack.direction });
    for (const form of new Intl.PluralRules(pack.locale).resolvedOptions().pluralCategories) {
      expect(extended.messages[`counts.turns_${form}`]).toBeDefined();
    }
    expect(() => validateTranslations(languagePackSchema.parse(extended))).not.toThrow();
  }
});

it('discovers, installs and reloads partial packs without a build, retaining the last good pack on invalid edits', () => {
  const path = directory(), languages = new Languages(path);
  expect(languages.status().languages.map(item => item.locale)).toEqual(['en', 'ru']);
  expect(languages.get('ru').messages).toEqual({});
  const saved = languages.save(russian, null);
  expect(saved.languages.find(item => item.locale === 'ru')).toMatchObject({ translated: 1, custom: true });
  expect(fs.statSync(join(path, 'ru.json')).mode & 0o777).toBe(0o600);
  expect(new Languages(path).get('ru')).toEqual(russian);
  expect(() => languages.save(russian, null)).toThrow('another window');
  fs.writeFileSync(join(path, 'ru.json'), '{bad JSON');
  expect(languages.reload().issues).toHaveLength(1);
  expect(languages.get('ru')).toEqual(russian);
  const fresh = new Languages(path);
  expect(fresh.get('ru').messages).toEqual({});
  fs.writeFileSync(join(path, 'de.json'), JSON.stringify({ ...russian, locale: 'de', nativeName: 'Deutsch' }));
  languages.reload();
  expect(languages.get('de').nativeName).toBe('Deutsch');
  fs.unlinkSync(join(path, 'de.json')); languages.reload();
  expect(() => languages.get('de')).toThrow('unavailable');
});

it('rejects unsafe filenames, invalid tags, unsupported formats, interpolation mismatches and incomplete plural groups', () => {
  for (const value of ['../ru', 'en--US', 'en-123456789', 'a', 'en-US-u']) expect(localeSchema.safeParse(value).success).toBe(false);
  expect(localeSchema.parse('pt-br')).toBe('pt-BR');
  for (const messages of [
    { 'language.coverage': '{{translated}} translations' },
    { 'language.heading': '<img src=x>' },
    { 'language.heading': '$t(other.key)' },
    { 'language.heading': '{{- html}}' },
  ]) expect(() => validateTranslations(languagePackSchema.parse({ ...russian, messages }))).toThrow();
  expect(languagePackSchema.safeParse({ ...russian, formatVersion: 2 }).success).toBe(false);
  const languages = new Languages(directory());
  expect(() => languages.save({ ...russian, locale: 'en' }, null)).toThrow('fallback');
  const target = join(directory(), 'private.json'); fs.writeFileSync(target, JSON.stringify(russian));
  const path = directory(); fs.symlinkSync(target, join(path, 'ru.json'));
  const linked = new Languages(path);
  expect(linked.get('ru').messages).toEqual({}); expect(linked.status().issues).toHaveLength(1);
  // Unknown translation keys remain inert, allowing packs to survive application versions.
  expect(() => validateTranslations({ ...russian, messages: { 'future.feature': 'Later' } })).not.toThrow();
  expect(() => validateTranslations(translationTemplate())).not.toThrow();
  expect(() => validateTranslations({ ...russian, messages: { 'counts.turns_one': '{{count}} ход', 'counts.turns_other': '{{count}} ходов' } })).toThrow('plural form');
});

it('preserves committed packs and cleans up temporary files after write and rename failures', () => {
  const path = directory(), languages = new Languages(path);
  const saved = languages.save(russian, null), before = fs.readFileSync(join(path, 'ru.json'), 'utf8');
  const revision = saved.languages.find(item => item.locale === 'ru')?.revision;
  if (!revision) throw new Error('Missing pack revision');
  for (const operation of ['write', 'rename']) {
    if (operation === 'write') vi.mocked(fs.writeFileSync).mockImplementationOnce(() => { throw new Error('Disk full'); });
    else vi.mocked(fs.renameSync).mockImplementationOnce(() => { throw new Error('Rename failed'); });
    expect(() => languages.save({ ...russian, nativeName: 'Replacement' }, revision)).toThrow('previous file was retained');
    expect(fs.readFileSync(join(path, 'ru.json'), 'utf8')).toBe(before);
    expect(fs.readdirSync(path)).toEqual(['ru.json']);
    expect(languages.get('ru')).toEqual(russian);
  }
});

it('renders Russian plurals, English fallback and historical descriptors without treating parameters as runtime options', async () => {
  const { i18n, t, formatMessage } = await import('../src/web/localization.js');
  i18n.addResourceBundle('ru', 'translation', {
    'counts.turns_one': '{{count}} ход', 'counts.turns_few': '{{count}} хода', 'counts.turns_many': '{{count}} ходов', 'counts.turns_other': '{{count}} хода',
    'language.heading': 'Язык', 'language.confirmBody': 'Замена {{language}}',
  });
  try {
    await i18n.changeLanguage('ru');
    expect([1, 2, 5, 21].map(count => t('counts.turns', { count }))).toEqual(['1 ход', '2 хода', '5 ходов', '21 ход']);
    expect(t('language.reload')).toBe('Reload languages');
    expect(formatMessage(message('language.heading'))).toBe('Язык');
    expect(formatMessage({ key: 'retired.diagnostic', fallback: 'Original saved wording' })).toBe('Original saved wording');
    await i18n.changeLanguage('en');
    expect(t('language.confirmBody', { language: '{{user}} <img>', lng: 'ru' })).toContain('{{user}} <img>');
    expect(i18n.language).toBe('en');
  } finally { i18n.removeResourceBundle('ru', 'translation'); await i18n.changeLanguage('en'); }
});

it('allows safe pre-login language reads, requires authenticated same-origin imports and leaves content untouched', async () => {
  const path = directory(), instance = await createApp({ database: join(path, 'test.sqlite'), languagesDirectory: join(path, 'languages') });
  const headers = { host: 'localhost', origin: 'http://localhost' };
  try {
    expect((await instance.app.inject({ url: '/api/localization', headers })).statusCode).toBe(200);
    expect((await instance.app.inject({ url: '/api/localization/ru', headers })).json()).toEqual({ ...russian, messages: {} });
    expect((await instance.app.inject({ method: 'POST', url: '/api/localization/import', headers, payload: { pack: russian, expectedRevision: null } })).statusCode).toBe(401);
    const setup = await instance.app.inject({ method: 'POST', url: '/api/setup', headers, payload: { password: 'synthetic-localization-password' } });
    const cookie = setup.headers['set-cookie']?.toString().split(';')[0];
    if (!cookie) throw new Error('Missing owner session');
    const authenticated = { ...headers, cookie };
    const before = instance.store.snapshot();
    expect((await instance.app.inject({ method: 'POST', url: '/api/localization/import', headers: { ...authenticated, origin: 'http://foreign.example' }, payload: { pack: russian, expectedRevision: null } })).statusCode).toBe(403);
    expect((await instance.app.inject({ method: 'POST', url: '/api/localization/import', headers: authenticated, payload: { pack: russian, expectedRevision: null } })).statusCode).toBe(200);
    expect(instance.store.snapshot()).toEqual(before);
    const failure = await instance.app.inject({ method: 'POST', url: '/api/localization/import', headers: authenticated, payload: { pack: { ...russian, messages: { 'language.coverage': '{{secret}}' } }, expectedRevision: null } });
    expect(failure.json()).toMatchObject({ code: 'invalid_language', localized: message('language.invalid') });
    expect(failure.body).not.toContain('secret');
    expect(englishPack.messages['language.heading']).toBe('Language');
  } finally { await instance.app.close(); }
});

it('upgrades populated schema 14 without rewriting legacy errors or historical request bodies', () => {
  const path = join(directory(), 'upgrade.sqlite');
  let store = new Store(path);
  store.saveSettings(0, { name: 'Synthetic', endpoint: 'http://127.0.0.1:9999', model: 'synthetic', contextWindow: 10_000, maxOutputTokens: 500, customParameters: {} }, store.snapshot().settings, 'synthetic-private-key');
  const operation = store.begin(store.snapshot().revision, crypto.randomUUID(), 'Preserve this input');
  const snapshot = store.snapshot();
  if (!snapshot.connection) throw new Error('Missing synthetic Connection');
  const historical = assembleRequest(snapshot.connection, snapshot.settings, snapshot.turns, snapshot.sources, snapshot.context);
  store.saveRequest(operation.id, historical);
  store.finish(operation.id, 'failed', '', 'Legacy error stays literal');
  const before = store.snapshot(); store.close();
  const legacy = new Database(path); legacy.exec('ALTER TABLE generations DROP COLUMN error_message; PRAGMA user_version = 14'); legacy.close();
  store = new Store(path);
  try {
    const after = store.snapshot();
    expect(after.turns).toEqual(before.turns);
    expect(after.generations[0].error).toBe('Legacy error stays literal');
    expect(after.generations[0].errorMessage).toBeNull();
    expect(after.generations[0].request).toEqual(before.generations[0].request);
    expect(after.generations[0].request?.body.messages.at(-1)?.content).toBe('Preserve this input');
    expect(store.sqlite.pragma('user_version', { simple: true })).toBe(15);
  } finally { store.close(); }
});

it('retains structured generation outcomes across restart and rejects duplicate terminal writes', () => {
  const path = join(directory(), 'outcomes.sqlite');
  let store = new Store(path);
  store.saveSettings(0, { name: 'Synthetic', endpoint: 'http://127.0.0.1:9999', model: 'synthetic', contextWindow: 10_000, maxOutputTokens: 500, customParameters: {} }, store.snapshot().settings);
  const operation = store.begin(store.snapshot().revision, crypto.randomUUID(), 'Keep this pending turn.');
  const diagnostic = message('language.unavailable');
  expect(store.finish(operation.id, 'failed', '', diagnostic)).toBe(true);
  expect(store.finish(operation.id, 'failed', '', message('language.invalid'))).toBe(false);
  store.close(); store = new Store(path);
  try {
    expect(store.snapshot().generations[0]).toMatchObject({ error: diagnostic.fallback, errorMessage: diagnostic, status: 'failed' });
    expect(store.snapshot().turns.at(-1)?.user.text).toBe('Keep this pending turn.');
  } finally { store.close(); }
});
