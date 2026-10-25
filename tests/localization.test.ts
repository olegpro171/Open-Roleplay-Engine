import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Languages } from '../src/server/languages.js';
import { englishPack, extendTranslation, languagePackSchema, localeSchema, message, translationTemplate, validateTranslations, languageFileProblem, languageStatusSchema } from '../src/shared/localization.js';
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

it('preserves incompatible entries across import, discovery, export and restart while counting only usable translations', () => {
  const key = 'repair_review.approved_unchanged_after_model_check_reused_without';
  const source = { ...russian, messages: {
    ...russian.messages,
    [key]: '{{value}} одобрено {{value2}} {{value3}}{{value4}}{{value5}}',
    'language.coverage': '{{translated}} переводов',
    'retired.label': 'Старый перевод',
  } };
  const before = structuredClone(source);
  const path = directory();
  fs.writeFileSync(join(path, 'ru.json'), JSON.stringify(source));
  const languages = new Languages(path);
  const expectPartial = (instance: Languages) => {
    expect(instance.status().issues).toEqual([]);
    expect(instance.status().languages.find(item => item.locale === 'ru')).toMatchObject({ translated: 1, custom: true, translationIssues: [
      { key, message: { key: 'language.entryPlaceholders', params: { expected: '{{value}}, {{value2}}, {{value3}}, {{value4}}', actual: '{{value}}, {{value2}}, {{value3}}, {{value4}}, {{value5}}' } } },
      { key: 'language.coverage', message: { key: 'language.entryPlaceholders', params: { expected: '{{total}}, {{translated}}', actual: '{{translated}}' } } },
    ] });
    expect(instance.get('ru')).toEqual(before);
    expect(validateTranslations(instance.get('ru')).messages).toEqual(russian.messages);
    expect(extendTranslation(instance.get('ru')).messages).toMatchObject(before.messages);
  };
  expectPartial(languages);
  expect(JSON.parse(fs.readFileSync(join(path, 'ru.json'), 'utf8'))).toEqual(before);
  const previousStatus = languages.status().languages;
  fs.writeFileSync(join(path, 'ru.json'), '{broken JSON');
  expect(languages.reload().languages).toEqual(previousStatus);
  expect(languages.status().issues).toMatchObject([{ file: 'ru.json', message: { key: 'language.invalidJson' } }]);
  const importPath = directory();
  const imported = new Languages(importPath);
  imported.save(source, null);
  expectPartial(imported);
  expectPartial(new Languages(importPath));
  expect(JSON.parse(fs.readFileSync(join(importPath, 'ru.json'), 'utf8'))).toEqual(before);
  expect(source).toEqual(before);
  const revision = imported.status().languages.find(item => item.locale === 'ru')?.revision;
  if (!revision) throw new Error('Missing pack revision');
  expect(() => imported.save({ ...source, formatVersion: 2 }, revision)).toThrow('format');
  expectPartial(imported);
  const fixed = { ...source, messages: { ...source.messages, [key]: englishPack.messages[key], 'language.coverage': englishPack.messages['language.coverage'] } };
  imported.save(fixed, revision);
  expect(imported.status().languages.find(item => item.locale === 'ru')).toMatchObject({ translated: 3, translationIssues: [] });
  expect(() => imported.save(source, revision)).toThrow('another window');
});

