import { localizedMessageSchema, message, type LocalizedMessage } from '../shared/localization';
import { z } from 'zod';
const issueSchema = z.array(z.object({ path: z.string().max(2000), localized: localizedMessageSchema })).max(100);
let epoch: string | null = null;
let changed = false;
export function datasetChanged() { return changed; }
export function datasetEpoch() { return epoch ?? 'initial'; }
export class ApiError extends Error {
  constructor(message: string, public status: number, public readonly localized?: LocalizedMessage, public readonly issues?: z.infer<typeof issueSchema>) { super(message); }
}
export class NetworkError extends Error {
  readonly localized = message('errors.network_request_failed');
  constructor(cause: TypeError) { super(message('errors.network_request_failed').fallback, { cause }); }
}
export async function api<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  // Serialize before the transport boundary so local input errors cannot be
  // mistaken for browser network failures. Cancellation keeps its own identity.
  const encoded = body === undefined ? undefined : JSON.stringify(body);
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method, credentials: 'same-origin', signal,
      headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json', 'X-ORE-Epoch': datasetEpoch(), Prefer: 'return=minimal' } : {}) },
      ...(encoded === undefined ? {} : { body: encoded }),
    });
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    // A transport failure has no HTTP status. Keep it distinct from ApiError
    // so uncertain commands retain their identity for a safe explicit retry.
    throw new NetworkError(error);
  }
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
