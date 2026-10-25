import { z } from 'zod';
import { englishMessages } from './localization-en.js';
import { russianMessages } from './localization-ru.js';

type CatalogKey = keyof typeof englishMessages;
type PluralKey = { [K in CatalogKey]: K extends `${infer Base}_one` ? Base : never }[CatalogKey];
export type MessageKey = CatalogKey | PluralKey;
export const messageParametersSchema = z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/), z.union([z.string().max(100_000), z.number().finite()]));
export const localizedMessageSchema = z.object({
  key: z.string().min(1).max(200), fallback: z.string().max(200_000), params: messageParametersSchema.optional(),
}).strict();
export type LocalizedMessage = z.infer<typeof localizedMessageSchema>;
export type MessageParameters = z.infer<typeof messageParametersSchema>;
export class MessageError extends Error {
  constructor(readonly localized: LocalizedMessage) { super(localized.fallback); }
}
export function diagnosticMessage(localized: LocalizedMessage) { return { message: localized.fallback, localized }; }
export function blockedText(blockedMessage: LocalizedMessage) { return { blocked: blockedMessage.fallback, blockedMessage }; }
export function limitationText(limitationMessage: LocalizedMessage) { return { limitation: limitationMessage.fallback, limitationMessage }; }
export function promptLabel(labelMessage: LocalizedMessage) { return { label: labelMessage.fallback, labelMessage }; }
export function outcomeMessage(value: string | LocalizedMessage | null) {
  if (value === null || typeof value === 'string') return { error: value, errorMessage: undefined };
  return { error: value.fallback, errorMessage: value };
}

/** English is immutable diagnostic data; language selection belongs to presentation. */
export function message(key: MessageKey, params?: MessageParameters): LocalizedMessage {
  const catalog: Readonly<Record<string, string>> = englishMessages;
  const template = catalog[key] ?? catalog[`${key}_${params?.count === 1 ? 'one' : 'other'}`];
  if (!template) throw new Error(`Unknown application message: ${key}`);
  return { key, fallback: template.replace(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g, (token, name: string) => String(params?.[name] ?? token)), ...(params ? { params } : {}) };
}

export const languageLimits = { bytes: 2_000_000, entries: 10_000, packs: 100 } as const;
const translationKey = z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,199}$/).refine(key => !key.split('.').some(part => ['__proto__', 'constructor', 'prototype'].includes(part)));
export const localeSchema = z.string().min(2).max(60).regex(/^[a-zA-Z]{2,8}(?:-[a-zA-Z0-9]{1,8})*$/)
  .refine(value => { try { return Intl.getCanonicalLocales(value).length === 1; } catch { return false; } }, 'Use a valid language tag.')
  .transform(value => Intl.getCanonicalLocales(value)[0]);

export const languagePackSchema = z.object({
  formatVersion: z.literal(1), locale: localeSchema, nativeName: z.string().trim().min(1).max(80),
  direction: z.enum(['ltr', 'rtl']),
  messages: z.record(translationKey, z.string().max(30_000))
    .refine(value => Object.keys(value).length <= languageLimits.entries),
}).strict();
export type LanguagePack = z.infer<typeof languagePackSchema>;
export const englishPack: LanguagePack = { formatVersion: 1, locale: 'en', nativeName: 'English', direction: 'ltr', messages: englishMessages };
export const russianPack: LanguagePack = { formatVersion: 1, locale: 'ru', nativeName: 'Русский', direction: 'ltr', messages: russianMessages };
export function translationTemplate(locale = 'ru', nativeName = 'Русский', direction: LanguagePack['direction'] = 'ltr'): LanguagePack {
  const messages: Record<string, string> = { ...englishMessages };
  for (const key of Object.keys(englishMessages)) {
    if (!key.endsWith('_other')) continue;
    const base = key.slice(0, -6);
    if (!Object.hasOwn(messages, `${base}_one`)) continue;
    for (const category of new Intl.PluralRules(locale).resolvedOptions().pluralCategories) {
      messages[`${base}_${category}`] ??= messages[key];
    }
  }
  return { formatVersion: 1, locale, nativeName, direction, messages };
}
export function extendTranslation(pack: LanguagePack): LanguagePack {
  const template = translationTemplate(pack.locale, pack.nativeName, pack.direction);
  return { ...pack, messages: { ...template.messages, ...pack.messages } };
}
export const languageStatusSchema = z.object({
  languages: z.array(languagePackSchema.omit({ messages: true }).extend({
    translated: z.number().int().nonnegative(), total: z.number().int().nonnegative(), revision: z.string(), custom: z.boolean(),
    translationIssues: z.array(z.object({ key: z.string(), message: localizedMessageSchema })),
  })),
  issues: z.array(z.object({ file: z.string(), message: localizedMessageSchema })),
}).strict();
export type LanguageStatus = z.infer<typeof languageStatusSchema>;

