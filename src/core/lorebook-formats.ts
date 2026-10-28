import { MessageError } from '../shared/localization.js';
import { message } from '../shared/localization.js';
import { diagnosticMessage } from '../shared/localization.js';
import { z } from 'zod';
import {
  LOREBOOK_ENTRY_LIMIT, LOREBOOK_FILE_LIMIT, lorebookSchema, newLoreEntry,
  type Lorebook, type LoreDiagnostic, type LoreEntry, type LoreImportPreview,
} from '../shared/lorebook.js';

type Format = LoreImportPreview['format'];
type JsonObject = Record<string, unknown>;

const objectSchema = z.record(z.string(), z.unknown());
const keysSchema = z.array(z.string().max(2000)).max(64);
const externalIdSchema = z.union([z.string().max(2000), z.number().finite()]);
const depthSchema = z.number().int().min(0).max(1000);
const entryFields = {
  keys: keysSchema, content: z.string().max(100_000), extensions: objectSchema.default({}),
  enabled: z.boolean(), insertion_order: z.number().finite(), case_sensitive: z.boolean().optional(),
  name: z.string().max(200).optional(), priority: z.number().finite().optional(),
  id: externalIdSchema.optional(), comment: z.string().max(100_000).optional(),
  selective: z.boolean().optional(), secondary_keys: keysSchema.optional(), constant: z.boolean().optional(),
  position: z.enum(['before_char', 'after_char']).optional(), use_regex: z.boolean().optional(),
};
const v2EntrySchema = z.object(entryFields).passthrough();
const v3EntrySchema = v2EntrySchema.extend({ extensions: objectSchema, use_regex: z.boolean() });
const bookFields = {
  name: z.string().max(100).optional(), description: z.string().max(100_000).optional(),
  scan_depth: depthSchema.optional(), token_budget: z.number().int().min(0).max(1_000_000).optional(),
  recursive_scanning: z.boolean().optional(), extensions: objectSchema.default({}),
};
const v2BookSchema = z.object({ ...bookFields, entries: z.array(v2EntrySchema).max(LOREBOOK_ENTRY_LIMIT) }).passthrough();
const v3BookSchema = z.object({ ...bookFields, extensions: objectSchema, entries: z.array(v3EntrySchema).max(LOREBOOK_ENTRY_LIMIT) }).passthrough();

const worldEntrySchema = z.object({
  content: z.string().max(100_000), key: keysSchema.optional(), keysecondary: keysSchema.optional(),
  uid: externalIdSchema.optional(), id: externalIdSchema.optional(), name: z.string().max(200).optional(),
  comment: z.string().max(100_000).optional(), constant: z.boolean().optional(),
  selective: z.boolean().optional(), disable: z.boolean().optional(), order: z.number().finite().optional(),
  priority: z.number().finite().optional(), position: z.number().int().min(0).max(1000).optional(),
  caseSensitive: z.boolean().nullable().optional(), scanDepth: depthSchema.nullable().optional(),
  depth: depthSchema.optional(), role: z.union([z.enum(['system', 'user', 'assistant']), z.number().int().min(0).max(2)]).nullable().optional(),
  use_regex: z.boolean().optional(), useRegex: z.boolean().optional(),
  selectiveLogic: z.number().int().min(0).max(3).optional(),
  probability: z.number().min(0).max(100).optional(), useProbability: z.boolean().optional(),
  group: z.string().max(100_000).optional(), groupOverride: z.boolean().optional(),
  groupWeight: z.number().finite().optional(), useGroupScoring: z.boolean().nullable().optional(),
  sticky: depthSchema.optional(), cooldown: depthSchema.optional(), delay: depthSchema.optional(),
  vectorized: z.boolean().optional(), matchWholeWords: z.boolean().nullable().optional(),
  excludeRecursion: z.boolean().optional(), preventRecursion: z.boolean().optional(),
  delayUntilRecursion: z.union([z.boolean(), depthSchema]).optional(),
  extensions: objectSchema.optional(),
}).passthrough();

