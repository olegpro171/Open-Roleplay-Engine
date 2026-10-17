import { z } from 'zod';
import { connectionSchema, revisionSchema, type Connection } from './contracts.js';
import { contextPresetSchema, type ContextPreset } from './context.js';

const name = z.string().trim().min(1).max(100);
const text = z.string().max(100_000);
export const personaSchema = z.object({ name, description: text }).strict();
export const characterSchema = z.object({
  name, description: text, personality: text, scenario: text, first_mes: text, mes_example: text,
  source: z.record(z.string(), z.unknown()).optional(),
}).strict();
export const markers = ['character', 'persona', 'description', 'personality', 'scenario', 'examples', 'messages', 'summary'] as const;
const blockBase = { id: z.string().min(1).max(100), name, enabled: z.boolean() };
export const promptBlockSchema = z.discriminatedUnion('kind', [
  z.object({ ...blockBase, kind: z.literal('text'), role: z.enum(['system', 'user', 'assistant']), text }).strict(),
  z.object({ ...blockBase, kind: z.literal('marker'), role: z.enum(['system', 'user', 'assistant']), marker: z.enum(markers) }).strict(),
]);
export const promptSchema = z.object({ name, blocks: z.array(promptBlockSchema).min(1).max(100) }).strict().superRefine((value, ctx) => {
  if (new Set(value.blocks.map(b => b.id)).size !== value.blocks.length) ctx.addIssue({ code: 'custom', message: 'Block identities must be unique.' });
  if (value.blocks.filter(b => b.enabled && b.kind === 'marker' && b.marker === 'messages').length !== 1) ctx.addIssue({ code: 'custom', message: 'Include exactly one enabled Messages marker to preserve history.' });
  if (value.blocks.filter(b => b.enabled && b.kind === 'marker' && b.marker === 'summary').length > 1) ctx.addIssue({ code: 'custom', message: 'Use at most one enabled Summary marker.' });
});
export type Persona = z.infer<typeof personaSchema>;
export type Character = z.infer<typeof characterSchema>;
export type PromptPreset = z.infer<typeof promptSchema>;
export type PromptBlock = z.infer<typeof promptBlockSchema>;
export type LibraryKind = 'personas' | 'characters' | 'prompts' | 'connections' | 'contexts';
export type Saved<T> = T & { id: string; revision: number };
export type PromptSources = { prompt: Saved<PromptPreset> | null; character: Saved<Character> | null; persona: Saved<Persona> | null };
export type ChatSummary = { id: string; title: string; revision: number; turnCount: number; running: boolean };
export type LibrarySnapshot = {
  revision: number; personas: Saved<Persona>[]; characters: Saved<Character>[]; prompts: Saved<PromptPreset>[];
  connections: (Saved<Connection> & { hasApiKey: boolean })[]; chats: ChatSummary[];
  contexts: Saved<ContextPreset>[];
};
export const defaultPrompt: PromptPreset = {
  name: 'Default roleplay', blocks: [
    { id: 'instructions', name: 'Instructions', enabled: true, kind: 'text', role: 'system', text: 'Write the next response in this roleplay. Stay consistent with the established story.' },
    { id: 'character', name: 'Character', enabled: true, kind: 'marker', role: 'system', marker: 'character' },
    { id: 'persona', name: 'Persona', enabled: true, kind: 'marker', role: 'system', marker: 'persona' },
    { id: 'messages', name: 'Messages', enabled: true, kind: 'marker', role: 'system', marker: 'messages' },
  ],
};
export const selectionsSchema = z.object({
  title: name, targetInputTokens: z.number().int().positive().max(10_000_000),
  connectionId: z.string().min(1).max(100).nullable(), promptId: z.string().min(1).max(100),
  characterId: z.string().min(1).max(100).nullable(), personaId: z.string().min(1).max(100).nullable(),
  contextPresetId: z.string().min(1).max(100).nullable().optional(),
}).strict();
export const libraryCommandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('personas'), revision: revisionSchema, data: personaSchema }).strict(),
  z.object({ kind: z.literal('characters'), revision: revisionSchema, data: characterSchema }).strict(),
  z.object({ kind: z.literal('prompts'), revision: revisionSchema, data: promptSchema }).strict(),
  z.object({ kind: z.literal('contexts'), revision: revisionSchema, data: contextPresetSchema }).strict(),
  z.object({ kind: z.literal('connections'), revision: revisionSchema, data: connectionSchema, apiKey: z.string().max(10_000).refine(v => !/[\r\n]/.test(v)).optional() }).strict(),
]);
export const importedTurnSchema = z.object({ user: text, assistant: text, complete: z.boolean() }).strict();
export const replaceHistorySchema = z.object({ revision: revisionSchema, turns: z.array(importedTurnSchema).min(1).max(50_000) }).strict().superRefine((value, ctx) => {
  if (value.turns.some((t, i) => !t.complete && (i !== value.turns.length - 1 || t.assistant !== ''))) ctx.addIssue({ code: 'custom', message: 'Only the final turn may await an assistant response.' });
  if (value.turns.reduce((n, t) => n + t.user.length + t.assistant.length, 0) > 20_000_000) ctx.addIssue({ code: 'custom', message: 'The active transcript exceeds the 20 million character import limit.' });
});
export type ImportedTurn = z.infer<typeof importedTurnSchema>;
