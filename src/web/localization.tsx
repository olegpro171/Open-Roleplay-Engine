import i18next from 'i18next';
import { initReactI18next, useTranslation } from 'react-i18next';
import { useEffect, useState, useSyncExternalStore, type Dispatch, type SetStateAction } from 'react';
import { api } from './api';
import { ApiError } from './api';
import { englishPack, languagePackSchema, languageStatusSchema, localizedMessageSchema, message, validateTranslations, type LanguagePack, type LanguageStatus, type LocalizedMessage, type MessageKey, type MessageParameters } from '../shared/localization';

export { message };
export type MessageText = string | LocalizedMessage | { issues: { path: string; localized: LocalizedMessage }[] };
export class LocalizedError extends Error {
  constructor(readonly localized: LocalizedMessage) { super(localized.fallback); }
}
export const i18n = i18next.createInstance();
void i18n.use(initReactI18next).init({
  lng: 'en', fallbackLng: 'en', resources: { en: { translation: englishPack.messages } },
  keySeparator: false, nsSeparator: false, returnNull: false, returnEmptyString: false,
  interpolation: { escapeValue: false, skipOnVariables: true }, react: { useSuspense: false },
  initAsync: false,
});

export function locale() { return i18n.language ?? 'en'; }
export function t(key: MessageKey, params?: MessageParameters): string {
  return i18n.t(key, { replace: params, ...(typeof params?.count === 'number' ? { count: params.count } : {}) });
}
export function formatMessage(value: MessageText | null | undefined): string {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if ('issues' in value) return value.issues.map(issue => t('validation.field', { field: issue.path, message: formatMessage(issue.localized) })).join('; ');
  return i18n.t(value.key, { replace: value.params, ...(typeof value.params?.count === 'number' ? { count: value.params.count } : {}), defaultValue: value.fallback });
}
export function errorText(error: unknown, fallback: MessageText = message('app.the_request_failed')): MessageText {
  if (error instanceof Error) {
    if (error instanceof ApiError && error.issues?.length) return { issues: error.issues };
    if ('localized' in error) {
      const parsed = localizedMessageSchema.safeParse(error.localized);
      if (parsed.success) return parsed.data;
    }
    return error.message;
  }
  return fallback;
}

/** Subscribe without tying effects or data requests to the selected language. */
export function useLocale() { useTranslation(undefined, { i18n }); }

export function useTextState(initial: string): [string, Dispatch<SetStateAction<MessageText | null>>];
export function useTextState(initial: string | null): [string | null, Dispatch<SetStateAction<MessageText | null>>];
export function useTextState(initial: string | null): [string | null, Dispatch<SetStateAction<MessageText | null>>] {
  useLocale();
  const [value, setValue] = useState<MessageText | null>(initial);
  return [value === null ? null : formatMessage(value), setValue];
}

const preferenceKey = 'ore-interface-language';
let preferred = '';
try { preferred = localStorage.getItem(preferenceKey) ?? ''; } catch { /* Selection still works without browser storage. */ }
let loaded: LanguageStatus | null = null;
let discovery = 0;
const languageListeners = new Set<() => void>();
export function useLanguages() {
  return useSyncExternalStore(listener => { languageListeners.add(listener); return () => { languageListeners.delete(listener); }; }, () => loaded);
}
export function publishLanguages(status: LanguageStatus) {
  discovery++;
  loaded = status;
  for (const listener of languageListeners) listener();
}
let selection = 0;
let activePack = englishPack;

async function read<T>(path: string, parse: (value: unknown) => T, body?: unknown): Promise<T> {
  if (body !== undefined) return parse(await api(`/localization${path}`, 'POST', body));
  const response = await fetch(`/api/localization${path}`, {
    credentials: 'same-origin', cache: 'no-store',
    ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new LocalizedError(message('language.unavailable'));
  return parse(await response.json());
}

function choose(status: LanguageStatus): string {
  const available = new Set(status.languages.map(item => item.locale));
  const preferences = preferred ? [preferred] : navigator.languages;
  for (const candidate of preferences) {
    if (available.has(candidate)) return candidate;
    const base = candidate.split('-')[0];
    if (available.has(base)) return base;
  }
  return 'en';
}

export async function selectLanguage(language: string, remember = true): Promise<boolean> {
  const request = ++selection;
  const pack = language === 'en' ? englishPack : await read(`/${encodeURIComponent(language)}`, value => languagePackSchema.parse(value));
  if (request !== selection) return true;
  if (pack.locale !== language) throw new Error(t('language.unavailable'));
  i18n.removeResourceBundle(language, 'translation');
  i18n.addResourceBundle(language, 'translation', validateTranslations(pack).messages);
  activePack = pack;
  await i18n.changeLanguage(language);
  if (request !== selection) return true;
  document.documentElement.lang = language;
  document.documentElement.dir = pack.direction;
  if (remember) {
    preferred = language;
    try { localStorage.setItem(preferenceKey, language); } catch { return false; }
  }
  return true;
}

export async function loadLanguages(reload = false): Promise<LanguageStatus> {
  const request = selection;
  const discoveryRequest = ++discovery;
  const status = await read(reload ? '/reload' : '', value => languageStatusSchema.parse(value), reload ? {} : undefined);
  if (discoveryRequest !== discovery) return loaded ?? status;
  loaded = status;
  for (const listener of languageListeners) listener();
  // An older discovery response must not supersede a user's explicit selection.
  if (request === selection) await selectLanguage(choose(status), false);
  return status;
}

export function currentPack(): LanguagePack { return activePack; }

export function LocalizationStartup() {
  useEffect(() => { void loadLanguages().catch(() => {
    if (loaded) publishLanguages({ ...loaded, issues: [{ file: 'languages', message: message('language.unavailable') }] });
  }); }, []);
  return null;
}