function object(value: unknown, message = 'Expected a lorebook JSON object.'): JsonObject {
  const result = objectSchema.safeParse(value);
  if (!result.success) throw new Error(message);
  return result.data;
}

function copyJson(value: unknown): JsonObject {
  const source = object(value);
  const pending: { value: unknown; depth: number }[] = [{ value: source, depth: 0 }];
  const seen = new WeakSet<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    if (current.depth > 100) throw new MessageError(message("importErrors.lorebook_metadata_exceeds_the_maximum_nesting_depth_of"));
    const item = current.value;
    if (item === null || typeof item === 'string' || typeof item === 'boolean') continue;
    if (typeof item === 'number' && Number.isFinite(item)) continue;
    if (typeof item !== 'object') throw new MessageError(message("importErrors.lorebooks_must_contain_only_valid_json_values"));
    if (seen.has(item)) continue;
    seen.add(item);
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
      throw new MessageError(message("importErrors.lorebooks_must_contain_only_plain_json_objects"));
    }
    for (const child of Object.values(item)) pending.push({ value: child, depth: current.depth + 1 });
  }
  let serialized: string;
  try { serialized = JSON.stringify(source); }
  catch { throw new MessageError(message("importErrors.lorebooks_must_contain_valid_non_circular_json")); }
  if (new TextEncoder().encode(serialized).byteLength > LOREBOOK_FILE_LIMIT) throw new MessageError(message("importErrors.lorebook_files_must_be_at_most_5_mb"));
  return object(JSON.parse(serialized));
}

function present(source: JsonObject, field: string) { return Object.hasOwn(source, field); }
function label(value: string | undefined, fallback: string, max: number) { return value?.trim() ? value.trim().slice(0, max) : fallback; }
function entryName(raw: JsonObject, keys: string[], index: number) {
  for (const value of [raw.name, raw.comment, keys[0]]) if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 200);
  return `Entry ${index + 1}`;
}

type Controls = Pick<LoreEntry, 'role' | 'depth' | 'scanDepth' | 'placement'>;
function simpleControls(content: string): Partial<Controls> {
  const lines = content.split(/\r?\n/);
  const directives = new Map<string, string[]>();
  for (let index = 0; index < lines.length; index++) {
    const match = /^(@{2,})([a-z_]+)(?:\s+(.*))?$/.exec(lines[index].trim());
    if (!match) continue;
    const values = directives.get(match[2]) ?? [];
    values.push(match[1] !== '@@' || lines[index + 1]?.trim().startsWith('@@@') ? '' : (match[3] ?? ''));
    directives.set(match[2], values);
  }
  const single = (name: string) => { const values = directives.get(name); return values?.length === 1 ? values[0] : undefined; };
  const result: Partial<Controls> = {};
  const role = single('role');
  if (role === 'system' || role === 'user' || role === 'assistant') result.role = role;
  for (const [directive, field] of [['depth', 'depth'], ['scan_depth', 'scanDepth']] as const) {
    const value = single(directive);
    if (value !== undefined && /^\d+$/.test(value) && depthSchema.safeParse(Number(value)).success) {
      result[field] = Number(value);
      if (field === 'depth') result.placement = 'history';
    }
  }
  const placement = single('position');
  if (placement === 'before_desc' || placement === 'after_desc' || placement === 'personality' || placement === 'scenario') result.placement = placement;
  return result;
}

