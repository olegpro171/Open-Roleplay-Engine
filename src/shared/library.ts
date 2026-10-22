import { message, type LocalizedMessage } from './localization.js';
import { pictureMutationSchema, type CharacterPicture } from './pictures.js';
import { tagIdsSchema, type Tag, type CharacterTag } from './tags.js';
import { z } from 'zod';
import { connectionSchema, revisionSchema, type Connection } from './contracts.js';
import { contextPresetSchema, type ContextPreset } from './context.js';
import { lorebookSchema, type Lorebook } from './lorebook.js';
import { cardInstructionTextSchema, characterDepthPromptSchema } from './card-instructions.js';
import { speechColorSchema } from './appearance.js';

const name = z.string().trim().min(1).max(100);
const text = z.string().max(100_000);
const titleComment = z.string().trim().max(200).refine(value => !/[\r\n]/.test(value), 'Use a single line.').optional();
// Omission preserves existing metadata; null explicitly clears a saved color.
const speechColor = speechColorSchema.nullable().optional();
export const maxAlternateGreetings = 1000;
const alternateGreetingsSchema = z.array(text).max(maxAlternateGreetings);
export const personaSchema = z.object({ name, description: text }).strict();
export const libraryPersonaSchema = personaSchema.extend({ titleComment, speechColor });
export const characterSchema = z.object({
  name, description: text, personality: text, scenario: text, first_mes: text, mes_example: text,
  alternate_greetings: alternateGreetingsSchema.optional(),
  system_prompt: cardInstructionTextSchema.optional(),
  post_history_instructions: cardInstructionTextSchema.optional(),
  depth_prompt: characterDepthPromptSchema.optional(),
  source: z.record(z.string(), z.unknown()).optional(),
  lorebookId: z.string().min(1).max(100).nullable().optional(),
}).strict();
// Local library metadata is deliberately absent from prompt-bearing Character.
export const libraryCharacterSchema = characterSchema.extend({
  titleComment, speechColor,
});
export type LibraryCharacter = z.infer<typeof libraryCharacterSchema>;
export function characterLabel(character: { name: string; titleComment?: string }): string {
  return character.titleComment ? `${character.name} · ${character.titleComment}` : character.name;
}
export const personaLabel = characterLabel;
export const characterFields = ['name', 'description', 'personality', 'scenario', 'examples'] as const;
export type CharacterField = typeof characterFields[number];
export const characterFieldLabels: Record<CharacterField, string> = { name: 'Name', description: 'Description', personality: 'Personality', scenario: 'Scenario', examples: 'Example dialogue' };
export const markers = ['character', 'persona', ...characterFields, 'messages', 'summary', 'card_system_prompt', 'card_post_history_instructions'] as const;
export function markerLabel(marker: typeof markers[number]): string {
  if (marker === 'card_system_prompt') return 'Card system prompt';
  if (marker === 'card_post_history_instructions') return 'Card post-history instructions';
  return marker[0].toUpperCase() + marker.slice(1);
}
const blockBase = { id: z.string().min(1).max(100), name, enabled: z.boolean() };
export const promptBlockSchema = z.discriminatedUnion('kind', [
  z.object({ ...blockBase, kind: z.literal('text'), role: z.enum(['system', 'user', 'assistant']), text }).strict(),
  z.object({ ...blockBase, kind: z.literal('marker'), role: z.enum(['system', 'user', 'assistant']), marker: z.enum(markers), fields: z.array(z.enum(characterFields)).max(characterFields.length).optional(), fallback: text.optional(), allowDepthPrompt: z.boolean().optional() }).strict().superRefine((block, ctx) => {
    if (block.fields !== undefined && block.marker !== 'character') ctx.addIssue({ code: 'custom', path: ['fields'], message: 'Only Character supports a field selection.' });
    if (block.fields && new Set(block.fields).size !== block.fields.length) ctx.addIssue({ code: 'custom', path: ['fields'], message: 'Character fields must be unique.' });
    if (block.fallback !== undefined && block.marker !== 'card_system_prompt' && block.marker !== 'card_post_history_instructions') ctx.addIssue({ code: 'custom', path: ['fallback'], message: 'Only card instruction markers support fallback text.' });
    if (block.allowDepthPrompt !== undefined && block.marker !== 'messages') ctx.addIssue({ code: 'custom', path: ['allowDepthPrompt'], message: 'Only Messages permits character depth injection.' });
  }),
]);
export const promptSchema = z.object({ name, blocks: z.array(promptBlockSchema).max(100) }).strict().superRefine((value, ctx) => {
  if (new Set(value.blocks.map(b => b.id)).size !== value.blocks.length) ctx.addIssue({ code: 'custom', message: 'Block identities must be unique.' });
  if (value.blocks.filter(b => b.enabled && b.kind === 'marker' && b.marker === 'messages').length > 1) ctx.addIssue({ code: 'custom', message: 'Use at most one enabled Messages marker.' });
  if (value.blocks.filter(b => b.enabled && b.kind === 'marker' && b.marker === 'summary').length > 1) ctx.addIssue({ code: 'custom', message: 'Use at most one enabled Summary marker.' });
  for (const marker of ['card_system_prompt', 'card_post_history_instructions'] as const) {
    if (value.blocks.filter(b => b.enabled && b.kind === 'marker' && b.marker === marker).length > 1) ctx.addIssue({ code: 'custom', message: `Use at most one enabled ${markerLabel(marker)} marker.` });
  }
});
export type Persona = z.infer<typeof personaSchema>;
export type LibraryPersona = z.infer<typeof libraryPersonaSchema>;
export type Character = z.infer<typeof characterSchema>;
/** Older imports retain this field only inside their original card metadata. */
export function readCharacterAlternateGreetings(card: Pick<Character, 'alternate_greetings' | 'source'>) {
  if (card.alternate_greetings !== undefined) return alternateGreetingsSchema.safeParse(card.alternate_greetings);
  const source = card.source;
  const data = source?.spec === 'chara_card_v2' || source?.spec === 'chara_card_v3' ? source.data : source;
  const value = data && typeof data === 'object' && 'alternate_greetings' in data ? data.alternate_greetings : [];
  return alternateGreetingsSchema.safeParse(value);
}
export type PromptPreset = z.infer<typeof promptSchema>;
export type PromptBlock = z.infer<typeof promptBlockSchema>;
export type LibraryKind = 'personas' | 'characters' | 'prompts' | 'connections' | 'contexts' | 'lorebooks';
export type Saved<T> = T & { id: string; revision: number };
export type PromptSources = { prompt: Saved<PromptPreset> | null; character: Saved<Character> | null; persona: Saved<Persona> | null; lorebook?: Saved<Lorebook> | null };
export type LibraryDates = { createdAt: string | null; updatedAt: string | null };
export type ChatSummary = LibraryDates & { lastMessageAt: string | null; id: string; title: string; characterId: string | null; revision: number; turnCount: number; running: boolean };
export type UnchangedLibrary = { unchanged: true; revision: number; chats: ChatSummary[] };
export type LibrarySnapshot = {
  dates: Record<string, LibraryDates>;
  characterPictures: CharacterPicture[];
  tags: Tag[]; characterTags: CharacterTag[];
  revision: number; personas: Saved<LibraryPersona>[]; characters: Saved<LibraryCharacter>[]; prompts: Saved<PromptPreset>[];
  connections: (Saved<Connection> & { hasApiKey: boolean })[]; chats: ChatSummary[];
  contexts: Saved<ContextPreset>[];
  lorebooks: Saved<Lorebook>[];
  lorebookUses: { bookId: string; characters: { id: string; name: string; titleComment?: string }[]; chats: { id: string; title: string }[] }[];
};
export const defaultInstructions = 'Write the next response in this roleplay. Stay consistent with the established story.';
export const defaultPrompt: PromptPreset = {
  name: 'Default prompt', blocks: [
    { id: 'instructions', name: 'Card system prompt', enabled: true, kind: 'marker', role: 'system', marker: 'card_system_prompt', fallback: defaultInstructions },
    { id: 'character', name: 'Character', enabled: true, kind: 'marker', role: 'system', marker: 'character', fields: [...characterFields] },
    { id: 'persona', name: 'Persona', enabled: true, kind: 'marker', role: 'system', marker: 'persona' },
    { id: 'summary', name: 'Summary', enabled: true, kind: 'marker', role: 'system', marker: 'summary' },
    { id: 'messages', name: 'Messages', enabled: true, kind: 'marker', role: 'system', marker: 'messages', allowDepthPrompt: true },
    { id: 'post-history', name: 'Card post-history instructions', enabled: true, kind: 'marker', role: 'system', marker: 'card_post_history_instructions', fallback: '' },
  ],
};
export function hasPromptMarker(prompt: PromptPreset | null | undefined, marker: typeof markers[number]): boolean {
  return (prompt ?? defaultPrompt).blocks.some(block => block.enabled && block.kind === 'marker' && block.marker === marker);
}

