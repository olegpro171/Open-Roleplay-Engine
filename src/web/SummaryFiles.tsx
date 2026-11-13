import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { summaryFileBytes, summaryImportPreviewSchema, type SummaryImportPreview } from '../shared/summary-file';
import { api, ApiError, datasetChanged } from './api';
import { openModal } from './dialog-focus';
import { startDownload } from './downloads';
import { Icon } from './Icon';
import { LibraryImport } from './LibraryImport';
import { errorText, formatMessage, LocalizedError, message, t, useLocale, type MessageText } from './localization';
import { ModalDialog } from './ModalDialog';

type Run = (action: () => Promise<unknown>) => Promise<boolean>;

export function SummaryFiles({ branchId, revision, disabled, importLocked, run, replaced }: {
  branchId: string; revision: number; disabled: boolean; importLocked: boolean; run: Run; replaced: () => void;
}) {
  useLocale();
  const [selection, setSelection] = useState<{ file: File; revision: number } | null>(null);
  const [status, setStatus] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const path = `/chats/${encodeURIComponent(branchId)}/context/summaries`;
  return <>
    <div className="actions">
      <button className="secondary" type="button" disabled={disabled} onClick={() => void run(async () => {
        startDownload(await api(`${path}/export`, 'POST', { revision }));
      })}><Icon name="Upload" />{t('summary_file.export')}</button>
      <LibraryImport label={t('summary_file.import')} description={t('summary_file.file_help')} accept=".json"
        inputLabel={t('summary_file.input')} disabled={disabled || importLocked} triggerRef={trigger} onChange={event => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) {
            setStatus(false);
            setSelection({ file, revision });
          }
        }} />
    </div>
    {status && <p role="status">{t('summary_file.replaced')}</p>}
    {selection && <SummaryImportReview file={selection.file} path={`${path}/import`} revision={selection.revision}
      current={selection.revision === revision} blocked={importLocked} close={() => setSelection(null)}
      returnFocus={trigger.current} run={run} replaced={() => {
        setSelection(null);
        setStatus(true);
        replaced();
      }} />}
  </>;
}

function SummaryImportReview({ file, path, revision, current, blocked, close, returnFocus, run, replaced }: {
  file: File; path: string; revision: number; current: boolean; blocked: boolean; close: () => void;
  returnFocus: HTMLElement | null; run: Run; replaced: () => void;
}) {
  useLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
  const description = useId();
  const lifetime = useRef<AbortController | null>(null);
  const submitting = useRef(false);
  const [saving, setSaving] = useState(false);
  const [review, setReview] = useState<{ file: unknown; preview: SummaryImportPreview } | null>(null);
  const [failure, setFailure] = useState<{ message: MessageText; uncertain?: true } | null>(null);
  useLayoutEffect(() => openModal(dialog.current, returnFocus), []);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    async function inspect() {
      try {
        if (file.size > summaryFileBytes) throw new LocalizedError(message('summary_file.too_large'));
        const bytes = await file.arrayBuffer();
        if (controller.signal.aborted) return;
        let data: unknown;
        try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
        catch { throw new LocalizedError(message('summary_file.invalid_file')); }
        const preview = summaryImportPreviewSchema.parse(await api(path, 'POST', { revision, file: data }, controller.signal));
        if (!controller.signal.aborted && !datasetChanged()) setReview({ file: data, preview });
      } catch (cause) {
        if (!controller.signal.aborted) setFailure({ message: errorText(cause, message('summary_file.read_failed')) });
      }
    }
    void inspect();
    return () => controller.abort();
  }, [file, path, revision]);

  async function replace() {
    const controller = lifetime.current;
    if (!review || !current || blocked || failure?.uncertain || submitting.current || datasetChanged() || !controller) return;
    submitting.current = true;
    setSaving(true);
    setFailure(null);
    try {
      await run(async () => {
        try {
          await api(path, 'POST', { revision, file: review.file, token: review.preview.token }, controller.signal);
          if (!controller.signal.aborted && !datasetChanged()) replaced();
        } catch (cause) {
          if (!controller.signal.aborted) {
            const mayHaveCommitted = !(cause instanceof ApiError) || cause.status >= 500;
            setFailure(mayHaveCommitted ? { message: message('summary_file.save_uncertain'), uncertain: true }
              : { message: errorText(cause) });
          }
          // Reconcile through App after an ambiguous response as well as a save.
        }
      });
    } finally {
      submitting.current = false;
      if (!controller.signal.aborted) setSaving(false);
    }
  }

  return createPortal(<ModalDialog ref={dialog} className="confirmation-dialog library-import-dialog transcript-import-dialog"
    aria-labelledby={heading} aria-describedby={review ? description : undefined} onDismiss={() => { if (!submitting.current) close(); }}>
    <h2 id={heading}>{t('summary_file.review')}</h2>
    <p dir="auto">{file.name}</p>
    {!review && !failure && current && <p role="status">{t('summary_file.checking')}</p>}
    {review && <>
      <p id={description}>{t('summary_file.replace_description')}</p>
      <div className="budget">
        <span>{t('summary_file.version_counts', { existing: review.preview.existingVersions, incoming: review.preview.importedVersions })}</span>
        <span>{t('summary_file.archived_count', { count: review.preview.archivedTurns })}</span>
      </div>
    </>}
    {failure && <p className="error-banner" role="alert">{formatMessage(failure.message)}</p>}
    {!current && !saving && !failure && <p className="error-banner" role="alert">{t('summary_file.review_changed')}</p>}
    {saving && <p role="status">{t('summary_file.replacing')}</p>}
    <div className="actions">
      <button type="button" className="secondary" disabled={saving} onClick={close}>{t('character_import.cancel')}</button>
      {review && <button type="button" className="danger" disabled={saving || !current || blocked || failure?.uncertain} onClick={() => void replace()}>
        {t('summary_file.replace')}
      </button>}
    </div>
  </ModalDialog>, document.body);
}