function standardBook(raw: JsonObject, format: 'v2' | 'v3', createId: () => string): Lorebook {
  const data = (format === 'v3' ? v3BookSchema : v2BookSchema).parse(raw);
  return {
    name: label(data.name, 'Imported lorebook', 100), description: data.description ?? '',
    scanDepth: data.scan_depth ?? 4, tokenBudget: data.token_budget ?? 2048, recursiveScanning: data.recursive_scanning ?? false,
    entries: data.entries.map((entry, index) => ({
      ...newLoreEntry(createId()), name: entryName(entry, entry.keys, index), comment: entry.comment ?? '',
      keys: entry.keys, secondaryKeys: entry.secondary_keys ?? [], content: entry.content, enabled: entry.enabled,
      constant: entry.constant ?? false, selective: entry.selective ?? false, useRegex: entry.use_regex ?? false,
      caseSensitive: entry.case_sensitive ?? false, insertionOrder: entry.insertion_order, priority: entry.priority ?? 0,
      placement: entry.position ?? 'after_char', ...simpleControls(entry.content),
      ...(entry.id === undefined ? {} : { externalId: entry.id }), source: { raw: object(rawEntries(raw)[index]) },
    })),
  };
}

function rawEntries(raw: JsonObject): unknown[] {
  if (!Array.isArray(raw.entries)) throw new MessageError(message("importErrors.lorebook_entries_must_be_an_array"));
  return raw.entries;
}

function consistentAlias(raw: JsonObject, first: string, second: string) {
  if (present(raw, first) && present(raw, second) && raw[first] !== raw[second]) throw new MessageError(message("importErrors.conflicting_lorebook_fields_and", { first: String(first), second: String(second) }));
  return raw[first] ?? raw[second];
}

function worldBook(raw: JsonObject, createId: () => string): Lorebook {
  const settings = v2BookSchema.omit({ entries: true }).parse(raw);
  const entryPairs: [string | undefined, unknown][] = Array.isArray(raw.entries)
    ? raw.entries.map(entry => [undefined, entry])
    : Object.entries(object(raw.entries, 'World Info entries must be an object map or a legacy entry array.'));
  if (entryPairs.length > LOREBOOK_ENTRY_LIMIT) throw new MessageError(message("importErrors.lorebooks_may_contain_at_most_2000_entries"));
  return {
    name: label(settings.name, 'Imported lorebook', 100), description: settings.description ?? '',
    scanDepth: settings.scan_depth ?? 4, tokenBudget: settings.token_budget ?? 2048, recursiveScanning: settings.recursive_scanning ?? false,
    entries: entryPairs.map(([mapKey, value], index) => {
      const source = object(value), data = worldEntrySchema.parse(value);
      const useRegex = consistentAlias(source, 'use_regex', 'useRegex');
      const externalId = consistentAlias(source, 'uid', 'id');
      let role: LoreEntry['role'] = null;
      if (data.role === 0 || data.role === 'system') role = 'system';
      if (data.role === 1 || data.role === 'user') role = 'user';
      if (data.role === 2 || data.role === 'assistant') role = 'assistant';
      return {
        ...newLoreEntry(createId()), name: entryName(source, data.key ?? [], index), comment: data.comment ?? '',
        keys: data.key ?? [], secondaryKeys: data.keysecondary ?? [], content: data.content, enabled: !data.disable,
        constant: data.constant ?? false, selective: data.selective ?? false, useRegex: useRegex === true,
        caseSensitive: data.caseSensitive ?? false, insertionOrder: data.order ?? 0, priority: data.priority ?? 0,
        placement: data.position === 0 ? 'before_char' : data.position === 4 ? 'history' : 'after_char',
        role, depth: data.depth ?? 0, scanDepth: data.scanDepth ?? null, ...simpleControls(data.content),
        ...(externalId === undefined ? {} : { externalId: externalIdSchema.parse(externalId) }),
        source: { raw: source, ...(mapKey === undefined ? {} : { mapKey }) },
      };
    }),
  };
}

