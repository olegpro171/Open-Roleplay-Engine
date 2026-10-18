import { describe, expect, it, vi } from 'vitest';
import type { Turn } from '../src/shared/contracts.js';
import { defaultPrompt, type PromptSources, type Saved } from '../src/shared/library.js';
import { newLorebook, newLoreEntry, type Lorebook, type LoreEntry, type LoreResolution, type LoreState } from '../src/shared/lorebook.js';
import { loreScanMessages, resolveLore, semanticFingerprint, type RegexMatcher } from '../src/core/lorebook.js';
import { countInput } from '../src/core/tokens.js';

const state = (): LoreState => ({ epoch: 3, entries: {} });
const entry = (id: string, patch: Partial<LoreEntry> = {}): LoreEntry => ({ ...newLoreEntry(id), name: id, keys: ['trigger'], content: `Lore ${id}`, ...patch });
const book = (entries: LoreEntry[], patch: Partial<Lorebook> = {}): Saved<Lorebook> => ({ ...newLorebook(), id: 'book', revision: 5, entries, ...patch });
const turn = (id: string, user: string, assistant = '', complete = true): Turn => ({ id, position: Number(id) || 0, complete, user: { id: `${id}-u`, revision: 2, text: user }, assistant: { id: `${id}-a`, revision: 4, text: assistant } });
const sources = (): PromptSources => ({ prompt: structuredClone({ ...defaultPrompt, id: 'prompt', revision: 1 }), character: { id: 'char', revision: 1, name: 'Élodie', description: 'Description', personality: 'Personality', scenario: 'Scenario', first_mes: '', mes_example: '' }, persona: { id: 'persona', revision: 1, name: 'Иван', description: '' } });
const regex: RegexMatcher = async (patterns, texts, caseSensitive) => {
  try {
    const expressions = patterns.map(pattern => new RegExp(pattern, caseSensitive ? 'u' : 'iu'));
    return { matched: expressions.some(pattern => texts.some(text => pattern.test(text))) };
  } catch { return { matched: false, invalid: 'Invalid fixture pattern' }; }
};
const run = (entries: LoreEntry[], options: { turns?: Turn[]; book?: Partial<Lorebook>; sources?: PromptSources; state?: LoreState; pressure?: boolean; matcher?: RegexMatcher } = {}) => resolveLore({ book: book(entries, options.book), turns: options.turns ?? [turn('1', 'trigger')], sources: options.sources ?? sources(), state: options.state ?? state(), pressure: options.pressure }, options.matcher ?? regex);
const admitted = (result: LoreResolution) => result.outcomes.filter(value => value.status === 'admitted').map(value => value.id);
const reason = (result: LoreResolution, id: string) => result.outcomes.find(value => value.id === id)?.reason;
const cost = (text: string, role: 'system' | 'user' | 'assistant' = 'system') => countInput([{ role, content: text }]).inputTokens - countInput([]).inputTokens;

function removeMarker(input: PromptSources, marker: string): PromptSources {
  if (!input.prompt) throw new Error('Fixture requires a preset.');
  return { ...input, prompt: { ...input.prompt, blocks: input.prompt.blocks.filter(block => block.kind !== 'marker' || block.marker !== marker) } };
}

