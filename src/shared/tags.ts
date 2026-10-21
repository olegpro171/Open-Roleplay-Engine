import type { PictureReview } from './pictures.js';
import { z } from 'zod';
import { loreDiagnosticSchema, type LoreDiagnostic } from './lorebook.js';

export const tagLimits = { name: 100, catalog: 2000, assignments: 128, candidates: 1024, metadataEntries: 4096, metadataCharacters: 500_000, diagnostics: 50, page: 50 } as const;
export function normalizeTagName(value: string): string { return value.trim().normalize('NFC'); }
export function canonicalTagName(value: string): string { return normalizeTagName(value).toLowerCase(); }
export const tagNameSchema = z.string().transform(normalizeTagName).pipe(z.string().min(1, 'Enter a nonempty tag name.').max(tagLimits.name, `Tag names are limited to ${tagLimits.name} characters after normalization.`));
export const tagIdsSchema = z.array(z.string().min(1).max(100)).max(tagLimits.metadataEntries).transform(ids => [...new Set(ids)]).pipe(z.array(z.string()).max(tagLimits.assignments));
export const tagPolicySchema = z.enum(['all', 'existing', 'none']);
export type TagPolicy = z.infer<typeof tagPolicySchema>;
export type Tag = { id: string; name: string; revision: number; usageCount: number };
export type CharacterTag = { characterId: string; tagId: string };
export type TagCandidate = { name: string; key: string; sourceIndexes: number[]; eligible: boolean };
export type TagCandidates = { candidates: TagCandidate[]; notices: string[]; omittedNotices: number };
export type TagReview = {
  existing: { id: string; name: string; sourceIndexes: number[] }[];
  newTags: { name: string; sourceIndexes: number[]; eligible: boolean }[];
  notices: string[]; omittedNotices: number;
  modes: Record<TagPolicy, { assign: number; create: number; blocked: string | null }>;
};
export type CharacterImportReview = {
  picture?: PictureReview;
  revision: number; name: string; description: string; book: { name: string; entries: number } | null;
  diagnostics: LoreDiagnostic[];
  tags: TagReview;
};
export type TagImportReport = { policy: TagPolicy; assigned: number; created: number };
export const tagImportReportSchema = z.object({ policy: tagPolicySchema, assigned: z.number().int().nonnegative(), created: z.number().int().nonnegative() });
export const characterImportResultSchema = z.object({
  ids: z.array(z.string()), books: z.array(z.object({ id: z.string(), name: z.string(), entries: z.number() })),
  diagnostics: z.array(loreDiagnosticSchema),
  tags: tagImportReportSchema.optional(),
  picture: z.object({ saved: z.boolean() }).optional(),
});
export type CharacterImportResult = z.infer<typeof characterImportResultSchema>;

export function characterTagIndex(links: CharacterTag[]): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const link of links) {
    let ids = result.get(link.characterId);
    if (!ids) { ids = new Set(); result.set(link.characterId, ids); }
    ids.add(link.tagId);
  }
  return result;
}
export function matchesCharacterTags(assigned: ReadonlySet<string> | undefined, selected: readonly string[]): boolean {
  return selected.every(id => assigned?.has(id));
}
