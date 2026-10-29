import { LibraryImport } from './LibraryImport';
import { LocalizedError, formatMessage, useTextState, errorText, t, message as msg, useLocale, locale } from './localization';
import { validationMessage } from '../shared/localization-validation';
import type { z } from 'zod';
import { placementLabel, stateLabel } from './localization-labels';
import { newId } from './uuid';
import { Icon } from './Icon';
import { useConfirmation } from './Confirmation';
import { EditorActions } from './EditorActions';
import { EditorTextarea } from './EditorTextarea';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { LOREBOOK_ENTRY_LIMIT, LOREBOOK_FILE_LIMIT, lorebookSchema, lorePlacements, newLoreEntry, type Lorebook, type LoreDiagnostic, type LoreEntry, type LoreImportPreview, type LorePlacement } from '../shared/lorebook';
import { api, ApiError } from './api';
import { Dropdown, NumberInput } from './Controls';
import { loreCompatibility } from '../core/lorebook-formats';

type Run = (action: () => Promise<unknown>) => Promise<boolean>;
export const lorePlacementLabels: Record<LorePlacement, string> = { before_char: 'Before Character', after_char: 'After Character', history: 'In message history', before_desc: 'Before description', after_desc: 'After description', personality: 'After personality', scenario: 'After scenario' };
const pageSize = 50;

export function LoreDiagnostics({ diagnostics }: { diagnostics: LoreDiagnostic[] }) {
  useLocale();
  const [page, setPage] = useState(0);
  const last = Math.max(0, Math.ceil(diagnostics.length / pageSize) - 1);
  const shown = Math.min(page, last);
  return diagnostics.length > 0 ? <details className="lore-diagnostics"><summary>{t("lorebook_editor.compatibility_notices", { length: diagnostics.length })}</summary><p className="small muted">{t("lorebook_editor.unsupported_behavior_is_preserved_for_export_and")}</p><ul>{diagnostics.slice(shown * pageSize, (shown + 1) * pageSize).map((item, index) => <li key={`${shown}-${index}`}>{formatMessage(item.localized ?? item.message)}{item.field && <small> · {item.field}</small>}</li>)}</ul>{last > 0 && <Pagination page={shown} last={last} change={setPage} />}</details> : null;
}