describe('lorebook original scan input', () => {
  it('counts eligible original messages, preserves boundaries and ignores blank or unfinished output', async () => {
    const turns = [turn('greeting', '', 'Hello'), turn('1', 'old', 'answer'), turn('2', '   ', '\n'), turn('3', 'pending', 'unfinished trigger', false)];
    expect(loreScanMessages(turns, 3)).toEqual([
      { turnId: '1', partId: '1-u', revision: 2, role: 'user', text: 'old' },
      { turnId: '1', partId: '1-a', revision: 4, role: 'assistant', text: 'answer' },
      { turnId: '3', partId: '3-u', revision: 2, role: 'user', text: 'pending' },
    ]);
    expect(loreScanMessages(turns, 0)).toEqual([]);
    const result = await run([entry('partial'), entry('boundary', { keys: ['answerpending'] }), entry('pending', { keys: ['pending'] })], { turns });
    expect(admitted(result)).toEqual(['pending']);
    expect(result.assistantCount).toBe(2);
    expect(result.scan).toHaveLength(4);
    expect(result.scan.some(message => 'text' in message)).toBe(false);
  });

  it('includes a hypothetical draft once, and permits constants with a zero-depth scan', async () => {
    const result = await run([entry('key'), entry('constant', { constant: true })], { turns: [turn('draft', 'trigger', '', false)], book: { scanDepth: 0 } });
    expect(admitted(result)).toEqual(['constant']);
    expect(result.scan).toEqual([]);
    const override = await run([entry('override', { content: '@@scan_depth 1\nLore' })], { turns: [turn('draft', 'trigger', '', false)], book: { scanDepth: 0 } });
    expect(admitted(override)).toEqual(['override']);
    expect(override.scan.map(message => message.turnId)).toEqual(['draft']);
  });

  it('uses NFC and locale-independent lowercase without regex inference or stored-text changes', async () => {
    const input = [entry('unicode', { keys: ['CAFÉ', 'ДРАКОН'] }), entry('sensitive', { keys: ['ДРАКОН'], caseSensitive: true }), entry('punctuation', { keys: ['a.b'] }), entry('split', { keys: ['endstart'] })];
    const original = structuredClone(input);
    const result = await run(input, { turns: [turn('1', 'end', 'start'), turn('2', 'cafe\u0301 дракон axb')] });
    expect(admitted(result)).toEqual(['unicode']);
    expect(input).toEqual(original);
  });

  it('resolves only supported names once in keys and prose, reporting other macros', async () => {
    const result = await run([entry('names', { keys: ['{{char}}'], content: '{{char}} meets {{user}}. {{random:a,b}}' })], { turns: [turn('1', 'ÉLODIE')] });
    expect(result.outcomes[0].text).toBe('Élodie meets Иван. {{random:a,b}}');
    expect(admitted(result)).toEqual(['names']);
    expect(result.diagnostics.some(value => value.code === 'unsupported_macro')).toBe(true);
    const named = sources();
    if (!named.character) throw new Error('Fixture character missing.');
    named.character.name = '{{user}}';
    const once = await run([entry('one-pass', { constant: true, content: '{{char}}' })], { sources: named });
    expect(once.outcomes[0].text).toBe('{{user}}');
  });
});

