import { z } from 'zod';
import { protectedFileOverheadBytes } from './protected-files.js';

export const backupLimits = { bytes: 128 * 1024 * 1024, rows: 100_000, textBytes: 16 * 1024 * 1024, page: 40, ttlMs: 30 * 60_000 } as const;
export const backupFileMaxBytes = backupLimits.bytes + protectedFileOverheadBytes;
export const backupTables = ['connections', 'library', 'tags', 'chats', 'turns', 'generations', 'response_variants', 'context_states', 'summaries', 'context_jobs', 'context_steps', 'lore_epochs', 'lore_states', 'lore_operations', 'character_tags', 'picture_assets', 'character_pictures', 'credentials'] as const;
export type BackupTable = typeof backupTables[number];
export const backupTableSchema = z.enum(backupTables);
export type BackupMetadata = { format: 'ore-sqlite'; version: 1; schema: number; build: string; createdAt: string };
export type BackupUnit = { kind: 'chats' | 'connections' | 'library' | 'tags'; id: string; name: string; overlap: boolean; children: number };
export type BackupReview = {
  stageId: string; digest: string; token: string; metadata: BackupMetadata | null;
  additions: number; overlaps: number; units: BackupUnit[]; totalUnits: number;
  effects: { id: string; title: string; reason: string }[]; totalEffects: number;
  blockers: string[]; expiresAt: string;
};
export type BackupPage = { table: BackupTable; offset: number; total: number; items: { key: number; label: string; chatId?: string }[] };
export type BackupLeaf = { label: string; text: string | null; textFields?: string[]; field?: string; imageUrl?: string; fields: { name: string; value: string }[]; offset: number; total: number };
export const dataCommandSchema = z.object({ requestId: z.string().uuid(), token: z.string().length(64), digest: z.string().length(64), overwrite: z.boolean() }).strict();
export type DataOutcome = { ok: true; epoch: string; kind: 'import' | 'wipe' };
