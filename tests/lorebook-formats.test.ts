import { describe, expect, it } from 'vitest';
import fixtures from './fixtures/lorebooks.json';
import { exportLorebook, importLorebook, loreCompatibility, markLoreEdits } from '../src/core/lorebook-formats.js';
import { newLorebook, newLoreEntry, type Lorebook } from '../src/shared/lorebook.js';

function ids() { let next = 0; return () => `local-${++next}`; }
function imported(value: unknown, format?: 'v2' | 'v3') { return importLorebook(value, ids(), format); }
function data(value: Record<string, unknown>): Record<string, unknown> {
  const result = value.data;
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Expected exported envelope data.');
  return Object.fromEntries(Object.entries(result));
}
function entries(value: Record<string, unknown>): Record<string, unknown>[] {
  if (!Array.isArray(value.entries)) throw new Error('Expected exported entry array.');
  return value.entries.map(entry => Object.fromEntries(Object.entries(entry)));
}
function first(book: Lorebook) {
  const entry = book.entries[0];
  if (!entry) throw new Error('Expected a fixture entry.');
  return entry;
}

describe('lorebook format import and roundtrip', () => {
  it.each([
    ['v2', fixtures.v2], ['v3', fixtures.v3], ['world_info', fixtures.worldInfo],
  ] as const)('preserves complete %s fixture metadata and external identities', (format, source) => {
    const result = imported(source);
    expect(result.format).toBe(format);
    expect(result.book.source).toEqual({ raw: source, format });
    expect(result.book.entries.every(entry => entry.id.startsWith('local-'))).toBe(true);
    expect(exportLorebook(result.book)).toEqual(source);
    const reimported = imported(exportLorebook(result.book));
    expect(reimported.book.entries.map(entry => entry.externalId)).toEqual(result.book.entries.map(entry => entry.externalId));
    expect(reimported.book.entries.map(entry => entry.content)).toEqual(result.book.entries.map(entry => entry.content));
  });

  it('imports embedded standard V2 and V3 books and preserves raw embedded provenance', () => {
    const v2 = imported(fixtures.v2, 'v2');
    expect(v2.book.entries[0]).toMatchObject({ externalId: 41, name: 'The tower', selective: true, secondaryKeys: ['key'], useRegex: false });
    const v3 = imported(fixtures.v3.data, 'v3');
    expect(first(v3.book)).toMatchObject({ externalId: 'external-entry-id', useRegex: true, role: 'user', placement: 'history', depth: 1 });
    expect(v3.book.source?.raw).toEqual(fixtures.v3.data);
    expect(data(exportLorebook(v3.book))).toEqual(fixtures.v3.data);
  });

  it('gives every explicit import fresh local identities even for repeated external ids', () => {
    const createId = ids();
    const source = { ...fixtures.v2, entries: [fixtures.v2.entries[0], fixtures.v2.entries[0]] };
    const one = importLorebook(source, createId), two = importLorebook(source, createId);
    expect(one.book.entries.map(entry => entry.id)).toEqual(['local-1', 'local-2']);
    expect(two.book.entries.map(entry => entry.id)).toEqual(['local-3', 'local-4']);
    expect(one.book.entries.map(entry => entry.externalId)).toEqual([41, 41]);
    expect(() => importLorebook(source, () => 'same')).toThrow('Entry identities must be unique');
  });

  it('preserves absent optional defaults and supplies required V2 extension objects', () => {
    const source = { entries: [
      { keys: [], content: 'One', enabled: true, insertion_order: 0 },
      { keys: [], content: 'Two', enabled: true, insertion_order: 1 },
    ] };
    const result = imported(source);
    expect(result.book).toMatchObject({ name: 'Imported lorebook', description: '', scanDepth: 4, tokenBudget: 2048, recursiveScanning: false });
    expect(result.book.entries.map(entry => entry.name)).toEqual(['Entry 1', 'Entry 2']);
    expect(exportLorebook(result.book)).toEqual({ ...source, extensions: {}, entries: source.entries.map(entry => ({ ...entry, extensions: {} })) });
    const reordered = markLoreEdits(result.book, { ...result.book, entries: [...result.book.entries].reverse() });
    expect(entries(exportLorebook(reordered)).every(entry => !Object.hasOwn(entry, 'name'))).toBe(true);
  });

  it('preserves empty/whitespace optional names while using readable local labels', () => {
    const source = { name: '  ', extensions: {}, entries: [{ ...fixtures.v2.entries[0], name: '' }] };
    const result = imported(source);
    expect(result.book.name).toBe('Imported lorebook');
    expect(first(result.book).name).toBe('Human-only fixture comment');
    expect(exportLorebook(result.book)).toEqual(source);
  });

  it('keeps metadata isolated from subsequent caller mutations', () => {
    const source = structuredClone(fixtures.v2);
    const result = imported(source);
    source.extensions.foreign_book_setting.keep = false;
    source.entries[0].keys.push('changed');
    source.entries[0].extensions.foreign_entry_setting.push(9);
    expect(exportLorebook(result.book)).toEqual(fixtures.v2);
  });

  it('keeps unknown World Info-looking standard fields inactive without changing CRLF content', () => {
    const source = { ...fixtures.v2, entries: [{ ...fixtures.v2.entries[0], content: 'Line one\r\nLine two', role: 'user', scanDepth: 4 }] };
    const result = imported(source);
    expect(first(result.book)).toMatchObject({ role: null, scanDepth: null });
    expect(exportLorebook(result.book)).toEqual(source);
  });

  it('accepts an explicitly empty book and exports new books in the V3 standalone envelope', () => {
    const empty = imported(fixtures.emptyV3);
    expect(empty.book.entries).toEqual([]);
    expect(exportLorebook(empty.book)).toEqual(fixtures.emptyV3);
    const local = { ...newLorebook(), entries: [{ ...newLoreEntry('new-local'), name: 'New', keys: ['tower'], content: 'The tower.' }] };
    const output = exportLorebook(local);
    expect(output).toMatchObject({ spec: 'lorebook_v3', data: { name: 'New lorebook', scan_depth: 4, token_budget: 2048, recursive_scanning: false, extensions: {}, entries: [{ use_regex: false, position: 'after_char' }] } });
    const restored = imported(output).book;
    expect(first(restored)).toMatchObject({ name: 'New', keys: ['tower'], content: 'The tower.', placement: 'after_char' });
    expect(first(restored).externalId).toBeUndefined();
  });

  it.each(['v2', 'v3', 'world_info'] as const)('converts a supported book to %s without losing unknown data', format => {
    const source = imported(fixtures.v2).book;
    const converted = imported(exportLorebook(source, format));
    expect(first(converted.book)).toMatchObject({ name: 'The tower', keys: ['башня', 'tower'], secondaryKeys: ['key'], enabled: true, selective: true, insertionOrder: 20, priority: 3, externalId: 41 });
    expect(converted.book.source?.raw).toMatchObject(format === 'v3' ? { data: { unknown_top_level: 'preserve' } } : { unknown_top_level: 'preserve' });
  });

  it.each(['v2', 'v3'] as const)('converts World Info to %s with compatible standard fields and inactive extras', format => {
    const source = imported(fixtures.worldInfo).book;
    const output = exportLorebook(source, format);
    const restored = imported(output);
    expect(first(restored.book)).toMatchObject({ keys: ['harbor'], secondaryKeys: ['fog'], placement: 'before_char', externalId: 17 });
    expect(first(restored.book).source?.raw).toMatchObject({ probability: 50, foreign_field: { keep: 'unchanged' } });
  });
});

