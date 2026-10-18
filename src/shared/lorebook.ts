import { z } from 'zod';

export const LOREBOOK_FILE_LIMIT = 5_000_000;
export const LOREBOOK_ENTRY_LIMIT = 2000;
export const lorePlacements = ['before_char', 'after_char', 'history', 'before_desc', 'after_desc', 'personality', 'scenario'] as const;
export const loreRoleSchema = z.enum(['system', 'user', 'assistant']);
const preservedSource = z.object({ raw: z.record(z.string(), z.unknown()), edited: z.array(z.string()).max(30).optional() }).strict();
export const loreEntrySchema = z.object({
  id: z.string().min(1).max(100), name: z.string().max(200), comment: z.string().max(100_000),
  activationRevision: z.number().int().nonnegative().optional(),
  keys: z.array(z.string().max(2000)).max(64), secondaryKeys: z.array(z.string().max(2000)).max(64),
  content: z.string().max(100_000), enabled: z.boolean(), constant: z.boolean(), selective: z.boolean(),
  useRegex: z.boolean(), caseSensitive: z.boolean(), insertionOrder: z.number().finite(), priority: z.number().finite(),
  placement: z.enum(lorePlacements), role: loreRoleSchema.nullable(), depth: z.number().int().min(0).max(1000),
  scanDepth: z.number().int().min(0).max(1000).nullable(),
  externalId: z.union([z.string().max(2000), z.number().finite()]).optional(),
  source: preservedSource.extend({ mapKey: z.string().max(2000).optional() }).optional(),
}).strict();
export const lorebookSchema = z.object({
  name: z.string().trim().min(1).max(100), description: z.string().max(100_000),
  scanDepth: z.number().int().min(0).max(1000), tokenBudget: z.number().int().min(0).max(1_000_000),
  recursiveScanning: z.boolean(), entries: z.array(loreEntrySchema).max(LOREBOOK_ENTRY_LIMIT),
  source: preservedSource.extend({ format: z.enum(['v2', 'v3', 'world_info']) }).optional(),
}).strict().superRefine((book, ctx) => {
  if (new Set(book.entries.map(entry => entry.id)).size !== book.entries.length) ctx.addIssue({ code: 'custom', path: ['entries'], message: 'Entry identities must be unique.' });
  if (JSON.stringify(book).length > LOREBOOK_FILE_LIMIT * 3 + 1_000_000) ctx.addIssue({ code: 'custom', message: 'The normalized book exceeds its storage limit.' });
});
export type LoreEntry = z.infer<typeof loreEntrySchema>;
export type Lorebook = z.infer<typeof lorebookSchema>;
export type LorePlacement = typeof lorePlacements[number];
export type LoreDiagnostic = { code: string; message: string; entryId?: string; field?: string };
export type LoreImportPreview = { format: 'v2' | 'v3' | 'world_info'; book: Lorebook; diagnostics: LoreDiagnostic[] };
export const newLorebook = (): Lorebook => ({ name: 'New lorebook', description: '', scanDepth: 4, tokenBudget: 2048, recursiveScanning: false, entries: [] });
export const newLoreEntry = (id: string): LoreEntry => ({ id, name: 'New entry', comment: '', keys: [], secondaryKeys: [], content: '', enabled: true, constant: false, selective: false, useRegex: false, caseSensitive: false, insertionOrder: 0, priority: 0, placement: 'after_char', role: null, depth: 0, scanDepth: null });

export type LoreScanMessage = { turnId: string; partId: string; revision: number; role: 'user' | 'assistant'; text: string };
export type LoreEntryState = { fingerprint: string; matches: number };
export type LoreState = { epoch: number; entries: Record<string, LoreEntryState> };
export type LoreDestination = { controlId: string; placement: LorePlacement; role: 'system' | 'user' | 'assistant'; depth: number; anchorId?: string };
export type LoreOutcome = {
  id: string; name: string; status: 'admitted' | 'excluded'; reason: string;
  text: string; destination: LoreDestination | null; tokens: number; fingerprint: string;
};
/** Immutable request-local policy result; never placed inside a provider body. */
export type LoreResolution = {
  detailsAvailable?: boolean;
  version: 'ore-lore-v1'; book: { id: string; revision: number; name: string }; epoch: number;
  settings: { scanDepth: number; tokenBudget: number; recursiveScanning: boolean };
  scan: Omit<LoreScanMessage, 'text'>[]; assistantCount: number;
  outcomes: LoreOutcome[]; diagnostics: LoreDiagnostic[]; tokens: number; pressure: boolean;
  stateBefore: Record<string, LoreEntryState>; stateDelta: Record<string, LoreEntryState>;
};