describe('lorebook matching and directives', () => {
  it('handles primary, selective-secondary and constant combinations explicitly', async () => {
    const result = await run([
      entry('primary'), entry('secondary-missing', { selective: true, secondaryKeys: ['moon'] }),
      entry('secondary-present', { selective: true, secondaryKeys: ['moon', 'trigger'] }),
      entry('secondary-only', { keys: ['absent'], selective: true, secondaryKeys: ['trigger'] }),
      entry('constant', { constant: true, keys: [], selective: true, secondaryKeys: [] }),
      entry('empty-keys', { keys: [] }), entry('empty-key', { keys: [''] }),
      entry('disabled', { enabled: false, constant: true }), entry('empty', { constant: true, content: '\n ' }),
    ]);
    expect(admitted(result)).toEqual(['primary', 'secondary-present', 'constant']);
    expect(reason(result, 'secondary-missing')).toBe('secondary_condition');
    expect(reason(result, 'secondary-only')).toBe('no_match');
    expect(reason(result, 'disabled')).toBe('disabled');
    expect(reason(result, 'empty')).toBe('empty_content');
  });

  it('isolates regex evaluation, ignores constant/secondary/exclude in regex mode and rejects invalid patterns', async () => {
    const matcher = vi.fn(regex);
    const result = await run([
      entry('regex', { useRegex: true, keys: ['trig.*'], selective: true, secondaryKeys: ['missing'], content: '@@exclude_keys trigger\nLore' }),
      entry('regex-constant', { useRegex: true, constant: true, keys: ['no match'] }),
      entry('invalid', { useRegex: true, keys: ['['] }),
      entry('disabled', { useRegex: true, enabled: false, keys: ['['] }),
    ], { matcher });
    expect(admitted(result)).toEqual(['regex']);
    expect(reason(result, 'regex-constant')).toBe('no_match');
    expect(reason(result, 'invalid')).toBe('invalid_regex');
    expect(matcher).toHaveBeenCalledTimes(3);
    expect(result.diagnostics.filter(value => value.code === 'invalid_regex')).toHaveLength(1);
  });

  it('propagates matcher timeout/resource failure before producing an activation result', async () => {
    await expect(run([entry('regex', { useRegex: true })], { matcher: async () => { throw new Error('bounded regex timeout'); } })).rejects.toThrow('bounded regex timeout');
  });

  it('applies repeated additional-key groups as AND conditions and literal exclusions', async () => {
    const result = await run([
      entry('groups', { content: '@@additional_keys moon,sun\n@@additional_keys river,sea\nLore' }),
      entry('missing-group', { content: '@@additional_keys moon\n@@additional_keys forest\nLore' }),
      entry('excluded', { content: '@@exclude_keys forbidden,moon\nLore' }),
      entry('regex-groups', { useRegex: true, content: '@@additional_keys mo+n\n@@additional_keys ri.er\nLore' }),
    ], { turns: [turn('1', 'trigger moon river')] });
    expect(admitted(result)).toEqual(['groups', 'regex-groups']);
    expect(reason(result, 'missing-group')).toBe('additional_keys');
    expect(reason(result, 'excluded')).toBe('exclude_keys');
  });

  it('strips every control line, follows long fallback chains and uses first occurrences', async () => {
    const result = await run([entry('fallback', { content: '@@unknown_one\n@@@unknown_two\n@@@reverse_depth 0\n@@@is_greeting 0\n@@@disable_ui_prompt system_prompt\n@@@activate\n@@scan_depth 0\n@@scan_depth 1\n\nOnly prose\n@@nonsense invalid\n' })]);
    expect(admitted(result)).toEqual(['fallback']);
    expect(result.outcomes[0].text).toBe('Only prose');
    expect(result.diagnostics.some(value => value.code === 'duplicate_directive')).toBe(true);
    expect(result.diagnostics.filter(value => value.code === 'unsupported_directive').length).toBeGreaterThanOrEqual(6);
    const orphan = await run([entry('orphan', { keys: [], content: '@@@activate\nProse' })]);
    expect(admitted(orphan)).toEqual([]);
    expect(orphan.outcomes[0].text).toBe('');
    expect(orphan.diagnostics.some(value => value.code === 'invalid_directive')).toBe(true);
  });

  it('removes control-adjacent blank lines without changing unrelated prose spacing', async () => {
    const result = await run([entry('spacing', { content: 'First\n\nSecond\r\n\r\n@@role user\r\n\r\nThird\n' })]);
    expect(result.outcomes[0].text).toBe('First\n\nSecond\nThird');
    expect(result.outcomes[0].destination?.role).toBe('user');
  });

  it('ignores invalid directives with diagnostics and considers their fallbacks', async () => {
    const result = await run([entry('invalid', { content: '@@activate_only_every 0\n@@@activate\n@@role root\n@@@role user\n@@scan_depth 1001\nLore' })]);
    expect(admitted(result)).toEqual(['invalid']);
    expect(result.outcomes[0].destination?.role).toBe('user');
    expect(result.diagnostics.filter(value => value.code === 'invalid_directive')).toHaveLength(3);
  });
});

