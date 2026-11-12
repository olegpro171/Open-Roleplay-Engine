import { message } from '../shared/localization.js';
import type { EngineSnapshot } from '../shared/contracts.js';
import { hasPromptMarker, transcriptPartLimit } from '../shared/library.js';
import { appendContinuation } from '../shared/text.js';
import { AppError } from './errors.js';
import { modelText } from './model-text.js';

export const continuationInstruction = '[OOC: Continue the scene from the previous reply. The player has supplied no new action. Advance the scene through your characters or the environment. Leave the player character’s actions, dialogue, and decisions to the player.]';

export function continuationBlock(reply: string, messagesEnabled: boolean, archived: boolean) {
  if (!messagesEnabled) return message('continue.messages_required');
  if (archived) return message('continue.archived_reply');
  if (appendContinuation(reply, 'x').length > transcriptPartLimit) return message('continue.reply_too_long', { limit: transcriptPartLimit });
  if (!modelText(reply).trim()) return message('continue.reply_required');
  return null;
}

export function continuationTarget(snapshot: EngineSnapshot, turnId: string) {
  const target = snapshot.turns.at(-1);
  if (!target?.complete || target.id !== turnId || !target.assistant.variantId) {
    throw new AppError(409, 'latest_turn_only', message('continue.latest_completed_required'));
  }
  const blocked = continuationBlock(target.assistant.text, hasPromptMarker(snapshot.sources.prompt, 'messages'),
    hasPromptMarker(snapshot.sources.prompt, 'summary') && snapshot.context.archivedTurnIds.includes(turnId));
  if (blocked) throw new AppError(422, 'continuation_unavailable', blocked);
  return { ...target, variantId: target.assistant.variantId };
}

export function requiredVerbatimTail(minimum: number, continuationTurnId?: string): number {
  return continuationTurnId ? Math.max(minimum, 1) : minimum;
}
