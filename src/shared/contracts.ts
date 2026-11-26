import { z } from 'zod';
import { authorNoteSchema } from './author-note.js';
import { composerDraftReferenceSchema } from './composer-draft.js';

import { customParametersSchema, type builtInParametersSchema } from './connection-parameters.js';

export const connectionSchema = z.object({
  name: z.string().trim().min(1).max(100),
  endpoint: z.string().url().max(2000).refine((value) => {
    try {
      const url = new URL(value);
      return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
    } catch { return false; }
  }, 'Use an HTTP(S) API base URL without credentials, query parameters, or a fragment.'),
  model: z.string().trim().min(1).max(200),
  contextWindow: z.number().int().positive().max(10_000_000),
  maxOutputTokens: z.number().int().positive().max(1_000_000),
  customParameters: customParametersSchema,
  // Older records, drafts and version 1 profiles may carry this retired flag.
  requestUsage: z.boolean().optional().overwrite(() => undefined),
}).strict().refine(outputFitsContextWindow, {
  message: 'Reserved output must be smaller than the context window.', path: ['maxOutputTokens'],
});

export function outputFitsContextWindow({ contextWindow, maxOutputTokens }: { contextWindow: number; maxOutputTokens: number }): boolean {
  return maxOutputTokens < contextWindow;
}

export const connectionRecordSchema = connectionSchema.safeExtend({
  modelWindowReport: z.strictObject({
    endpoint: connectionSchema.shape.endpoint,
    model: connectionSchema.shape.model,
    tokens: connectionSchema.shape.contextWindow,
  }).optional(),
}).refine(({ endpoint, model, modelWindowReport }) =>
  !modelWindowReport || (modelWindowReport.endpoint === endpoint && modelWindowReport.model === model), {
  message: 'The reported window must match the Connection endpoint and model.', path: ['modelWindowReport'],
});

export type ConnectionRecord = z.infer<typeof connectionRecordSchema>;

export function connectionSettings({ modelWindowReport: _report, requestUsage: _legacyUsage, ...settings }: ConnectionRecord): Connection {
  return settings;
}

export const modelDiscoveryLimit = 10_000;
const discoveredModelSchema = z.object({
  id: connectionSchema.shape.model,
  contextWindow: connectionSchema.shape.contextWindow.optional(),
});
export const modelDiscoverySchema = z.object({ models: z.array(discoveredModelSchema).max(modelDiscoveryLimit) });
export type DiscoveredModel = z.infer<typeof discoveredModelSchema>;

export const chatSettingsSchema = z.object({
  title: z.string().trim().min(1).max(100),
  instructions: z.string().max(100_000),
  character: z.string().max(100_000),
  persona: z.string().max(100_000),
  targetInputTokens: z.number().int().positive().max(10_000_000),
  authorNote: authorNoteSchema.optional(),
  connectionId: z.string().nullable().optional(), promptId: z.string().optional(),
  characterId: z.string().nullable().optional(), personaId: z.string().nullable().optional(),
  contextPresetId: z.string().nullable().optional(),
  lorebookId: z.string().min(1).max(100).nullable().optional(),
}).strict();

