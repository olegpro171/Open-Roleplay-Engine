import { z } from 'zod';

export const cardInstructionTextSchema = z.string().max(100_000);
export const characterDepthPromptSchema = z.object({
  prompt: cardInstructionTextSchema,
  depth: z.number().int().min(0).max(1000).default(2),
  role: z.enum(['system', 'user', 'assistant']).default('system'),
}).strict();
export type CharacterDepthPrompt = z.infer<typeof characterDepthPromptSchema>;
export const cardInstructionFields = ['system_prompt', 'post_history_instructions'] as const;
export type CardInstructionField = typeof cardInstructionFields[number];
export const cardInstructionLabels: Record<CardInstructionField, string> = {
  system_prompt: 'Card system prompt', post_history_instructions: 'Card post-history instructions',
};
type InstructionSource = {
  source?: Record<string, unknown>;
  system_prompt?: string;
  post_history_instructions?: string;
  depth_prompt?: CharacterDepthPrompt;
};
const recordSchema = z.record(z.string(), z.unknown());
function sourceData(card: InstructionSource) {
  const source = card.source ?? {};
  return source.spec === 'chara_card_v2' || source.spec === 'chara_card_v3'
    ? recordSchema.safeParse(source.data) : recordSchema.safeParse(source);
}

/** Explicit edited fields, including empty text, supersede preserved imports. */
export function readCardInstruction(card: InstructionSource, field: CardInstructionField) {
  if (card[field] !== undefined) return cardInstructionTextSchema.safeParse(card[field]);
  const data = sourceData(card);
  const value = data.success ? data.data[field] : null;
  return cardInstructionTextSchema.safeParse(value === undefined ? '' : value);
}

export function readCharacterDepthPrompt(card: InstructionSource) {
  if (card.depth_prompt !== undefined) return characterDepthPromptSchema.safeParse(card.depth_prompt);
  const data = sourceData(card);
  if (!data.success) return characterDepthPromptSchema.safeParse(null);
  const extensions = recordSchema.safeParse(data.data.extensions === undefined ? {} : data.data.extensions);
  if (!extensions.success) return characterDepthPromptSchema.safeParse(null);
  const raw = extensions.data.depth_prompt;
  if (raw === undefined) return characterDepthPromptSchema.safeParse({ prompt: '' });
  const note = recordSchema.safeParse(raw);
  // Unknown extension properties stay in source and are overlaid during export.
  return characterDepthPromptSchema.safeParse(note.success
    ? { prompt: note.data.prompt, depth: note.data.depth, role: note.data.role } : null);
}
