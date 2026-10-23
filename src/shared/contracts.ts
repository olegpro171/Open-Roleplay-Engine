import { z } from 'zod';

export const customParametersSchema = z.object({
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  presence_penalty: z.number().min(-2).max(2).optional(),
  frequency_penalty: z.number().min(-2).max(2).optional(),
  seed: z.number().int().optional(),
  stop: z.union([z.string().max(200), z.array(z.string().max(200)).max(4)]).optional(),
  reasoning_effort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
}).strict();

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
  requestUsage: z.boolean().optional(),
}).strict().refine((value) => value.maxOutputTokens < value.contextWindow, {
  message: 'Reserved output must be smaller than the context window.', path: ['maxOutputTokens'],
});

export const chatSettingsSchema = z.object({
  title: z.string().trim().min(1).max(100),
  instructions: z.string().max(100_000),
  character: z.string().max(100_000),
  persona: z.string().max(100_000),
  targetInputTokens: z.number().int().positive().max(10_000_000),
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
  id: string; position: number; complete: boolean; user: TurnPart;
  // Selection/edit revisions advance; sourceRevision identifies saved content.
  assistant: TurnPart & { variantId?: string; sourceRevision?: number };
  variants?: ResponseVariant[];
};
export type RequestBody = {
  model: string; messages: Message[]; stream: true; max_tokens: number;
  stream_options?: { include_usage: true };
} & z.infer<typeof customParametersSchema>;
export type PromptEntry = { messageIndex: number; kind: 'prompt' | 'character' | 'persona' | 'memory' | 'history' | 'draft' | 'lore'; label: string; labelMessage?: import('./localization.js').LocalizedMessage; tokens: number; group?: { id: string; label: string } };
export type TokenUsage = { inputTokens: number; outputTokens: number; totalTokens: number };
export type ConnectionDiagnostic = { message: string; request?: RequestPreview; usage?: TokenUsage | null; response?: string };
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
export type GenerationStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
export type Generation = {
  errorMessage?: import('./localization.js').LocalizedMessage | null;
  id: string; turnId: string; status: GenerationStatus; sourceRevision: number;
  kind?: 'response' | 'regeneration';
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

export const revisionSchema = z.number().int().nonnegative();
export const saveSettingsSchema = z.object({
  revision: revisionSchema, connection: connectionSchema, settings: chatSettingsSchema,
  apiKey: z.string().max(10_000).refine((value) => !/[\r\n]/.test(value), 'API keys cannot contain line breaks.').optional(),
}).strict();
export const submissionSchema = z.object({
  revision: revisionSchema, requestId: z.string().uuid(), text: z.string().min(1).max(100_000),
}).strict();
export const retrySchema = z.object({ revision: revisionSchema, requestId: z.string().uuid() }).strict();
export const editSchema = z.object({ revision: revisionSchema, text: z.string().max(100_000) }).strict();
export const passwordSchema = z.object({ password: z.string().min(12).max(256) }).strict();
