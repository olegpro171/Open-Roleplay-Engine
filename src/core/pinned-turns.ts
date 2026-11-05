import type { PinnedSource, Turn } from '../shared/contracts.js';
import { modelText } from './model-text.js';

const introduction = 'The user has explicitly indicated that the following messages are important to the story. Pay particular attention to the facts, decisions, promises, and relationships they establish when continuing the current conversation. Read them as excerpts from earlier turns.';

export function pinnedExcerpts(userText: string, assistantText: string) {
  const user = modelText(userText);
  const assistant = modelText(assistantText);
  return { user: user.trim() ? user : '', assistant: assistant.trim() ? assistant : '' };
}

export function pinnedBlock(turns: Turn[]): { content: string; sources: PinnedSource[] } | null {
  const sources: PinnedSource[] = [];
  const excerpts: string[] = [];
  for (const [index, turn] of turns.entries()) {
    // Regeneration presents the target as pending until the new reply commits.
    if (!turn.pinned || !turn.complete) continue;
    const { user, assistant } = pinnedExcerpts(turn.user.text, turn.assistant.text);
    if (!user && !assistant) continue;
    const ordinal = index + 1;
    sources.push({ turnId: turn.id, ordinal });
    excerpts.push([
      `[Turn ${ordinal}]`,
      ...(user ? [`User:\n${user}`] : []),
      ...(assistant ? [`Assistant:\n${assistant}`] : []),
    ].join('\n\n'));
  }
  return excerpts.length ? { content: [introduction, ...excerpts].join('\n\n'), sources } : null;
}
