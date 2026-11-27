import { z } from 'zod';

export const backupLimits = { rows: 100_000, textBytes: 16 * 1024 * 1024, page: 40, ttlMs: 30 * 60_000 } as const;
export const backupTables = ['connections', 'library', 'tags', 'chat_groups', 'chats', 'turns', 'generations', 'response_variants', 'context_states', 'summaries', 'context_jobs', 'context_steps', 'lore_epochs', 'lore_states', 'lore_operations', 'character_tags', 'picture_assets', 'character_pictures', 'credentials'] as const;
export type BackupTable = typeof backupTables[number];
export const backupTableSchema = z.enum(backupTables);
export const backupMetadataSchema = z.object({
  format: z.literal('ore-sqlite'), version: z.literal(1), schema: z.number().int(),
  build: z.string().max(100), createdAt: z.string().datetime(),
}).strict();
export type BackupMetadata = z.infer<typeof backupMetadataSchema>;
const unitSchema = z.object({
  kind: z.enum(['chats', 'connections', 'library', 'tags']), id: z.string(), name: z.string(),
  overlap: z.boolean(), children: z.number().int().nonnegative(),
});
export type BackupUnit = z.infer<typeof unitSchema>;
const effectSchema = z.object({ id: z.string(), title: z.string(), reason: z.string() });
export const backupPlanSchema = z.object({
  token: z.string().length(64), units: z.array(unitSchema).max(backupLimits.rows),
  overlaps: z.number().int().nonnegative(), effects: z.array(effectSchema).max(backupLimits.rows), blockers: z.array(z.string()),
});
export const backupProgressSchema = z.object({
  phase: z.enum(['snapshot', 'sanitize', 'validate', 'references', 'compact', 'encrypt', 'decrypt', 'reconstruct', 'compare', 'merge', 'validateClean', 'referencesClean', 'validateMerged', 'referencesMerged']),
  done: z.number().int().nonnegative().optional(), total: z.number().int().nonnegative().optional(),
});
export type BackupProgress = z.infer<typeof backupProgressSchema>;
export type ReportBackupProgress = (phase: BackupProgress['phase'], done?: number, total?: number) => void;
export const backupReviewSchema = z.object({
  stageId: z.string().uuid(), digest: z.string().length(64), token: z.string().length(64),
  metadata: backupMetadataSchema.nullable(), expiresAt: z.string().datetime(),
  additions: z.number().int().nonnegative(), overlaps: z.number().int().nonnegative(),
  units: z.array(unitSchema).max(backupLimits.page), totalUnits: z.number().int().nonnegative(),
  effects: z.array(effectSchema).max(backupLimits.page),
  totalEffects: z.number().int().nonnegative(), blockers: z.array(z.string()),
});
export type BackupReview = z.infer<typeof backupReviewSchema>;
export type BackupPage = { table: BackupTable; offset: number; total: number; items: { key: number; label: string; chatId?: string }[] };
export type BackupLeaf = { label: string; text: string | null; textFields?: string[]; field?: string; imageUrl?: string; fields: { name: string; value: string }[]; offset: number; total: number };
export const dataCommandSchema = z.object({ requestId: z.string().uuid(), token: z.string().length(64), digest: z.string().length(64), overwrite: z.boolean() }).strict();
export type DataOutcome = { ok: true; epoch: string; kind: 'import' | 'wipe' };
