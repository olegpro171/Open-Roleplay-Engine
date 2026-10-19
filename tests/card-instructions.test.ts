import { describe, expect, it } from 'vitest';
import { assembleRequest } from '../src/core/prompt.js';
import { exportCharacter, importCharacter } from '../src/core/cards.js';
import { promptDiagnostics } from '../src/core/prompt-diagnostics.js';
import { resolveLore } from '../src/core/lorebook.js';
import { sourceOf } from '../src/core/context.js';
import { countInput } from '../src/core/tokens.js';
import { defaultPrompt, promptSchema, type Character, type PromptBlock, type PromptSources } from '../src/shared/library.js';
import { readCardInstruction, readCharacterDepthPrompt } from '../src/shared/card-instructions.js';
import type { Turn } from '../src/shared/contracts.js';
import type { ContextState } from '../src/shared/context.js';
import { newLorebook, newLoreEntry } from '../src/shared/lorebook.js';

const connection = { name: 'Synthetic', endpoint: 'http://localhost/v1', model: 'synthetic', contextWindow: 10000, maxOutputTokens: 100, customParameters: {} };
const settings = { title: 'Instructions', instructions: '', character: '', persona: '', targetInputTokens: 5000 };
const character: Character = { name: 'Mira', description: 'Keeper', personality: '', scenario: '', first_mes: '', mes_example: '' };
const system: PromptBlock = { id: 'system', name: 'Card system prompt', enabled: true, kind: 'marker', marker: 'card_system_prompt', role: 'system', fallback: 'Continue {{char}} and {{user}}.' };
const post: PromptBlock = { id: 'post', name: 'Card post-history instructions', enabled: true, kind: 'marker', marker: 'card_post_history_instructions', role: 'user', fallback: 'Default ending.' };
const messages: PromptBlock = { id: 'messages', name: 'Messages', enabled: true, kind: 'marker', marker: 'messages', role: 'system', allowDepthPrompt: true };
const summary: PromptBlock = { id: 'summary', name: 'Summary', enabled: true, kind: 'marker', marker: 'summary', role: 'system' };
function sources(card: Character = character, blocks: PromptBlock[] = [system, messages, post]): PromptSources {
  return { prompt: { name: 'Custom', id: 'preset', revision: 0, blocks }, character: { ...card, id: 'card', revision: 0 }, persona: { id: 'persona', revision: 0, name: 'Leon', description: '' } };
}
const turn = (index: number, user = `User ${index}`, assistant = `Response ${index}`, complete = true): Turn => ({ id: `t${index}`, position: index,
  complete, user: { id: `u${index}`, revision: 0, text: user }, assistant: { id: `a${index}`, revision: 0, text: assistant } });
const request = (input: PromptSources, turns: Turn[] = [], context?: ContextState) => assembleRequest(connection, settings, turns, input, context);