describe('edited lorebook export', () => {
  it('overlays all supported standard edits while retaining external ids and unknown metadata', () => {
    const before = imported(fixtures.v2).book;
    const next = markLoreEdits(before, { ...before, name: 'Edited archive', scanDepth: 0, tokenBudget: 500, recursiveScanning: true,
      entries: [{ ...first(before), name: 'Edited entry', keys: ['new key'], secondaryKeys: ['secondary'], content: 'Edited prose', enabled: false,
        useRegex: true, caseSensitive: true, insertionOrder: -3, priority: 7, placement: 'before_char' }],
    });
    const output = exportLorebook(next);
    expect(output).toMatchObject({ name: 'Edited archive', scan_depth: 0, token_budget: 500, recursive_scanning: true, unknown_top_level: 'preserve',
      entries: [{ id: 41, name: 'Edited entry', keys: ['new key'], secondary_keys: ['secondary'], content: 'Edited prose', enabled: false,
        use_regex: true, case_sensitive: true, insertion_order: -3, priority: 7, position: 'before_char', extensions: fixtures.v2.entries[0].extensions }],
    });
    expect(first(imported(output).book)).toMatchObject({ name: 'Edited entry', enabled: false, useRegex: true, priority: 7 });
    expect(first(before).source?.raw).toEqual(fixtures.v2.entries[0]);
  });

  it('remembers explicitly edited optional fields even after restoring their default', () => {
    const before = imported({ entries: [{ keys: [], content: 'Prose', enabled: true, insertion_order: 0 }] }).book;
    const edited = markLoreEdits(before, { ...before, scanDepth: 2, entries: [{ ...first(before), caseSensitive: true }] });
    const restored = markLoreEdits(edited, { ...edited, scanDepth: 4, entries: [{ ...first(edited), caseSensitive: false }] });
    expect(exportLorebook(restored)).toMatchObject({ scan_depth: 4, entries: [{ case_sensitive: false }] });
    expect(restored.source?.edited).toContain('scanDepth');
    expect(first(restored).source?.edited).toContain('caseSensitive');
    expect(exportLorebook(before)).not.toHaveProperty('scan_depth');
    expect(entries(exportLorebook(before))[0]).not.toHaveProperty('case_sensitive');
  });

  it('keeps source metadata authoritative when an editor omits or replaces source', () => {
    const before = imported(fixtures.v2).book;
    const next: Lorebook = { ...before, source: undefined, name: 'Edited', entries: [{ ...first(before), source: { raw: { injected: 'no' } }, content: 'New content' }] };
    const marked = markLoreEdits(before, next);
    expect(marked.source?.raw).toEqual(fixtures.v2);
    expect(first(marked).source?.raw).toEqual(fixtures.v2.entries[0]);
    expect(exportLorebook(marked)).toMatchObject({ entries: [{ content: 'New content', extensions: fixtures.v2.entries[0].extensions }] });
  });

  it.each(['v2', 'v3', 'world_info'] as const)('keeps local identities and activation revisions out of %s exports', format => {
    const book = imported(fixtures.v2).book;
    const output = exportLorebook({ ...book, entries: [{ ...first(book), activationRevision: 73 }] }, format);
    expect(JSON.stringify(output)).not.toContain('activationRevision');
    expect(JSON.stringify(output)).not.toContain(first(book).id);
    expect(JSON.stringify(output)).toContain('41');
  });

  it('exports roles, history depth, scan overrides and field-relative placement as standard decorators', () => {
    const original = imported(fixtures.v3).book;
    const changed = markLoreEdits(original, { ...original, entries: [{ ...first(original), role: 'assistant', depth: 3, scanDepth: 2 }, original.entries[1]] });
    expect(first(changed).content).toContain('@@role assistant');
    expect(first(changed).content).not.toContain('@@role user');
    const output = exportLorebook(changed);
    const text = entries(data(output))[0].content;
    expect(text).toContain('@@role assistant');
    expect(text).toContain('@@depth 3');
    expect(text).toContain('@@scan_depth 2');
    expect(text).not.toContain('@@role user');
    expect(first(imported(output).book)).toMatchObject({ role: 'assistant', placement: 'history', depth: 3, scanDepth: 2 });
    const field = markLoreEdits(changed, { ...changed, entries: [{ ...first(changed), role: null, placement: 'scenario' }] });
    expect(first(imported(exportLorebook(field)).book)).toMatchObject({ role: null, placement: 'scenario', scanDepth: 2 });
    expect(entries(data(exportLorebook(field)))[0].content).not.toContain('@@depth');
  });

  it('materializes control changes for activation while preserving later explicit content edits', () => {
    const original = imported(fixtures.v3).book;
    const changed = markLoreEdits(original, { ...original, entries: [{ ...first(original), role: 'assistant' }] });
    const manualContent = '@@foreign x\n@@@role system\nThe edited prose';
    const edited = markLoreEdits(changed, { ...changed, entries: [{ ...first(changed), content: manualContent }] });
    expect(first(edited).content).toBe(manualContent);
    expect(entries(data(exportLorebook(edited)))[0].content).toBe(manualContent);
    const clear = markLoreEdits(edited, { ...edited, entries: [{ ...first(edited), role: null }] });
    expect(first(clear).content).not.toContain('role');
    expect(entries(data(exportLorebook(clear)))[0].content).not.toContain('role');
  });

  it('keeps authored decorators in a new book and applies subsequent local control changes', () => {
    const original = { ...newLorebook(), entries: [{ ...newLoreEntry('one'), content: '@@role user\n@@position scenario\nLocal prose' }] };
    expect(entries(data(exportLorebook(original)))[0].content).toBe(first(original).content);
    const changed = markLoreEdits(original, { ...original, entries: [{ ...first(original), role: 'assistant', placement: 'history', depth: 2 }] });
    expect(first(changed).content).toBe('@@role assistant\n@@depth 2\nLocal prose');
    expect(first(imported(exportLorebook(changed)).book)).toMatchObject({ role: 'assistant', placement: 'history', depth: 2 });
  });

  it('preserves fallback/duplicate decorator source until a relevant control changes', () => {
    const content = '@@foreign x\n@@@role assistant\n@@role user\n@@role system\nProse';
    const source = { ...fixtures.v2, entries: [{ ...fixtures.v2.entries[0], content }] };
    const before = imported(source).book;
    expect(first(before).role).toBeNull();
    expect(entries(exportLorebook(before))[0].content).toBe(content);
    const edited = markLoreEdits(before, { ...before, entries: [{ ...first(before), role: 'assistant' }] });
    expect(entries(exportLorebook(edited))[0].content).toBe('@@role assistant\n@@foreign x\nProse');
    const fallback = imported({ ...source, entries: [{ ...source.entries[0], content: '@@foreign x\n@@@role assistant\n@@role user\nProse' }] });
    expect(first(fallback.book).role).toBeNull();
  });

  it('preserves World Info map keys, source order, unsupported settings and external ids after edits', () => {
    const before = imported(fixtures.worldInfo).book;
    const after = markLoreEdits(before, { ...before, entries: [{ ...first(before), content: 'Changed', enabled: false }] });
    expect(exportLorebook(after)).toEqual({ ...fixtures.worldInfo, entries: { '17': { ...fixtures.worldInfo.entries['17'], content: 'Changed', disable: true } } });
    expect(first(imported(exportLorebook(after)).book).source?.mapKey).toBe('17');
    const duplicate = { ...first(before), id: 'duplicate-local', content: 'Independent copy' };
    const output = exportLorebook({ ...before, entries: [first(before), duplicate, { ...newLoreEntry('new'), content: 'New' }] });
    const map = output.entries;
    expect(map).toMatchObject({ '17': { content: fixtures.worldInfo.entries['17'].content }, '17_1': { content: 'Independent copy' }, '2': { content: 'New' } });
    expect(imported(output).book.entries).toHaveLength(3);
  });
});

