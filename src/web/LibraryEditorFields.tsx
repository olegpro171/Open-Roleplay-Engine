import { useId, type InvalidEvent } from 'react';
import { flushSync } from 'react-dom';
import { Icon } from './Icon';
import { t, useLocale } from './localization';

export function EditorFieldError({ id, error }: { id: string; error?: string }) {
  return error && <small id={id} className="editor-field-error" role="alert">{error}</small>;
}

export function EditorNameField({ value, change, label, help, name, error }: {
  value: string; label?: string; help?: string; name?: string; error?: string; change: (name: string) => void;
}) {
  useLocale();
  const helpId = useId();
  const errorId = `${helpId}-error`;
  const title = label ?? t('character_editor.name');
  return <label>{title}
    <span className="library-editor-name"><input name={name} required maxLength={100} value={value} aria-label={title}
      aria-invalid={error ? true : undefined} aria-describedby={[help && helpId, error && errorId].filter(Boolean).join(' ') || undefined}
      onChange={event => change(event.target.value)} /><Icon name="EditOutline" /></span>
    {help && <small id={helpId}>{help}</small>}
    <EditorFieldError id={errorId} error={error} />
  </label>;
}

export function revealInvalidField(event: InvalidEvent<HTMLDivElement>, showPanel: () => void) {
  const field = event.target;
  if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)) return;
  // Keep the first invalid field visible when native validation visits multiple panels.
  if (field !== field.form?.querySelector('input:invalid, textarea:invalid')) {
    event.preventDefault();
    return;
  }
  flushSync(showPanel);
  const disclosure = field.closest('details');
  if (disclosure) disclosure.open = true;
}
