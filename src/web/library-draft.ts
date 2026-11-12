import { z } from 'zod';
import { connectionSchema, revisionSchema } from '../shared/contracts';
import { contextPresetSchema } from '../shared/context';
import { libraryCharacterSchema, libraryPersonaSchema, promptBlockSchema, promptSchema } from '../shared/library';
import { lorebookSchema, loreEntrySchema } from '../shared/lorebook';
import { tagIdsSchema } from '../shared/tags';

// Drafts can contain incomplete or invalid values. Check their shape here and
// leave normalization and validation of saved records to the normal save path.
const text = z.string();
const number = z.number();
const target = { id: z.string().min(1).max(100).optional(), revision: revisionSchema, numbers: z.record(z.string(), text).optional() };
const [textBlock, markerBlock] = promptBlockSchema.options;
const draftBlock = z.discriminatedUnion('kind', [
  z.strictObject({ ...textBlock.shape, name: text, text }),
  z.strictObject({ ...markerBlock.shape, name: text }),
]);
const draftEntry = z.strictObject({ ...loreEntrySchema.shape, keys: z.array(text), secondaryKeys: z.array(text), depth: number, scanDepth: number.nullable() });
const editorDraft = z.discriminatedUnion('kind', [
  z.strictObject({ ...target, kind: z.literal('characters'), data: libraryCharacterSchema.safeExtend({ name: text, titleComment: text.optional() }), tagIds: tagIdsSchema, pictureOmitted: z.boolean() }),
  z.strictObject({ ...target, kind: z.literal('personas'), data: libraryPersonaSchema.safeExtend({ name: text, titleComment: text.optional() }) }),
  z.strictObject({ ...target, kind: z.literal('prompts'), data: z.strictObject({ ...promptSchema.shape, name: text, blocks: z.array(draftBlock).max(100) }) }),
  z.strictObject({ ...target, kind: z.literal('contexts'), data: contextPresetSchema.safeExtend({
    name: text, extractionPrompt: text, promotionPrompt: text, repairPrompt: text,
    minTail: number, batchSize: number, summaryTokens: number, promotionGroup: number, retainedPerLevel: number,
  }) }),
  z.strictObject({ ...target, kind: z.literal('lorebooks'), data: z.strictObject({ ...lorebookSchema.shape, name: text, scanDepth: number, tokenBudget: number, entries: z.array(draftEntry) }), selectedId: text }),
  z.strictObject({ ...target, kind: z.literal('connections'), data: z.strictObject({
    ...connectionSchema.shape, name: text, endpoint: text, model: text, contextWindow: number, maxOutputTokens: number,
  }), parameters: text, removeKey: z.boolean(), keyOmitted: z.boolean() }),
]);
const storedDraft = z.strictObject({ version: z.literal(1), epoch: text, editor: editorDraft });
export type LibraryEditorDraft = z.infer<typeof editorDraft>;
export type LibraryDraft = z.infer<typeof storedDraft>;
export type DraftOf<Kind extends LibraryEditorDraft['kind']> = Extract<LibraryEditorDraft, { kind: Kind }>;

const storageKey = 'ore-library-editor-draft';

export function readLibraryDraft(): LibraryDraft | null {
  try {
    const stored = sessionStorage.getItem(storageKey);
    if (stored === null) return null;
    const parsed = storedDraft.safeParse(JSON.parse(stored));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function writeLibraryDraft(draft: LibraryDraft | null): boolean {
  try {
    if (draft) sessionStorage.setItem(storageKey, JSON.stringify(draft));
    else sessionStorage.removeItem(storageKey);
    return true;
  } catch {
    return false;
  }
}

export function sameDraftValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) return false;
  if (Array.isArray(left)) {
    return Array.isArray(right) && left.length === right.length && left.every((value, index) => sameDraftValue(value, right[index]));
  }
  if (Array.isArray(right)) return false;
  const fields = Object.entries(left).filter(([, value]) => value !== undefined);
  return fields.length === Object.values(right).filter(value => value !== undefined).length
    && fields.every(([key, value]) => Object.hasOwn(right, key) && sameDraftValue(value, Reflect.get(right, key)));
}
