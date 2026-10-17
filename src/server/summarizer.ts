import { AppError } from '../core/errors.js';
import { validateSummary } from '../core/summary-validation.js';
import type { Provider, ProviderCompletion } from '../provider/openai.js';
import type { RequestPreview } from '../shared/contracts.js';

/** Summary-only gate: callers may commit context replacements only after this returns. */
export async function generateSummary(provider: Provider, request: RequestPreview, apiKey: string, signal: AbortSignal): Promise<string> {
  const cancelled = () => new AppError(409, 'summary_cancelled', 'Summary preparation was cancelled. Its source context must remain selected.');
  if (signal.aborted) throw cancelled();
  let text = '';
  let completion: ProviderCompletion | void;
  try {
    completion = await provider.stream(request, apiKey, signal, (delta) => { text += delta; });
  } catch (error) {
    if (signal.aborted) throw cancelled();
    if (error instanceof AppError) {
      if (error.code === 'empty_response') throw new AppError(502, 'empty_summary', 'The summarizer returned no usable text.');
      if (error.code === 'incomplete_stream') throw new AppError(502, 'incomplete_summary', 'The summary stream ended before completion. Its source context must remain selected.');
      throw error;
    }
    // Raw transport exceptions can contain credentials or upstream response bodies.
    throw new AppError(502, 'summary_request_failed', 'The summary request failed or timed out. Its source context must remain selected.');
  }
  // Some injected providers do not expose an outcome. They must do so for summaries.
  if (signal.aborted) throw cancelled();
  const validation = validateSummary(text, completion?.finishReason ?? 'unknown');
  if (!validation.accepted) throw new AppError(502, validation.code, validation.message);
  return validation.text;
}
