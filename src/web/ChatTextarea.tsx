import { useLayoutEffect, useRef, type TextareaHTMLAttributes } from 'react';

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'defaultValue' | 'onChange'> & {
  value: string;
  onValueChange: (value: string) => void;
};

/** Typographic substitution belongs to live typing, never to loading saved prose. */
export function ChatTextarea({ value, onValueChange, ...props }: Props) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const pendingCaret = useRef<number | null>(null);

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
