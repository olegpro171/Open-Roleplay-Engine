import { flushSync } from 'react-dom';
import { compareInsertionOrder, rankLoreEntry } from '../core/lore-entry-order';
import { moveListItem } from './useListReorder';
import { LibraryImport } from './LibraryImport';
import { LocalizedError, formatMessage, useTextState, errorText, t, message as msg, useLocale, locale } from './localization';
import { validationMessage } from '../shared/localization-validation';
import type { z } from 'zod';
import { entryNumberFields, entryNumberKey, LoreEntryFields } from './LoreEntryFields';
import { newId } from './uuid';
import { Icon } from './Icon';
import { useConfirmation } from './Confirmation';
import { WarningDetails } from './WarningDialog';
import { EditorActions } from './EditorActions';
import { CopyLibraryDraft, LibraryDraftNotice, useLibraryEditorDraft } from './LibraryDraft';
import { sameDraftValue, type DraftOf } from './library-draft';
import { EditorTextarea } from './EditorTextarea';
import { EditorNameField, revealInvalidField } from './LibraryEditorFields';
import { EditorTabs } from './EditorTabs';
import { LoreEntryList, LorePagination, lorePageSize as pageSize } from './LoreEntryList';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type MouseEventHandler, type ReactNode } from 'react';
import { LOREBOOK_ENTRY_LIMIT, LOREBOOK_FILE_LIMIT, lorebookSchema, newLoreEntry, type Lorebook, type LoreDiagnostic, type LoreEntry, type LoreImportPreview } from '../shared/lorebook';
import { api, ApiError } from './api';
import { NumberDraftContext, NumberInput, useNumberDraft } from './Controls';
import { loreCompatibility } from '../core/lorebook-formats';

type Run = (action: () => Promise<unknown>) => Promise<boolean>;
const tabs = [
  ['entries', 'lorebook_editor.edit_entries'], ['arrange', 'lorebook_editor.arrange_entries'], ['settings', 'lorebook_editor.book_settings'],
] as const;
type LoreTab = (typeof tabs)[number][0];

export function LoreDiagnostics({ diagnostics }: { diagnostics: LoreDiagnostic[] }) {
  useLocale();
  const [page, setPage] = useState(0);
  const last = Math.max(0, Math.ceil(diagnostics.length / pageSize) - 1);
  const shown = Math.min(page, last);
  if (diagnostics.length === 0) return null;
  const label = t("lorebook_editor.compatibility_notices", { length: diagnostics.length });
  return <WarningDetails label={label} title={label}>
    <p>{t("lorebook_editor.unsupported_behavior_is_preserved_for_export_and")}</p>
    <ul className="warning-messages">{diagnostics.slice(shown * pageSize, (shown + 1) * pageSize).map((item, index) => (
      <li key={index}>{formatMessage(item.localized ?? item.message)}{item.field && <small> · {item.field}</small>}</li>
    ))}</ul>
    {last > 0 && <LorePagination page={shown} last={last} change={setPage} />}
  </WarningDetails>;
}

