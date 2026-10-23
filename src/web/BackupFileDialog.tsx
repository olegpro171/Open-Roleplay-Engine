import { useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { filePasswordMaxLength } from '../shared/protected-files';
import { t, useLocale } from './localization';

export type BackupFileAction = { kind: 'save' } | { kind: 'import'; file: File };

export function BackupFileDialog({ action, busy, error, errorDetails, cancel, submit }: {
  action: BackupFileAction;
  busy: boolean;
  error: string;
  errorDetails: string;
  cancel: () => void;
  submit: (password: string, confirmation: string) => void;
}) {
  useLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId(), description = useId();
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  useLayoutEffect(() => {
    const trigger = document.activeElement;
    const node = dialog.current;
    node?.showModal();
    return () => {
      node?.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus({ preventScroll: true });
    };
  }, []);
  const saving = action.kind === 'save';
  return createPortal(<dialog ref={dialog} className="confirmation-dialog backup-file-dialog" aria-labelledby={title} aria-describedby={description}
    onCancel={event => { event.preventDefault(); if (!busy) cancel(); }}>
    <h2 id={title}>{t(saving ? 'application_settings.save_backup' : 'application_settings.import_backup')}</h2>
    <p id={description}>{t(saving ? 'application_settings.backup_password_help' : 'application_settings.backup_import_password_help')}</p>
    {action.kind === 'import' && <p>{action.file.name}</p>}
    <form onSubmit={event => { event.preventDefault(); if (!busy) submit(password, confirmation); }}>
      <div className="form-grid">
        <label className="full">{t(saving ? 'application_settings.backup_export_password' : 'application_settings.backup_import_password')}
          <input type="password" autoFocus autoComplete={saving ? 'new-password' : 'off'} maxLength={filePasswordMaxLength} value={password} disabled={busy} aria-describedby={description} onChange={event => setPassword(event.target.value)} />
        </label>
        {saving && <label className="full">{t('application_settings.backup_confirm_password')}
          <input type="password" autoComplete="new-password" maxLength={filePasswordMaxLength} value={confirmation} disabled={busy} onChange={event => setConfirmation(event.target.value)} />
        </label>}
      </div>
      {busy && <p role="status">{t('application_settings.working_upload_validation_and_snapshot_work_must')}</p>}
      {error && <div role="alert"><p>{error}</p>
        {errorDetails && <details className="backup-error-details"><summary>{t('application_settings.details')}</summary><pre>{errorDetails}</pre></details>}
      </div>}
      <div className="actions">
        <button type="submit" disabled={busy}>{t(saving ? 'application_settings.save_backup_file' : 'application_settings.import_backup_file')}</button>
        <button type="button" className="secondary" disabled={busy} onClick={cancel}>{t('character_import.cancel')}</button>
      </div>
    </form>
  </dialog>, document.body);
}
