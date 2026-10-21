import { newId } from './uuid';
import { Icon } from './Icon';
import { useConfirmation } from './Confirmation';
import { EditorActions } from './EditorActions';
import { EditorTextarea } from './EditorTextarea';
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { LOREBOOK_ENTRY_LIMIT, LOREBOOK_FILE_LIMIT, lorebookSchema, lorePlacements, newLoreEntry, type Lorebook, type LoreDiagnostic, type LoreEntry, type LoreImportPreview, type LorePlacement } from '../shared/lorebook';
import { api, ApiError } from './api';
import { Dropdown, NumberInput } from './Controls';
import { loreCompatibility } from '../core/lorebook-formats';

type Run = (action: () => Promise<unknown>) => Promise<boolean>;
export const lorePlacementLabels: Record<LorePlacement, string> = { before_char: 'Before Character', after_char: 'After Character', history: 'In message history', before_desc: 'Before description', after_desc: 'After description', personality: 'After personality', scenario: 'After scenario' };
const pageSize = 50;

export function LoreDiagnostics({ diagnostics }: { diagnostics: LoreDiagnostic[] }) {
  const [page, setPage] = useState(0);
  const last = Math.max(0, Math.ceil(diagnostics.length / pageSize) - 1);
  const shown = Math.min(page, last);
  return diagnostics.length > 0 ? <details className="lore-diagnostics"><summary>Compatibility notices ({diagnostics.length})</summary><p className="small muted">Unsupported behavior is preserved for export and remains inactive.</p><ul>{diagnostics.slice(shown * pageSize, (shown + 1) * pageSize).map((item, index) => <li key={`${shown}-${index}`}>{item.message}{item.field && <small> · {item.field}</small>}</li>)}</ul>{last > 0 && <Pagination page={shown} last={last} change={setPage} />}</details> : null;
}

function Pagination({ page, last, change }: { page: number; last: number; change: (page: number) => void }) {
  return <div className="actions lore-pagination"><button type="button" className="secondary" disabled={page === 0} onClick={() => change(page - 1)}>Previous page</button><span>Page {page + 1} of {last + 1}</span><button type="button" className="secondary" disabled={page === last} onClick={() => change(page + 1)}>Next page</button></div>;
}

