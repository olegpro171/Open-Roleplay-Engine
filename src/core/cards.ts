import { readCharacterAlternateGreetings, characterSchema, libraryCharacterSchema, personaSchema, type Character, type LibraryCharacter, type Persona } from '../shared/library.js';
import type { Lorebook } from '../shared/lorebook.js';
import { exportLorebook } from './lorebook-formats.js';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a card JSON object.');
  return value as Record<string, unknown>;
}
export function importCharacter(value: unknown): Character {
  const source = object(value);
  if (source.spec !== undefined && !['chara_card_v2', 'chara_card_v3'].includes(source.spec as string)) throw new Error('Only legacy, Character Card V2 and V3 cards are supported.');
  const data = source.spec === 'chara_card_v2' || source.spec === 'chara_card_v3' ? object(source.data) : source;
  const fields = Object.fromEntries(['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example'].map(key => [key, data[key] ?? '']));
  return characterSchema.parse({ ...fields, ...(data.alternate_greetings !== undefined ? { alternate_greetings: data.alternate_greetings } : {}), source });
}
export function exportCharacter(card: LibraryCharacter, linkedBook?: Lorebook | null): Record<string, unknown> {
  const original = card.source ?? {};
  const oldData = original.spec === 'chara_card_v2' || original.spec === 'chara_card_v3' ? object(original.data) : original;
  const { source: _source, lorebookId: _lorebookId, titleComment: _titleComment, depth_prompt, ...fields } = libraryCharacterSchema.parse(card);
  const greetings = readCharacterAlternateGreetings(card);
  const result = { ...original, ...fields, spec: original.spec === 'chara_card_v3' ? 'chara_card_v3' : 'chara_card_v2', spec_version: original.spec === 'chara_card_v3' ? '3.0' : '2.0', data: {
    creator_notes: '', system_prompt: '', post_history_instructions: '', tags: [], creator: '', character_version: '', extensions: {},
    ...oldData, ...fields, ...(greetings.success ? { alternate_greetings: greetings.data } : {}),
  } };
  if (depth_prompt !== undefined) {
    // An explicit note replacement also repairs an invalid extension container.
    // Unrelated saves keep that original value because depth_prompt is absent.
    const preserved = oldData.extensions && typeof oldData.extensions === 'object' && !Array.isArray(oldData.extensions) ? object(oldData.extensions) : {};
    const oldNote = preserved.depth_prompt && typeof preserved.depth_prompt === 'object' && !Array.isArray(preserved.depth_prompt) ? object(preserved.depth_prompt) : {};
    result.data.extensions = { ...preserved, depth_prompt: { ...oldNote, ...depth_prompt } };
  }
  // An explicit relation, including None, supersedes the preserved import.
  // Absence exists only on older, not-yet-extracted cards.
  if (linkedBook !== undefined) {
    const output: Record<string, unknown> = result.data;
    if (linkedBook) {
      const exported = exportLorebook(linkedBook, original.spec === 'chara_card_v3' ? 'v3' : 'v2');
      output.character_book = original.spec === 'chara_card_v3' ? exported.data : exported;
    } else delete output.character_book;
    delete (result as Record<string, unknown>).character_book;
  }
  return result;
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