it('isolates empty and unsafe entries and disables whole plural groups without activating unknown keys', () => {
  const source = { ...russian, messages: {
    ...russian.messages,
    'language.select': '',
    'language.description': '<img src=x>',
    'language.template': '$t(language.heading)',
    'language.extend': '{{- html}}',
    'counts.turns_one': '{{count}} ход',
    'counts.turns_other': '{{count}} ходов',
    'counts.summaries_one': '{{count}} память',
    'counts.summaries_few': '{{wrong}} памяти',
    'counts.summaries_many': '{{count}} памятей',
    'counts.summaries_other': '{{count}} памяти',
    'future.feature': '$t(language.heading)',
    'toString': 'Unknown prototype name',
  } };
  const result = validateTranslations(languagePackSchema.parse(source));
  expect(result.messages).toEqual(russian.messages);
  expect(result.issues).toHaveLength(10);
  expect(result.issues.find(issue => issue.key === 'language.select')?.message.key).toBe('language.entryEmpty');
  expect(result.issues.find(issue => issue.key === 'counts.turns_one')?.message).toEqual(message('language.entryPluralGroup', { keys: 'counts.turns_few, counts.turns_many' }));
  expect(result.issues.find(issue => issue.key === 'counts.summaries_one')?.message).toEqual(message('language.entryPluralGroup', { keys: 'counts.summaries_few' }));
  expect(result.issues.some(issue => issue.key === 'future.feature')).toBe(false);
  expect(source.messages['language.select']).toBe('');
});

it('explains structural file failures without including uploaded values', () => {
  expect(languageFileProblem(new SyntaxError('private uploaded text'))).toEqual(message('language.invalidJson'));
  for (const [pack, key] of [
    [{ ...russian, formatVersion: 2 }, 'language.invalidVersion'],
    [{ ...russian, messages: { 'language.heading': 42 } }, 'language.invalidType'],
    [{ ...russian, locale: '../bad' }, 'language.invalidField'],
  ] as const) {
    const result = languagePackSchema.safeParse(pack);
    if (result.success) throw new Error('Expected structural rejection');
    expect(languageFileProblem(result.error).key).toBe(key);
  }
});

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
  expect(validateTranslations(languagePackSchema.parse(extended)).issues).toEqual([]);
  expect(extendTranslation(extended)).toEqual(extended);
});

