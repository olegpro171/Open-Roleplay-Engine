import type { EnterKeyBehavior } from '../shared/chat-behavior';

export function isPhoneOrTablet(device: { userAgent: string; platform: string; maxTouchPoints: number }): boolean {
  return /Android|iPad|iPhone|iPod|Mobile/.test(device.userAgent)
    || (device.platform === 'MacIntel' && device.maxTouchPoints > 1);
}

export function isMacKeyboard(device: { platform: string; userAgent: string }): boolean {
  return /Mac|iPad|iPhone|iPod/.test(device.platform + device.userAgent);
}

type Key = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey' | 'isComposing' | 'keyCode'>;

export function isComposerSendKey(event: Key, behavior: EnterKeyBehavior, mobile: boolean, mac: boolean): boolean {
  if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229 || event.shiftKey || event.altKey) return false;
  // A code alone cannot distinguish software keyboards. Never intercept plain
  // Return on phones/tablets, even if a browser supplies a physical-looking code.
  if (behavior === 'enter') return !mobile && !event.ctrlKey && !event.metaKey;
  if (behavior === 'ctrl-enter') {
    return (event.code === 'Enter' || event.code === 'NumpadEnter')
      && ((event.ctrlKey && !event.metaKey) || (mac && event.metaKey && !event.ctrlKey));
  }
  return false;
}