describe('meaningful compatibility notices', () => {
  function standardEntry(extra: Record<string, unknown> = {}) {
    return { keys: ['harbor'], content: 'Synthetic prose.', enabled: true, insertion_order: 25, extensions: {},
      priority: 30, selective: false, secondary_keys: [], position: 'after_char', ...extra };
  }

  it('omits default and redundant metadata across repeated standard entries without changing exports', () => {
    const source = { extensions: {}, recursive_scanning: false, entries: Array.from({ length: 6 }, (_, index) => standardEntry({
      probability: 100, selectiveLogic: 0,
      extensions: { depth: 4, linked: false, weight: 30, addMemo: true, embedded: true,
        probability: 100, displayIndex: index, selectiveLogic: 0, useProbability: true,
        characterFilter: null, excludeRecursion: true },
    })) };
    const result = imported(source);
    expect(result.diagnostics).toEqual([]);
    expect(exportLorebook(result.book)).toEqual(source);
    expect(loreCompatibility(result.book)).toEqual([]);
  });

  it('omits inactive World Info defaults but retains unknown fields even when false', () => {
    const source = { recursive_scanning: false, entries: { a: { key: ['harbor'], content: 'Prose',
      probability: 100, useProbability: true, selectiveLogic: 0, sticky: 0, cooldown: 0,
      delay: 0, group: '', vectorized: false, matchWholeWords: false, excludeRecursion: true,
      preventRecursion: false, delayUntilRecursion: false, foreign_field: false } } };
    const result = imported(source);
    expect(result.diagnostics.map(item => item.field)).toEqual(['foreign_field']);
    expect(exportLorebook(result.book)).toEqual(source);
  });

  it.each([false, true])('reports nondefault probability only when enabled (extensions: %s)', extension => {
    const raw = { probability: 35, useProbability: false };
    const source = { extensions: {}, entries: [standardEntry(extension ? { extensions: raw } : raw)] };
    const result = imported(source);
    expect(result.diagnostics).toEqual([]);
    const active = imported({ entries: [standardEntry(extension
      ? { extensions: { ...raw, useProbability: true } } : { ...raw, useProbability: true })] });
    expect(active.diagnostics.some(item => item.field === (extension ? 'extensions.probability' : 'probability'))).toBe(true);
    expect(exportLorebook(result.book)).toEqual(source);
  });

  it('rechecks dependent controls after supported settings change', () => {
    const result = imported({ entries: [standardEntry({ selectiveLogic: 2,
      extensions: { excludeRecursion: true, depth: 4, weight: 30 } })] });
    expect(result.diagnostics).toEqual([]);
    const changed = { ...result.book, recursiveScanning: true,
      entries: [{ ...first(result.book), selective: true, secondaryKeys: ['fog'], priority: 40, placement: 'history' as const }] };
    expect(loreCompatibility(changed).map(item => item.field)).toEqual([
      'selectiveLogic', 'extensions.excludeRecursion', 'extensions.depth', 'extensions.weight',
    ]);
  });

  it.each(['v2', 'v3', 'world_info'] as const)('retains meaningful unsupported controls in %s', format => {
    const settings = { probability: 45, useProbability: true, selectiveLogic: 2,
      sticky: 2, cooldown: 3, delay: 1, vectorized: true, matchWholeWords: true,
      group: 'weather', excludeRecursion: true, preventRecursion: true, delayUntilRecursion: 2 };
    const entry = format === 'world_info'
      ? { key: ['harbor'], keysecondary: ['fog'], selective: true, content: 'Prose', ...settings }
      : standardEntry({ selective: true, secondary_keys: ['fog'], use_regex: false, ...settings });
    const raw = { recursive_scanning: true, extensions: {}, entries: format === 'world_info' ? { a: entry } : [entry] };
    const source = format === 'v3' ? { spec: 'lorebook_v3', data: raw } : raw;
    const result = imported(source);
    for (const field of Object.keys(settings)) {
      expect(result.diagnostics.some(item => item.field === field), field).toBe(true);
    }
    expect(exportLorebook(result.book)).toEqual(source);
  });

  it('keeps malformed known values and unknown extensions visible', () => {
    const result = imported({ entries: [standardEntry({ probability: '100',
      extensions: { displayIndex: '0', embedded: 'true', depth: '4', characterFilter: {}, mystery: null } })] });
    expect(result.diagnostics.map(item => item.field)).toEqual([
      'probability', 'extensions.displayIndex', 'extensions.embedded', 'extensions.depth',
      'extensions.characterFilter', 'extensions.mystery',
    ]);
  });
});

