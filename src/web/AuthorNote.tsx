import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AuthorNote as Note, AuthorNoteStatus } from '../shared/author-note';
import { openModal } from './dialog-focus';
import { Dropdown } from './Controls';
import { Icon } from './Icon';
import { errorText, formatMessage, t, useLocale } from './localization';
import { stateLabel } from './localization-labels';
import type { SettingsAutosave } from './settings-autosave';

export function AuthorNoteSaveStatus({ saving, error, retry, disabled = false }: {
  saving: boolean; error: unknown; retry: () => Promise<void>; disabled?: boolean;
}) {
  useLocale();
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (!saving) return;
    const timer = window.setTimeout(() => setSlow(true), 1000);
    return () => window.clearTimeout(timer);
  }, [saving]);
  return <>
    {saving && slow && error == null && <div className="error-banner" role="alert">{t('author_note.slow')}</div>}
    {error != null && <div className="error-banner" role="alert"><p>{t('author_note.failed', { error: formatMessage(errorText(error)) })}</p>
      <button type="button" className="secondary" disabled={saving || disabled} onClick={() => void retry()}>{t('settings.retry')}</button></div>}
  </>;
}

export function AuthorNoteDialog({ note, editor, locked, missingMessages, saving, error, storageError, close }: {
  note: Note; editor: SettingsAutosave<Note, AuthorNoteStatus>; locked: boolean; missingMessages: boolean;
  saving: boolean; error: unknown; storageError: boolean; close: () => void;
}) {
  useLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  const [depth, setDepth] = useState(String(note.depth));
  const validDepth = /^\d+$/.test(depth) && Number(depth) <= 1000;
  useEffect(() => { setDepth(String(note.depth)); }, [note.depth]);
  useLayoutEffect(() => {
    const trigger = document.activeElement;
    const node = dialog.current;
    openModal(node);
    return () => {
      node?.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus({ preventScroll: true });
    };
  }, []);
  return createPortal(<dialog ref={dialog} className="prompt-peek author-note-dialog" aria-labelledby={title}
    onCancel={event => { event.preventDefault(); close(); }}
    onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <div className="peek-content">
      <div className="peek-heading"><h2 id={title}>{t('author_note.title')}</h2>
        <button type="button" className="secondary" aria-label={t('author_note.close')} onClick={close}><Icon name="Close" /></button></div>
      {locked && <p role="status">{t('author_note.locked')}</p>}
      <label>{t('author_note.text')}<textarea rows={12} maxLength={100_000} value={note.prompt} disabled={locked}
        onChange={event => editor.update({ prompt: event.target.value })} /></label>
      <div className="author-note-controls">
        <label>{t('author_note.depth')}<input type="text" inputMode="numeric" pattern="[0-9]+" value={depth} disabled={locked}
          aria-invalid={!validDepth || undefined} onBlur={() => { if (!validDepth) setDepth(String(note.depth)); }}
          onChange={event => {
            const value = event.target.value;
            setDepth(value);
            if (/^\d+$/.test(value) && Number(value) <= 1000) editor.update({ depth: Number(value) });
          }} /></label>
        <label>{t('author_note.role')}<Dropdown aria-label={t('author_note.role')} value={note.role} disabled={locked} onChange={role => {
          if (role === 'system' || role === 'user' || role === 'assistant') editor.update({ role });
        }} options={(['system', 'user', 'assistant'] as const).map(role => ({ value: role, label: stateLabel(role) }))} /></label>
      </div>
      {!validDepth && <p role="alert">{t('author_note.depth_invalid')}</p>}
      <p className="small muted">{t('author_note.depth_help')}</p>
      {missingMessages && note.prompt.trim() && <p role="status">{t('author_note.messages_missing')}</p>}
      {storageError && <p role="alert">{t('author_note.storage_failed')}</p>}
      <AuthorNoteSaveStatus saving={saving} error={error} retry={editor.retry} disabled={locked} />
    </div>
  </dialog>, document.body);
}