export type Connection = z.infer<typeof connectionSchema>;
export type ChatSettings = z.infer<typeof chatSettingsSchema>;
export type Message = { role: 'system' | 'user' | 'assistant'; content: string };
export type TurnPart = { id: string; revision: number; text: string };
export type ResponseVariant = { id: string; text: string; sourceRevision: number; generationId: string | null; createdAt: string };
export type Turn = {
  id: string; position: number; complete: boolean; pinned?: boolean; user: TurnPart;
  // Selection/edit revisions advance; sourceRevision identifies saved content.
  assistant: TurnPart & { variantId?: string; sourceRevision?: number };
  variants?: ResponseVariant[];
};
export type RequestBody = {
  model: string; messages: Message[]; stream: true; max_tokens: number;
  stream_options?: { include_usage: true };
} & z.infer<typeof builtInParametersSchema> & Record<string, unknown>;
export const pinnedSourceSchema = z.object({ turnId: z.string().min(1).max(100), ordinal: z.number().int().positive().safe() }).strict();
export type PinnedSource = z.infer<typeof pinnedSourceSchema>;
export const promptEntryKinds = ['prompt', 'character', 'persona', 'memory', 'history', 'draft', 'lore', 'pinned', 'continuation', 'opening'] as const;
export type PromptEntry = { messageIndex: number; kind: (typeof promptEntryKinds)[number]; pinnedSources?: PinnedSource[]; label: string; labelMessage?: import('./localization.js').LocalizedMessage; tokens: number; group?: { id: string; label: string } };
export type TokenUsage = { inputTokens: number; outputTokens: number; totalTokens: number };
export type ConnectionDiagnostic = { message: string; localized?: import('./localization.js').LocalizedMessage; request?: RequestPreview; usage?: TokenUsage | null; response?: string };
export type TokenCounting = {
  kind: 'reference' | 'model' | 'fallback'; tokenizer: string | null;
  implementation?: string; tokenizerRevision?: string;
  framing: 'estimated-recipe' | 'fallback'; fallbackReason: string | null; limitations: string;
};
export type RequestPreview = {
  layout?: PromptEntry[];
  warnings?: string[];
  warningMessages?: import('./localization.js').LocalizedMessage[];
  endpoint: string;
  body: RequestBody;
  coverage: { turnId: string; userRevision: number; assistantRevision: number; complete: boolean }[];
  context?: { selected: import('./context.js').SummaryRef[]; archivedTurnIds: string[] };
  history?: { mode: 'managed' | 'recent'; verbatimTurnIds: string[] };
  lore?: import('./lorebook.js').LoreResolution | null;
  // Repair baseline for later edits; stored locally, never added to the provider body.
  summarySources?: { turnId: string; user: string; assistant: string }[];
  budget: {
    inputTokens: number; targetInputTokens: number; reservedOutputTokens: number;
    contextWindow: number; method: string; verified: false;
    counting?: TokenCounting; // Absent on immutable requests saved before model-aware counting.
  };
};
// The sidebar needs category totals, never prose or one record per message.
export type RequestEstimate = Pick<RequestPreview, 'budget' | 'warnings' | 'warningMessages'> & {
  allocations: Partial<Record<PromptEntry['kind'], number>>;
  history?: { mode: 'managed' | 'recent'; verbatimTurns: number };
};
export function requestEstimate(request: RequestPreview): RequestEstimate {
  const allocations: RequestEstimate['allocations'] = {};
  for (const entry of request.layout ?? []) allocations[entry.kind] = (allocations[entry.kind] ?? 0) + entry.tokens;
  return { budget: request.budget, allocations, warnings: request.warnings, warningMessages: request.warningMessages,
    ...(request.history ? { history: { mode: request.history.mode, verbatimTurns: request.history.verbatimTurnIds.filter(id => id !== 'draft').length } } : {}) };
}
export type GenerationStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
export type Generation = {
  errorMessage?: import('./localization.js').LocalizedMessage | null;
  id: string; turnId: string; status: GenerationStatus; sourceRevision: number;
  kind?: 'response' | 'regeneration' | 'continuation';
  request: RequestPreview | null; partialText: string; error: string | null; usage: TokenUsage | null;
  // Bounded preview of separate per-attempt output; full text is fetched on demand.
  reasoningText?: string;
  reasoningLength?: number; // Live stream cursor; reply-only updates do not refetch reasoning.
  createdAt: string; updatedAt: string;
};
export type ChatSnapshot = {
  promptDiagnostics?: import('./prompt-diagnostics.js').PromptDiagnostic[];
  id: string; sources: import('./library.js').PromptSources;
  revision: number; settings: ChatSettings; connection: Connection | null; hasApiKey: boolean;
  turns: Turn[]; generations: Generation[];
  context: import('./context.js').ContextSnapshot;
  loreState?: import('./lorebook.js').LoreState;
  loreResolution?: import('./lorebook.js').LoreResolution | null;
};
export type TurnInstruction = { kind: 'opening' } | { kind: 'continuation'; turnId: string };
export type EngineSnapshot = Omit<ChatSnapshot, 'generations'> & { turnInstruction?: TurnInstruction };
export type ChatToolsSnapshot = EngineSnapshot & { generating: boolean };
export type GenerationDescriptor = Omit<Generation, 'request' | 'partialText' | 'reasoningText' | 'reasoningLength'> & { requestAvailable: boolean };
export type GenerationPage = { items: GenerationDescriptor[]; nextBefore: string | null; selected?: GenerationDescriptor | null };
// Portable backups preserve bounded opaque record identities, including older
// imported identities that are not UUIDs. Read cursors follow that contract.
export const generationIdentitySchema = z.string().min(1).max(100);
export const generationPageSchema = z.object({
  before: generationIdentitySchema.optional(),
  selected: generationIdentitySchema.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
}).strict();

export const revisionSchema = z.number().int().nonnegative();
export const saveSettingsSchema = z.object({
  revision: revisionSchema, connection: connectionSchema, settings: chatSettingsSchema,
  apiKey: z.string().max(10_000).refine((value) => !/[\r\n]/.test(value), 'API keys cannot contain line breaks.').optional(),
}).strict();
export const submissionSchema = z.object({
  revision: revisionSchema, requestId: z.string().uuid(), text: z.string().min(1).max(100_000),
  draft: composerDraftReferenceSchema.optional(),
}).strict();
export const retrySchema = z.object({ revision: revisionSchema, requestId: z.string().uuid() }).strict();
export const editSchema = z.object({ revision: revisionSchema, text: z.string().max(100_000) }).strict();
export const passwordSchema = z.object({ password: z.string().min(12).max(256) }).strict();
