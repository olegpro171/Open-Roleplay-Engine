import { z } from 'zod';
import { revisionSchema } from './contracts.js';
import type { ChatSnapshot, Connection, Generation, ResponseVariant, Turn } from './contracts.js';
import type { ContextJob, ContextJobProgress } from './context.js';
import type { markers } from './library.js';
import type { PromptDiagnostic } from './prompt-diagnostics.js';

export const transcriptInitialSize = 15;
export const transcriptBatchSize = 40;
export const transcriptWindowLimit = 120;
export const transcriptQuerySchema = z.object({
  anchor: z.string().min(1).max(100).optional(),
  shift: z.coerce.number().int().min(-transcriptBatchSize).max(transcriptBatchSize).default(0),
  limit: z.coerce.number().int().min(1).max(transcriptWindowLimit).default(transcriptInitialSize),
  revision: z.coerce.number().int().nonnegative().optional(),
}).strict().refine(value => value.shift === 0 || (value.anchor !== undefined && value.revision !== undefined), 'Moving a transcript window requires an anchor and revision.');
export type TranscriptQuery = z.infer<typeof transcriptQuerySchema>;
export type StoryGeneration = Omit<Generation, 'request'> & { requestAvailable: boolean };
export type StorySuggestion = Pick<Generation, 'id' | 'status' | 'sourceRevision' | 'error' | 'errorMessage'> & {
  sessionId: string; requestId: string; completedCount: number;
};
export const turnPinSchema = z.object({ revision: revisionSchema, pinned: z.boolean() }).strict();
export type PinList = {
  revision: number;
  markerEnabled: boolean;
  hasConnection: boolean;
  turns: { id: string; ordinal: number; user: string; assistant: string; hasModelText: boolean }[];
};
export type TranscriptTurn = Omit<Turn, 'variants'> & {
  variants?: Pick<ResponseVariant, 'id' | 'generationId'>[];
  ordinal: number;
  archived: boolean;
};
export type StoryPreparation = Pick<ContextJob, 'id' | 'generationId' | 'mode' | 'status' | 'error' | 'errorMessage'> & Pick<ContextJobProgress, 'phase' | 'retrying' | 'deletionReviewToken'> & {
  working?: { inputTokens: number; targetInputTokens: number; level: number | null };
  completedSteps: number;
};

// This display window is deliberately distinct from the complete engine snapshot.
export type StorySnapshot = Pick<ChatSnapshot, 'id' | 'revision' | 'settings' | 'hasApiKey'> & {
  connection: Pick<Connection, 'name' | 'model'> | null;
  sources: {
    prompt: { blocks: { enabled: boolean; kind: 'marker'; marker: typeof markers[number] }[] } | null;
    character: { name: string } | null;
    persona: { name: string } | null;
  };
  promptDiagnostics: PromptDiagnostic[];
  groupId?: string;
  branchName?: string | null;
  totalTurns: number;
  pinCount: number;
  latestTurn: { id: string; complete: boolean; continuationBlocked?: import('./localization.js').LocalizedMessage | null } | null;
  latestGeneration: StoryGeneration | null;
  suggestion?: StorySuggestion;
  preparing: boolean;
  preparation: StoryPreparation | null;
  memory: { revision: number; selectedCount: number; archivedCount: number; stale: boolean; awaitingReview: boolean; refusalCount: number; refusalBlocked: boolean };
  page: { turns: TranscriptTurn[]; generations: StoryGeneration[]; hasOlder: boolean; hasNewer: boolean };
};