describe('card instruction sources and explicit prompt control', () => {
  it.each(['legacy', 'chara_card_v2', 'chara_card_v3'])('reads already-preserved %s cards and exports edited fields without losing extensions', spec => {
    const data = { ...character, system_prompt: 'Main', post_history_instructions: 'End', extensions: { custom: { preserved: true }, depth_prompt: { prompt: 'Note', depth: 3, role: 'assistant', custom: 42 } } };
    const source = spec === 'legacy' ? data : { spec, data };
    const imported = importCharacter(source);
    expect(readCardInstruction(imported, 'system_prompt')).toMatchObject({ success: true, data: 'Main' });
    expect(readCharacterDepthPrompt(imported)).toMatchObject({ success: true, data: { prompt: 'Note', depth: 3, role: 'assistant' } });
    const exported = exportCharacter({ ...imported, system_prompt: '', post_history_instructions: 'Edited', depth_prompt: { prompt: '', depth: 0, role: 'system' } });
    expect(exported.data).toMatchObject({ system_prompt: '', post_history_instructions: 'Edited', extensions: { custom: { preserved: true }, depth_prompt: { prompt: '', depth: 0, role: 'system', custom: 42 } } });
    expect(exported).not.toHaveProperty('depth_prompt');
    expect(exported.data).not.toHaveProperty('depth_prompt');
    expect(readCardInstruction(importCharacter(exported), 'system_prompt')).toMatchObject({ success: true, data: '' });
  });

  it('replaces only its own fallback, resolves macros once, and preserves unrelated blocks and history literally', () => {
    const input = sources({ ...character, system_prompt: '{{original}} Narrate {{char}}.', post_history_instructions: 'End {{user}}: {{original}}' }, [
      { id: 'always', name: 'Always', enabled: true, kind: 'text', role: 'system', text: 'Always included.' }, system, messages, post,
    ]);
    const result = request(input, [turn(1, '{{char}} stays literal', '')]);
    expect(result.body.messages).toEqual([
      { role: 'system', content: 'Always included.' }, { role: 'system', content: 'Continue Mira and Leon. Narrate Mira.' },
      { role: 'user', content: '{{char}} stays literal' }, { role: 'user', content: 'End Leon: Default ending.' },
    ]);
    expect(request(sources({ ...character, system_prompt: 'Replacement' })).body.messages[0].content).toBe('Replacement');
    const nested = sources({ ...character, name: '{{user}}', system_prompt: '{{original}} {{char}}' }, [{ ...system, fallback: '{{char}} {{original}}' }]);
    expect(request(nested).body.messages).toEqual([{ role: 'system', content: '{{user}} {{original}} {{user}}' }]);
    expect(result.layout?.[1].label).toContain('card');
  });

  it('uses fallback for absent/blank fields or characters and emits nothing for fully empty markers', () => {
    const input = sources({ ...character, system_prompt: '  \n' });
    expect(request(input).body.messages[0].content).toBe('Continue Mira and Leon.');
    input.character = null;
    expect(request(input).body.messages[0].content).toBe('Continue Character and Leon.');
    expect(request(input).layout?.[0].label).toContain('fallback');
    expect(() => request(sources(character, [{ ...system, fallback: '' }]))).toThrow('resolved prompt is empty');
    const disabled = sources({ ...character, system_prompt: 'EXCLUDED', post_history_instructions: 'EXCLUDED', depth_prompt: { prompt: 'EXCLUDED', role: 'system', depth: 0 } }, [{ ...system, enabled: false }, { ...messages, allowDepthPrompt: false }]);
    expect(request(disabled, [turn(1)]).body.messages.map(message => message.content)).toEqual(['User 1', 'Response 1']);
  });

  it('rejects malformed active preserved values without dropping them from export, and accepts explicit correction', () => {
    const card = importCharacter({ ...character, system_prompt: null, extensions: { depth_prompt: { prompt: 'Note', depth: -1, role: 'unknown' } } });
    expect(() => request(sources(card))).toThrow('depth note has invalid settings');
    expect(() => request(sources(card, [system]))).toThrow('Card system prompt is invalid');
    expect(request(sources(card, [{ ...messages, allowDepthPrompt: false }]), [turn(1)]).body.messages).toHaveLength(2);
    expect(exportCharacter(card).data).toMatchObject({ system_prompt: null, extensions: { depth_prompt: { depth: -1, role: 'unknown' } } });
    expect(request(sources({ ...card, system_prompt: '', depth_prompt: { prompt: '', depth: 2, role: 'system' } })).body.messages[0].content).toBe('Continue Mira and Leon.');
    const warnings = promptDiagnostics(sources(card));
    expect(warnings.map(warning => warning.code)).toEqual(['invalid_system_prompt', 'invalid_depth_prompt']);
  });

  it('keeps malformed extension containers on unrelated exports and repairs them only after an explicit note replacement', () => {
    const invalid = importCharacter({ ...character, extensions: ['invalid container'] });
    expect(readCharacterDepthPrompt(invalid).success).toBe(false);
    expect(exportCharacter({ ...invalid, description: 'Unrelated edit' }).data).toMatchObject({ extensions: ['invalid container'] });
    const fixed = exportCharacter({ ...invalid, depth_prompt: { prompt: '', depth: 2, role: 'system' } });
    expect(fixed.data).toMatchObject({ extensions: { depth_prompt: { prompt: '', depth: 2, role: 'system' } } });
    expect(readCharacterDepthPrompt(importCharacter(fixed))).toMatchObject({ success: true, data: { prompt: '' } });
  });

  it('validates marker-specific configuration, uniqueness, and bounded note settings', () => {
    for (const blocks of [[system, { ...system, id: 'duplicate' }], [post, { ...post, id: 'duplicate' }], [{ ...messages, fallback: 'wrong' }], [{ ...system, allowDepthPrompt: true }]]) {
      expect(promptSchema.safeParse({ name: 'Invalid', blocks }).success).toBe(false);
    }
    expect(readCharacterDepthPrompt({ source: { extensions: { depth_prompt: { prompt: 'Defaults' } } } })).toMatchObject({ success: true, data: { prompt: 'Defaults', depth: 2, role: 'system' } });
    for (const depth of [-1, 1.5, 1001]) expect(readCharacterDepthPrompt({ source: { extensions: { depth_prompt: { prompt: 'Bad', depth } } } }).success).toBe(false);
    expect(defaultPrompt.blocks.find(block => block.kind === 'marker' && block.marker === 'messages')).toMatchObject({ allowDepthPrompt: true });
  });
});

