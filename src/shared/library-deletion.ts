import { z } from 'zod';
import { libraryKindSchema } from './library.js';

const identity = z.string().min(1).max(100);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const deleteLorebookId = identity.optional();
export const libraryDeletionChoiceSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('clear'), deleteLorebookId }).strict(),
  z.object({ mode: z.literal('replace'), replacementId: identity, deleteLorebookId }).strict(),
]);
export const libraryDeletionCommandSchema = z.object({
  kind: libraryKindSchema,
  requestId: z.string().uuid(),
  token: digest,
  choice: libraryDeletionChoiceSchema,
}).strict();
export const libraryDeletionQuerySchema = z.object({
  kind: libraryKindSchema,
  replacementId: identity.optional(),
  deleteLorebookId,
}).strict();

const namedItem = z.object({ id: identity, name: z.string() }).strict();
const affectedBranch = namedItem.extend({ branchName: z.string().nullable() });
const blocker = z.object({
  reason: z.enum(['busy', 'repair', 'excluded', 'layout', 'replacement', 'lorebook_unavailable']),
  branches: z.array(affectedBranch),
}).strict();
export const libraryDeletionReviewSchema = z.object({
  target: namedItem,
  linkedLorebook: namedItem.extend({ inUse: z.boolean() }).optional(),
  dependencies: z.object({
    chats: z.array(namedItem.extend({ direct: z.boolean(), memoryPreset: namedItem.nullable() })),
    characters: z.array(namedItem),
    contexts: z.array(namedItem),
  }).strict(),
  replacements: z.array(namedItem),
  bookmark: z.object({ fallback: namedItem.nullable() }).strict().nullable(),
  blockers: z.array(blocker),
  version: digest,
  action: z.object({
    choice: libraryDeletionChoiceSchema,
    token: digest,
    blockers: z.array(blocker),
  }).strict(),
}).strict();
export const libraryDeletionResultSchema = z.object({ ok: z.literal(true) }).strict();

export type LibraryDeletionReview = z.infer<typeof libraryDeletionReviewSchema>;
export type LibraryDeletionChoice = z.infer<typeof libraryDeletionChoiceSchema>;
export type LibraryDeletionCommand = z.infer<typeof libraryDeletionCommandSchema>;
