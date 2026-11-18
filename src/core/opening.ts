import type { Turn } from '../shared/contracts.js';
import { hasPromptMarker, type PromptPreset } from '../shared/library.js';
import { message } from '../shared/localization.js';
import { AppError } from './errors.js';

export function isOpeningTurn(turns: readonly Turn[]): boolean {
  const [first] = turns;
  return turns.length === 1 && first !== undefined && !first.user.text.trim();
}

export function requireOpeningMessages(prompt?: PromptPreset | null): void {
  if (!hasPromptMarker(prompt, 'messages')) {
    throw new AppError(422, 'opening_unavailable', message('opening.messages_required'));
  }
}