/** Parse without mutations or I/O. External identities never become local entry identities. */
export function importLorebook(value: unknown, createId: () => string, embeddedFormat?: 'v2' | 'v3'): LoreImportPreview {
  const raw = copyJson(value);
  let data = raw;
  let format: Format;
  if (present(raw, 'spec')) {
    if (raw.spec !== 'lorebook_v3') throw new MessageError(message("importErrors.unsupported_lorebook_specification_expected_lorebook_v3"));
    if (present(raw, 'entries')) throw new MessageError(message("importErrors.ambiguous_lorebook_both_envelope_and_root_entries_are"));
    if (embeddedFormat === 'v2') throw new MessageError(message("importErrors.a_v3_envelope_cannot_be_imported_as_an"));
    data = object(raw.data, 'The V3 lorebook envelope requires a data object.');
    format = 'v3';
  } else if (embeddedFormat) {
    format = embeddedFormat;
  } else if (Array.isArray(raw.entries)) {
    const styles = new Set(raw.entries.map(value => {
      const entry = object(value, 'Every lorebook entry must be an object.');
      const standard = present(entry, 'keys') || present(entry, 'insertion_order') || present(entry, 'enabled');
      const legacy = present(entry, 'key') || present(entry, 'uid') || present(entry, 'disable') || present(entry, 'order');
      if (standard && legacy) throw new MessageError(message("importErrors.ambiguous_entry_mixes_standard_and_world_info_field"));
      return standard ? 'v2' : legacy ? 'world_info' : 'unknown';
    }));
    if (styles.has('v2') && styles.has('world_info')) throw new MessageError(message("importErrors.ambiguous_lorebook_mixes_standard_and_world_info_entries"));
    if (styles.has('world_info') && styles.has('unknown')) throw new MessageError(message("importErrors.legacy_world_info_array_entries_must_identify_their"));
    format = styles.has('world_info') ? 'world_info' : 'v2';
  } else {
    object(raw.entries, 'Lorebook entries must be an array or a World Info object map.');
    format = 'world_info';
  }
  if (present(raw, 'data') && objectSchema.safeParse(raw.data).success && present(object(raw.data), 'entries') && !present(raw, 'spec')) {
    throw new MessageError(message("importErrors.ambiguous_lorebook_contains_both_nested_and_root_book"));
  }
  const parsed = format === 'world_info' ? worldBook(data, createId) : standardBook(data, format, createId);
  const book = lorebookSchema.parse({ ...parsed, source: { raw, format } });
  return { format, book, diagnostics: loreCompatibility(book) };
}

export function importCharacterLorebook(value: unknown, characterName: string, createId: () => string, format: 'v2' | 'v3'): LoreImportPreview {
  const preview = importLorebook(value, createId, format);
  // Reserve the suffix within the book-name limit; keep original metadata intact.
  const name = message('defaults.character_lorebook', { name: characterName.slice(0, 89) }).fallback;
  return { ...preview, book: { ...preview.book, name } };
}

const bookKnownFields = new Set([...Object.keys(bookFields), 'entries']);
const standardKnownFields = new Set(Object.keys(entryFields));
const worldSupportedFields = new Set(['content', 'key', 'keysecondary', 'uid', 'id', 'name', 'comment', 'constant', 'selective', 'selectiveLogic', 'disable', 'order', 'priority', 'position', 'caseSensitive', 'scanDepth', 'depth', 'role', 'use_regex', 'useRegex', 'extensions']);
const recognizedDecorators = new Set(['activate_only_after', 'activate_only_every', 'keep_activate_after_match', 'dont_activate_after_match', 'depth', 'role', 'scan_depth', 'position', 'ignore_on_max_context', 'additional_keys', 'exclude_keys', 'dont_activate', 'activate']);

function bookRaw(book: Lorebook) {
  const source = book.source?.raw ?? {};
  return source.spec === 'lorebook_v3' ? object(source.data) : source;
}

