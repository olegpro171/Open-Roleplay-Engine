import { z } from 'zod';
import { englishMessages } from './localization-en.js';

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
  messages: z.record(translationKey, z.string().min(1).max(30_000)).refine(value => Object.keys(value).length <= languageLimits.entries),
}).strict();
export type LanguagePack = z.infer<typeof languagePackSchema>;
export const englishPack: LanguagePack = { formatVersion: 1, locale: 'en', nativeName: 'English', direction: 'ltr', messages: englishMessages };
export const russianPack: LanguagePack = { formatVersion: 1, locale: 'ru', nativeName: 'Русский', direction: 'ltr', messages: {} };
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
export const languageStatusSchema = z.object({
  languages: z.array(languagePackSchema.omit({ messages: true }).extend({ translated: z.number().int().nonnegative(), total: z.number().int().nonnegative(), revision: z.string(), custom: z.boolean() })),
  issues: z.array(z.object({ file: z.string(), message: localizedMessageSchema })),
}).strict();
export type LanguageStatus = z.infer<typeof languageStatusSchema>;

export function placeholders(text: string): string[] {
  return [...new Set([...text.matchAll(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g)].map(match => match[1]))].sort();
}

/** Reject interpolation/nesting syntax we do not support, including HTML and resource references. */
export function validateTranslations(pack: LanguagePack): void {
  const plural = new Intl.PluralRules(pack.locale).resolvedOptions().pluralCategories;
  for (const [key, value] of Object.entries(pack.messages)) {
    const base = key.replace(/_(zero|one|two|few|many|other)$/, '');
    const source = englishPack.messages[key] ?? englishPack.messages[`${base}_other`] ?? englishPack.messages[`${base}_one`];
    if (source === undefined) continue; // Retain future/older keys without activating them.
    const stripped = value.replace(/\{\{[A-Za-z][A-Za-z0-9_]*\}\}/g, '');
    if (stripped.includes('{{') || stripped.includes('}}') || value.includes('$t(') || /<\/?[A-Za-z!]/.test(value)) throw new Error(`Unsupported translation syntax: ${key}`);
    if (placeholders(source).join(',') !== placeholders(value).join(',')) throw new Error(`Placeholder mismatch: ${key}`);
    if (englishPack.messages[`${base}_other`] !== undefined && englishPack.messages[`${base}_one`] !== undefined) {
      for (const category of plural) if (!pack.messages[`${base}_${category}`]) throw new Error(`Missing plural form: ${base}_${category}`);
    }
  }
}
