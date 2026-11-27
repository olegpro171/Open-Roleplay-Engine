import { z } from 'zod';
import { ApiError, datasetEpoch } from './api';

const uncertain = new Map<string, unknown>();

// An ambiguous acknowledgement keeps the original body and command identity.
// Only a user action enters this function, including after a reload.
export async function stagedCommand<T extends { requestId: string }>(action: string, chatId: string, schema: z.ZodType<T>, create: () => T, send: (command: T) => Promise<unknown>, observedRequestId?: string) {
  const key = `ore-${action}:${datasetEpoch()}:${chatId}`;
  let saved = uncertain.get(key);
  if (!saved) {
    try { saved = JSON.parse(sessionStorage.getItem(key) ?? 'null'); } catch { /* Browser storage is optional. */ }
  }
  const parsed = schema.safeParse(saved);
  // Story can confirm a suggestion whose HTTP acknowledgement was lost.
  const command = parsed.success && parsed.data.requestId !== observedRequestId ? parsed.data : create();
  uncertain.set(key, command);
  try { sessionStorage.setItem(key, JSON.stringify(command)); } catch { /* Keep the in-memory command. */ }
  const clear = () => {
    uncertain.delete(key);
    try { sessionStorage.removeItem(key); } catch { /* Browser storage is optional. */ }
  };
  try { await send(command); clear(); }
  catch (error) {
    if (error instanceof ApiError && error.status < 500) clear();
    throw error;
  }
}
