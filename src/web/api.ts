let epoch: string | null = null;
let changed = false;
export function datasetChanged() { return changed; }
export function datasetEpoch() { return epoch ?? 'initial'; }
export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
export async function api<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method, credentials: 'same-origin', signal,
    ...(body !== undefined ? { headers: { 'Content-Type': 'application/json', 'X-ORE-Epoch': datasetEpoch() }, body: JSON.stringify(body) } : {}),
  });
  const observed = response.headers.get('X-ORE-Epoch');
  if (observed && epoch === null) epoch = observed;
  else if (observed && observed !== epoch) { changed = true; window.dispatchEvent(new Event('ore-dataset-changed')); }
  const result = await response.json();
  if (!response.ok) throw new ApiError(result.message ?? 'The request failed.', response.status);
  return result as T;
}