describe('World Info compatibility', () => {
  it('maps the supported subset and diagnoses unsupported activation settings without executing them', () => {
    const result = imported(fixtures.worldInfo);
    expect(first(result.book)).toMatchObject({ externalId: 17, keys: ['harbor'], secondaryKeys: ['fog'], name: 'The harbor', selective: true, enabled: true, insertionOrder: 100, placement: 'before_char' });
    for (const field of ['probability', 'useProbability', 'group', 'sticky', 'cooldown', 'foreign_field']) expect(result.diagnostics.some(diagnostic => diagnostic.field === field)).toBe(true);
    expect(loreCompatibility(result.book)).toEqual(result.diagnostics);
  });

  it('accepts only unambiguous legacy arrays and preserves their array shape', () => {
    const source = { entries: [{ uid: 'foreign', key: ['tower'], content: 'Legacy content', disable: false, order: 7 }] };
    const result = imported(source);
    expect(result.format).toBe('world_info');
    expect(exportLorebook(result.book)).toEqual(source);
    expect(first(result.book)).toMatchObject({ externalId: 'foreign', insertionOrder: 7, enabled: true });
  });

  it('keeps regex punctuation literal unless an explicit typed setting enables regex', () => {
    const source = { entries: { a: { key: ['/tower.*/i'], content: 'Literal.' }, b: { key: ['/tower.*/i'], content: 'Regex.', useRegex: true } } };
    const result = imported(source);
    expect(result.book.entries.map(entry => entry.useRegex)).toEqual([false, true]);
    expect(result.diagnostics.filter(diagnostic => diagnostic.code === 'literal_regex_text')).toHaveLength(1);
    expect(exportLorebook(result.book)).toEqual(source);
  });

  it('preserves unsupported positions while explicitly reporting its after-character fallback', () => {
    const source = { entries: { a: { key: [], content: 'Prose', position: 7, selective: true, keysecondary: ['fog'], selectiveLogic: 2, delay: 3, vectorized: true, matchWholeWords: true } } };
    const result = imported(source);
    expect(first(result.book).placement).toBe('after_char');
    expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'unsupported_position', message: expect.stringContaining('after-character') }), expect.objectContaining({ code: 'unsupported_selective_logic' })]));
    expect(exportLorebook(result.book)).toEqual(source);
    const changed = markLoreEdits(result.book, { ...result.book, entries: [{ ...first(result.book), placement: 'before_char' }] });
    expect(exportLorebook(changed)).toMatchObject({ entries: { a: { position: 0 } } });
  });

  it('maps explicit World Info depth, role and scan settings and keeps nullable defaults', () => {
    const source = { entries: { a: { key: [], content: 'Prose', position: 4, depth: 5, role: 2, scanDepth: 0, caseSensitive: true }, b: { key: [], content: 'Other', role: null, scanDepth: null, caseSensitive: null } } };
    const result = imported(source);
    expect(first(result.book)).toMatchObject({ placement: 'history', depth: 5, role: 'assistant', scanDepth: 0, caseSensitive: true });
    expect(exportLorebook(result.book)).toEqual(source);
    const converted = imported(exportLorebook(result.book, 'v3'));
    expect(first(converted.book)).toMatchObject({ placement: 'history', depth: 5, role: 'assistant', scanDepth: 0 });
  });

  it('preserves raw World Info controls overridden by content decorators', () => {
    const source = { entries: { a: { key: [], content: '@@position scenario\n@@role user\n@@scan_depth 2\n@@depth 3\nProse', position: 0, role: 2, scanDepth: 4, depth: 5 } } };
    const result = imported(source);
    expect(first(result.book)).toMatchObject({ placement: 'scenario', role: 'user', scanDepth: 2, depth: 3 });
    expect(exportLorebook(result.book)).toEqual(source);
  });

  it('reports malformed preserved metadata without crashing compatibility rendering', () => {
    const malformed: Lorebook = { ...newLorebook(), source: { format: 'v3', raw: { spec: 'lorebook_v3', data: null } },
      entries: [{ ...newLoreEntry('one'), source: { raw: { extensions: [] } } }],
    };
    expect(loreCompatibility(malformed).filter(diagnostic => diagnostic.code === 'invalid_preserved_metadata')).toHaveLength(2);
  });

  it('bounds compatibility diagnostics for large metadata while preserving all source fields', () => {
    const extras = Object.fromEntries(Array.from({ length: 250 }, (_, index) => [`foreign_${index}`, index]));
    const source = { entries: [], ...extras };
    const result = imported(source);
    expect(result.diagnostics).toHaveLength(201);
    expect(result.diagnostics[200]).toMatchObject({ code: 'more_compatibility_notices' });
    expect(exportLorebook(result.book)).toMatchObject(extras);
  });
});

