import type { ChatBehavior } from '../shared/chat-behavior.js';

export type InputOvershoot = Pick<ChatBehavior, 'allowInputOvershoot' | 'maximumOvershootTokens'>;

/** Equality with the overshoot threshold requires preparation; target equality fits. */
export function fitsInputTarget(input: number, target: number, overshoot?: InputOvershoot): boolean {
  return input <= target || Boolean(overshoot?.allowInputOvershoot && input - target < overshoot.maximumOvershootTokens);
}
