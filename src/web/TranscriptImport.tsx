import { useId, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { importChat } from '../core/chat-import';
import { transcriptFileLimit, transcriptImportResultSchema, type ImportBranch, type ImportChat, type LibrarySnapshot } from '../shared/library';
import { MessageError } from '../shared/localization';
import { api, ApiError, datasetChanged } from './api';
import { ChatParticipants, type ChatParticipantsValue } from './ChatParticipants';
import { openModal } from './dialog-focus';
import { LibraryImport } from './LibraryImport';
import { errorText, formatMessage, message, t, useLocale, type MessageText } from './localization';
import { newId } from './uuid';

type Destination = { kind: 'chat'; library: LibrarySnapshot } | { kind: 'branch'; groupId: string; title: string };

async function* fileChunks(file: File, signal: AbortSignal) {
  const reader = file.stream().getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  function decode(value?: Uint8Array) {
    try { return decoder.decode(value, { stream: value !== undefined }); }
    catch { throw new MessageError(message('importErrors.invalid_utf8')); }
  }
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) { yield decode(); return; }
      yield decode(value);
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
}

function importTitle(destination: Destination) {
  return t(destination.kind === 'chat' ? 'transcript_import.chat' : 'transcript_import.branch');
}

export function TranscriptImport({ destination, disabled, created }: {
  destination: Destination; disabled: boolean; created: (id: string) => void;
}) {
  useLocale();
  const [selection, setSelection] = useState<{ file: File; requestId: string } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const title = importTitle(destination);
  return <>
    <LibraryImport label={destination.kind === 'branch' ? t('branches.import') : title} dialogTitle={title} description={t('library_import.transcript_description')}
      inputLabel={t('transcript_import.file')} accept=".jsonl" disabled={disabled} triggerRef={trigger} onChange={event => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (file) setSelection({ file, requestId: newId() });
      }} />
    {selection && <ImportReview key={selection.requestId} destination={destination} file={selection.file} initialRequestId={selection.requestId}
      close={() => setSelection(null)} restoreFocus={() => trigger.current?.focus({ preventScroll: true })} created={created} />}
  </>;
}

function ImportReview({ destination, file, initialRequestId, close, restoreFocus, created }: {
  destination: Destination; file: File; initialRequestId: string;
  close: () => void; restoreFocus: () => void; created: (id: string) => void;
}) {
  useLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const lifecycle = useRef<AbortController | null>(null);
  const submitting = useRef(false);
  const heading = useId();
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof importChat>> | null>(null);
  const [error, setError] = useState<MessageText | null>(null);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState<string | null>(null);
  const [participants, setParticipants] = useState<ChatParticipantsValue>({ characterId: null, personaId: null });
  const requestId = useRef(initialRequestId);
  const [uncertainName, setUncertainName] = useState<string | null>(null);
  const stem = file.name.trim().replace(/\.[^.]+$/, '').trim().slice(0, 100).replace(/[\uD800-\uDFFF]$/u, '');
  const confirmedName = uncertainName ?? name ?? (stem || t(destination.kind === 'chat' ? 'transcript_import.default_chat_title' : 'transcript_import.default_branch_name'));
  const locked = saving || uncertainName !== null;

  useLayoutEffect(() => {
    const node = dialog.current;
    const controller = new AbortController();
    lifecycle.current = controller;
    openModal(node);
    async function read() {
      try {
        if (file.size > transcriptFileLimit) throw new MessageError(message('importErrors.file_too_large'));
        const result = await importChat(fileChunks(file, controller.signal));
        if (!controller.signal.aborted) setPreview(result);
      } catch (error) {
        if (!controller.signal.aborted) setError(error instanceof MessageError ? error.localized : message('transcript_import.read_failed'));
      }
    }
    void read();
    return () => {
      controller.abort();
      node?.close();
      restoreFocus();
    };
  // A newly selected file mounts its own review and owns its read/submit lifetime.
  }, [file]);

  async function save(event: FormEvent) {
    event.preventDefault();
    const controller = lifecycle.current;
    if (!preview || !confirmedName.trim() || !controller || submitting.current) return;
    submitting.current = true;
    setSaving(true);
    setError(null);
    try {
      const fields = { requestId: requestId.current, turns: preview.turns };
      const path = destination.kind === 'chat' ? '/chats/import' : `/chat-groups/${encodeURIComponent(destination.groupId)}/branches/import`;
      const body: ImportChat | ImportBranch = destination.kind === 'chat'
        ? { ...fields, title: confirmedName, ...participants } : { ...fields, name: confirmedName };
      const result = transcriptImportResultSchema.parse(await api<unknown>(path, 'POST', body, controller.signal));
      if (controller.signal.aborted) return;
      if (datasetChanged()) throw new MessageError(message('errors.application_data_was_imported_or_wiped_reopen_the'));
      close();
      created(result.id);
    } catch (error) {
      if (controller.signal.aborted) return;
      // A missing acknowledgement may hide a committed import. Retry the same inputs and ID.
      const uncertain = !(error instanceof ApiError) || error.status >= 500;
      setUncertainName(uncertain ? confirmedName : null);
      setError(error instanceof MessageError || (error instanceof ApiError && (error.localized || error.issues?.length))
        ? errorText(error) : message(uncertain ? 'transcript_import.save_uncertain' : 'transcript_import.save_failed'));
    } finally {
      submitting.current = false;
      if (!controller.signal.aborted) setSaving(false);
    }
  }

  return createPortal(<dialog ref={dialog} className="confirmation-dialog library-import-dialog transcript-import-dialog" aria-labelledby={heading}
    onCancel={event => { event.preventDefault(); event.stopPropagation(); if (!submitting.current) close(); }}>
    <h2 id={heading}>{importTitle(destination)}</h2>
    {destination.kind === 'branch' && <p>{t('transcript_import.branch_destination', { title: destination.title })}</p>}
    <p>{file.name}</p>
    {!preview && !error && <p role="status">{t('transcript_import.reading')}</p>}
    {preview && <div className="budget transcript-import-counts">
      <strong>{t('transcript_import.messages', { count: preview.messages })} · {t('counts.turns', { count: preview.turns.length })}</strong>
      {preview.extraTurns > 0 && <span>{t('transcript_import.splits', { count: preview.extraTurns })}</span>}
      <span>{t(preview.turns.at(-1)?.complete ? 'interface.all_turns_are_complete' : 'interface.the_final_user_turn_will_await_a_response')}</span>
    </div>}
    {error && <div className="error-banner" role="alert">{formatMessage(error)}</div>}
    <form onSubmit={save}>
      {preview && <>
        <label>{t(destination.kind === 'chat' ? 'libraries.chat_title' : 'branches.name')}
          <input required maxLength={100} disabled={locked} value={confirmedName} onChange={event => {
            setName(event.target.value);
            requestId.current = newId();
          }} />
        </label>
        {destination.kind === 'chat' && <ChatParticipants library={destination.library} value={participants} disabled={locked}
          change={value => { setParticipants(value); requestId.current = newId(); }} />}
      </>}
      {saving && <p role="status">{t('transcript_import.saving')}</p>}
      <div className="actions">
        <button type="button" className="secondary" disabled={saving} onClick={close}>{t('character_import.cancel')}</button>
        {preview && <button type="submit" disabled={saving || !confirmedName.trim()}>
          {t(uncertainName === null ? 'character_import.import' : 'transcript_import.retry')}
        </button>}
      </div>
    </form>
  </dialog>, document.body);
}