it('extends empty and right-to-left packs using their own locale and plural requirements', () => {
  for (const pack of [russian, { ...russian, locale: 'ar', nativeName: 'العربية', direction: 'rtl' as const }]) {
    const extended = extendTranslation({ ...pack, messages: {} });
    expect(extended).toMatchObject({ locale: pack.locale, nativeName: pack.nativeName, direction: pack.direction });
    for (const form of new Intl.PluralRules(pack.locale).resolvedOptions().pluralCategories) {
      expect(extended.messages[`counts.turns_${form}`]).toBeDefined();
    }
    expect(validateTranslations(languagePackSchema.parse(extended)).issues).toEqual([]);
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

it('rejects unsafe filenames, invalid tags and unsupported formats while reporting incompatible entries', () => {
  for (const value of ['../ru', 'en--US', 'en-123456789', 'a', 'en-US-u']) expect(localeSchema.safeParse(value).success).toBe(false);
  expect(localeSchema.parse('pt-br')).toBe('pt-BR');
  for (const messages of [
    { 'language.coverage': '{{translated}} translations' },
    { 'language.heading': '<img src=x>' },
    { 'language.heading': '$t(other.key)' },
    { 'language.heading': '{{- html}}' },
  ]) expect(validateTranslations(languagePackSchema.parse({ ...russian, messages })).issues).toHaveLength(1);
  expect(languagePackSchema.safeParse({ ...russian, formatVersion: 2 }).success).toBe(false);
  const languages = new Languages(directory());
  expect(() => languages.save({ ...russian, locale: 'en' }, null)).toThrow('fallback');
  const target = join(directory(), 'private.json'); fs.writeFileSync(target, JSON.stringify(russian));
  const path = directory(); fs.symlinkSync(target, join(path, 'ru.json'));
  const linked = new Languages(path);
  expect(linked.get('ru').messages).toEqual({}); expect(linked.status().issues).toHaveLength(1);
  // Unknown translation keys remain inert, allowing packs to survive application versions.
  expect(validateTranslations({ ...russian, messages: { 'future.feature': 'Later' } })).toEqual({ messages: {}, issues: [] });
  expect(validateTranslations(translationTemplate()).issues).toEqual([]);
  expect(validateTranslations({ ...russian, messages: { 'counts.turns_one': '{{count}} ход', 'counts.turns_other': '{{count}} ходов' } }).messages).toEqual({});
});

it('preserves committed packs and cleans up temporary files after write and rename failures', () => {
  const path = directory(), languages = new Languages(path);
  const original = { ...russian, messages: { ...russian.messages, 'language.coverage': '{{unexpected}}' } };
  const saved = languages.save(original, null), before = fs.readFileSync(join(path, 'ru.json'), 'utf8');
  const revision = saved.languages.find(item => item.locale === 'ru')?.revision;
  if (!revision) throw new Error('Missing pack revision');
  for (const operation of ['write', 'rename']) {
    if (operation === 'write') vi.mocked(fs.writeFileSync).mockImplementationOnce(() => { throw new Error('Disk full'); });
    else vi.mocked(fs.renameSync).mockImplementationOnce(() => { throw new Error('Rename failed'); });
    expect(() => languages.save({ ...original, nativeName: 'Replacement' }, revision)).toThrow('previous file was retained');
    expect(fs.readFileSync(join(path, 'ru.json'), 'utf8')).toBe(before);
    expect(fs.readdirSync(path)).toEqual(['ru.json']);
    expect(languages.get('ru')).toEqual(original);
    expect(languages.status()).toEqual(saved);
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
    expect(t('language.template')).toBe('Download translation template');
    expect(formatMessage(message('language.heading'))).toBe('Язык');
    expect(formatMessage({ key: 'retired.diagnostic', fallback: 'Original saved wording' })).toBe('Original saved wording');
    await i18n.changeLanguage('en');
    expect(t('language.confirmBody', { language: '{{user}} <img>', lng: 'ru' })).toContain('{{user}} <img>');
    expect(i18n.language).toBe('en');
  } finally { i18n.removeResourceBundle('ru', 'translation'); await i18n.changeLanguage('en'); }
});

it('activates only compatible messages while retaining the raw current pack for export', async () => {
  const { currentPack, selectLanguage, t, formatMessage } = await import('../src/web/localization.js');
  const source = { ...russian, messages: {
    ...russian.messages, 'language.template': '{{unexpected}}',
    'counts.turns_one': '{{count}} ход', 'counts.turns_other': '{{count}} ходов',
    'retired.diagnostic': 'Must stay inert',
  } };
  const originalFetch = globalThis.fetch;
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  globalThis.fetch = vi.fn(async () => Response.json(source));
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: {} } });
  try {
    await selectLanguage('ru', false);
    expect(t('language.heading')).toBe('Язык');
    expect(t('language.template')).toBe('Download translation template');
    expect([1, 2, 5].map(count => t('counts.turns', { count }))).toEqual(['1 turn', '2 turns', '5 turns']);
    expect(formatMessage({ key: 'retired.diagnostic', fallback: 'Retained historical wording' })).toBe('Retained historical wording');
    expect(currentPack()).toEqual(source);
  } finally {
    await selectLanguage('en', false);
    globalThis.fetch = originalFetch;
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  }
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
    const status = await instance.app.inject({ url: '/api/localization', headers: authenticated });
    const revision = languageStatusSchema.parse(status.json()).languages.find(item => item.locale === 'ru')?.revision;
    const partial = await instance.app.inject({ method: 'POST', url: '/api/localization/import', headers: authenticated, payload: { pack: { ...russian, messages: { ...russian.messages, 'language.coverage': '{{unexpected}}' } }, expectedRevision: revision } });
    expect(partial.statusCode).toBe(200);
    expect(partial.json()).toMatchObject({ languages: expect.arrayContaining([expect.objectContaining({ locale: 'ru', translated: 1, translationIssues: [expect.objectContaining({ key: 'language.coverage' })] })]) });
    expect(instance.store.snapshot()).toEqual(before);
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
