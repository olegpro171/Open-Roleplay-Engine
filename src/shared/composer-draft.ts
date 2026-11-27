import { z } from 'zod';

const revision = z.number().int().nonnegative();
export const composerEditSchema = z.object({ editorId: z.string().uuid(), sequence: revision }).strict();
export const composerDraftReferenceSchema = z.object({
  baseRevision: revision.nullable(),
  edit: composerEditSchema,
}).strict();
export const composerDraftSaveSchema = composerDraftReferenceSchema.extend({ text: z.string().max(100_000), replaceAtBranchRevision: revision.optional() });
export const composerDraftSchema = z.object({
  revision,
  sentRevision: revision,
  text: composerDraftSaveSchema.shape.text,
  edit: composerEditSchema.nullable(),
}).strict();

export type ComposerEdit = z.infer<typeof composerEditSchema>;
export type ComposerDraftReference = z.infer<typeof composerDraftReferenceSchema>;
export type ComposerDraftSave = z.infer<typeof composerDraftSaveSchema>;
export type ComposerDraft = z.infer<typeof composerDraftSchema>;

export function sameComposerEdit(a: ComposerEdit | null, b: ComposerEdit) {
  return a?.editorId === b.editorId && a.sequence === b.sequence;
}
