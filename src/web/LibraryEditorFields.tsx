import type { InvalidEvent } from 'react';
import { flushSync } from 'react-dom';
import { Icon } from './Icon';
import { t, useLocale } from './localization';

export function EditorNameField({ value, change }: { value: string; change: (name: string) => void }) {
  useLocale();
  return <label>{t('character_editor.name')}
    <span className="library-editor-name"><input required maxLength={100} value={value}
      onChange={event => change(event.target.value)} /><Icon name="EditOutline" /></span>
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
