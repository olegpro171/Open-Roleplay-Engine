import { z } from 'zod';
import { characterFields, promptSchema, type PromptPreset } from '../shared/library.js';

// Older exported/saved presets may contain the three retired lore controls.
// Validate those blocks before removing them; unknown sources still fail.
const retiredBlock = z.object({
  id: z.string().min(1).max(100), name: z.string().trim().min(1).max(100), enabled: z.boolean(),
  kind: z.literal('marker'), role: z.enum(['system', 'user', 'assistant']),
  marker: z.enum(['lore_before', 'lore_after', 'lore_history']),
}).strict();
const importSchema = z.object({ name: z.string().trim().min(1).max(100), blocks: z.array(z.record(z.string(), z.unknown())).max(100) }).strict();

export function upgradePrompt(value: unknown): PromptPreset {
  const input = importSchema.parse(value);
  const blocks = input.blocks.filter(block => !retiredBlock.safeParse(block).success).map(block => {
    return block.kind === 'marker' && block.marker === 'character' && block.fields === undefined ? { ...block, fields: [...characterFields] } : block;
  });
  return promptSchema.parse({ ...input, blocks });
}
