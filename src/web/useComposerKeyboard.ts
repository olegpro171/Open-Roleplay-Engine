import { useEffect, useState } from 'react';

/** Infer a software keyboard from composer focus and unzoomed viewport loss. */
export function useComposerKeyboard(enabled: boolean) {
  const [keyboardViewport, setKeyboardViewport] = useState<{ pageTop: number; height: number } | null>(null);

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
      if (!focused || !unzoomed || expandedHeight - viewport.height < 120) {
        setKeyboardViewport(null);
        return;
      }
      // Focusing the editor can pan the document and the visual viewport
      // independently of the resize. Anchor Story in document coordinates.
      const { pageTop, height } = viewport;
      setKeyboardViewport(current => current?.pageTop === pageTop && current.height === height ? current : { pageTop, height });
    };
    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    window.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    document.addEventListener('focusin', update);
    document.addEventListener('focusout', update);
    return () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      document.removeEventListener('focusin', update);
      document.removeEventListener('focusout', update);
    };
  }, [enabled]);

  return enabled ? keyboardViewport : null;
}
