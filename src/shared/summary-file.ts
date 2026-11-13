import { z } from 'zod';
import { revisionSchema } from './contracts.js';
import type { SummaryNode } from './context.js';

export const summaryFileBytes = 25_000_000;
export const summaryUploadBytes = summaryFileBytes + 1_000;
const maxRecords = 100_000;
const branchOrTurnId = z.string().min(1).max(100);
const ref = z.strictObject({ id: z.uuid(), revision: revisionSchema });
const refs = z.array(ref).max(maxRecords);
const turnSource = z.strictObject({
  turnId: branchOrTurnId, userRevision: revisionSchema, assistantRevision: revisionSchema, complete: z.boolean(),
});
// A new promotion combines at least two children, so no real history can
// reach a higher layer within the safe integer range of turn positions.
const summary = ref.extend({
  level: revisionSchema.min(1).max(53), text: z.string().max(1_000_000), turns: z.array(turnSource).max(maxRecords),
  children: refs, prior: refs, corrections: refs.optional(), basedOn: ref.optional(), manual: z.boolean(),
}) satisfies z.ZodType<Omit<SummaryNode, 'approved' | 'createdAt' | 'refusalCheck' | 'regeneration'>>;

export const summaryFileSchema = z.strictObject({
  format: z.literal('ore-summaries'),
  version: z.literal(1),
  branchId: branchOrTurnId,
  branchCreatedAt: z.string().max(100).nullable(),
  selected: refs,
  archivedTurnIds: z.array(branchOrTurnId).max(maxRecords),
  summaries: z.array(summary).max(maxRecords),
});
export type SummaryFile = z.infer<typeof summaryFileSchema>;
export const summaryImportCommandSchema = z.strictObject({
  revision: revisionSchema,
  file: z.unknown(),
  token: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});

export const summaryImportPreviewSchema = z.strictObject({
  token: z.string().regex(/^[a-f0-9]{64}$/),
  existingVersions: revisionSchema,
  importedVersions: revisionSchema,
  archivedTurns: revisionSchema,
});
export type SummaryImportPreview = z.infer<typeof summaryImportPreviewSchema>;
