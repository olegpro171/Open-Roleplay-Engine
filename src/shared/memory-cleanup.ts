import { z } from 'zod';

export const memoryImpactTokenSchema = z.string().regex(/^[a-f0-9]{64}$/);

export type MemoryCleanupImpact = {
  token: string;
  branches: {
    id: string;
    title: string;
    branchName: string | null;
    discardedSummaries: number;
    restoredTurns: number;
    corrections: {
      id: string;
      level: number;
      firstTurn: number | null;
      lastTurn: number | null;
      text: string;
    }[];
  }[];
};
