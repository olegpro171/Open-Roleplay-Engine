import { z } from 'zod';
import { retrySchema } from '../shared/contracts';
import { api } from './api';
import { newId } from './uuid';
import { stagedCommand } from './staged-command';

const commandSchema = retrySchema.extend({ turnId: z.string().min(1).max(100) });

export function continueResponse(chatId: string, turnId: string, revision: number, signal?: AbortSignal) {
  return stagedCommand('continue', chatId, commandSchema, () => ({ turnId, revision, requestId: newId() }), command =>
    api(`/chats/${encodeURIComponent(chatId)}/turns/${encodeURIComponent(command.turnId)}/continue`, 'POST',
      { revision: command.revision, requestId: command.requestId }, signal));
}