describe('lorebook cap, ordering and recursion', () => {
  it('admits by priority and constant ties, but inserts by stable source order', async () => {
    const entries = [entry('lower', { content: 'Lower', insertionOrder: 1 }), entry('constant', { content: 'Constant', constant: true, insertionOrder: 20 }), entry('high', { content: 'High', priority: 2, insertionOrder: 10 })];
    const result = await run(entries, { book: { tokenBudget: cost('High') + cost('Constant') } });
    expect(admitted(result)).toEqual(['high', 'constant']);
    expect(reason(result, 'lower')).toBe('cap');
    expect(result.tokens).toBe(cost('High') + cost('Constant'));
    const tied = await run([entry('first'), entry('second')], { book: { tokenBudget: cost('Lore first') } });
    expect(admitted(tied)).toEqual(['first']);
  });

  it('measures complete separate message framing, exact fit, one-over and smaller candidates after an exclusion', async () => {
    const exact = await run([entry('exact', { content: 'Hello' })], { book: { tokenBudget: cost('Hello') } });
    expect(admitted(exact)).toEqual(['exact']);
    expect(exact.tokens).toBe(5);
    const oneOver = await run([entry('large', { content: 'Hello' }), entry('small', { content: 'x' })], { book: { tokenBudget: cost('Hello') - 1 } });
    expect(reason(oneOver, 'large')).toBe('cap');
    expect(admitted(oneOver)).toEqual([]);
    // A second framing cost is charged even if joining the prose would have been cheaper.
    const two = await run([entry('a', { content: 'a', role: 'assistant' }), entry('b', { content: 'b', role: 'user' })], { book: { tokenBudget: 9 } });
    expect(admitted(two)).toEqual(['a']);
    const both = await run([entry('a', { content: 'a', role: 'assistant' }), entry('b', { content: 'b', role: 'user' })], { book: { tokenBudget: 10 } });
    expect(admitted(both)).toEqual(['a', 'b']);
    expect(both.tokens).toBe(10);
    expect(both.tokens).toBe(countInput([{ role: 'assistant', content: 'a' }, { role: 'user', content: 'b' }]).inputTokens - countInput([]).inputTokens);
    const oversized = await run([entry('big', { content: 'larger '.repeat(20), priority: 3 }), entry('tiny', { content: 'tiny' })], { book: { tokenBudget: cost('tiny') } });
    expect(admitted(oversized)).toEqual(['tiny']);
  });

  it('recursively discovers admitted content, terminates cycles and never inserts duplicates', async () => {
    const entries = [entry('a', { keys: ['trigger', 'also'], content: 'beta' }), entry('b', { keys: ['beta'], content: 'trigger' })];
    expect(admitted(await run(entries))).toEqual(['a']);
    const recursive = await run(entries, { book: { recursiveScanning: true } });
    expect(admitted(recursive)).toEqual(['a', 'b']);
    expect(reason(recursive, 'b')).toBe('recursive_keyword');
    expect(Object.values(recursive.stateDelta).map(value => value.matches)).toEqual([1, 1]);
  });

  it('does not evict direct entries for a higher-priority recursive discovery', async () => {
    const result = await run([entry('direct', { content: 'child' }), entry('child', { keys: ['child'], content: 'large child '.repeat(20), priority: 100 })], { book: { recursiveScanning: true, tokenBudget: cost('child') } });
    expect(admitted(result)).toEqual(['direct']);
    expect(reason(result, 'child')).toBe('cap');
  });

  it('cannot recurse through disabled, empty, unplaceable, cap-excluded or pressure-excluded entries', async () => {
    const noBefore = removeMarker(sources(), 'lore_before');
    const result = await run([
      entry('disabled', { content: 'key-disabled', enabled: false }),
      entry('empty', { content: '@@activate\n' }),
      entry('unplaceable', { content: 'key-unplaceable', placement: 'before_char' }),
      entry('oversized', { content: `key-cap ${'large '.repeat(200)}` }),
      entry('optional', { content: '@@ignore_on_max_context\nkey-optional' }),
      ...['disabled', 'unplaceable', 'cap', 'optional'].map(key => entry(`child-${key}`, { keys: [`key-${key}`] })),
    ], { sources: noBefore, pressure: true, book: { recursiveScanning: true, tokenBudget: 20 } });
    expect(admitted(result)).toEqual([]);
    expect(reason(result, 'optional')).toBe('pressure');
    expect(Object.keys(result.stateDelta)).toEqual([]);
  });

  it('reports a recursive chain that exceeds the safety bound instead of claiming completion', async () => {
    const entries = Array.from({ length: 34 }, (_, index) => entry(String(index), { keys: [index === 0 ? 'trigger' : `node-${index}:`], content: `node-${index + 1}:` }));
    await expect(run(entries, { book: { recursiveScanning: true, tokenBudget: 10000 } })).rejects.toMatchObject({ code: 'lore_recursion_limit', status: 422 });
    const finite = await run(entries.slice(0, 32), { book: { recursiveScanning: true, tokenBudget: 10000 } });
    expect(admitted(finite)).toHaveLength(32);
  });
});

