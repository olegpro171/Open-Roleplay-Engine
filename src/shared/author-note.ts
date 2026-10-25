import { z } from 'zod';

export const authorNoteSchema = z.object({
  prompt: z.string().max(100_000),
  depth: z.number().int().min(0).max(1000),
  role: z.enum(['system', 'user', 'assistant']),
}).strict();
export type AuthorNote = z.infer<typeof authorNoteSchema>;
export const defaultAuthorNote: AuthorNote = { prompt: '', depth: 2, role: 'system' };
export const authorNoteStatusSchema = z.object({
  revision: z.number().int().nonnegative(), settings: authorNoteSchema,
}).strict();
export type AuthorNoteStatus = z.infer<typeof authorNoteStatusSchema>;
