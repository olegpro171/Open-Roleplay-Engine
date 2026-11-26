import { useLocale } from './localization';
import { useLayoutEffect, useRef, type TextareaHTMLAttributes } from 'react';

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'defaultValue'> & { value: string };

/** Fit loaded prose without continuously overriding typing or manual resizing. */
export function EditorTextarea(props: Props) {
  useLocale();
  const textarea = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const field = textarea.current;
    if (!field) return;
    // A tab or disclosure can hide the field on mount. Capture its natural height once it has layout.
    let defaultHeight: number | undefined;
    const fitLoadedText = () => {
      const { width, height } = field.getBoundingClientRect();
      if (!width || !height) return;
      defaultHeight ??= height;
      if (!field.value) return;
      const measurement = field.cloneNode();
      if (!(measurement instanceof HTMLTextAreaElement)) return;
      measurement.removeAttribute('id');
      measurement.removeAttribute('name');
      measurement.removeAttribute('aria-label');
      measurement.setAttribute('aria-hidden', 'true');
      measurement.tabIndex = -1;
      Object.assign(measurement.style, {
        position: 'fixed', visibility: 'hidden', pointerEvents: 'none',
        top: '0', left: '0', width: `${width}px`,
        height: '0', minHeight: '0', maxHeight: 'none', overflow: 'hidden',
      });
      measurement.value = field.value;
      field.after(measurement);
      try {
        const borders = measurement.offsetHeight - measurement.clientHeight;
        field.style.height = `${Math.max(defaultHeight, Math.min(defaultHeight * 4, measurement.scrollHeight + borders))}px`;
      } finally {
        measurement.remove();
      }
    };
    fitLoadedText();
    let width = field.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      const nextWidth = field.getBoundingClientRect().width;
      if (nextWidth === width) return;
      width = nextWidth;
      fitLoadedText();
    });
    observer.observe(field);
    return () => observer.disconnect();
  }, []);
  return <textarea {...props} ref={textarea} />;
}