/** Notices describe preserved inactive metadata; they never execute extension behavior. */
export function loreCompatibility(book: Lorebook): LoreDiagnostic[] {
  const diagnostics: LoreDiagnostic[] = [];
  let omitted = 0;
  const add = (diagnostic: LoreDiagnostic) => { if (diagnostics.length < 200) diagnostics.push(diagnostic); else omitted++; };
  const extras = (raw: JsonObject, fields: Set<string>, entryId?: string) => {
    for (const field of Object.keys(raw)) if (!fields.has(field)) add({ code: 'unsupported_field', field, entryId, ...diagnosticMessage(message("interface.is_preserved_for_export_and_has_no_activation", { field: String(field) })) });
    if (raw.extensions !== undefined) {
      const extensions = objectSchema.safeParse(raw.extensions);
      if (!extensions.success) add({ code: 'invalid_preserved_metadata', field: 'extensions', entryId, ...diagnosticMessage(message("interface.preserved_extension_metadata_is_malformed_it_stays_inactive")) });
      else for (const field of Object.keys(extensions.data)) add({ code: 'unsupported_extension', field: `extensions.${field}`, entryId, ...diagnosticMessage(message("interface.extension_is_preserved_inactive", { field: String(field) })) });
    }
  };
  const source = book.source?.raw ?? {};
  const rawBook = objectSchema.safeParse(source.spec === 'lorebook_v3' ? source.data : source);
  if (!rawBook.success) add({ code: 'invalid_preserved_metadata', field: 'data', ...diagnosticMessage(message("interface.preserved_lorebook_envelope_data_is_malformed_it_stays")) });
  else extras(rawBook.data, bookKnownFields);
  if (book.source?.raw.spec === 'lorebook_v3') {
    for (const field of Object.keys(book.source.raw)) if (field !== 'spec' && field !== 'data') add({ code: 'preserved_envelope', field, ...diagnosticMessage(message("interface.envelope_field_is_preserved_and_does_not_affect", { field: String(field) })) });
  }
  for (const entry of book.entries) {
    const raw = entry.source?.raw ?? {};
    extras(raw, book.source?.format === 'world_info' ? worldSupportedFields : standardKnownFields, entry.id);
    if (book.source?.format === 'world_info') {
      if (raw.selectiveLogic !== undefined && raw.selectiveLogic !== 0) add({ code: 'unsupported_selective_logic', entryId: entry.id, field: 'selectiveLogic', ...diagnosticMessage(message("interface.this_world_info_selective_logic_is_preserved_inactive")) });
      if (typeof raw.position === 'number' && ![0, 1, 4].includes(raw.position)) add({ code: 'unsupported_position', entryId: entry.id, field: 'position', ...diagnosticMessage(message("interface.this_world_info_position_is_preserved_inactive_the")) });
      if (!entry.useRegex && entry.keys.some(key => /^\/.*\/[a-z]*$/s.test(key))) add({ code: 'literal_regex_text', entryId: entry.id, field: 'key', ...diagnosticMessage(message("interface.regex_like_keys_remain_literal_because_this_entry")) });
    }
    for (const line of entry.content.split(/\r?\n/)) {
      const directive = /^\s*@{2,}([^\s]*)(?:\s|$)/.exec(line)?.[1];
      if (directive !== undefined && !recognizedDecorators.has(directive)) add({ code: 'unsupported_decorator', entryId: entry.id, field: 'content', ...diagnosticMessage(message("interface.decorator_is_preserved_inactive_and_removed_from_inserted", { value: String(directive || '(empty)') })) });
    }
  }
  if (omitted > 0) diagnostics.push({ code: 'more_compatibility_notices', ...diagnosticMessage(message("interface.additional_compatibility_notices_are_omitted_from_this_bounded", { omitted: String(omitted) })) });
  return diagnostics;
}

function same(left: unknown, right: unknown) { return JSON.stringify(left) === JSON.stringify(right); }
function changedFields(previous: JsonObject, next: JsonObject, supported: readonly string[]) { return supported.filter(field => !same(previous[field], next[field])); }