export function placeholders(text: string): string[] {
  return [...new Set([...text.matchAll(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g)].map(match => match[1]))].sort();
}

/** Resolve active messages without modifying the retained translation file. Unknown keys stay inert. */
export function validateTranslations(pack: LanguagePack): { messages: Record<string, string>; issues: LanguageStatus['languages'][number]['translationIssues'] } {
  const messages: Record<string, string> = {};
  const issues = new Map<string, LocalizedMessage>();
  const groups = new Map<string, string[]>();
  const plural = new Intl.PluralRules(pack.locale).resolvedOptions().pluralCategories;
  for (const [key, value] of Object.entries(pack.messages)) {
    const base = key.replace(/_(zero|one|two|few|many|other)$/, '');
    const isPlural = base !== key && Object.hasOwn(englishPack.messages, `${base}_one`) && Object.hasOwn(englishPack.messages, `${base}_other`);
    const source = Object.hasOwn(englishPack.messages, key) ? englishPack.messages[key] : isPlural ? englishPack.messages[`${base}_other`] : undefined;
    if (source === undefined) continue; // Retain future/older keys without activating them.
    if (isPlural) {
      const keys = groups.get(base) ?? [];
      keys.push(key);
      groups.set(base, keys);
    }
    const stripped = value.replace(/\{\{[A-Za-z][A-Za-z0-9_]*\}\}/g, '');
    if (!value.trim()) issues.set(key, message('language.entryEmpty'));
    else if (stripped.includes('{{') || stripped.includes('}}') || value.includes('$t(') || /<\/?[A-Za-z!]/.test(value)) {
      issues.set(key, message('language.entrySyntax'));
    } else if (placeholders(source).join(',') !== placeholders(value).join(',')) {
      issues.set(key, message('language.entryPlaceholders', {
        expected: placeholders(source).map(name => `{{${name}}}`).join(', ') || '∅',
        actual: placeholders(value).map(name => `{{${name}}}`).join(', ') || '∅',
      }));
    } else messages[key] = value;
  }
  for (const [base, keys] of groups) {
    const missing = plural.map(category => `${base}_${category}`).filter(key => !Object.hasOwn(pack.messages, key));
    const invalid = keys.filter(key => issues.has(key));
    if (!missing.length && !invalid.length) continue;
    for (const key of keys) {
      delete messages[key];
      if (!issues.has(key)) issues.set(key, message('language.entryPluralGroup', { keys: [...missing, ...invalid].join(', ') }));
    }
  }
  return { messages, issues: [...issues].map(([key, problem]) => ({ key, message: problem })) };
}

/** Structural failures reject the whole file; never include uploaded text in diagnostics. */
export function languageFileProblem(error: unknown): LocalizedMessage {
  if (error instanceof SyntaxError) return message('language.invalidJson');
  if (error instanceof z.ZodError) {
    const issue = error.issues[0];
    if (issue) {
      const path = issue.path.map(String).join('.') || 'root';
      if (issue.path[0] === 'formatVersion') return message('language.invalidVersion');
      if (issue.code === 'invalid_type') return message('language.invalidType', { path, expected: issue.expected });
      return message('language.invalidField', { path });
    }
  }
  return message('language.invalid');
}
