import { useLayoutEffect, useRef, type TextareaHTMLAttributes } from 'react';

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'defaultValue'> & { value: string };

/** Fit loaded prose without continuously overriding typing or manual resizing. */
export function EditorTextarea(props: Props) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const field = textarea.current;
    if (!field) return;
    const defaultHeight = field.getBoundingClientRect().height;
    const fitLoadedText = () => {
      const width = field.getBoundingClientRect().width;
      if (!width || !field.value) return;
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
