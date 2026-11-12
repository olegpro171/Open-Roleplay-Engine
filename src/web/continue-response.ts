import { z } from 'zod';
import { retrySchema } from '../shared/contracts';
import { api, ApiError, datasetEpoch } from './api';
import { newId } from './uuid';

const commandSchema = retrySchema.extend({ turnId: z.string().min(1).max(100) });
const uncertain = new Map<string, z.infer<typeof commandSchema>>();

export async function continueResponse(chatId: string, turnId: string, revision: number) {
  const key = `ore-continue:${datasetEpoch()}:${chatId}`;
  let command = uncertain.get(key);
  if (!command) {
    try {
      const saved = commandSchema.safeParse(JSON.parse(sessionStorage.getItem(key) ?? 'null'));
      if (saved.success) command = saved.data;
    } catch { /* Retain the command in memory if session storage is unavailable. */ }
  }
  command ??= { turnId, revision, requestId: newId() };
  uncertain.set(key, command);
  try { sessionStorage.setItem(key, JSON.stringify(command)); } catch { /* The in-memory identity is enough for this tab. */ }
  const clear = () => {
    uncertain.delete(key);
    try { sessionStorage.removeItem(key); } catch { /* Session storage may be disabled. */ }
  };
  try {
    await api(`/chats/${encodeURIComponent(chatId)}/turns/${encodeURIComponent(command.turnId)}/continue`, 'POST',
      { revision: command.revision, requestId: command.requestId });
    clear();
  } catch (error) {
    if (error instanceof ApiError && error.status < 500) clear();
    throw error;
  }
}