describe('lorebook destination authority', () => {
  it('resolves every supported placement and roles within explicit controls', async () => {
    const placements = ['before_char', 'after_char', 'history', 'before_desc', 'after_desc', 'personality', 'scenario'] as const;
    const result = await run(placements.map(placement => entry(placement, { placement, role: placement === 'history' ? 'assistant' : null, depth: 99 })));
    expect(admitted(result)).toEqual([...placements]);
    for (const outcome of result.outcomes) {
      expect(outcome.destination?.placement).toBe(outcome.id);
      expect(outcome.destination?.role).toBe(outcome.id === 'history' ? 'assistant' : 'system');
      if (['before_desc', 'after_desc', 'personality', 'scenario'].includes(outcome.id)) expect(outcome.destination?.anchorId).toBe('character');
    }
    expect(result.outcomes.find(value => value.id === 'history')?.destination?.depth).toBe(99);
  });

  it('uses the first active nonempty corresponding field or composite anchor', async () => {
    const input = sources();
    if (!input.prompt) throw new Error('Fixture prompt missing.');
    input.prompt.blocks.unshift({ id: 'disabled-description', name: 'Hidden', enabled: false, kind: 'marker', marker: 'description', role: 'system' }, { id: 'description-first', name: 'Description', enabled: true, kind: 'marker', marker: 'description', role: 'system' });
    const result = await run([entry('field', { placement: 'before_desc' })], { sources: input });
    expect(result.outcomes[0].destination?.anchorId).toBe('description-first');
    if (!input.character) throw new Error('Fixture character missing.');
    input.character.description = '';
    expect(admitted(await run([entry('field', { placement: 'before_desc' })], { sources: input }))).toEqual([]);
  });

  it('honors position over depth and fallback chains when a field is unavailable', async () => {
    const result = await run([entry('position', { content: '@@depth 0\n@@position after_desc\n@@role user\nLore' })]);
    expect(result.outcomes[0].destination).toMatchObject({ placement: 'after_desc', anchorId: 'character', role: 'user' });
    let input = removeMarker(sources(), 'character');
    const fallback = await run([entry('fallback', { content: '@@position scenario\n@@@depth 3\nLore' })], { sources: input });
    expect(fallback.outcomes[0].destination?.placement).toBe('history');
    input = removeMarker(input, 'lore_history');
    const lowPriority = await run([entry('fallback', { content: '@@position scenario\n@@@depth 3\nLore' })], { sources: input });
    expect(lowPriority.outcomes[0].destination?.placement).toBe('before_char');
    expect(lowPriority.diagnostics.some(value => value.code === 'depth_fallback')).toBe(true);
  });

  it('does not require Messages for ordinary lore and respects missing/disabled controls and empty presets', async () => {
    const noMessages = removeMarker(sources(), 'messages');
    expect(admitted(await run([entry('ordinary')], { sources: noMessages }))).toEqual(['ordinary']);
    const high = await run([entry('depth', { content: '@@depth 0\nLore' })], { sources: noMessages });
    expect(high.outcomes[0].destination?.placement).toBe('after_char');
    const none = removeMarker(removeMarker(noMessages, 'lore_after'), 'lore_before');
    const unavailable = await run([entry('depth', { content: '@@depth 0\nLore' })], { sources: none });
    expect(reason(unavailable, 'depth')).toBe('unavailable_destination');
    const blank = sources();
    if (!blank.prompt) throw new Error('Fixture prompt missing.');
    blank.prompt.blocks = [];
    expect(admitted(await run([entry('constant', { constant: true })], { sources: blank }))).toEqual([]);
  });
});

