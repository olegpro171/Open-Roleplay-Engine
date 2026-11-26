import { BackupFileSummary } from './BackupFileSummary';
import { Icon } from './Icon';
import { openModal } from './dialog-focus';
import { ModalDialog } from './ModalDialog';
import { useId, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from './api';
import { backupProgressSchema, type BackupProgress as ServerProgress } from '../shared/backups';
import { filePasswordMaxLength } from '../shared/protected-files';
import { locale, t, useLocale } from './localization';

export type BackupFileAction = { kind: 'save' } | { kind: 'import'; file: File };

export function BackupFileDialog({ action, uploaded, progressId, busy, error, errorDetails, cancel, submit }: {
  action: BackupFileAction;
  uploaded: number | null;
  progressId?: string;
  busy: boolean;
  error: string;
  errorDetails: string;
  cancel: () => void;
  submit: (password: string, confirmation: string) => void;
}) {
  useLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId(), description = useId();
  const passwordLabel = useId();
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  useLayoutEffect(() => openModal(dialog.current), []);
  const saving = action.kind === 'save';
  return createPortal(<ModalDialog ref={dialog} className="confirmation-dialog backup-file-dialog backup-operation-dialog" aria-labelledby={title} aria-describedby={description}
    onDismiss={() => { if (!busy) cancel(); }}>
    <h2 id={title}><Icon name={saving ? 'SaveOutline' : 'Import'} />{t(saving ? 'application_settings.save_backup' : 'application_settings.import_backup')}</h2>
    {action.kind === 'import' && <BackupFileSummary file={action.file} />}
    <form onSubmit={event => { event.preventDefault(); if (!busy) submit(password, confirmation); }}>
      <div className="form-grid">
        <label className="full"><span id={passwordLabel}>{t(saving ? 'application_settings.backup_export_password' : 'application_settings.backup_import_password')}</span>
          <input type="password" autoComplete={saving ? 'new-password' : 'off'} maxLength={filePasswordMaxLength} value={password} disabled={busy} aria-labelledby={passwordLabel} aria-describedby={description} onChange={event => setPassword(event.target.value)} />
          <small id={description} className="muted">{t(saving ? 'application_settings.backup_password_help' : 'application_settings.backup_import_password_help')}</small>
        </label>
        {saving && <label className="full">{t('application_settings.backup_confirm_password')}
          <input type="password" autoComplete="new-password" maxLength={filePasswordMaxLength} value={confirmation} disabled={busy} onChange={event => setConfirmation(event.target.value)} />
        </label>}
      </div>
      {busy && <BackupProgress key={progressId} progressId={progressId} operation={saving ? 'save' : 'preview'} transfer={
        action.kind === 'import' && uploaded !== null ? { sent: uploaded, size: action.file.size } : undefined
      } />}
      {error && <div role="alert"><p>{error}</p>
        {errorDetails && <details className="backup-error-details"><summary>{t('application_settings.details')}</summary><pre>{errorDetails}</pre></details>}
      </div>}
      <div className="actions">
        <button type="button" className="secondary" disabled={busy} onClick={cancel}>{t('character_import.cancel')}</button>
        <button type="submit" disabled={busy}>{t(saving ? 'application_settings.save_backup_file' : 'backup.preview')}</button>
      </div>
    </form>
  </ModalDialog>, document.body);
}

// Several measured passes can share one segment.
const saveSteps = ['snapshot', 'clean', 'verify', 'compact', 'encrypt'] as const;
const importSteps = ['upload', 'open', 'snapshot', 'rebuild', 'verify', 'clean', 'verifyClean', 'compare', 'verifyMerged', 'import'] as const;
type BackupStep = typeof saveSteps[number] | typeof importSteps[number];
const phaseSteps = {
  snapshot: 'snapshot', sanitize: 'clean', validate: 'verify', references: 'verify',
  compact: 'compact', encrypt: 'encrypt', decrypt: 'open', reconstruct: 'rebuild',
  validateClean: 'verifyClean', referencesClean: 'verifyClean', compare: 'compare', merge: 'compare',
  validateMerged: 'verifyMerged', referencesMerged: 'verifyMerged',
} as const satisfies Record<ServerProgress['phase'], BackupStep>;

function BackupSteps({ operation, phase, uploading }: {
  operation: 'save' | 'preview' | 'restore'; phase?: ServerProgress['phase']; uploading: boolean;
}) {
  const steps: readonly BackupStep[] = operation === 'save' ? saveSteps : importSteps;
  let current: BackupStep;
  if (operation === 'restore') current = 'import';
  else if (!phase) current = operation === 'save' ? 'snapshot' : uploading ? 'upload' : 'open';
  else current = phaseSteps[phase];
  const index = steps.indexOf(current);
  const count = t('backup.step_count', { current: index + 1, total: steps.length });
  return <div className="backup-steps">
    <div className="backup-progress-caption"><strong>{t('backup.overall_progress')}</strong><span>{count}</span></div>
    <div className="backup-step-track" role="progressbar" aria-label={t('backup.overall_progress')} aria-valuemin={0}
      aria-valuemax={steps.length} aria-valuenow={index} aria-valuetext={count}>
      {steps.map((step, i) => <span key={step} data-state={i < index ? 'done' : i === index ? 'current' : undefined} />)}
    </div>
  </div>;
}

function BackupProgress({ operation, transfer, progressId }: {
  progressId?: string;
  operation: 'save' | 'preview' | 'restore'; transfer?: { sent: number; size: number };
}) {
  const id = useId();
  const [progress, setProgress] = useState<ServerProgress | null>(null);
  useEffect(() => {
    if (!progressId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const value = await api<{ progress: unknown }>(`/data/backup-progress/${progressId}`, 'GET', undefined, controller.signal);
        const parsed = backupProgressSchema.safeParse(value.progress);
        if (!controller.signal.aborted && parsed.success) setProgress(parsed.data);
      } catch { /* The original request owns success and failure. Retry this read independently. */ }
      if (!controller.signal.aborted) timer = setTimeout(poll, 250);
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [progressId]);
  const done = progress ? progress.done : transfer?.sent;
  const total = progress ? progress.total : transfer?.size;
  const fraction = done !== undefined && total ? Math.min(1, done / total) : undefined;
  const fallbackLabels = {
    save: 'application_settings.preparing_backup_file', preview: 'application_settings.opening_backup_review',
    restore: 'application_settings.restoring_backup',
  } as const;
  const label = progress ? `backup.progress.${progress.phase}` as const : transfer ? 'backup.uploading' : fallbackLabels[operation];
  return <div className="backup-progress">
    <BackupSteps operation={operation} phase={progress?.phase} uploading={Boolean(transfer)} />
    <div className="backup-progress-caption"><span role="status" id={id}>{t(label)}</span>
      {fraction !== undefined && <span>{new Intl.NumberFormat(locale(), { style: 'percent' }).format(fraction)}</span>}
    </div>
    <div className="backup-phase-track" role="progressbar" aria-labelledby={id} aria-valuemin={0} aria-valuemax={100}
      aria-valuenow={fraction !== undefined ? Math.round(fraction * 100) : undefined}>
      <span key={label} style={fraction !== undefined ? { transform: `scaleX(${fraction})` } : undefined} />
    </div>
  </div>;
}

export function BackupRestoreDialog({ busy, error, close }: { busy: boolean; error: string; close: () => void }) {
  useLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  useLayoutEffect(() => openModal(dialog.current), []);
  return createPortal(<ModalDialog ref={dialog} className="confirmation-dialog backup-file-dialog backup-operation-dialog" aria-labelledby={title}
    onDismiss={() => { if (!busy) close(); }}>
    <h2 id={title}>{t('application_settings.import_entire_backup')}</h2>
    {busy && <BackupProgress operation="restore" />}
    {error && <p role="alert">{error}</p>}
    {!busy && <div className="actions"><button type="button" className="secondary" onClick={close}>{t('reasoning.close')}</button></div>}
  </ModalDialog>, document.body);
}