function Pagination({ page, last, change }: { page: number; last: number; change: (page: number) => void }) {
  useLocale();
  return <div className="actions lore-pagination"><button type="button" className="secondary" disabled={page === 0} onClick={() => change(page - 1)}>{t("lorebook_editor.previous_page")}</button><span>{t("lorebook_editor.page_of", { value: page + 1, value2: last + 1 })}</span><button type="button" className="secondary" disabled={page === last} onClick={() => change(page + 1)}>{t("lorebook_editor.next_page")}</button></div>;
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

export function LorebookEditor({ initial, currentRevision, busy, run, close }: { initial: { id?: string; revision: number; data: Lorebook }; currentRevision: number; busy: boolean; run: Run; close: () => void }) {
  useLocale();
  const formId = useId();
  const confirmAction = useConfirmation();
  const [book, setBook] = useState(initial.data), [selectedId, setSelectedId] = useState(initial.data.entries[0]?.id ?? '');
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
  const [query, setQuery] = useState(''), [page, setPage] = useState(0), [issues, setIssues] = useState<z.core.$ZodIssue[]>([]);
  const compatibility = useMemo(() => loreCompatibility(initial.data), [initial.data]);
  const stale = initial.revision !== currentRevision;
  const selected = book.entries.find(entry => entry.id === selectedId);
  const needle = query.normalize('NFC').toLowerCase();
  const matching = useMemo(() => needle ? book.entries.filter(entry => [entry.name, entry.comment, entry.content, ...entry.keys, ...entry.secondaryKeys].some(value => value.normalize('NFC').toLowerCase().includes(needle))) : book.entries, [book.entries, needle]);
  const last = Math.max(0, Math.ceil(matching.length / pageSize) - 1), shown = Math.min(page, last);
  function update(patch: Partial<Lorebook>) { setBook(value => markBook(value, patch)); }
  function updateEntry(patch: Partial<LoreEntry>) { update({ entries: book.entries.map(entry => entry.id === selectedId ? markEntry(entry, patch) : entry) }); }
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
    const entry = duplicate ? { ...structuredClone(duplicate), id, name: `${duplicate.name.slice(0, 190)} copy` } : { ...newLoreEntry(id), insertionOrder: Math.max(-1, ...book.entries.map(item => item.insertionOrder)) + 1 };
    update({ entries: [...book.entries, entry] }); selectEntry(id); setQuery(''); setPage(Math.floor(book.entries.length / pageSize));
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    const parsed = lorebookSchema.safeParse(book);
    if (!parsed.success) { setIssues(parsed.error.issues); return; }
    setIssues([]);
    if (await run(() => api(initial.id ? `/library/${initial.id}` : '/library', initial.id ? 'PUT' : 'POST', { kind: 'lorebooks', revision: initial.revision, data: parsed.data }))) close();
  }
  function error(field: string) { return issues.filter(issue => issue.path.length === 1 && issue.path[0] === field).map((issue, index) => <small role="alert" key={index}>{formatMessage(validationMessage(issue))}</small>); }
  const entryIndex = book.entries.findIndex(entry => entry.id === selectedId);
  const entryIssues = issues.filter(issue => issue.path[0] === 'entries' && issue.path[1] === entryIndex);
  return <form ref={form} id={formId} className="lorebook-editor" onSubmit={event => void save(event)}>
    <LoreDiagnostics diagnostics={compatibility} />
    <fieldset disabled={busy || stale}><legend>{t("lorebook_editor.lorebook", { value: initial.id ? t("libraries.edit_2") : t("libraries.create") })}</legend><div className="form-grid">
      <label className="full">{t("lorebook_editor.book_name")}<input required maxLength={100} value={book.name} onChange={event => update({ name: event.target.value })} />{error('name')}</label>
      <label className="full">{t("lorebook_editor.book_description")}<EditorTextarea aria-label={t("lorebook_editor.book_description")} value={book.description} maxLength={100_000} onChange={event => update({ description: event.target.value })} /><small>{t("lorebook_editor.for_your_library_never_inserted_into_the")}</small>{error('description')}</label>
      <label>{t("lorebook_editor.book_scan_depth")}<NumberInput aria-label={t("lorebook_editor.book_scan_depth")} required min={0} max={1000} value={book.scanDepth} onChange={scanDepth => update({ scanDepth })} /><small>{t("lorebook_editor.number_of_recent_nonempty_original_messages_to")}</small>{error('scanDepth')}</label>
      <label>{t("lorebook_editor.lore_token_cap")}<NumberInput required min={0} max={1_000_000} value={book.tokenBudget} onChange={tokenBudget => update({ tokenBudget })} />{error('tokenBudget')}</label>
      <label className="checkbox full"><input type="checkbox" checked={book.recursiveScanning} onChange={event => update({ recursiveScanning: event.target.checked })} />{t("lorebook_editor.allow_admitted_lore_to_activate_other_entries")}</label>
    </div></fieldset>
    <fieldset disabled={busy || stale}><legend>{t("lorebook_editor.entries", { length: book.entries.length })}</legend>
      <p className="small muted">{t("lorebook_editor.higher_priority_is_admitted_first_equal_priorities")}</p>
      <div className="actions"><button type="button" className="secondary" disabled={book.entries.length >= LOREBOOK_ENTRY_LIMIT} onClick={() => add()}>{t("lorebook_editor.add_entry")}</button></div>
      <label className="lore-search">{t("lorebook_editor.search_entries")}<span className="search-field"><Icon name="Search" /><input type="search" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} /></span></label>
      <div className="lore-workspace"><div className="lore-entry-list" role="group" aria-label={t("lorebook_editor.lorebook_entries")}>
        {matching.slice(shown * pageSize, (shown + 1) * pageSize).map(entry => <button type="button" className="secondary" aria-pressed={entry.id === selectedId} key={entry.id} onClick={() => selectEntry(entry.id)}><strong>{entry.name || t("lorebook_editor.unnamed_entry")}</strong><small>{t("lorebook_editor.order_priority", { value: entry.enabled ? t("interface.enabled") : t("interface.disabled"), insertionOrder: entry.insertionOrder, priority: entry.priority })}</small></button>)}
        {matching.length === 0 && <p className="small muted">{book.entries.length ? t("lorebook_editor.no_entries_match_your_search") : t("lorebook_editor.this_book_is_empty_add_an_entry")}</p>}
        {last > 0 && <Pagination page={shown} last={last} change={setPage} />}
      </div>{selected ? <section className="lore-entry-editor" aria-label={t("lorebook_editor.selected_lore_entry")}><EntryFields key={selected.id} entry={selected} update={updateEntry} issues={entryIssues} /><div className="actions"><button type="button" className="secondary" disabled={book.entries.length >= LOREBOOK_ENTRY_LIMIT} onClick={() => add(selected)}><Icon name="CopyOutline" />{t("lorebook_editor.duplicate_entry")}</button><button type="button" className="quiet" onClick={() => { confirmAction({ title: t("lorebook_editor.delete_lore_entry"), message: t("lorebook_editor.delete_entry_save_the_book_to_commit", { name: selected.name }), actionLabel: t("lorebook_editor.delete_entry"), onConfirm: () => { update({ entries: book.entries.filter(entry => entry.id !== selectedId) }); selectEntry(book.entries.find(entry => entry.id !== selectedId)?.id ?? ''); } }); }}><Icon name="TrashOutline" />{t("lorebook_editor.delete_entry")}</button></div></section> : <p className="small muted">{t("lorebook_editor.select_an_entry_to_edit_its_content")}</p>}</div>
    </fieldset>
    {issues.length > 0 && <div role="alert"><p>{t("lorebook_editor.correct_these_fields_before_saving")}</p><ul>{issues.map((issue, index) => <li key={index}>{issue.path[0] === 'entries' && typeof issue.path[1] === 'number' && book.entries[issue.path[1]] ? <button type="button" className="quiet" onClick={() => selectEntry(book.entries[Number(issue.path[1])].id)}>{book.entries[Number(issue.path[1])].name}: </button> : null}{issue.path.join('.')}: {formatMessage(validationMessage(issue))}</li>)}</ul></div>}
    {stale && <p role="status">{t("lorebook_editor.the_library_changed_your_unsaved_edits_remain")}</p>}
    <p className="small muted">{t("lorebook_editor.saved_changes_apply_to_future_requests_in")}</p>
    <EditorActions formId={formId} disabled={busy || stale} close={close} />
  </form>;
}

