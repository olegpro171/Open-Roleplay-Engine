import { useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { connectionFileMaxBytes } from '../shared/connection-files';
import { filePasswordMaxLength } from '../shared/protected-files';
import { api } from './api';
import { startDownload } from './downloads';
import { openModal } from './dialog-focus';
import { errorText, LocalizedError, message, t, useLocale, useTextState } from './localization';

export type ConnectionFileAction =
  | { kind: 'export'; id: string; name: string }
  | { kind: 'import'; file: File; revision: number };

export function ConnectionFileDialog({ action, cancel, complete }: {
  action: ConnectionFileAction;
  cancel: () => void;
  complete: (kind: ConnectionFileAction['kind']) => void;
}) {
  useLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId(), description = useId(), warning = useId();
  const [password, setPassword] = useState('');
  const [includeApiKey, setIncludeApiKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useTextState('');
  const pending = useRef(false), mounted = useRef(true);
  useLayoutEffect(() => {
    mounted.current = true;
    const trigger = document.activeElement;
    const node = dialog.current;
    openModal(node);
    return () => {
      mounted.current = false;
      node?.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus({ preventScroll: true });
    };
  }, []);
  const exporting = action.kind === 'export';
  async function submit() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true); setError('');
    try {
      if (action.kind === 'export') {
        const prepared = await api<unknown>(`/library/connections/${encodeURIComponent(action.id)}/export`, 'POST', { password, includeApiKey });
        if (!mounted.current) return;
        startDownload(prepared);
      } else {
        if (action.file.size > connectionFileMaxBytes) throw new LocalizedError(message('connection_files.too_large'));
        const bytes = new Uint8Array(await action.file.arrayBuffer());
        if (!mounted.current) return;
        let binary = '';
        for (const byte of bytes) binary += String.fromCharCode(byte);
        // Keep this captured revision on retries: an uncertain first save must
        // never create another copy after an acknowledgement is lost.
        await api('/library/connections/import', 'POST', { revision: action.revision, password, base64: btoa(binary) });
      }
      if (mounted.current) complete(action.kind);
    } catch (failure) {
      if (mounted.current) setError(errorText(failure, message(exporting ? 'connection_files.export_failed' : 'connection_files.import_failed')));
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return createPortal(<dialog ref={dialog} className="confirmation-dialog backup-file-dialog" aria-labelledby={title} aria-describedby={description}
    onCancel={event => { event.preventDefault(); if (!pending.current) cancel(); }}>
    <h2 id={title}>{t(exporting ? 'connection_files.export_title' : 'connection_files.import_title')}</h2>
    <p id={description}>{t(exporting ? 'connection_files.export_help' : 'connection_files.import_help')}</p>
    <p>{action.kind === 'export' ? action.name : action.file.name}</p>
    <form onSubmit={event => { event.preventDefault(); void submit(); }}>
      <div className="form-grid">
        <label className="full">{t(exporting ? 'connection_files.export_password' : 'connection_files.import_password')}
          <input type="password" autoComplete={exporting ? 'new-password' : 'off'} maxLength={filePasswordMaxLength} value={password} disabled={busy} aria-describedby={description} onChange={event => setPassword(event.target.value)} />
        </label>
        {exporting && <label className="checkbox full"><input type="checkbox" checked={includeApiKey} disabled={busy} aria-describedby={includeApiKey ? warning : undefined} onChange={event => setIncludeApiKey(event.target.checked)} />{t('connection_files.include_key')}</label>}
      </div>
      {exporting && includeApiKey && <p id={warning} role="alert">{t('connection_files.key_warning')}</p>}
      {busy && <p role="status">{t('connection_files.working')}</p>}
      {error && <p role="alert">{error}</p>}
      <div className="actions">
        <button type="submit" disabled={busy}>{t(exporting ? 'application_settings.save_backup_file' : 'application_settings.import_backup_file')}</button>
        <button type="button" className="secondary" disabled={busy} onClick={cancel}>{t('character_import.cancel')}</button>
      </div>
    </form>
  </dialog>, document.body);
}
