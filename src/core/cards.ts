import { characterSchema, personaSchema, type Character, type Persona } from '../shared/library.js';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a card JSON object.');
  return value as Record<string, unknown>;
}
export function importCharacter(value: unknown): Character {
  const source = object(value);
  if (source.spec !== undefined && !['chara_card_v2', 'chara_card_v3'].includes(source.spec as string)) throw new Error('Only legacy, Character Card V2 and V3 cards are supported.');
  const data = source.spec === 'chara_card_v2' || source.spec === 'chara_card_v3' ? object(source.data) : source;
  const fields = Object.fromEntries(['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example'].map(key => [key, data[key] ?? '']));
  return characterSchema.parse({ ...fields, source });
}
export function exportCharacter(card: Character): Record<string, unknown> {
  const original = card.source ?? {};
  const oldData = original.spec === 'chara_card_v2' || original.spec === 'chara_card_v3' ? object(original.data) : original;
  const { source: _source, ...fields } = characterSchema.parse(card);
  return { ...original, ...fields, spec: original.spec === 'chara_card_v3' ? 'chara_card_v3' : 'chara_card_v2', spec_version: original.spec === 'chara_card_v3' ? '3.0' : '2.0', data: {
    creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [], tags: [], creator: '', character_version: '', extensions: {},
    ...oldData, ...fields,
  } };
}
export function importPersonas(value: unknown): Persona[] {
  const data = object(value);
  if (data.personas !== undefined) {
    const names = object(data.personas), descriptions = object(data.persona_descriptions);
    const entries = Object.entries(names);
    if (entries.length === 0 || entries.length > 1000) throw new Error('Import between 1 and 1000 personas at a time.');
    return entries.map(([key, name]) => personaSchema.parse({ name, description: descriptions[key] ? object(descriptions[key]).description ?? '' : '' }));
  }
  const card = data.spec === 'chara_card_v2' || data.spec === 'chara_card_v3' ? object(data.data) : data;
  return [personaSchema.parse({ name: card.name, description: card.description ?? '' })];
}
export function exportPersona(persona: Persona) {
  return { personas: { 'roleplay-persona.png': persona.name }, persona_descriptions: { 'roleplay-persona.png': { description: persona.description, position: 0, depth: 2, role: 0 } }, default_persona: null };
}