describe('lorebook boundary validation', () => {
  it('rejects malformed nested standard input before creating entries', () => {
    let calls = 0;
    expect(() => importLorebook(fixtures.malformedV3, () => `${++calls}`)).toThrow();
    expect(calls).toBe(0);
  });

  it.each([
    { keys: 'wrong' }, { secondary_keys: 'comma,separated' }, { enabled: 'true' }, { content: 123 },
    { insertion_order: '1' }, { extensions: [] }, { use_regex: 'false' }, { case_sensitive: null },
    { selective: 1 }, { constant: null }, { position: 'history' }, { priority: 'high' },
  ])('rejects malformed standard entry fields: %j', invalid => {
    expect(() => imported({ ...fixtures.v2, entries: [{ ...fixtures.v2.entries[0], ...invalid }] })).toThrow();
  });

  it.each(['keys', 'content', 'enabled', 'insertion_order'] as const)('requires standard entry %s', field => {
    const entry: Record<string, unknown> = { ...fixtures.v2.entries[0] };
    delete entry[field];
    expect(() => imported({ ...fixtures.v2, entries: [entry] })).toThrow();
  });

  it('requires V3 use_regex and extensions, accepts optional typed V2 regex', () => {
    const v3 = structuredClone(fixtures.v3);
    const entry: Record<string, unknown> = { ...v3.data.entries[0] };
    delete entry.use_regex;
    expect(() => imported({ ...v3, data: { ...v3.data, entries: [entry] } })).toThrow();
    expect(() => imported({ spec: 'lorebook_v3', data: { entries: [] } })).toThrow();
    delete entry.extensions;
    expect(() => imported({ ...v3, data: { ...v3.data, entries: [{ ...entry, use_regex: false }] } })).toThrow();
    expect(first(imported({ ...fixtures.v2, entries: [{ ...fixtures.v2.entries[0], use_regex: true }] }).book).useRegex).toBe(true);
  });

  it.each([
    { name: 4 }, { description: false }, { scan_depth: -1 }, { scan_depth: 1.5 },
    { token_budget: -1 }, { token_budget: 1_000_001 }, { recursive_scanning: 'false' }, { extensions: null },
  ])('rejects invalid explicit standard book settings: %j', invalid => {
    expect(() => imported({ ...fixtures.v2, ...invalid })).toThrow();
  });

  it.each([
    null, [], {}, { spec: 'unknown', entries: [] }, { spec: 'lorebook_v3', data: [] },
    { ...fixtures.v3, entries: [] }, { entries: [], data: { entries: [] } },
    { entries: [{ keys: [], key: [], content: 'Mixed' }] },
    { entries: [{ ...fixtures.v2.entries[0] }, { key: [], content: 'Other', uid: 5 }] },
    { entries: [{ key: [], content: 'Legacy' }, { content: 'Ambiguous' }] },
  ])('rejects unsupported, ambiguous and conflicting shapes: %j', source => {
    expect(() => imported(source)).toThrow();
  });

  it.each([
    { key: 'comma,separated' }, { disable: 'false' }, { useRegex: 'true' }, { useRegex: true, use_regex: false },
    { uid: 1, id: 2 }, { probability: 101 }, { sticky: -1 }, { role: 'developer' }, { scanDepth: -1 },
    { selectiveLogic: 5 }, { content: null }, { order: '50' },
  ])('rejects invalid typed World Info values: %j', invalid => {
    expect(() => imported({ entries: { a: { key: [], content: 'Prose', ...invalid } } })).toThrow();
  });

  it('enforces entry limits and UTF-8 byte size before allocating identities', () => {
    let calls = 0;
    const createId = () => `${++calls}`;
    expect(() => importLorebook({ entries: Array.from({ length: 2001 }, () => fixtures.v2.entries[0]) }, createId)).toThrow();
    expect(() => importLorebook({ entries: [], foreign: 'я'.repeat(2_500_000) }, createId)).toThrow('5 MB');
    expect(calls).toBe(0);
    expect(importLorebook({ entries: Array.from({ length: 2000 }, () => ({ keys: [], content: '', enabled: true, insertion_order: 0 })) }, createId).book.entries).toHaveLength(2000);
  });

  it('roundtrips a representative content-heavy book just below the source size limit', () => {
    const source = { extensions: {}, entries: Array.from({ length: 49 }, (_, index) => ({ keys: [`key-${index}`], content: 'x'.repeat(100_000), enabled: true, insertion_order: index, extensions: {} })) };
    expect(new TextEncoder().encode(JSON.stringify(source)).byteLength).toBeLessThan(5_000_000);
    expect(exportLorebook(imported(source).book)).toEqual(source);
  });

  it('rejects non-JSON values, circular metadata and excessive nesting', () => {
    const circular: Record<string, unknown> = { entries: [] }; circular.self = circular;
    expect(() => imported(circular)).toThrow('non-circular');
    expect(() => imported({ entries: [], number: Number.NaN })).toThrow('valid JSON');
    expect(() => imported({ entries: [], value: undefined })).toThrow('valid JSON');
    expect(() => imported({ entries: [], date: new Date() })).toThrow('plain JSON');
    let nested: Record<string, unknown> = {};
    for (let i = 0; i < 101; i++) nested = { child: nested };
    expect(() => imported({ entries: [], nested })).toThrow('nesting depth');
  });
});
