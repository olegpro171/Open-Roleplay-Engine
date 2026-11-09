import { createHash } from 'node:crypto';
import { latestApproved } from '../core/context-corrections.js';
import { AppError } from '../core/errors.js';
import type { MemoryLayoutCleanup } from '../core/memory-layout.js';
import type { ContextState } from '../shared/context.js';
import { message } from '../shared/localization.js';
import type { MemoryCleanupImpact } from '../shared/memory-cleanup.js';

export type MemoryLayoutReview = {
  id: string;
  title: string;
  branchName: string | null;
  revision: number;
  before: ContextState;
  cleanup: MemoryLayoutCleanup;
};

export function memoryCleanupImpact(reviews: MemoryLayoutReview[], command: unknown, turnOrdinal: (chatId: string, turnId: string) => number | null): MemoryCleanupImpact | null {
  const branches = reviews.flatMap(({ id, title, branchName, before, cleanup }) => {
    const discardedSummaries = cleanup.deletedIds.size;
    const restoredTurns = cleanup.restoredTurnIds.length;
    if (!discardedSummaries && !restoredTurns) return [];
    const corrections = latestApproved(before).filter(node => node.manual && cleanup.deletedIds.has(node.id)).map(node => {
      const first = node.turns[0];
      const last = node.turns.at(-1);
      return { id: node.id, level: node.level, text: node.text,
        firstTurn: first ? turnOrdinal(id, first.turnId) : null,
        lastTurn: last ? turnOrdinal(id, last.turnId) : null };
    });
    return [{ id, title, branchName, discardedSummaries, restoredTurns, corrections }];
  });
  if (!branches.length) return null;
  const captured = [...reviews].sort((a, b) => a.id.localeCompare(b.id)).map(({ id, revision, before, cleanup }) => [
    id, revision, before.revision, [...cleanup.deletedIds].sort(), cleanup.after.archivedTurnIds.length,
  ]);
  const token = createHash('sha256').update(JSON.stringify([command, captured, branches])).digest('hex');
  return { token, branches };
}

export function assertMemoryImpact(impact: MemoryCleanupImpact | null, token?: string) {
  if (token !== undefined && token !== impact?.token) {
    throw new AppError(409, 'memory_impact_changed', message('memory.cleanup_changed'));
  }
  if (impact && token === undefined) {
    throw new AppError(409, 'memory_impact_required', message('memory.review_cleanup_first'));
  }
}
