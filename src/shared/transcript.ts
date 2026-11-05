import { z } from 'zod';
import { revisionSchema } from './contracts.js';
import type { ChatSnapshot, Generation, Turn } from './contracts.js';

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
export const turnPinSchema = z.object({ revision: revisionSchema, pinned: z.boolean() }).strict();
export type PinList = {
  revision: number;
  markerEnabled: boolean;
  hasConnection: boolean;
  turns: { id: string; ordinal: number; user: string; assistant: string; hasModelText: boolean }[];
};
export type TranscriptTurn = Turn & { ordinal: number; archived: boolean };

// This display window is deliberately distinct from the complete engine snapshot.
export type StorySnapshot = Pick<ChatSnapshot, 'id' | 'revision' | 'settings' | 'connection' | 'hasApiKey' | 'sources' | 'promptDiagnostics'> & {
  groupId?: string;
  branchName?: string | null;
  totalTurns: number;
  pinCount: number;
  latestTurn: { id: string; complete: boolean } | null;
  latestGeneration: StoryGeneration | null;
  preparing: boolean;
  memory: { revision: number; selectedCount: number; archivedCount: number; stale: boolean; awaitingReview: boolean; refusalCount: number; refusalBlocked: boolean };
  page: { turns: TranscriptTurn[]; generations: StoryGeneration[]; hasOlder: boolean; hasNewer: boolean };
};