export function LorebookImport({ leadingAction, revision, busy, run, imported }: { leadingAction: ReactNode; revision: number; busy: boolean; run: Run; imported: (id: string, notice: string) => void }) {
  useLocale();
  const [review, setReview] = useState<{ preview: LoreImportPreview; value: unknown; revision: number; requestId: string; filename: string } | null>(null);
  const [error, setError] = useTextState(''), [reading, setReading] = useState(false), [attempted, setAttempted] = useState(false);
  const attempt = useRef(0);
  useEffect(() => () => { attempt.current++; }, []);
  return <div className="lore-import">
    <div className="actions library-toolbar" role="group" aria-label={t("character_import.library_actions")}>{leadingAction}<LibraryImport label={t("lorebook_editor.import_lorebook")} description={t('library_import.lorebook_description')} inputLabel={t("lorebook_editor.lorebook_json_file")} accept=".json,application/json" disabled={busy || reading} onChange={async event => {
      const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
      const current = ++attempt.current; setReview(null); setError(''); setReading(true); setAttempted(false);
      try {
        if (file.size > LOREBOOK_FILE_LIMIT) throw new LocalizedError(msg("lorebook_editor.lorebook_imports_are_limited_to_5_mb"));
        const value: unknown = JSON.parse(await file.text());
        const preview = await api<LoreImportPreview>('/library/lorebooks/preview', 'POST', { value });
        if (attempt.current === current) setReview({ preview, value, revision, requestId: newId(), filename: file.name });
      } catch (failure) { if (attempt.current === current) setError(errorText(failure, msg("lorebook_editor.could_not_read_this_lorebook"))); }
      finally { if (attempt.current === current) setReading(false); }
    }} /></div>
    {reading && <p role="status">{t("lorebook_editor.reviewing_lorebook")}</p>}{error && <p role="alert">{error}</p>}
    {review && <div className="lore-import-review"><h3>{t("character_import.review", { name: review.preview.book.name })}</h3><p className="small">{t("lorebook_editor.format_entries_enabled", { filename: review.filename, format: review.preview.format, length: review.preview.book.entries.length, length2: review.preview.book.entries.filter(entry => entry.enabled).length })}</p><p className="small">{t("lorebook_editor.scan_depth_messages_lore_cap_tokens_recursion", { scanDepth: review.preview.book.scanDepth, value: review.preview.book.tokenBudget.toLocaleString(locale()), value2: review.preview.book.recursiveScanning ? t("interface.on") : t("interface.off") })}</p><LoreDiagnostics diagnostics={review.preview.diagnostics} />
      <p className="small muted">{t("lorebook_editor.import_creates_a_new_book_select_it")}</p>
      {review.revision !== revision && !attempted && <p role="status">{t("lorebook_editor.the_library_changed_select_the_file_again")}</p>}
      <div className="actions"><button disabled={busy || (!attempted && review.revision !== revision)} onClick={async () => {
        setAttempted(true);
        await run(async () => {
          try {
            const result = await api<{ id: string; diagnostics: LoreDiagnostic[] }>('/library/lorebooks/import', 'POST', { revision: review.revision, requestId: review.requestId, value: review.value });
            setReview(null); setAttempted(false); imported(result.id, t("lorebook_editor.imported_with_entries", { name: review.preview.book.name, length: review.preview.book.entries.length }));
          } catch (failure) {
            if (failure instanceof ApiError && failure.status < 500) setAttempted(false);
            throw failure;
          }
        });
      }}>{attempted ? t("lorebook_editor.retry_reviewed_import") : t("lorebook_editor.import_reviewed_lorebook")}</button><button className="quiet" disabled={busy} onClick={() => { setReview(null); setAttempted(false); }}>{t("lorebook_editor.cancel_import")}</button></div>
      {attempted && <p className="small muted">{t("lorebook_editor.retry_keeps_the_same_import_identity_and")}</p>}
    </div>}
  </div>;
}

function markBook(book: Lorebook, patch: Partial<Lorebook>): Lorebook {
  return { ...book, ...patch, ...(book.source ? { source: { ...book.source, edited: [...new Set([...(book.source.edited ?? []), ...Object.keys(patch)])] } } : {}) };
}
function markEntry(entry: LoreEntry, patch: Partial<LoreEntry>): LoreEntry {
  return { ...entry, ...patch, ...(entry.source ? { source: { ...entry.source, edited: [...new Set([...(entry.source.edited ?? []), ...Object.keys(patch)])] } } : {}) };
}

function sameBookDraft(book: Lorebook, baseline: Lorebook) {
  if (book === baseline) return true;
  // Import export markers track which fields were touched. Reverting every
  // editable value should still leave a clean editor.
  const { entries, source: _source, ...fields } = book;
  const { entries: originalEntries, source: _originalSource, ...originalFields } = baseline;
  return sameDraftValue(fields, originalFields) && entries.length === originalEntries.length && entries.every((entry, index) => {
    const original = originalEntries[index];
    if (entry === original) return true;
    return sameDraftValue({ ...entry, source: undefined }, { ...original, source: undefined });
  });
}

