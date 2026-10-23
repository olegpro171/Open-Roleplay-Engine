import { useLayoutEffect } from 'react';

/** iOS can pan its root viewport even when the document has overflow:hidden. */
export function useTouchScrollGuard(enabled: boolean) {
  useLayoutEffect(() => {
    if (!enabled) return;
    let gesture: { x: number; y: number; started: number; moving: boolean; path: HTMLElement[] } | null = null;
    const start = (event: TouchEvent) => {
      const touch = event.touches.item(0);
      gesture = event.touches.length === 1 && touch ? {
        x: touch.clientX, y: touch.clientY, started: performance.now(), moving: false,
        path: event.composedPath().filter((node): node is HTMLElement => node instanceof HTMLElement),
      } : null;
    };
    const move = (event: TouchEvent) => {
      const touch = event.touches.item(0);
      if (event.touches.length !== 1 || !touch) {
        gesture = null;
        return;
      }
      if (!gesture || Math.abs((window.visualViewport?.scale ?? 1) - 1) >= 0.01) return;
      const dx = gesture.x - touch.clientX, dy = gesture.y - touch.clientY;
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 4) return;
      const horizontal = Math.abs(dx) > Math.abs(dy);
      const target = gesture.path[0];
      const longPress = !gesture.moving && performance.now() - gesture.started > 350
        && target?.closest('input,textarea,[contenteditable],.prose');
      gesture.x = touch.clientX;
      gesture.y = touch.clientY;
      gesture.moving = true;
      // Keep native selection handles, long-press selection, range controls and
      // application-owned drag surfaces (such as picture cropping) available.
      if (document.getSelection()?.isCollapsed === false
        || longPress
        || (target instanceof HTMLTextAreaElement && target.selectionStart !== target.selectionEnd)
        || gesture.path.some(node => node instanceof HTMLInputElement && node.type === 'range')
        || gesture.path.some(node => getComputedStyle(node).touchAction === 'none')) {
        gesture = null;
        return;
      }
      if (horizontal && target instanceof HTMLInputElement && document.activeElement === target) return;

      for (const node of gesture.path) {
        if (node === document.body || node === document.documentElement) break;
        const style = getComputedStyle(node);
        const overflow = horizontal ? style.overflowX : style.overflowY;
        const extent = horizontal ? node.scrollWidth - node.clientWidth : node.scrollHeight - node.clientHeight;
        if (!/^(auto|scroll)$/.test(overflow) || extent <= 1) continue;
        const position = horizontal ? node.scrollLeft : node.scrollTop;
        const delta = horizontal ? dx : dy;
        // Negative scrollLeft is the normal origin convention for RTL boxes.
        const start = horizontal && style.direction === 'rtl' ? -extent : 0;
        const end = horizontal && style.direction === 'rtl' ? 0 : extent;
        if ((delta < 0 && position > start + 1) || (delta > 0 && position < end - 1)) return;
        const overscroll = horizontal ? style.overscrollBehaviorX : style.overscrollBehaviorY;
        if (overscroll === 'contain' || overscroll === 'none') break;
      }
      if (event.cancelable) event.preventDefault();
    };
    const end = () => { gesture = null; };
    document.addEventListener('touchstart', start, { passive: true, capture: true });
    document.addEventListener('touchmove', move, { passive: false, capture: true });
    document.addEventListener('touchend', end, true);
    document.addEventListener('touchcancel', end, true);
    return () => {
      document.removeEventListener('touchstart', start, true);
      document.removeEventListener('touchmove', move, true);
      document.removeEventListener('touchend', end, true);
      document.removeEventListener('touchcancel', end, true);
    };
  }, [enabled]);
}