export function LorebookImport({ leadingAction, revision, busy, run, imported }: { leadingAction: ReactNode; revision: number; busy: boolean; run: Run; imported: (id: string, notice: string) => void }) {
  const [review, setReview] = useState<{ preview: LoreImportPreview; value: unknown; revision: number; requestId: string; filename: string } | null>(null);
  const [error, setError] = useState(''), [reading, setReading] = useState(false), [attempted, setAttempted] = useState(false);
  const attempt = useRef(0), fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => () => { attempt.current++; }, []);
  return <div className="lore-import">
    <div className="actions library-toolbar" role="group" aria-label="Library actions">{leadingAction}<button type="button" className="secondary" disabled={busy || reading} onClick={() => fileInput.current?.click()}><Icon name="Import" />Import lorebook</button></div>
    <input ref={fileInput} aria-label="Lorebook JSON file" hidden type="file" accept=".json,application/json" disabled={busy || reading} onChange={async event => {
      const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
      const current = ++attempt.current; setReview(null); setError(''); setReading(true); setAttempted(false);
      try {
        if (file.size > LOREBOOK_FILE_LIMIT) throw new Error('Lorebook imports are limited to 5 MB.');
        const value: unknown = JSON.parse(await file.text());
        const preview = await api<LoreImportPreview>('/library/lorebooks/preview', 'POST', { value });
        if (attempt.current === current) setReview({ preview, value, revision, requestId: newId(), filename: file.name });
      } catch (failure) { if (attempt.current === current) setError(failure instanceof Error ? failure.message : 'Could not read this lorebook.'); }
      finally { if (attempt.current === current) setReading(false); }
    }} />
    {reading && <p role="status">Reviewing lorebook…</p>}{error && <p role="alert">{error}</p>}
    {review && <div className="lore-import-review"><h3>Review {review.preview.book.name}</h3><p className="small">{review.filename} · Format: {review.preview.format} · {review.preview.book.entries.length} entries ({review.preview.book.entries.filter(entry => entry.enabled).length} enabled)</p><p className="small">Scan depth {review.preview.book.scanDepth} messages · Lore cap {review.preview.book.tokenBudget.toLocaleString()} tokens · Recursion {review.preview.book.recursiveScanning ? 'on' : 'off'}</p><LoreDiagnostics diagnostics={review.preview.diagnostics} />
      <p className="small muted">Import creates a new book. Select it separately in a character or chat.</p>
      {review.revision !== revision && !attempted && <p role="status">The library changed. Select the file again to review the import.</p>}
      <div className="actions"><button disabled={busy || (!attempted && review.revision !== revision)} onClick={async () => {
        setAttempted(true);
        await run(async () => {
          try {
            const result = await api<{ id: string; diagnostics: LoreDiagnostic[] }>('/library/lorebooks/import', 'POST', { revision: review.revision, requestId: review.requestId, value: review.value });
            setReview(null); setAttempted(false); imported(result.id, `Imported “${review.preview.book.name}” with ${review.preview.book.entries.length} entries.`);
          } catch (failure) {
            if (failure instanceof ApiError && failure.status < 500) setAttempted(false);
            throw failure;
          }
        });
      }}>{attempted ? 'Retry reviewed import' : 'Import reviewed lorebook'}</button><button className="quiet" disabled={busy} onClick={() => { setReview(null); setAttempted(false); }}>Cancel import</button></div>
      {attempted && <p className="small muted">Retry keeps the same import identity and cannot create a second copy. Select the file again for a separate import.</p>}
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
  const formId = useId();
  const confirmAction = useConfirmation();
  const [book, setBook] = useState(initial.data), [selectedId, setSelectedId] = useState(initial.data.entries[0]?.id ?? '');
  const [query, setQuery] = useState(''), [page, setPage] = useState(0), [issues, setIssues] = useState<{ path: PropertyKey[]; message: string }[]>([]);
  const compatibility = useMemo(() => loreCompatibility(initial.data), [initial.data]);
  const stale = initial.revision !== currentRevision;
  const selected = book.entries.find(entry => entry.id === selectedId);
  const needle = query.normalize('NFC').toLowerCase();
  const matching = useMemo(() => needle ? book.entries.filter(entry => [entry.name, entry.comment, entry.content, ...entry.keys, ...entry.secondaryKeys].some(value => value.normalize('NFC').toLowerCase().includes(needle))) : book.entries, [book.entries, needle]);
  const last = Math.max(0, Math.ceil(matching.length / pageSize) - 1), shown = Math.min(page, last);
  function update(patch: Partial<Lorebook>) { setBook(value => markBook(value, patch)); }
  function updateEntry(patch: Partial<LoreEntry>) { update({ entries: book.entries.map(entry => entry.id === selectedId ? markEntry(entry, patch) : entry) }); }
  function add(duplicate?: LoreEntry) {
    const id = newId();
    const entry = duplicate ? { ...structuredClone(duplicate), id, name: `${duplicate.name.slice(0, 190)} copy` } : { ...newLoreEntry(id), insertionOrder: Math.max(-1, ...book.entries.map(item => item.insertionOrder)) + 1 };
    update({ entries: [...book.entries, entry] }); setSelectedId(id); setQuery(''); setPage(Math.floor(book.entries.length / pageSize));
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    const parsed = lorebookSchema.safeParse(book);
    if (!parsed.success) { setIssues(parsed.error.issues); return; }
    setIssues([]);
    if (await run(() => api(initial.id ? `/library/${initial.id}` : '/library', initial.id ? 'PUT' : 'POST', { kind: 'lorebooks', revision: initial.revision, data: parsed.data }))) close();
  }
  function error(field: string) { return issues.filter(issue => issue.path.length === 1 && issue.path[0] === field).map((issue, index) => <small role="alert" key={index}>{issue.message}</small>); }
  const entryIndex = book.entries.findIndex(entry => entry.id === selectedId);
  const entryIssues = issues.filter(issue => issue.path[0] === 'entries' && issue.path[1] === entryIndex);
  return <form id={formId} className="lorebook-editor" onSubmit={event => void save(event)}>
    <LoreDiagnostics diagnostics={compatibility} />
    <fieldset disabled={busy || stale}><legend>{initial.id ? 'Edit' : 'Create'} lorebook</legend><div className="form-grid">
      <label className="full">Book name<input required maxLength={100} value={book.name} onChange={event => update({ name: event.target.value })} />{error('name')}</label>
      <label className="full">Book description<EditorTextarea aria-label="Book description" value={book.description} maxLength={100_000} onChange={event => update({ description: event.target.value })} /><small>For your library; never inserted into the prompt.</small>{error('description')}</label>
      <label>Book scan depth<NumberInput aria-label="Book scan depth" required min={0} max={1000} value={book.scanDepth} onChange={scanDepth => update({ scanDepth })} /><small>Number of recent nonempty original messages to scan.</small>{error('scanDepth')}</label>
      <label>Lore token cap<NumberInput required min={0} max={1_000_000} value={book.tokenBudget} onChange={tokenBudget => update({ tokenBudget })} />{error('tokenBudget')}</label>
      <label className="checkbox full"><input type="checkbox" checked={book.recursiveScanning} onChange={event => update({ recursiveScanning: event.target.checked })} />Allow admitted lore to activate other entries</label>
    </div></fieldset>
    <fieldset disabled={busy || stale}><legend>Entries · {book.entries.length}</legend>
      <p className="small muted">Higher priority is admitted first; equal priorities prefer constants, then insertion order and source order. Final placement follows insertion order. Only complete entries that fit the cap and an enabled lore control are inserted.</p>
      <div className="actions"><button type="button" className="secondary" disabled={book.entries.length >= LOREBOOK_ENTRY_LIMIT} onClick={() => add()}>Add entry</button></div>
      <label className="lore-search">Search entries<span className="search-field"><Icon name="Search" /><input type="search" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} /></span></label>
      <div className="lore-workspace"><div className="lore-entry-list" role="group" aria-label="Lorebook entries">
        {matching.slice(shown * pageSize, (shown + 1) * pageSize).map(entry => <button type="button" className="secondary" aria-pressed={entry.id === selectedId} key={entry.id} onClick={() => setSelectedId(entry.id)}><strong>{entry.name || 'Unnamed entry'}</strong><small>{entry.enabled ? 'Enabled' : 'Disabled'} · Order {entry.insertionOrder} · Priority {entry.priority}</small></button>)}
        {matching.length === 0 && <p className="small muted">{book.entries.length ? 'No entries match your search.' : 'This book is empty. Add an entry to begin.'}</p>}
        {last > 0 && <Pagination page={shown} last={last} change={setPage} />}
      </div>{selected ? <section className="lore-entry-editor" aria-label="Selected lore entry"><EntryFields key={selected.id} entry={selected} update={updateEntry} issues={entryIssues} /><div className="actions"><button type="button" className="secondary" disabled={book.entries.length >= LOREBOOK_ENTRY_LIMIT} onClick={() => add(selected)}><Icon name="CopyOutline" />Duplicate entry</button><button type="button" className="quiet" onClick={() => { confirmAction({ title: 'Delete lore entry?', message: `Delete entry “${selected.name}”? Save the book to commit this change.`, actionLabel: 'Delete entry', onConfirm: () => { update({ entries: book.entries.filter(entry => entry.id !== selectedId) }); setSelectedId(book.entries.find(entry => entry.id !== selectedId)?.id ?? ''); } }); }}><Icon name="TrashOutline" />Delete entry</button></div></section> : <p className="small muted">Select an entry to edit its content and matching rules.</p>}</div>
    </fieldset>
    {issues.length > 0 && <div role="alert"><p>Correct these fields before saving:</p><ul>{issues.map((issue, index) => <li key={index}>{issue.path[0] === 'entries' && typeof issue.path[1] === 'number' && book.entries[issue.path[1]] ? <button type="button" className="quiet" onClick={() => setSelectedId(book.entries[Number(issue.path[1])].id)}>{book.entries[Number(issue.path[1])].name}: </button> : null}{issue.path.join('.')}: {issue.message}</li>)}</ul></div>}
    {stale && <p role="status">The library changed. Your unsaved edits remain here. Close and reopen this book to load its current revision.</p>}
    <p className="small muted">Saved changes apply to future requests in every chat selecting this shared book. Changing activation rules or content resets affected entries’ prior-match history; labels and comments preserve it. Saved requests retain their original lore.</p>
    <EditorActions><button type="submit" form={formId} disabled={busy || stale}>Save lorebook</button><button type="button" className="quiet" onClick={close} title="Close editor"><Icon name="Close" /><span className="sr-only">Close editor</span></button></EditorActions>
  </form>;
}