/** Reusable presets have no chat-specific sources or turn counts. */
export function promptWarningMessages(prompt: PromptPreset): LocalizedMessage[] {
  const warnings: LocalizedMessage[] = [];
  if (!hasPromptMarker(prompt, 'summary')) warnings.push(message('warnings.noSummary'));
  if (!hasPromptMarker(prompt, 'messages')) warnings.push(message('warnings.noMessages'));
  if (!hasPromptMarker(prompt, 'persona')) warnings.push(message('warnings.noPersona'));
  const characterEnabled = prompt.blocks.some(block => block.enabled && block.kind === 'marker' && (
    block.marker === 'character' ? (block.fields ?? characterFields).length > 0 : characterFields.some(field => field === block.marker)
  ));
  if (!characterEnabled) warnings.push(message('warnings.noCharacter'));
  return warnings;
}
export function promptWarnings(prompt: PromptPreset): string[] { return promptWarningMessages(prompt).map(value => value.fallback); }

export const selectionsSchema = z.object({
  title: name, targetInputTokens: z.number().int().positive().max(10_000_000),
  connectionId: z.string().min(1).max(100).nullable(), promptId: z.string().min(1).max(100),
  characterId: z.string().min(1).max(100).nullable(), personaId: z.string().min(1).max(100).nullable(),
  contextPresetId: z.string().min(1).max(100).nullable().optional(),
  lorebookId: z.string().min(1).max(100).nullable().optional(),
}).strict();
// Omitted selections use current server defaults; explicit selections remain authoritative.
export const createChatSchema = selectionsSchema.partial({ connectionId: true, promptId: true });
export const libraryCommandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('personas'), revision: revisionSchema, data: libraryPersonaSchema }).strict(),
  z.object({ kind: z.literal('characters'), revision: revisionSchema, data: libraryCharacterSchema, tagIds: tagIdsSchema.optional(), requestId: z.string().uuid().optional(), expectedPicture: z.string().uuid().nullable().optional(), picture: pictureMutationSchema.optional() }).strict(),
  z.object({ kind: z.literal('prompts'), revision: revisionSchema, data: promptSchema }).strict(),
  z.object({ kind: z.literal('contexts'), revision: revisionSchema, data: contextPresetSchema }).strict(),
  z.object({ kind: z.literal('lorebooks'), revision: revisionSchema, data: lorebookSchema }).strict(),
  z.object({ kind: z.literal('connections'), revision: revisionSchema, data: connectionSchema, apiKey: z.string().max(10_000).refine(v => !/[\r\n]/.test(v)).optional() }).strict(),
]);
export const importedTurnSchema = z.object({ user: text, assistant: text, complete: z.boolean() }).strict();
export const replaceHistorySchema = z.object({ revision: revisionSchema, turns: z.array(importedTurnSchema).min(1).max(50_000) }).strict().superRefine((value, ctx) => {
  if (value.turns.some((t, i) => !t.complete && (i !== value.turns.length - 1 || t.assistant !== ''))) ctx.addIssue({ code: 'custom', message: 'Only the final turn may await an assistant response.' });
  if (value.turns.reduce((n, t) => n + t.user.length + t.assistant.length, 0) > 20_000_000) ctx.addIssue({ code: 'custom', message: 'The active transcript exceeds the 20 million character import limit.' });
});
export type ImportedTurn = z.infer<typeof importedTurnSchema>;

export type CharacterSaveCommand = Extract<z.infer<typeof libraryCommandSchema>, { kind: 'characters' }>;