/** Retain explicit edits even if a later save restores the imported default value. */
export function markLoreEdits(previous: Lorebook, next: Lorebook): Lorebook {
  const bookFields = ['name', 'description', 'scanDepth', 'tokenBudget', 'recursiveScanning'];
  const entryFields = ['name', 'comment', 'keys', 'secondaryKeys', 'content', 'enabled', 'constant', 'selective', 'useRegex', 'caseSensitive', 'insertionOrder', 'priority', 'placement', 'role', 'depth', 'scanDepth'];
  const oldEntries = new Map(previous.entries.map(entry => [entry.id, entry]));
  const entries = next.entries.map(entry => {
    const old = oldEntries.get(entry.id);
    const changed = old ? changedFields(old, entry, entryFields) : !entry.source ? changedFields(newLoreEntry(entry.id), entry, entryFields) : [];
    const edited = [...new Set([...(old?.source?.edited ?? []), ...(entry.source?.edited ?? []), ...changed])];
    const updated = old?.source ? { ...entry, source: { ...old.source, edited } } : entry;
    const controls = new Set((['role', 'depth', 'scanDepth', 'placement'] as const).filter(field => changed.includes(field)));
    if (controls.size === 0) return updated;
    const content = exportedContent(updated, false, previous.source?.format === 'world_info', controls);
    if (content === updated.content) return updated;
    if (updated.source) return { ...updated, content, source: { ...updated.source, edited: [...new Set([...edited, 'content'])] } };
    return { ...updated, content };
  });
  if (!previous.source) return lorebookSchema.parse({ ...next, entries });
  const edited = [...new Set([...(previous.source.edited ?? []), ...(next.source?.edited ?? []), ...changedFields(previous, next, bookFields)])];
  return lorebookSchema.parse({ ...next, entries, source: { ...previous.source, edited } });
}

function optional(raw: JsonObject, output: JsonObject, external: string, field: string, value: unknown, fallback: unknown, edited: string[] = [], fresh = false) {
  if (!fresh && !edited.includes(field) && !edited.includes(external) && raw[external] === null && same(value, fallback)) return;
  if (fresh || present(raw, external) || edited.includes(field) || edited.includes(external) || !same(value, fallback)) output[external] = value;
}

function optionalName(raw: JsonObject, output: JsonObject, name: string, baseline: string, edited: string[], fresh: boolean) {
  const inferredEntryName = /^Entry [1-9]\d*$/.test(name) && /^Entry [1-9]\d*$/.test(baseline);
  if (fresh || edited.includes('name') || (name !== baseline && !inferredEntryName)) output.name = name;
  else if (present(raw, 'name')) output.name = raw.name;
}

function sourceKeys(raw: JsonObject) {
  const values = Array.isArray(raw.keys) ? raw.keys : Array.isArray(raw.key) ? raw.key : [];
  return values.filter((value): value is string => typeof value === 'string');
}

function removeControl(content: string, directive: string) {
  let removeFallbacks = false;
  return content.split(/\r?\n/).filter(line => {
    const match = /^\s*(@{2,})([a-z_]+)(?:\s|$)/.exec(line);
    if (!match) { removeFallbacks = false; return true; }
    if (match[1] === '@@') removeFallbacks = match[2] === directive;
    return match[2] !== directive && !(match[1].length > 2 && removeFallbacks);
  }).join('\n');
}

function exportedContent(entry: LoreEntry, encodeRawControls = false, worldRawControls = false, forced?: Set<keyof Controls>): string {
  const original = entry.source?.raw;
  const importedControls = typeof original?.content === 'string' ? simpleControls(original.content) : {};
  const edited = entry.source?.edited ?? [];
  // Saves materialize control changes into content. Later content edits remain authoritative.
  if (!forced && edited.includes('content')) return entry.content;
  const write = (field: keyof Controls, fallback: unknown) => {
    if (forced) return forced.has(field);
    if (!original) return !same(entry[field], field === 'placement' ? 'after_char' : field === 'depth' ? 0 : null);
    return edited.includes(field) || !same(entry[field], importedControls[field] ?? fallback);
  };
  let content = entry.content;
  const controls: string[] = [];
  const rawRole = !worldRawControls ? null : original?.role === 0 ? 'system' : original?.role === 1 ? 'user' : original?.role === 2 ? 'assistant' : original?.role ?? null;
  if (write('role', encodeRawControls ? null : rawRole)) {
    content = removeControl(content, 'role');
    if (entry.role) controls.push(`@@role ${entry.role}`);
  }
  if (write('scanDepth', !worldRawControls || encodeRawControls ? null : original?.scanDepth ?? null)) {
    content = removeControl(content, 'scan_depth');
    if (entry.scanDepth !== null) controls.push(`@@scan_depth ${entry.scanDepth}`);
  }
  const rawPosition = original?.position;
  const fallbackPlacement = rawPosition === 'before_char' || (worldRawControls && !encodeRawControls && rawPosition === 0) ? 'before_char' : worldRawControls && !encodeRawControls && rawPosition === 4 ? 'history' : 'after_char';
  if (write('placement', fallbackPlacement)) {
    content = removeControl(removeControl(content, 'position'), 'depth');
    if (entry.placement === 'history') controls.push(`@@depth ${entry.depth}`);
    else if (entry.placement !== 'before_char' && entry.placement !== 'after_char') controls.push(`@@position ${entry.placement}`);
  } else if (entry.placement === 'history' && write('depth', typeof original?.depth === 'number' ? original.depth : 0)) {
    content = removeControl(content, 'depth');
    controls.push(`@@depth ${entry.depth}`);
  }
  return controls.length > 0 ? `${controls.join('\n')}\n${content}` : content;
}