describe('lorebook durable-state proposals', () => {
  it('counts only completed nonblank original assistant messages including greetings', async () => {
    const entries = [entry('after', { content: '@@activate_only_after 2\nLore' }), entry('every', { content: '@@activate_only_every 2\nLore' })];
    const turns = [turn('greeting', '', 'Greeting'), turn('blank', 'trigger', '  '), turn('pending', 'trigger', 'Partial', false)];
    const first = await run(entries, { turns });
    expect(admitted(first)).toEqual([]);
    expect(first.assistantCount).toBe(1);
    const second = await run(entries, { turns: [turn('greeting', '', 'Greeting'), turn('complete', 'trigger', 'Done')] });
    expect(admitted(second)).toEqual(['after', 'every']);
  });

  it('requires two prior admitted matches, respects conflict precedence and never mutates input state', async () => {
    const entries = [
      entry('keep', { keys: ['absent'], content: '@@keep_activate_after_match\n@@activate_only_after 99\nLore' }),
      entry('stop', { content: '@@activate\n@@dont_activate_after_match\nLore' }),
      entry('dont', { keys: ['absent'], content: '@@keep_activate_after_match\n@@dont_activate\nLore' }),
      entry('explicit', { keys: [], content: '@@activate\n@@dont_activate\n@@activate_only_after 99\nLore' }),
    ];
    const sourceBook = book(entries);
    const saved: LoreState = { epoch: 9, entries: Object.fromEntries(entries.map(value => [value.id, { fingerprint: semanticFingerprint(sourceBook, value), matches: 2 }])) };
    saved.entries.removed = { fingerprint: 'historical', matches: 7 };
    const before = structuredClone(saved);
    const result = await run(entries, { state: saved });
    expect(admitted(result)).toEqual(['keep', 'explicit']);
    expect(reason(result, 'stop')).toBe('dont_activate_after_match');
    expect(reason(result, 'dont')).toBe('dont_activate');
    expect(result.epoch).toBe(9);
    expect(result.stateDelta.keep.matches).toBe(3);
    expect(result.stateBefore).toEqual(saved.entries);
    expect(saved).toEqual(before);
    saved.entries.keep.matches = 1;
    expect(result.stateBefore.keep.matches).toBe(2);
    expect(admitted(await run(entries, { state: saved }))).toEqual(['explicit']);
  });

  it('resets an entry on semantic changes while cosmetic names, comments and metadata preserve state', async () => {
    const value = entry('state', { content: '@@keep_activate_after_match\nLore' });
    const sourceBook = book([value]);
    const fingerprint = semanticFingerprint(sourceBook, value);
    expect(semanticFingerprint({ ...sourceBook, name: 'Renamed', description: 'Human note' }, { ...value, name: 'Renamed entry', comment: 'Comment', source: { raw: { unknown: true } } })).toBe(fingerprint);
    for (const patch of [{ content: 'changed' }, { keys: ['changed'] }, { priority: 1 }, { placement: 'before_char' as const }, { enabled: false }]) expect(semanticFingerprint(sourceBook, { ...value, ...patch })).not.toBe(fingerprint);
    expect(semanticFingerprint({ ...sourceBook, scanDepth: 8 }, value)).not.toBe(fingerprint);
    expect(semanticFingerprint({ ...sourceBook, scanDepth: 8 }, { ...value, scanDepth: 2 })).toBe(semanticFingerprint(sourceBook, { ...value, scanDepth: 2 }));
    const saved = { epoch: 1, entries: { state: { fingerprint, matches: 2 } } };
    const result = await run([{ ...value, keys: ['absent'], priority: 1 }], { state: saved });
    expect(admitted(result)).toEqual([]);
    expect(result.stateBefore.state).toEqual(saved.entries.state);
    expect(result.stateDelta).toEqual({});
  });
});


