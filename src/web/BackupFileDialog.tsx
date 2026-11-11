import { openModal } from './dialog-focus';
import { ModalDialog } from './ModalDialog';
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
    openModal(node);
    return () => {
      node?.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus({ preventScroll: true });
    };
  }, []);
  const saving = action.kind === 'save';
  return createPortal(<ModalDialog ref={dialog} className="confirmation-dialog backup-file-dialog" aria-labelledby={title} aria-describedby={description}
    onDismiss={() => { if (!busy) cancel(); }}>
    <h2 id={title}>{t(saving ? 'application_settings.save_backup' : 'application_settings.import_backup')}</h2>
    <p id={description}>{t(saving ? 'application_settings.backup_password_help' : 'application_settings.backup_import_password_help')}</p>
    {action.kind === 'import' && <p>{action.file.name}</p>}
    <form onSubmit={event => { event.preventDefault(); if (!busy) submit(password, confirmation); }}>
      <div className="form-grid">
        <label className="full">{t(saving ? 'application_settings.backup_export_password' : 'application_settings.backup_import_password')}
          <input type="password" autoComplete={saving ? 'new-password' : 'off'} maxLength={filePasswordMaxLength} value={password} disabled={busy} aria-describedby={description} onChange={event => setPassword(event.target.value)} />
        </label>
        {saving && <label className="full">{t('application_settings.backup_confirm_password')}
          <input type="password" autoComplete="new-password" maxLength={filePasswordMaxLength} value={confirmation} disabled={busy} onChange={event => setConfirmation(event.target.value)} />
        </label>}
      </div>
      {busy && <BackupProgress operation={saving ? 'save' : 'preview'} />}
      {error && <div role="alert"><p>{error}</p>
        {errorDetails && <details className="backup-error-details"><summary>{t('application_settings.details')}</summary><pre>{errorDetails}</pre></details>}
      </div>}
      <div className="actions">
        <button type="submit" disabled={busy}>{t(saving ? 'application_settings.save_backup_file' : 'application_settings.import_backup_file')}</button>
        <button type="button" className="secondary" disabled={busy} onClick={cancel}>{t('character_import.cancel')}</button>
      </div>
    </form>
  </ModalDialog>, document.body);
}

function BackupProgress({ operation }: { operation: 'save' | 'preview' | 'restore' }) {
  const id = useId();
  const label = operation === 'save' ? 'application_settings.preparing_backup_file'
    : operation === 'preview' ? 'application_settings.opening_backup_review'
    : 'application_settings.restoring_backup';
  return <div className="backup-progress">
    <p role="status" id={id}>{t(label)}</p>
    <progress aria-labelledby={id} />
  </div>;
}

export function BackupRestoreDialog({ busy, error, close }: { busy: boolean; error: string; close: () => void }) {
  useLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  useLayoutEffect(() => {
    const trigger = document.activeElement;
    const node = dialog.current;
    openModal(node);
    return () => {
      node?.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus({ preventScroll: true });
    };
  }, []);
  return createPortal(<ModalDialog ref={dialog} className="confirmation-dialog backup-file-dialog" aria-labelledby={title}
    onDismiss={() => { if (!busy) close(); }}>
    <h2 id={title}>{t('application_settings.import_entire_backup')}</h2>
    {busy && <BackupProgress operation="restore" />}
    {error && <p role="alert">{error}</p>}
    {!busy && <div className="actions"><button type="button" className="secondary" onClick={close}>{t('reasoning.close')}</button></div>}
  </ModalDialog>, document.body);
}