function standardEntry(entry: LoreEntry, index: number, format: 'v2' | 'v3', importedFormat?: Format): JsonObject {
  const raw = entry.source?.raw ?? {}, edited = entry.source?.edited ?? [];
  const output: JsonObject = { ...raw };
  const fresh = !entry.source || importedFormat === 'world_info';
  if (importedFormat === 'world_info') {
    for (const field of ['key', 'keysecondary', 'uid', 'disable', 'order', 'caseSensitive', 'scanDepth', 'depth', 'role', 'useRegex']) delete output[field];
  }
  output.keys = entry.keys;
  output.content = exportedContent(entry, importedFormat === 'world_info', importedFormat === 'world_info');
  output.enabled = entry.enabled;
  output.insertion_order = entry.insertionOrder;
  output.extensions = raw.extensions ?? {};
  optionalName(raw, output, entry.name, entryName(raw, sourceKeys(raw), index), edited, fresh);
  const fields: [string, string, unknown, unknown][] = [
    ['comment', 'comment', entry.comment, ''],
    ['secondary_keys', 'secondaryKeys', entry.secondaryKeys, []], ['constant', 'constant', entry.constant, false],
    ['selective', 'selective', entry.selective, false], ['case_sensitive', 'caseSensitive', entry.caseSensitive, false],
    ['priority', 'priority', entry.priority, 0],
  ];
  for (const [external, field, value, fallback] of fields) optional(raw, output, external, field, value, fallback, edited, fresh);
  if (format === 'v3' || entry.useRegex || present(raw, 'use_regex') || edited.includes('useRegex')) output.use_regex = entry.useRegex;
  if (entry.externalId !== undefined) output.id = entry.externalId;
  if (entry.placement === 'before_char' || entry.placement === 'after_char') optional(raw, output, 'position', 'placement', entry.placement, 'after_char', edited, fresh);
  else if (present(output, 'position') && output.position !== 'before_char' && output.position !== 'after_char') delete output.position;
  return output;
}