function EntryFields({ entry, update, issues }: { entry: LoreEntry; update: (patch: Partial<LoreEntry>) => void; issues: { path: PropertyKey[]; message: string }[] }) {
  const [keys, setKeys] = useState(entry.keys.join('\n')), [secondary, setSecondary] = useState(entry.secondaryKeys.join('\n'));
  function errors(field: string) { return issues.filter(issue => issue.path[2] === field).map((issue, index) => <small role="alert" key={index}>{issue.message}</small>); }
  return <div className="form-grid">
    <label className="full">Entry name<input maxLength={200} value={entry.name} onChange={event => update({ name: event.target.value })} />{errors('name')}</label>
    <label className="checkbox"><input type="checkbox" checked={entry.enabled} onChange={event => update({ enabled: event.target.checked })} />Entry enabled</label>
    <label className="checkbox"><input type="checkbox" checked={entry.constant} onChange={event => update({ constant: event.target.checked })} />Constant activation</label>
    <label className="full">Primary keys<EditorTextarea aria-label="Primary keys" value={keys} onChange={event => { setKeys(event.target.value); update({ keys: event.target.value.split('\n').filter(Boolean) }); }} /><small>One key per line. At least one primary key must match unless constant.</small>{errors('keys')}</label>
    <label className="full">Secondary keys<EditorTextarea aria-label="Secondary keys" value={secondary} onChange={event => { setSecondary(event.target.value); update({ secondaryKeys: event.target.value.split('\n').filter(Boolean) }); }} /><small>One key per line; secondary matching additionally requires one of these keys.</small>{errors('secondaryKeys')}</label>
    <label className="checkbox full"><input type="checkbox" checked={entry.selective} onChange={event => update({ selective: event.target.checked })} />Require a secondary-key match</label>
    <label className="checkbox"><input type="checkbox" checked={entry.caseSensitive} onChange={event => update({ caseSensitive: event.target.checked })} />Case-sensitive matching</label>
    <label className="checkbox"><input type="checkbox" checked={entry.useRegex} onChange={event => update({ useRegex: event.target.checked })} />Use regular expressions</label>
    <label className="full">Lore content<EditorTextarea aria-label="Lore content" className="lore-content" maxLength={100_000} value={entry.content} onChange={event => update({ content: event.target.value })} /><small>Inserted prose supports {'{{user}}'} and {'{{char}}'}. V3 decorator lines control activation and are removed from outgoing prose.</small>{errors('content')}</label>
    <label className="full">Entry comment<EditorTextarea aria-label="Entry comment" maxLength={100_000} value={entry.comment} onChange={event => update({ comment: event.target.value })} /><small>For you; never inserted into the prompt.</small>{errors('comment')}</label>
    <label>Insertion order<input required type="number" step="any" value={entry.insertionOrder} onChange={event => update({ insertionOrder: Number(event.target.value) })} />{errors('insertionOrder')}</label>
    <label>Admission priority<input required type="number" step="any" value={entry.priority} onChange={event => update({ priority: Number(event.target.value) })} />{errors('priority')}</label>
    <label>Placement<Dropdown aria-label="Lore entry placement" value={entry.placement} options={lorePlacements.map(value => ({ value, label: lorePlacementLabels[value] }))} onChange={placement => { const parsed = lorePlacements.find(value => value === placement); if (parsed) update({ placement: parsed }); }} /></label>
    <label>Message role<Dropdown aria-label="Lore entry role" value={entry.role ?? ''} options={[{ value: '', label: 'Use prompt control role' }, ...['system', 'user', 'assistant'].map(role => ({ value: role, label: role }))]} onChange={role => { if (role === '' || role === 'system' || role === 'user' || role === 'assistant') update({ role: role || null }); }} /></label>
    {entry.placement === 'history' && <label>History depth<NumberInput aria-label="History depth" required min={0} max={1000} value={entry.depth} onChange={depth => update({ depth })} /><small>0 is after the newest outgoing message.</small>{errors('depth')}</label>}
    <label className="checkbox full"><input type="checkbox" checked={entry.scanDepth !== null} onChange={event => update({ scanDepth: event.target.checked ? 4 : null })} />Override the book scan depth</label>
    {entry.scanDepth !== null && <label>Entry scan depth<NumberInput required min={0} max={1000} value={entry.scanDepth} onChange={scanDepth => update({ scanDepth })} />{errors('scanDepth')}</label>}
    {entry.source && <p className="small muted full">Imported metadata and external identity are retained for export.</p>}
  </div>;
}
