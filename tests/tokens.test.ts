import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { countInput, countText } from '../src/core/tokens.js';
import { assembleRequest } from '../src/core/prompt.js';
import { contextPlan, summaryRequest } from '../src/core/context-plan.js';
import { defaultContextPreset, type SummaryNode } from '../src/shared/context.js';
import type { ChatSnapshot, Connection, Turn } from '../src/shared/contracts.js';

const vectors = JSON.parse(readFileSync('tests/fixtures/token-counts.json', 'utf8')).vectors as { text: string; cl100k_base: number }[];
const connection: Connection = { name: 'Gemma', endpoint: 'https://openrouter.ai/api/v1', model: 'google/gemma-3-4b-it', contextWindow: 100_000, maxOutputTokens: 1_000, customParameters: {} };
const turn = (i: number): Turn => ({ id: `turn-${i}`, position: i, complete: true, user: { id: `user-${i}`, revision: 0, text: i === 252 ? '' : 'Mira waits at the door.' }, assistant: { id: `assistant-${i}`, revision: 0, text: 'Leon pockets the key.' } });

describe('shared reference planning counter', () => {
  it.each(vectors)('matches independent Python tokenizer counts for $text', vector => {
    expect(countText(vector.text)).toBe(vector.cl100k_base);
  });

  it('uses a small shared framing allowance and retains verification limits in metadata', () => {
    const messages = [{ role: 'system' as const, content: 'You are helpful.' }, { role: 'user' as const, content: 'Hello world!' }];
    const count = countInput(messages);
    expect(count.inputTokens).toBe(18); // 7 content + 2 role + 6 message + 3 reply tokens.
    expect(count.counting).toMatchObject({ kind: 'reference', tokenizer: 'cl100k_base', framing: 'estimated-recipe', fallbackReason: null });
    expect(count.verified).toBe(false);
    expect(count.counting.limitations).toContain('no exact remote-limit guarantee');
  });

  it('gives identical budgets and allocations for existing, unknown and future model identifiers', () => {
    const settings = { title: 'Test', instructions: 'Continue the story.', character: '', persona: '', targetInputTokens: 5_000 };
    const turns = [turn(0)];
    const expected = assembleRequest(connection, settings, turns);
    for (const model of ['unknown', 'my-gpt-4o-clone', 'gemma-3-4b-it-custom', 'google/gemma-4-4b-it', 'google/gemma-3-4b-it:unknown', 'gpt-4o-2099-01-01', 'openai/gpt-4o']) {
      const request = assembleRequest({ ...connection, model }, settings, turns);
      expect(request.budget).toEqual(expected.budget);
      expect(request.layout).toEqual(expected.layout);
      expect(request.body.model).toBe(model);
    }
  });

  it('keeps 20 selected summaries, 252 archived turns and seven verbatim messages without premature compaction', () => {
    const turns = Array.from({ length: 256 }, (_, i) => turn(i));
    const summaries: SummaryNode[] = Array.from({ length: 20 }, (_, i) => ({ id: `summary-${i}`, revision: 0, level: 1, text: 'Mira entrusted Leon with a brass key and warned him about the cellar. '.repeat(18), turns: turns.slice(i * 12, i === 19 ? 252 : (i + 1) * 12).map(t => ({ turnId: t.id, userRevision: 0, assistantRevision: 0, complete: true })), children: [], prior: [], approved: true, manual: false, createdAt: '2026-10-17' }));
    const snapshot: ChatSnapshot = { id: 'synthetic', revision: 0, connection, hasApiKey: false, sources: { prompt: null, persona: null, character: null }, settings: { title: 'Synthetic imported session', instructions: 'Continue the story.', character: '', persona: '', targetInputTokens: 10_000 }, turns, generations: [], context: { revision: 0, archivedTurnIds: turns.slice(0, 252).map(t => t.id), selected: summaries.map(({ id, revision }) => ({ id, revision })), summaries, jobs: [], preset: { ...defaultContextPreset, id: 'preset', revision: 0, minTail: 4 } } };
    const request = assembleRequest(connection, snapshot.settings, turns, snapshot.sources, snapshot.context);
    const previousByteAllowance = new TextEncoder().encode(JSON.stringify(request.body.messages)).length + 128 + request.body.messages.length * 16;
    expect(previousByteAllowance).toBeGreaterThan(10_000);
    expect(request.budget.inputTokens).toBeLessThan(10_000);
    expect(request.layout?.filter(part => part.kind === 'history')).toHaveLength(7);
    expect(request.coverage).toHaveLength(256);
    expect(request.context?.selected).toHaveLength(20);
    expect(request.layout!.reduce((sum, part) => sum + part.tokens, 0)).toBeLessThan(request.budget.inputTokens);
    expect(contextPlan(snapshot)).toMatchObject({ ready: true, next: null, inputTokens: request.budget.inputTokens, counting: { tokenizer: request.budget.counting!.tokenizer } });
    expect(() => assembleRequest(connection, { ...snapshot.settings, targetInputTokens: request.budget.inputTokens - 1 }, turns, snapshot.sources, snapshot.context)).toThrow('exceeds your target');
    expect(() => assembleRequest({ ...connection, contextWindow: request.budget.inputTokens + connection.maxOutputTokens - 1 }, snapshot.settings, turns, snapshot.sources, snapshot.context)).toThrow('plus reserved output');
    const summary = summaryRequest(snapshot, { level: 1, turnIds: ['turn-252'], children: [] }, { ...connection, model: 'gpt-4o' }).request;
    expect(summary.budget.counting?.tokenizer).toBe('cl100k_base');
    expect(summary.budget.inputTokens).toBe(countInput(summary.body.messages).inputTokens);
    expect(snapshot.context.archivedTurnIds).toHaveLength(252);
  });
});
