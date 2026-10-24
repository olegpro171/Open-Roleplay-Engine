import { message } from '../shared/localization.js';
import { AppError } from '../core/errors.js';
import { validateSummary } from '../core/summary-validation.js';
import type { Provider, ProviderCompletion } from '../provider/openai.js';
import type { RequestPreview } from '../shared/contracts.js';
import type { SummaryPhase } from '../shared/context.js';

export class RefusedSummaryError extends AppError {
  constructor(public readonly rejectedText: string, diagnostic: string) {
    super(502, 'refused_summary', diagnostic);
  }
}

/** Summary-only gate: callers may commit context replacements only after this returns. */
export async function generateSummary(provider: Provider, request: RequestPreview, apiKey: string, signal: AbortSignal, onPhase?: (phase: SummaryPhase) => void): Promise<string> {
  const cancelled = () => new AppError(409, 'summary_cancelled', message("errors.summary_preparation_was_cancelled_its_source_context_must"));
  if (signal.aborted) throw cancelled();
  let text = '';
  let completion: ProviderCompletion | void;
  let phase: SummaryPhase = 'connecting';
  onPhase?.(phase);
  const updatePhase = (next: SummaryPhase) => {
    if (signal.aborted || phase === next) return;
    phase = next;
    onPhase?.(phase);
  };
  try {
    completion = await provider.stream(request, apiKey, signal, delta => {
      text += delta;
      if (delta) updatePhase('generating');
    }, reasoning => { if (reasoning && !text) updatePhase('reasoning'); });
  } catch (error) {
    if (signal.aborted) throw cancelled();
    if (error instanceof AppError) {
      if (error.code === 'empty_response') throw new AppError(502, 'empty_summary', message("errors.the_summarizer_returned_no_usable_text"));
      if (error.code === 'incomplete_stream') throw new AppError(502, 'incomplete_summary', message("errors.the_summary_stream_ended_before_completion_its_source"));
      throw error;
    }
    // Raw transport exceptions can contain credentials or upstream response bodies.
    throw new AppError(502, 'summary_request_failed', message("errors.the_summary_request_failed_or_timed_out_its"));
  }
  // Some injected providers do not expose an outcome. They must do so for summaries.
  if (signal.aborted) throw cancelled();
  const validation = validateSummary(text, completion?.finishReason ?? 'unknown');
  if (!validation.accepted) {
    if (validation.code === 'refused_summary') throw new RefusedSummaryError(text, validation.message);
    throw new AppError(502, validation.code, validation.message);
  }
  return validation.text;
}
