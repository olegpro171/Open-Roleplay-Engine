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

// Scroll notifications queued while revealing a trigger can arrive after its
// popup has already been placed. Compare against the offsets at placement.
export function capturePopupScroll(anchor: Element | null, viewport?: VisualViewport | null) {
  const offsets = new Map<Element, { left: number; top: number }>();
  for (let node = anchor; node; node = node.parentElement) {
    offsets.set(node, { left: node.scrollLeft, top: node.scrollTop });
  }
  const windowLeft = window.scrollX, windowTop = window.scrollY;
  const viewportLeft = viewport?.pageLeft, viewportTop = viewport?.pageTop;
  return (target: EventTarget | null) => {
    if (target === document || target === window) return window.scrollX !== windowLeft || window.scrollY !== windowTop;
    if (viewport && target === viewport) return viewport.pageLeft !== viewportLeft || viewport.pageTop !== viewportTop;
    if (target instanceof Element) {
      const opening = offsets.get(target);
      if (opening) return target.scrollLeft !== opening.left || target.scrollTop !== opening.top;
    }
    return true;
  };
}
