import { characterFields, type Character, type CharacterField, type PromptBlock } from '../shared/library.js';

/** One expansion defines both outgoing field messages and eligible lore anchors. */
export function characterParts(block: PromptBlock, card: Character | null | undefined, legacyDescription = ''): { field: CharacterField; text: string }[] {
  if (!block.enabled || block.kind !== 'marker') return [];
  const fields = block.marker === 'character'
    ? characterFields.filter(field => (block.fields ?? characterFields).includes(field))
    : characterFields.filter(field => field === block.marker);
  return fields.flatMap(field => {
    const text = card ? (field === 'examples' ? card.mes_example : card[field]) : field === 'description' ? legacyDescription : '';
    return text.trim() ? [{ field, text }] : [];
  });
}
