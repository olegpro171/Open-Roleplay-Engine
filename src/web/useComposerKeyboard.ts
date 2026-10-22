import { useEffect, useState } from 'react';

/** Infer a software keyboard from composer focus and unzoomed viewport loss. */
export function useComposerKeyboard(enabled: boolean) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!enabled || !viewport) return;

    let width = window.innerWidth;
    let expandedHeight = Math.max(window.innerHeight, viewport.height);
    const update = () => {
      const unzoomed = Math.abs(viewport.scale - 1) < 0.01;
      if (window.innerWidth !== width) {
        width = window.innerWidth;
        expandedHeight = Math.max(window.innerHeight, viewport.height);
      }
      if (unzoomed) expandedHeight = Math.max(expandedHeight, window.innerHeight, viewport.height);
      // Browser chrome can resize the viewport too; require a keyboard-sized
      // loss and editor focus, rather than treating any resize as a keyboard.
      const focused = document.activeElement?.id === 'turn-input';
      setVisible(focused && unzoomed && expandedHeight - viewport.height >= 120);
    };
    update();
    viewport.addEventListener('resize', update);
    window.addEventListener('resize', update);
    document.addEventListener('focusin', update);
    document.addEventListener('focusout', update);
    return () => {
      viewport.removeEventListener('resize', update);
      window.removeEventListener('resize', update);
      document.removeEventListener('focusin', update);
      document.removeEventListener('focusout', update);
    };
  }, [enabled]);

  return enabled && visible;
}
