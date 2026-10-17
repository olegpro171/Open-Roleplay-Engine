import { describe, expect, it } from 'vitest';
import { assembleRequest, estimateInputTokens } from '../src/core/prompt.js';
import { sourceOf } from '../src/core/context.js';
import { defaultPrompt, promptSchema, promptWarnings, type PromptBlock, type PromptSources } from '../src/shared/library.js';
import type { ChatSettings, Connection, Turn } from '../src/shared/contracts.js';
import type { ContextState } from '../src/shared/context.js';

const connection: Connection = { name: 'Synthetic', endpoint: 'http://localhost/v1', model: 'synthetic', contextWindow: 10_000, maxOutputTokens: 100, customParameters: {} };
const settings: ChatSettings = { title: 'Control', instructions: '', character: 'A keeper', persona: 'A traveller', targetInputTokens: 5_000 };
const turns: Turn[] = Array.from({ length: 6 }, (_, i) => ({ id: `t${i}`, position: i + 1, complete: true,
  user: { id: `u${i}`, revision: 0, text: `User ${i}: ` + 'A brass key. '.repeat(8) },
  assistant: { id: `a${i}`, revision: 0, text: `Assistant ${i}: ` + 'The cellar is locked. '.repeat(9) } }));
const summary = { id: 'saved', revision: 0, level: 1, text: 'SAVED MEMORY', turns: turns.slice(0, 4).map(sourceOf), children: [], prior: [], manual: false, approved: true, createdAt: '' };
const context: ContextState = { revision: 1, selected: [summary], archivedTurnIds: turns.slice(0, 4).map(turn => turn.id), summaries: [summary] };
const messages = defaultPrompt.blocks.find(block => block.id === 'messages')!;
const sources = (blocks: PromptBlock[]): PromptSources => ({ prompt: { name: 'Custom', id: 'custom', revision: 0, blocks }, character: null, persona: null });
const request = (blocks: PromptBlock[], targetInputTokens = 5_000, history = turns, state = context) => assembleRequest(connection, { ...settings, targetInputTokens }, history, sources(blocks), state);

describe('explicit prompt control', () => {
  it('starts with all four source markers and permits empty/missing-marker presets', () => {
    expect(defaultPrompt.blocks.map(block => block.id)).toEqual(['instructions', 'character', 'persona', 'summary', 'messages']);
    expect(promptSchema.parse({ name: 'Empty', blocks: [] }).blocks).toEqual([]);
    expect(promptWarnings({ name: 'Empty', blocks: [] })).toHaveLength(4);
    expect(() => request([])).toThrow('resolved prompt is empty');
    expect(promptSchema.safeParse({ name: 'Duplicates', blocks: [messages, { ...messages, id: 'second' }] }).success).toBe(false);
  });

  it.each(['absent', 'disabled'] as const)('never injects %s Summary and ignores saved cutoff and stale memory', mode => {
    const blocks = mode === 'absent' ? [messages] : [...defaultPrompt.blocks.map(block => ({ ...block, enabled: block.id !== 'summary' }))];
    const changed = turns.map((turn, i) => i ? turn : { ...turn, user: { ...turn.user, revision: 1 } });
    const resolved = request(blocks, 5_000, changed);
    expect(resolved.body.messages.some(message => message.content.includes(summary.text))).toBe(false);
    expect(resolved.history).toEqual({ mode: 'recent', verbatimTurnIds: changed.map(turn => turn.id) });
    expect(resolved.context).toEqual({ selected: [], archivedTurnIds: [] });
    expect(resolved.body.messages).toContainEqual({ role: 'user', content: turns[0].user.text });
    expect(resolved.warnings).toContain('Summary marker is absent or disabled. Summaries will not be sent.');
    expect(context.selected).toEqual([summary]);
  });

  it('fills the remaining budget with a contiguous suffix of whole turns and counts blocks after Messages', () => {
    const after: PromptBlock = { id: 'after', name: 'After', enabled: true, kind: 'text', role: 'system', text: 'An important closing instruction. '.repeat(6) };
    const budget = estimateInputTokens([...turns.slice(-2).flatMap(turn => [{ role: 'user' as const, content: turn.user.text }, { role: 'assistant' as const, content: turn.assistant.text }]), { role: 'system', content: after.text }]);
    const resolved = request([messages, after], budget);
    expect(resolved.budget.inputTokens).toBe(budget);
    expect(resolved.history?.verbatimTurnIds).toEqual(['t4', 't5']);
    expect(resolved.body.messages.at(-1)).toEqual({ role: 'system', content: after.text });
    expect(resolved.body.messages).toHaveLength(5);
    expect(request([messages, after], budget - 1).history?.verbatimTurnIds).toEqual(['t5']);
    const physical = assembleRequest({ ...connection, contextWindow: budget + 100 }, settings, turns, sources([messages, after]), context);
    expect(physical.history?.verbatimTurnIds).toEqual(['t4', 't5']);
  });

  it('keeps pending input, excludes partial responses, and fails if required input alone cannot fit', () => {
    const pending: Turn = { ...turns[5], id: 'pending', complete: false, assistant: { ...turns[5].assistant, text: 'PARTIAL MUST NOT BE SENT' } };
    const budget = estimateInputTokens([{ role: 'user', content: pending.user.text }]);
    const resolved = request([messages], budget, [...turns.slice(0, 5), pending]);
    expect(resolved.body.messages).toEqual([{ role: 'user', content: pending.user.text }]);
    expect(resolved.history?.verbatimTurnIds).toEqual(['pending']);
    expect(() => request([messages], budget - 1, [...turns.slice(0, 5), pending])).toThrow('exceeds your target');
    const inspected = assembleRequest(connection, { ...settings, targetInputTokens: budget - 1 }, [pending], sources([messages]), context, { validateLimits: false });
    expect(inspected.body.messages[0].content).toBe(pending.user.text);
  });

  it('does not skip an oversized recent turn to include older ones or split an exchange', () => {
    const history = [...turns.slice(0, 2), { ...turns[2], user: { ...turns[2].user, text: 'oversized '.repeat(500) } }];
    const resolved = request([defaultPrompt.blocks[0], messages], 200, history);
    expect(resolved.history?.verbatimTurnIds).toEqual([]);
    expect(resolved.body.messages).toHaveLength(1);
  });

  it('inserts only explicitly selected sources, preserving Summary position and role', () => {
    const marker = { ...defaultPrompt.blocks.find(block => block.id === 'summary')!, role: 'assistant' as const };
    const resolved = request([messages, marker]);
    expect(resolved.body.messages.at(-1)).toEqual({ role: 'assistant', content: '[Memory L1 · turns 1–4]\nSAVED MEMORY' });
    expect(resolved.body.messages.filter(message => message.content.includes(summary.text))).toHaveLength(1);
    expect(resolved.history?.verbatimTurnIds).toEqual(['t4', 't5']);
    const onlyMemory = request([marker]);
    expect(onlyMemory.body.messages).toHaveLength(1);
    expect(onlyMemory.history?.verbatimTurnIds).toEqual([]);
    const onlyText = request([defaultPrompt.blocks[0]]);
    expect(onlyText.body.messages).toHaveLength(1);
    expect(onlyText.body.messages[0].content).not.toContain('keeper');
  });
});