function parseEntryKeys(text: string, useRegex: boolean): string[] {
  // Commas and surrounding spaces can be meaningful inside a regex pattern.
  if (useRegex) return text.split('\n').filter(Boolean);
  return text.split(/[,\r\n]/).map(key => key.trim()).filter(Boolean);
}

function EntryFields({ entry, update, issues }: { entry: LoreEntry; update: (patch: Partial<LoreEntry>) => void; issues: z.core.$ZodIssue[] }) {
  useLocale();
  const [keys, setKeys] = useState(entry.keys.join('\n')), [secondary, setSecondary] = useState(entry.secondaryKeys.join('\n'));
  function errors(field: string) { return issues.filter(issue => issue.path[2] === field).map((issue, index) => <small role="alert" key={index}>{formatMessage(validationMessage(issue))}</small>); }
  return <div className="form-grid">
    <label className="full">{t("lorebook_editor.entry_name")}<input maxLength={200} value={entry.name} onChange={event => update({ name: event.target.value })} />{errors('name')}</label>
    <label className="checkbox"><input type="checkbox" checked={entry.enabled} onChange={event => update({ enabled: event.target.checked })} />{t("lorebook_editor.entry_enabled")}</label>
    <label className="checkbox"><input type="checkbox" checked={entry.constant} onChange={event => update({ constant: event.target.checked })} />{t("lorebook_editor.constant_activation")}</label>
    <label className="full">{t("lorebook_editor.primary_keys")}<EditorTextarea aria-label={t("lorebook_editor.primary_keys")} value={keys} onChange={event => { setKeys(event.target.value); update({ keys: parseEntryKeys(event.target.value, entry.useRegex) }); }} /><small>{t("lorebook_editor.one_key_per_line_at_least_one")}</small>{errors('keys')}</label>
    <label className="full">{t("lorebook_editor.secondary_keys")}<EditorTextarea aria-label={t("lorebook_editor.secondary_keys")} value={secondary} onChange={event => { setSecondary(event.target.value); update({ secondaryKeys: parseEntryKeys(event.target.value, entry.useRegex) }); }} /><small>{t("lorebook_editor.one_key_per_line_secondary_matching_additionally")}</small>{errors('secondaryKeys')}</label>
    <label className="checkbox full"><input type="checkbox" checked={entry.selective} onChange={event => update({ selective: event.target.checked })} />{t("lorebook_editor.require_a_secondary_key_match")}</label>
    <label className="checkbox"><input type="checkbox" checked={entry.caseSensitive} onChange={event => update({ caseSensitive: event.target.checked })} />{t("lorebook_editor.case_sensitive_matching")}</label>
    <label className="checkbox"><input type="checkbox" checked={entry.useRegex} onChange={event => {
      // Keep the existing key boundaries when changing how those keys match.
      setKeys(entry.keys.join('\n'));
      setSecondary(entry.secondaryKeys.join('\n'));
      update({ useRegex: event.target.checked });
    }} />{t("lorebook_editor.use_regular_expressions")}</label>
    <label className="full">{t("lorebook_editor.lore_content")}<EditorTextarea aria-label={t("lorebook_editor.lore_content")} className="lore-content" maxLength={100_000} value={entry.content} onChange={event => update({ content: event.target.value })} /><small>{t("lorebook_editor.inserted_prose_supports_and_v3_decorator_lines", { value: '{{user}}', value2: '{{char}}' })}</small>{errors('content')}</label>
    <label className="full">{t("lorebook_editor.entry_comment")}<EditorTextarea aria-label={t("lorebook_editor.entry_comment")} maxLength={100_000} value={entry.comment} onChange={event => update({ comment: event.target.value })} /><small>{t("lorebook_editor.for_you_never_inserted_into_the_prompt")}</small>{errors('comment')}</label>
    <label>{t("lorebook_editor.insertion_order")}<input required type="number" step="any" value={entry.insertionOrder} onChange={event => update({ insertionOrder: Number(event.target.value) })} />{errors('insertionOrder')}</label>
    <label>{t("lorebook_editor.admission_priority")}<input required type="number" step="any" value={entry.priority} onChange={event => update({ priority: Number(event.target.value) })} />{errors('priority')}</label>
    <label>{t("lorebook_editor.placement")}<Dropdown aria-label={t("lorebook_editor.lore_entry_placement")} value={entry.placement} options={lorePlacements.map(value => ({ value, label: placementLabel(value) }))} onChange={placement => { const parsed = lorePlacements.find(value => value === placement); if (parsed) update({ placement: parsed }); }} /></label>
    <label>{t("lorebook_editor.message_role")}<Dropdown aria-label={t("lorebook_editor.lore_entry_role")} value={entry.role ?? ''} options={[{ value: '', label: t("lorebook_editor.use_prompt_control_role") }, ...['system', 'user', 'assistant'].map(role => ({ value: role, label: stateLabel(role === 'system' || role === 'user' ? role : 'assistant') }))]} onChange={role => { if (role === '' || role === 'system' || role === 'user' || role === 'assistant') update({ role: role || null }); }} /></label>
    {entry.placement === 'history' && <label>{t("lorebook_editor.history_depth")}<NumberInput aria-label={t("lorebook_editor.history_depth")} required min={0} max={1000} value={entry.depth} onChange={depth => update({ depth })} /><small>{t("lorebook_editor.0_is_after_the_newest_outgoing_message")}</small>{errors('depth')}</label>}
    <label className="checkbox full"><input type="checkbox" checked={entry.scanDepth !== null} onChange={event => update({ scanDepth: event.target.checked ? 4 : null })} />{t("lorebook_editor.override_the_book_scan_depth")}</label>
    {entry.scanDepth !== null && <label>{t("lorebook_editor.entry_scan_depth")}<NumberInput required min={0} max={1000} value={entry.scanDepth} onChange={scanDepth => update({ scanDepth })} />{errors('scanDepth')}</label>}
    {entry.source && <p className="small muted full">{t("lorebook_editor.imported_metadata_and_external_identity_are_retained")}</p>}
  </div>;
}
