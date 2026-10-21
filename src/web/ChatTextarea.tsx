import { useLocale } from './localization';
import { useLayoutEffect, useRef, type TextareaHTMLAttributes } from 'react';

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'defaultValue' | 'onChange'> & {
  value: string;
  onValueChange: (value: string) => void;
  autoSize?: boolean;
};

/** Typographic substitution belongs to live typing, never to loading saved prose. */
export function ChatTextarea({ value, onValueChange, autoSize = false, ...props }: Props) {
  useLocale();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const pendingCaret = useRef<number | null>(null);

  useLayoutEffect(() => {
    const field = textarea.current;
    if (!autoSize || !field) return;
    const measurement = field.cloneNode();
    if (!(measurement instanceof HTMLTextAreaElement)) return;
    measurement.removeAttribute('id');
    measurement.removeAttribute('name');
    measurement.removeAttribute('aria-label');
    measurement.setAttribute('aria-hidden', 'true');
    measurement.tabIndex = -1;
    const fitContent = () => {
      const scrollTop = field.scrollTop;
      // Shrinking the live field to measure it clamps the transcript's scroll
      // position. Measure outside layout so only the final height affects chat.
      Object.assign(measurement.style, {
        position: 'fixed', visibility: 'hidden', pointerEvents: 'none',
        top: '0', left: '0', width: `${field.getBoundingClientRect().width}px`,
        height: '0', minHeight: '0', maxHeight: 'none', overflow: 'hidden',
      });
      measurement.value = field.value;
      field.after(measurement);
      try {
        const borderHeight = measurement.offsetHeight - measurement.clientHeight;
        field.style.height = `${measurement.scrollHeight + borderHeight}px`;
      } finally {
        measurement.remove();
      }
      field.scrollTop = scrollTop;
    };
    fitContent();
    let width = field.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      const nextWidth = field.getBoundingClientRect().width;
      if (nextWidth === width) return;
      width = nextWidth;
      fitContent();
    });
    observer.observe(field);
    window.addEventListener('resize', fitContent);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', fitContent);
    };
  }, [autoSize, value]);

  useLayoutEffect(() => {
    if (pendingCaret.current === null) return;
    textarea.current?.setSelectionRange(pendingCaret.current, pendingCaret.current);
    pendingCaret.current = null;
  });

  return <textarea {...props} ref={textarea} value={value} onChange={event => {
    const input = event.nativeEvent;
    const field = event.currentTarget;
    const caret = field.selectionStart;
    if (input instanceof InputEvent && !input.isComposing && input.inputType === 'insertText'
      && input.data === '-' && caret === field.selectionEnd && field.value.slice(caret - 2, caret) === '--') {
      field.setRangeText('—', caret - 2, caret, 'end');
      pendingCaret.current = caret - 1;
    }
    onValueChange(field.value);
  }} />;
}