describe('automatic character depth injection', () => {
  it.each([[0, 3], [1, 2], [2, 1], [1000, 0]])('inserts depth %i at original message index %i, ignoring whitespace, partial responses and other injections', async (depth, index) => {
    const input = sources({ ...character, depth_prompt: { prompt: 'Note for {{char}} / {{user}}', depth, role: 'assistant' } }, [messages]);
    input.lorebook = { ...newLorebook(), id: 'book', revision: 0, entries: [{ ...newLoreEntry('lore'), name: 'Lore', content: 'Lore', constant: true, placement: 'history', depth }] };
    const turns = [turn(1), turn(2, ' ', ''), turn(3, 'Pending', 'PARTIAL', false)];
    const lore = await resolveLore({ book: input.lorebook, sources: input, turns, state: { epoch: 0, entries: {} } }, async () => ({ matched: false }));
    const result = assembleRequest(connection, settings, turns, input, undefined, { lore });
    const nonblank = result.body.messages.filter(message => message.content.trim());
    expect(nonblank.slice(index, index + 2)).toEqual([{ role: 'system', content: 'Lore' }, { role: 'assistant', content: 'Note for Mira / Leon' }]);
    expect(nonblank.filter(message => message.content !== 'Lore' && !message.content.startsWith('Note'))).toEqual([{ role: 'user', content: 'User 1' }, { role: 'assistant', content: 'Response 1' }, { role: 'user', content: 'Pending' }]);
    expect(result.coverage).toEqual(turns.map(sourceOf));
    expect(turns[2].assistant.text).toBe('PARTIAL');
  });

  it('injects into empty history but never without an enabled and opted-in Messages marker', () => {
    const card = { ...character, depth_prompt: { prompt: 'Note', role: 'system' as const, depth: 0 } };
    expect(request(sources(card, [messages])).body.messages).toEqual([{ role: 'system', content: 'Note' }]);
    for (const blocks of [[system], [system, { ...messages, enabled: false }], [system, { ...messages, allowDepthPrompt: undefined }]]) {
      expect(request(sources(card, blocks)).body.messages.map(message => message.content)).toEqual(['Continue Mira and Leon.']);
      expect(promptDiagnostics(sources(card, blocks)).some(warning => warning.code === 'disabled_depth_prompt')).toBe(true);
    }
  });

  it('uses the selected managed tail for depth without modifying memory or counting summaries', () => {
    const turns = [turn(1), turn(2)];
    const saved = { id: 'saved', revision: 0, level: 1, text: 'MEMORY', turns: [sourceOf(turns[0])], children: [], prior: [], manual: false, approved: true, createdAt: '' };
    const context: ContextState = { revision: 1, selected: [saved], archivedTurnIds: ['t1'], summaries: [saved] };
    const before = structuredClone(context);
    const input = sources({ ...character, depth_prompt: { prompt: 'Note', depth: 1000, role: 'system' } }, [summary, messages]);
    expect(request(input, turns, context).body.messages.map(message => message.content)).toEqual(['[Memory L1 · turns 1–1]\nMEMORY', 'Note', 'User 2', 'Response 2']);
    expect(context).toEqual(before);
  });

  it('reserves every instruction and injection before choosing a recent suffix, then enforces exact target and physical boundaries', () => {
    const input = sources({ ...character, depth_prompt: { prompt: 'Long note. '.repeat(12), depth: 0, role: 'system' } });
    const turns = [turn(1), turn(2), turn(3, 'Pending', '', false)];
    const fixed = request(input, turns.slice(1));
    const exact = assembleRequest(connection, { ...settings, targetInputTokens: fixed.budget.inputTokens }, turns, input);
    expect(exact.body).toEqual(fixed.body);
    expect(exact.history?.verbatimTurnIds).toEqual(['t2', 't3']);
    const reduced = assembleRequest(connection, { ...settings, targetInputTokens: fixed.budget.inputTokens - 1 }, turns, input);
    expect(reduced.history?.verbatimTurnIds).toEqual(['t3']);
    expect(reduced.body.messages.some(message => message.content.startsWith('Long note.'))).toBe(true);
    expect(exact.budget.inputTokens).toBe(countInput(exact.body.messages).inputTokens);
    const required = request(input, turns.slice(-1));
    expect(() => assembleRequest(connection, { ...settings, targetInputTokens: required.budget.inputTokens - 1 }, turns, input)).toThrow('exceeds your target');
    expect(() => assembleRequest({ ...connection, contextWindow: required.budget.inputTokens + 99 }, settings, turns, input)).toThrow('Connection context window');
  });
});

