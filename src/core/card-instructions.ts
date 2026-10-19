import { readCardInstruction, cardInstructionLabels, type CardInstructionField } from '../shared/card-instructions.js';
import type { Character } from '../shared/library.js';
import { AppError } from './errors.js';
import { replaceNameMacros } from './names.js';

export function resolveCardInstruction(card: Character | null | undefined, field: CardInstructionField, fallback: string, userName: string) {
  const value = readCardInstruction(card ?? {}, field);
  if (!value.success) throw new AppError(422, 'invalid_card_instruction', `${cardInstructionLabels[field]} is invalid. Edit the character to clear or replace it before generating.`);
  const characterName = card?.name ?? 'Character';
  const original = replaceNameMacros(fallback, userName, characterName);
  if (!value.data.trim()) return { text: original, fallback: true };
  // A single pass prevents card text, fallback text and substituted names from
  // recursively interpreting one another's macros.
  const text = value.data.replace(/{{\s*(original|user|char)\s*}}/gi, (_match, key: string) => {
    switch (key.toLowerCase()) {
      case 'original': return original;
      case 'user': return userName;
      default: return characterName;
    }
  });
  return { text, fallback: false };
}