describe('lorebook work bounds and arbitrary identities', () => {
  it('handles a representative 2000-entry book using a bounded 1000-message window', async () => {
    const entries = Array.from({ length: 2000 }, (_, index) => entry(`entry-${index}`, { keys: [`key-${index}:`], content: `Lore ${index}`, scanDepth: index % 2 ? 1 : 1000 }));
    const turns = Array.from({ length: 1000 }, (_, index) => turn(String(index + 1), `original-${index}`, `answer-${index}`));
    turns.push(turn('draft', 'key-3: key-1999:', '', false));
    const result = await run(entries, { turns });
    expect(admitted(result)).toEqual(['entry-3', 'entry-1999']);
    expect(result.scan).toHaveLength(1000);
    expect(result.scan.at(-1)?.turnId).toBe('draft');
  });

  it('fails excessive original scan text actionably and does not inspect inactive entries', async () => {
    const text = 'x'.repeat(100000);
    const turns = Array.from({ length: 201 }, (_, index) => turn(String(index), text));
    await expect(run([entry('large-scan', { scanDepth: 1000 })], { turns })).rejects.toMatchObject({ code: 'lore_scan_limit', status: 422 });
    const disabled = await run([entry('disabled', { scanDepth: 1000, enabled: false })], { turns });
    expect(admitted(disabled)).toEqual([]);
    expect(disabled.scan).toEqual([]);
  });

  it('bounds cumulative isolated regex workload without truncating texts', async () => {
    const texts = [turn('1', 'x'.repeat(100000))];
    const entries = Array.from({ length: 4 }, (_, index) => entry(String(index), { useRegex: true, keys: Array.from({ length: 64 }, (_, key) => `key-${key}`) }));
    const matcher = vi.fn<RegexMatcher>(async (_patterns, received) => {
      expect(received[0]).toHaveLength(100000);
      return { matched: false };
    });
    await expect(run(entries, { turns: texts, matcher })).rejects.toMatchObject({ code: 'lore_regex_work_limit', status: 422 });
    expect(matcher).toHaveBeenCalledTimes(3);
  });

  it('bounds aggregate literal matching and leaves constant-only scans empty', async () => {
    const entries = Array.from({ length: 32 }, (_, index) => entry(String(index), { keys: Array.from({ length: 64 }, (_, key) => `key-${key}`) }));
    await expect(run(entries, { turns: [turn('1', 'x'.repeat(100000))] })).rejects.toMatchObject({ code: 'lore_match_work_limit', status: 422 });
    const constant = await run([entry('constant', { constant: true })]);
    expect(admitted(constant)).toEqual(['constant']);
    expect(constant.scan).toEqual([]);
  });

  it('preserves dictionary-shaped entry IDs as own state properties', async () => {
    const result = await run([entry('__proto__'), entry('constructor'), entry('toString')]);
    expect(admitted(result)).toEqual(['__proto__', 'constructor', 'toString']);
    const persisted = JSON.parse(JSON.stringify(result.stateDelta));
    expect(Object.keys(persisted)).toEqual(['__proto__', 'constructor', 'toString']);
    expect(persisted.__proto__.matches).toBe(1);
  });
});