function recoveredNumbers(draft?: DraftOf<'lorebooks'>) {
  const values = { ...draft?.numbers };
  // Earlier drafts stored unfinished numbers only for the selected entry.
  for (const field of entryNumberFields) {
    const previous = `entry.${field}`;
    if (draft?.selectedId && values[previous] !== undefined) {
      values[entryNumberKey(draft.selectedId, field)] = values[previous];
      delete values[previous];
    }
  }
  return values;
}

export function LorebookEditor({ initial, recovered, currentRevision, busy, run, close, committed }: { initial: { id?: string; revision: number; data: Lorebook }; recovered?: DraftOf<'lorebooks'>; currentRevision: number; busy: boolean; run: Run; close: MouseEventHandler<HTMLButtonElement>; committed: () => void }) {
  useLocale();
  const formId = useId();
  const confirmAction = useConfirmation();
  const [book, setBook] = useState(recovered?.data ?? initial.data);
  const ordered = useMemo(() => [...book.entries].sort(compareInsertionOrder), [book.entries]);
  const [selectedId, setSelectedId] = useState(() => recovered?.selectedId || ordered[0]?.id || '');
  const initialNumbers = useMemo(() => recoveredNumbers(recovered), [recovered]);
  const numberDraft = useNumberDraft(initialNumbers);
  const bookChanged = useMemo(() => !sameBookDraft(book, initial.data), [book, initial.data]);
  const dirty = bookChanged || numberDraft.dirty;
  const draft = useMemo<DraftOf<'lorebooks'>>(() => ({ kind: 'lorebooks', id: initial.id, revision: initial.revision, data: book, selectedId, numbers: numberDraft.values }),
    [initial.id, initial.revision, book, selectedId, numberDraft.values]);
  const storageError = useLibraryEditorDraft(draft, dirty);
  const form = useRef<HTMLFormElement>(null);
  const selectionScroll = useRef<{ element: HTMLElement; top: number }[]>([]);
  useLayoutEffect(() => {
    // Safari can move scrolling ancestors when the keyed entry fields are
    // removed. Restore their positions after the replacement fields fit their
    // loaded text; the browser still clamps to a genuinely shorter page.
    const positions = selectionScroll.current;
    selectionScroll.current = [];
    for (const { element, top } of positions) {
      element.scrollTo({ top, behavior: 'instant' });
    }
  }, [selectedId]);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(() => Math.floor(Math.max(0, ordered.findIndex(entry => entry.id === selectedId)) / pageSize));
  const [issues, setIssues] = useState<z.core.$ZodIssue[]>([]);
  const compatibility = useMemo(() => loreCompatibility(initial.data), [initial.data]);
  const stale = initial.revision !== currentRevision;
  const selected = book.entries.find(entry => entry.id === selectedId);
  const [tab, setTab] = useState<LoreTab>('entries');
  function update(patch: Partial<Lorebook>) { setBook(value => markBook(value, patch)); }
  function updateEntry(patch: Partial<LoreEntry>) { update({ entries: book.entries.map(entry => entry.id === selectedId ? markEntry(entry, patch) : entry) }); }
  function applyOrder(next: LoreEntry[], position: number, newEntry?: LoreEntry) {
    const ranks = rankLoreEntry(next, position);
    const entries = newEntry ? [...book.entries, newEntry] : book.entries;
    update({ entries: entries.map(entry => {
      const insertionOrder = ranks.get(entry.id);
      return insertionOrder === undefined || insertionOrder === entry.insertionOrder ? entry : markEntry(entry, { insertionOrder });
    }) });
  }
  function selectEntry(id: string) {
    if (id === selectedId) return;
    const positions: { element: HTMLElement; top: number }[] = [];
    for (let element = form.current?.parentElement; element; element = element.parentElement) {
      if (element.scrollTop > 0) positions.push({ element, top: element.scrollTop });
    }
    selectionScroll.current = positions;
    setSelectedId(id);
  }
  function add(duplicate?: LoreEntry) {
    const id = newId();
    const entry = duplicate ? { ...structuredClone(duplicate), id, name: `${duplicate.name.slice(0, 190)} copy` } : newLoreEntry(id);
    const position = duplicate ? ordered.findIndex(item => item.id === duplicate.id) + 1 : ordered.length;
    const next = [...ordered];
    next.splice(position, 0, entry);
    applyOrder(next, position, entry);
    selectEntry(id);
    setQuery('');
    setPage(Math.floor(position / pageSize));
  }
  function revealEntry(id: string) {
    setTab('entries');
    setQuery('');
    setPage(Math.floor(ordered.findIndex(entry => entry.id === id) / pageSize));
    selectEntry(id);
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || stale) return;
    // Native form validation covers the mounted entry. Visit unfinished numbers
    // belonging to another entry before committing its last valid numeric value.
    const unfinished = ordered.find(entry => entryNumberFields.some(field => numberDraft.values[entryNumberKey(entry.id, field)] !== undefined));
    if (unfinished) {
      flushSync(() => revealEntry(unfinished.id));
      form.current?.reportValidity();
      return;
    }
    const parsed = lorebookSchema.safeParse(book);
    if (!parsed.success) {
      setIssues(parsed.error.issues);
      const [section, index] = parsed.error.issues[0]?.path ?? [];
      if (section === 'entries' && typeof index === 'number') revealEntry(book.entries[index].id);
      else setTab('settings');
      return;
    }
    setIssues([]);
    if (await run(() => api(initial.id ? `/library/${initial.id}` : '/library', initial.id ? 'PUT' : 'POST', { kind: 'lorebooks', revision: initial.revision, data: parsed.data }))) committed();
  }
  function error(field: string) { return issues.filter(issue => issue.path.length === 1 && issue.path[0] === field).map((issue, index) => <small role="alert" key={index}>{formatMessage(validationMessage(issue))}</small>); }
  const entryIndex = book.entries.findIndex(entry => entry.id === selectedId);
  const entryIssues = issues.filter(issue => issue.path[0] === 'entries' && issue.path[1] === entryIndex);
  const listProps = {
    ordered, selectedId, page, setPage, query, search: setQuery, canAdd: book.entries.length < LOREBOOK_ENTRY_LIMIT,
    add: () => add(), select: selectEntry,
    move: (from: number, to: number) => applyOrder(moveListItem(ordered, from, to), to),
  };
  function deleteEntry(entry: LoreEntry) {
    confirmAction({
      confirmOnEnter: true, title: t('lorebook_editor.delete_lore_entry'), actionLabel: t('lorebook_editor.delete_entry'),
      message: t('lorebook_editor.delete_entry_save_the_book_to_commit', { name: entry.name }),
      onConfirm: () => {
        const remaining = book.entries.filter(item => item.id !== entry.id);
        for (const field of entryNumberFields) numberDraft.set(entryNumberKey(entry.id, field), undefined);
        setIssues([]);
        update({ entries: remaining });
        selectEntry(remaining[0]?.id ?? '');
      },
    });
  }
  function panel(tabId: LoreTab) {
    return { id: `${formId}-${tabId}-panel`, role: 'tabpanel', 'aria-labelledby': `${formId}-${tabId}-tab`, hidden: tab !== tabId };
  }
  return <NumberDraftContext.Provider value={numberDraft}><form ref={form} id={formId} className="lorebook-editor" onSubmit={event => void save(event)}>
    <LibraryDraftNotice recovered={recovered} storageError={storageError} />
    <fieldset disabled={busy} className="tabbed-library-editor">
      <legend className="sr-only">{t('lorebook_editor.lorebook', { value: t(initial.id ? 'libraries.edit_2' : 'libraries.create') })}</legend>
      <EditorNameField label={t('lorebook_editor.book_name')} value={book.name} change={name => update({ name })} />{error('name')}
      <LoreDiagnostics diagnostics={compatibility} />
      <EditorTabs id={formId} label={t('lorebook_editor.sections')} tabs={tabs} active={tab} select={setTab} className="tabs library-editor-tabs" />
      <div {...panel('entries')} onInvalid={event => revealInvalidField(event, () => setTab('entries'))}>
        <div className="lore-workspace">
          {tab === 'entries' && <LoreEntryList {...listProps} arrange={false} />}
          {selected && <section className="lore-entry-editor" aria-label={t('lorebook_editor.selected_lore_entry')}>
            <LoreEntryFields key={selected.id} entry={selected} update={updateEntry} issues={entryIssues} />
            <div className="actions lore-entry-actions">
              <button type="button" className="secondary" disabled={!listProps.canAdd} onClick={() => add(selected)}>
                <Icon name="CopyOutline" />{t('lorebook_editor.duplicate_entry')}</button>
              <button type="button" className="quiet" onClick={() => deleteEntry(selected)}><Icon name="TrashOutline" />{t('lorebook_editor.delete_entry')}</button>
            </div>
          </section>}
        </div>
      </div>
      <div {...panel('arrange')}>
        {tab === 'arrange' && <LoreEntryList {...listProps} arrange />}
      </div>
      <div {...panel('settings')} onInvalid={event => revealInvalidField(event, () => setTab('settings'))}>
        <div className="lore-book-settings">
          <label>{t('lorebook_editor.book_description')}<EditorTextarea aria-label={t('lorebook_editor.book_description')} value={book.description}
            maxLength={100_000} onChange={event => update({ description: event.target.value })} /><small>{t('lorebook_editor.for_your_library_never_inserted_into_the')}</small>{error('description')}</label>
          <div className="lore-book-limits">
            <label className="library-editor-setting"><span>{t('lorebook_editor.book_scan_depth')}</span>
              <NumberInput draftField="scanDepth" aria-describedby={`${formId}-scan-help`} required min={0} max={1000} value={book.scanDepth}
                onChange={scanDepth => update({ scanDepth })} />{error('scanDepth')}</label>
            <small className="muted" id={`${formId}-scan-help`}>{t('lorebook_editor.number_of_recent_nonempty_original_messages_to')}</small>
            <label className="library-editor-setting"><span>{t('lorebook_editor.lore_token_cap')}</span>
              <NumberInput draftField="tokenBudget" required min={0} max={1_000_000} value={book.tokenBudget}
                onChange={tokenBudget => update({ tokenBudget })} />{error('tokenBudget')}</label>
          </div>
          <label className="checkbox"><input type="checkbox" checked={book.recursiveScanning} onChange={event => update({ recursiveScanning: event.target.checked })} />
            {t('lorebook_editor.allow_admitted_lore_to_activate_other_entries')}</label>
        </div>
      </div>
    </fieldset>
    {issues.length > 0 && <div role="alert"><p>{t("lorebook_editor.correct_these_fields_before_saving")}</p><ul>{issues.map((issue, index) => <li key={index}>{issue.path[0] === 'entries' && typeof issue.path[1] === 'number' && book.entries[issue.path[1]] ? <button type="button" className="quiet" onClick={() => revealEntry(book.entries[Number(issue.path[1])].id)}>{book.entries[Number(issue.path[1])].name}: </button> : null}{issue.path.join('.')}: {formatMessage(validationMessage(issue))}</li>)}</ul></div>}
    {stale && <p role="status">{t("lorebook_editor.the_library_changed_your_unsaved_edits_remain")}</p>}
    {stale && dirty && <CopyLibraryDraft editor={draft} />}
    <EditorActions formId={formId} disabled={busy || stale} cancelDisabled={busy} close={close} />
  </form></NumberDraftContext.Provider>;
}
