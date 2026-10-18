import type { ChatSnapshot } from '../shared/contracts.js';
import { hasPromptMarker } from '../shared/library.js';
import type { LoreResolution } from '../shared/lorebook.js';
import { resolveLore } from '../core/lorebook.js';
import { assembleRequest } from '../core/prompt.js';
import type { LoreRegexPool } from './lore-regex.js';
import { loreCompatibility } from '../core/lorebook-formats.js';

export async function resolveRequestLore(snapshot: ChatSnapshot, pool: LoreRegexPool, signal?: AbortSignal): Promise<LoreResolution | null> {
  const book = snapshot.sources.lorebook;
  if (!book || !snapshot.connection) return null;
  const input = { book, turns: snapshot.turns, sources: snapshot.sources, state: snapshot.loreState ?? { epoch: 0, entries: {} } };
  const matchRegex = pool.matcher(signal);
  const first = await resolveLore(input, matchRegex);
  const request = assembleRequest(snapshot.connection, snapshot.settings, snapshot.turns, snapshot.sources, snapshot.context, { validateLimits: false, allowStale: true, lore: first });
  const ceiling = Math.min(snapshot.settings.targetInputTokens, snapshot.connection.contextWindow - snapshot.connection.maxOutputTokens);
  const included = new Set(request.history?.verbatimTurnIds);
  const trimmed = !hasPromptMarker(snapshot.sources.prompt, 'summary') && hasPromptMarker(snapshot.sources.prompt, 'messages') && snapshot.turns.some(turn => turn.complete && !included.has(turn.id));
  const pressure = request.budget.inputTokens > ceiling || trimmed;
  const final = pressure ? await resolveLore({ ...input, pressure: true }, matchRegex) : first;
  return { ...final, diagnostics: [...loreCompatibility(book), ...final.diagnostics] };
}
