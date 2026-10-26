import { describe, expect, it } from 'vitest';
import { assembleRequest } from '../src/core/prompt.js';
import { resolveLore } from '../src/core/lorebook.js';
import { countInput } from '../src/core/tokens.js';
import { promptSchema, type PromptSources } from '../src/shared/library.js';
import { lorebookSchema, newLorebook, newLoreEntry } from '../src/shared/lorebook.js';

const connection = { name: 'Synthetic', endpoint: 'http://localhost/v1', model: 'synthetic', contextWindow: 10000, maxOutputTokens: 100, customParameters: {} };
const settings = { title: 'Fields', instructions: '', character: '', persona: '', targetInputTokens: 5000 };
const character = { id: 'card', revision: 2, name: 'Mira', description: '{{char}} meets {{user}}.', personality: 'Patient', scenario: 'Tower', mes_example: 'Example', first_mes: 'GREETING EXCLUDED' };
function sources(blocks: unknown[]): PromptSources {
  return { prompt: { ...promptSchema.parse({ name: 'Fields', blocks }), id: 'preset', revision: 1 }, character, persona: { id: 'persona', revision: 1, name: 'Leon', description: '' } };
}
const marker = (id: string, source = 'character', fields?: string[]) => ({ id, name: id, kind: 'marker', marker: source, enabled: true, role: 'user', ...(fields ? { fields } : {}) });
const request = (input: PromptSources) => assembleRequest(connection, settings, [], input);

describe('Character as selectable separate fields', () => {
  it('expands exactly like adjacent individual markers, with complete framing and field provenance', () => {
    const combined = request(sources([marker('Character')]));
    const separate = request(sources(['name', 'description', 'personality', 'scenario', 'examples'].map(field => marker(field, field))));
    expect(combined.body.messages).toEqual([
      { role: 'user', content: 'Mira' }, { role: 'user', content: 'Mira meets Leon.' },
      { role: 'user', content: 'Patient' }, { role: 'user', content: 'Tower' }, { role: 'user', content: 'Example' },
    ]);
    expect(combined.body).toEqual(separate.body);
    expect(combined.budget).toEqual(separate.budget);
    expect(combined.budget.inputTokens).toBe(countInput(combined.body.messages).inputTokens);
    expect(combined.layout?.map(part => part.label)).toEqual(['Name', 'Description', 'Personality', 'Scenario', 'Example dialogue']);
    expect(combined.layout?.map(part => part.labelMessage?.key)).toEqual([
      'labels.characterField.name', 'labels.characterField.description', 'labels.characterField.personality',
      'labels.characterField.scenario', 'labels.characterField.examples',
    ]);
    expect(separate.layout?.every(part => part.labelMessage === undefined)).toBe(true);
    expect(combined.layout?.every(part => part.group?.id === 'Character')).toBe(true);
  });

  it('uses canonical order, omits unchecked/empty fields, and keeps names available for macros', () => {
    const input = sources([marker('Character', 'character', ['scenario', 'description', 'examples'])]);
    input.character = { ...character, scenario: '  ' };
    expect(request(input).body.messages).toEqual([{ role: 'user', content: 'Mira meets Leon.' }, { role: 'user', content: 'Example' }]);
    expect(() => request(sources([marker('Character', 'character', [])]))).toThrow('resolved prompt is empty');
    expect(promptSchema.safeParse({ name: 'Empty group', blocks: [marker('Character', 'character', [])] }).success).toBe(true);
    for (const fields of [['first_mes'], ['description', 'description']]) {
      expect(promptSchema.safeParse({ name: 'Invalid', blocks: [marker('Character', 'character', fields)] }).success).toBe(false);
    }
    expect(promptSchema.safeParse({ name: 'Invalid', blocks: [marker('Persona', 'persona', ['description'])] }).success).toBe(false);
  });

  it('enforces the complete framing cost without dropping any selected field', () => {
    const input = sources([marker('Character')]), full = request(input);
    expect(assembleRequest(connection, { ...settings, targetInputTokens: full.budget.inputTokens }, [], input).body).toEqual(full.body);
    expect(() => assembleRequest(connection, { ...settings, targetInputTokens: full.budget.inputTokens - 1 }, [], input)).toThrow('exceeds your target');
    expect(() => assembleRequest({ ...connection, contextWindow: full.budget.inputTokens + 99 }, settings, [], input)).toThrow('Connection context window');
  });

  it('anchors automatic lore to included fields and group boundaries, without lore controls', async () => {
    const input = sources([marker('Character', 'character', ['description', 'scenario']), marker('Later', 'personality')]);
    const entries = [
      ['before_char', 'Before'], ['after_char', 'After'], ['before_desc', 'Before description'],
      ['after_desc', 'After description'], ['personality', 'After personality'], ['scenario', 'After scenario'],
      ['history', 'NO HISTORY'],
    ].map(([placement, content], index) => ({ ...newLoreEntry(String(index)), placement, content, constant: true }));
    input.lorebook = { ...lorebookSchema.parse({ ...newLorebook(), entries }), id: 'book', revision: 1 };
    const lore = await resolveLore({ book: input.lorebook, sources: input, turns: [], state: { epoch: 0, entries: {} } }, async () => ({ matched: false }));
    const result = assembleRequest(connection, settings, [], input, undefined, { lore });
    expect(result.body.messages.map(message => message.content)).toEqual(['Before', 'Before description', 'Mira meets Leon.', 'After description', 'Tower', 'After scenario', 'Patient', 'After personality', 'After']);
    expect(result.body.messages.filter(message => message.content === 'Before')[0].role).toBe('system');
    expect(lore.outcomes.find(outcome => outcome.id === '6')?.reason).toBe('unavailable_destination');
    const historical = { ...lore, outcomes: lore.outcomes.map(outcome => outcome.destination ? { ...outcome, destination: { ...outcome.destination, controlId: 'retired-control' } } : outcome) };
    const before = structuredClone(historical);
    expect(() => assembleRequest(connection, settings, [], input, undefined, { lore: historical })).toThrow('older prompt layout');
    expect(historical).toEqual(before);
  });
});
