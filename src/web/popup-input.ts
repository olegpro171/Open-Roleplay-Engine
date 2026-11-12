export type PopupInput = 'pointer' | 'keyboard';

let lastInput: PopupInput = 'keyboard';

export function trackPopupInput() {
  document.addEventListener('pointerdown', () => { lastInput = 'pointer'; }, true);
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') lastInput = 'keyboard';
  }, true);
  document.addEventListener('click', event => {
    // Keyboard and assistive-technology activation can arrive as a click.
    if (event.isTrusted) lastInput = event.detail === 0 ? 'keyboard' : 'pointer';
  }, true);
}

export function popupInput(): PopupInput {
  return lastInput;
}

export function restorePopupFocusAfterEscape(opener: HTMLElement | null, input: PopupInput) {
  if (input === 'keyboard') opener?.focus({ preventScroll: true });
  else if (document.activeElement === opener) opener?.blur();
}
