import { localizedMessageSchema, type LocalizedMessage } from '../shared/localization';
import { z } from 'zod';
const issueSchema = z.array(z.object({ path: z.string().max(2000), localized: localizedMessageSchema })).max(100);
let epoch: string | null = null;
let changed = false;
export function datasetChanged() { return changed; }
export function datasetEpoch() { return epoch ?? 'initial'; }
export class ApiError extends Error {
  constructor(message: string, public status: number, public readonly localized?: LocalizedMessage, public readonly issues?: z.infer<typeof issueSchema>) { super(message); }
}
export async function api<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method, credentials: 'same-origin', signal,
    headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json', 'X-ORE-Epoch': datasetEpoch() } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const observed = response.headers.get('X-ORE-Epoch');
  if (observed && epoch === null) epoch = observed;
  else if (observed && observed !== epoch) { changed = true; window.dispatchEvent(new Event('ore-dataset-changed')); }
  const result = await response.json();
  if (!response.ok) {
    const localized = localizedMessageSchema.safeParse(result.localized);
    const issues = issueSchema.safeParse(result.issues);
    throw new ApiError(result.message ?? 'The request failed.', response.status, localized.success ? localized.data : undefined, issues.success ? issues.data : undefined);
  }
  return result as T;
}