it('reports actual structural omissions, respects lore directive fallbacks, and ignores no-match and token-cap conditions', () => {
  const input = sources({ ...character, system_prompt: 'Main', post_history_instructions: 'End', depth_prompt: { prompt: 'Note', depth: 0, role: 'system' } }, [{ ...messages, allowDepthPrompt: false }]);
  input.lorebook = { ...newLorebook(), tokenBudget: 0, id: 'book', revision: 0, entries: [
    { ...newLoreEntry('history'), name: 'No keywords', placement: 'history', content: 'Eligible destination' },
    { ...newLoreEntry('missing'), name: 'Missing description', placement: 'after_desc', content: 'Unavailable' },
    { ...newLoreEntry('fallback'), name: 'Fallback', placement: 'history', content: '@@position after_desc\n@@@depth 0\nFallback to history' },
    { ...newLoreEntry('disabled'), name: 'Disabled', placement: 'after_desc', content: 'Disabled', enabled: false },
  ] };
  const diagnostics = promptDiagnostics(input);
  expect(diagnostics.map(warning => warning.code)).toEqual(['disabled_system_prompt', 'disabled_post_history_instructions', 'disabled_depth_prompt', 'unavailable_lore_destinations']);
  expect(diagnostics.at(-1)?.message).toContain('1 lorebook entry');
  expect(diagnostics.at(-1)?.message).toContain('Missing description');
  expect(diagnostics.at(-1)?.message).not.toContain('Fallback');
  expect(promptDiagnostics(sources())).toEqual([]);
});
