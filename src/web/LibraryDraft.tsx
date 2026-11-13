import { createContext, useContext, useLayoutEffect, useMemo, useState, type MouseEventHandler } from 'react';
import { datasetEpoch } from './api';
import { useConfirmEditorLeave, warnBeforeUnload } from './EditorLeaveGuard';
import { EditorTextarea } from './EditorTextarea';
import { readLibraryDraft, writeLibraryDraft, type LibraryDraft, type LibraryEditorDraft } from './library-draft';
import { t, useLocale } from './localization';

function libraryDraftSession(recovered: LibraryDraft | null) {
  let draft = recovered;
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reportStorageError: ((failed: boolean) => void) | undefined;

  function flush() {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
    const saved = writeLibraryDraft(draft);
    reportStorageError?.(!saved);
  }
  function clear() {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    const hadDraft = draft !== null;
    draft = null;
    dirty = false;
    if (hadDraft) reportStorageError?.(!writeLibraryDraft(null));
  }
  function beforeUnload(event: BeforeUnloadEvent) {
    if (!dirty) return;
    flush();
    warnBeforeUnload(event);
  }
  function onVisibilityChange() { if (document.visibilityState === 'hidden') flush(); }

  return {
    recovered: () => draft,
    dirty: () => dirty,
    clear,
    update(next: LibraryDraft | null, report: (failed: boolean) => void) {
      reportStorageError = report;
      if (!next) { clear(); return; }
      dirty = true;
      draft = next;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(flush, 300);
    },
    watchUnload() {
      window.addEventListener('beforeunload', beforeUnload);
      document.addEventListener('visibilitychange', onVisibilityChange);
      return () => {
        window.removeEventListener('beforeunload', beforeUnload);
        document.removeEventListener('visibilitychange', onVisibilityChange);
      };
    },
    deactivate() {
      reportStorageError = undefined;
      // Keep the tab draft if a sibling tab signs out of the shared session.
      flush();
      dirty = false;
    },
  };
}

type DraftSession = ReturnType<typeof libraryDraftSession>;
export const LibraryDraftContext = createContext<DraftSession | null>(null);
export function useLibraryLeaveGuard(authenticated: boolean) {
  const [drafts] = useState(() => libraryDraftSession(readLibraryDraft()));
  const leave = useConfirmEditorLeave(authenticated ? 'library-editor' : null, drafts.dirty, drafts.clear);
  return { drafts, leave };
}

export function useLibraryEditorDraft(editor: LibraryEditorDraft, dirty: boolean, recoveredEpoch?: string) {
  const session = useContext(LibraryDraftContext);
  const [epoch] = useState(() => recoveredEpoch ?? datasetEpoch());
  const [storageError, setStorageError] = useState(false);
  const draft = useMemo<LibraryDraft | null>(() => dirty ? { version: 1, epoch, editor } : null, [dirty, epoch, editor]);
  useLayoutEffect(() => () => session?.deactivate(), [session]);
  useLayoutEffect(() => { session?.update(draft, setStorageError); }, [session, draft]);
  useLayoutEffect(() => dirty ? session?.watchUnload() : undefined, [session, dirty]);
  return storageError;
}

export function LibraryDraftNotice({ recovered, storageError }: { recovered?: LibraryEditorDraft; storageError?: boolean }) {
  useLocale();
  return <>
    {recovered && <p role="status">{t('library_draft.recovered')}</p>}
    {recovered?.kind === 'characters' && recovered.pictureOmitted && <p role="status">{t('library_draft.picture_omitted')}</p>}
    {recovered?.kind === 'connections' && recovered.keyOmitted && <p role="status">{t('library_draft.key_omitted')}</p>}
    {storageError && <p role="alert">{t('library_draft.storage_failed')}</p>}
  </>;
}

export function CopyLibraryDraft({ editor }: { editor: LibraryEditorDraft }) {
  useLocale();
  const [open, setOpen] = useState(false);
  // Use selectable text so copying also works on HTTP LAN origins.
  return <details onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{t('library_draft.copy_fields')}</summary>
    {open && <label>{t('library_draft.draft_fields')}<EditorTextarea readOnly value={formatDraftFields(editor)} /></label>}
  </details>;
}

function formatDraftFields(editor: LibraryEditorDraft) {
  const fields: string[] = [];
  function append(value: unknown, path: string) {
    if (typeof value === 'object' && value !== null) {
      for (const [key, child] of Object.entries(value)) {
        if (key !== 'source' && child !== undefined) append(child, path ? `${path}.${key}` : key);
      }
    } else {
      fields.push(`${path}\n${String(value)}`);
    }
  }
  append(editor.data, '');
  if (editor.numbers) append(editor.numbers, 'numbers');
  if (editor.kind === 'characters') append(editor.tagIds, 'tagIds');
  if (editor.kind === 'connections') {
    append(editor.parameters, 'customParameters');
    append(editor.removeKey, 'removeKey');
  }
  return fields.join('\n\n');
}

export function StaleLibraryDraft({ draft, close }: { draft: LibraryDraft; close: MouseEventHandler<HTMLButtonElement> }) {
  useLocale();
  const storageError = useLibraryEditorDraft(draft.editor, true, draft.epoch);
  return <section>
    <p role="status">{t('library_draft.stale')}</p>
    <LibraryDraftNotice storageError={storageError} />
    <CopyLibraryDraft editor={draft.editor} />
    <div className="actions"><button type="button" className="secondary" onClick={close}>{t('library_draft.discard_draft')}</button></div>
  </section>;
}