function worldEntry(entry: LoreEntry, index: number, importedFormat?: Format): JsonObject {
  const raw = entry.source?.raw ?? {}, edited = entry.source?.edited ?? [];
  const output: JsonObject = { ...raw, key: entry.keys, content: exportedContent(entry, false, importedFormat === 'world_info') };
  const fresh = !entry.source || importedFormat !== 'world_info';
  const contentControls = typeof raw.content === 'string' ? simpleControls(raw.content) : {};
  if (importedFormat && importedFormat !== 'world_info') {
    for (const field of ['keys', 'secondary_keys', 'enabled', 'insertion_order', 'case_sensitive']) delete output[field];
  }
  optionalName(raw, output, entry.name, entryName(raw, sourceKeys(raw), index), edited, fresh);
  const fields: [string, string, unknown, unknown][] = [
    ['comment', 'comment', entry.comment, ''],
    ['keysecondary', 'secondaryKeys', entry.secondaryKeys, []], ['constant', 'constant', entry.constant, false],
    ['selective', 'selective', entry.selective, false], ['disable', 'enabled', !entry.enabled, false],
    ['order', 'insertionOrder', entry.insertionOrder, 0], ['priority', 'priority', entry.priority, 0],
    ['caseSensitive', 'caseSensitive', entry.caseSensitive, false], ['scanDepth', 'scanDepth', entry.scanDepth, null],
    ['depth', 'depth', entry.depth, 0],
  ];
  for (const [external, field, value, fallback] of fields) {
    if (!fresh && (field === 'depth' || field === 'scanDepth') && contentControls[field] === value && !edited.includes(field)) continue;
    optional(raw, output, external, field, value, fallback, edited, fresh);
  }
  if (entry.externalId !== undefined) {
    output.uid = entry.externalId;
    if (present(raw, 'id')) output.id = entry.externalId;
  }
  const regexFields = ['use_regex', 'useRegex'].filter(field => present(raw, field));
  for (const field of regexFields.length > 0 ? regexFields : ['useRegex']) optional(raw, output, field, 'useRegex', entry.useRegex, false, edited, fresh);
  const rawPlacement = raw.position === 0 ? 'before_char' : raw.position === 4 ? 'history' : 'after_char';
  if (fresh || edited.includes('placement') || (entry.placement !== rawPlacement && contentControls.placement !== entry.placement)) output.position = entry.placement === 'before_char' ? 0 : entry.placement === 'history' ? 4 : 1;
  if (fresh || edited.includes('role') || (present(raw, 'role') && contentControls.role !== entry.role)) {
    output.role = typeof raw.role === 'number' ? entry.role === 'user' ? 1 : entry.role === 'assistant' ? 2 : 0 : entry.role;
  }
  return output;
}

/** Overlay supported edits onto preserved metadata. New standalone books use the V3 envelope. */
export function exportLorebook(input: Lorebook, format: Format = input.source?.format ?? 'v3'): JsonObject {
  const book = lorebookSchema.parse(input), raw = bookRaw(book), edited = book.source?.edited ?? [];
  const output: JsonObject = { ...raw };
  const fresh = !book.source;
  optionalName(raw, output, book.name, label(typeof raw.name === 'string' ? raw.name : undefined, 'Imported lorebook', 100), edited, fresh);
  optional(raw, output, 'description', 'description', book.description, '', edited, fresh);
  optional(raw, output, 'scan_depth', 'scanDepth', book.scanDepth, 4, edited, fresh);
  optional(raw, output, 'token_budget', 'tokenBudget', book.tokenBudget, 2048, edited, fresh);
  optional(raw, output, 'recursive_scanning', 'recursiveScanning', book.recursiveScanning, false, edited, fresh);
  if (format !== 'world_info' || present(raw, 'extensions')) output.extensions = raw.extensions ?? {};
  if (format === 'world_info') {
    const entries = book.entries.map((entry, index) => worldEntry(entry, index, book.source?.format));
    if (book.source?.format === 'world_info' && Array.isArray(raw.entries)) output.entries = entries;
    else {
      const pairs: [string, unknown][] = [];
      const used = new Set<string>();
      for (const [index, entry] of book.entries.entries()) {
        const preferred = entry.source?.mapKey ?? String(entry.externalId ?? index);
        let key = preferred;
        for (let suffix = 1; used.has(key); suffix++) key = `${preferred}_${suffix}`;
        used.add(key);
        pairs.push([key, entries[index]]);
      }
      output.entries = Object.fromEntries(pairs);
    }
    return output;
  }
  output.entries = book.entries.map((entry, index) => standardEntry(entry, index, format, book.source?.format));
  if (format === 'v2') return output;
  const envelope = book.source?.raw.spec === 'lorebook_v3' ? book.source.raw : {};
  return { ...envelope, spec: 'lorebook_v3', data: output };
}
