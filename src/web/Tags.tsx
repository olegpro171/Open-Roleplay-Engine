import { useId, useMemo, useState } from 'react';
import type { LibrarySnapshot } from '../shared/library';
import { canonicalTagName, tagLimits, type Tag, type TagPolicy, type TagReview } from '../shared/tags';
import { api } from './api';

type Run = (action: () => Promise<unknown>) => Promise<boolean>;
export type TagCommit = (before: number, after: number, snapshot: LibrarySnapshot, deletedId?: string) => void;

export function TagChips({ tags, selected, remove, catalog }: { catalog?: ReadonlyMap<string, Tag>; tags: Tag[]; selected: readonly string[]; remove?: (id: string) => void }) {
  const byId = useMemo(() => catalog ?? new Map(tags.map(tag => [tag.id, tag])), [tags, catalog]);
  return <div className="tag-chips">{selected.map(id => <span className="tag-chip" key={id}>{byId.get(id)?.name ?? 'Unavailable tag'}{remove && <button type="button" className="quiet" aria-label={`Remove ${byId.get(id)?.name ?? 'unavailable tag'}`} onClick={() => remove(id)}>×</button>}</span>)}</div>;
}
export function TagChooser({ tags, selected, change, label, disabled = false }: { tags: Tag[]; selected: string[]; change: (ids: string[]) => void; label: string; disabled?: boolean }) {
  const [search, setSearch] = useState(''), [page, setPage] = useState(0);
  const query = canonicalTagName(search), chosen = useMemo(() => new Set(selected), [selected]);
  const matches = useMemo(() => tags.filter(tag => canonicalTagName(tag.name).includes(query)).sort((a, b) => a.name.localeCompare(b.name)), [tags, query]);
  const last = Math.max(0, Math.ceil(matches.length / tagLimits.page) - 1), shown = Math.min(page, last);
  return <fieldset className="tag-chooser" disabled={disabled}><legend>{label}</legend>
    <TagChips tags={tags} selected={selected} remove={id => change(selected.filter(value => value !== id))} />
    <label>Search {label.toLowerCase()}<input type="search" value={search} onChange={event => { setSearch(event.target.value); setPage(0); }} /></label>
    <div className="tag-options">{matches.slice(shown * tagLimits.page, (shown + 1) * tagLimits.page).map(tag => <label className="checkbox" key={tag.id}><input type="checkbox" checked={chosen.has(tag.id)} onChange={event => change(event.target.checked ? [...selected, tag.id] : selected.filter(id => id !== tag.id))} /><span className="tag-option-name">{tag.name}</span><small>({tag.usageCount})</small></label>)}</div>
    {!matches.length && <p className="small muted">{tags.length ? 'No tags match your search.' : 'No tags yet. Create one in Manage tags.'}</p>}
    {last > 0 && <div className="actions"><button type="button" disabled={shown === 0} onClick={() => setPage(shown - 1)}>Previous tags</button><span>{shown + 1} / {last + 1}</span><button type="button" disabled={shown === last} onClick={() => setPage(shown + 1)}>Next tags</button></div>}
  </fieldset>;
}
export function TagManager({ library, busy, run, committed, close }: { library: LibrarySnapshot; busy: boolean; run: Run; committed?: TagCommit; close: () => void }) {
  const [search, setSearch] = useState(''), [name, setName] = useState(''), [rename, setRename] = useState<{ id: string; name: string; revision: number } | null>(null);
  const [error, setError] = useState(''), [pending, setPending] = useState(false), [page, setPage] = useState(0);
  const query = canonicalTagName(search);
  const matches = useMemo(() => library.tags.filter(tag => canonicalTagName(tag.name).includes(query)).sort((a, b) => a.name.localeCompare(b.name)), [library.tags, query]);
  const last = Math.max(0, Math.ceil(matches.length / tagLimits.page) - 1), shown = Math.min(page, last);
  async function mutate(method: string, path: string, body: { revision: number; name?: string }, deletedId?: string) {
    if (pending) return false;
    setPending(true); setError('');
    const ok = await run(async () => {
      try {
        const result = await api<{ revision: number }>(path, method, body);
        const snapshot = await api<LibrarySnapshot>('/library');
        committed?.(body.revision, result.revision, snapshot, deletedId);
      } catch (error) { setError(error instanceof Error ? error.message : 'Could not save tags.'); throw error; }
    });
    setPending(false); return ok;
  }
  return <section className="tag-manager" aria-label="Manage tags"><h2>Manage tags</h2><p className="small muted">Local character organization. Names can contain commas. Unused tags stay in the catalog.</p>
    <form onSubmit={async event => { event.preventDefault(); if (await mutate('POST', '/library/tags', { revision: library.revision, name })) setName(''); }}><label>New tag name<input required value={name} onChange={event => setName(event.target.value)} /></label><button disabled={busy || pending}>Create tag</button></form>
    <label>Search catalog<input type="search" value={search} onChange={event => { setSearch(event.target.value); setPage(0); }} /></label>
    <div className="tag-catalog">{matches.slice(shown * tagLimits.page, (shown + 1) * tagLimits.page).map(tag => <div key={tag.id} className="tag-catalog-row">
      <span>{tag.name} <small>· {tag.usageCount} characters</small></span><div className="actions"><button type="button" className="secondary" disabled={busy || pending} onClick={() => setRename({ id: tag.id, name: tag.name, revision: library.revision })}>Rename {tag.name}</button><button type="button" className="quiet" disabled={busy || pending} onClick={() => { if (confirm(`Delete “${tag.name}”? ${tag.usageCount} characters will lose this local assignment. Embedded card metadata is preserved.`)) void mutate('DELETE', `/library/tags/${tag.id}`, { revision: library.revision }, tag.id); }}>Delete {tag.name}</button></div>
    </div>)}</div>
    {rename && <form onSubmit={async event => { event.preventDefault(); if (await mutate('PUT', `/library/tags/${rename.id}`, { revision: rename.revision, name: rename.name })) setRename(null); }}><label>Rename tag<input required value={rename.name} onChange={event => setRename({ ...rename, name: event.target.value })} /></label><button disabled={busy || pending || rename.revision !== library.revision}>Save tag name</button><button type="button" className="quiet" onClick={() => setRename(null)}>Cancel rename</button>{rename.revision !== library.revision && <p role="status">The catalog changed. Your draft remains here; reopen Rename to reconcile.</p>}</form>}
    {!matches.length && <p className="muted">{library.tags.length ? 'No tags match your search.' : 'No tags in the catalog.'}</p>}
    {last > 0 && <div className="actions"><button type="button" disabled={!shown} onClick={() => setPage(shown - 1)}>Previous tags</button><span>{shown + 1} / {last + 1}</span><button type="button" disabled={shown === last} onClick={() => setPage(shown + 1)}>Next tags</button></div>}
    {error && <p role="alert">{error}</p>}<button type="button" className="quiet" disabled={pending} onClick={close}>Close tag manager</button>
  </section>;
}
export function TagImportOptions({ review, policy, change, disabled }: { review: TagReview; policy: TagPolicy; change: (policy: TagPolicy) => void; disabled?: boolean }) {
  const [page, setPage] = useState(0);
  const groupName = useId();
  const candidates = [...review.existing.map(tag => ({ ...tag, group: 'Existing', eligible: true })), ...review.newTags.map(tag => ({ ...tag, group: 'New' }))];
  const last = Math.max(0, Math.ceil(candidates.length / tagLimits.page) - 1), shown = Math.min(page, last);
  return <div className="tag-import-options"><p>{review.existing.length} existing · {review.newTags.length} new candidate tags</p>
    <details><summary>Review embedded tags</summary><ul>{candidates.slice(shown * tagLimits.page, (shown + 1) * tagLimits.page).map(tag => <li key={tag.sourceIndexes[0]}>{tag.name}{!tag.eligible && '… (exceeds local limit)'} · {tag.group} · source {tag.sourceIndexes.map(i => i + 1).join(', ')}</li>)}</ul>
      {last > 0 && <div className="actions"><button type="button" disabled={!shown} onClick={() => setPage(shown - 1)}>Previous candidates</button><span>{shown + 1} / {last + 1}</span><button type="button" disabled={shown === last} onClick={() => setPage(shown + 1)}>Next candidates</button></div>}
    </details>
    {review.notices.length > 0 && <details><summary>Tag compatibility notices ({review.notices.length + review.omittedNotices})</summary><ul>{review.notices.map((notice, i) => <li key={i}>{notice}</li>)}</ul>{review.omittedNotices > 0 && <p>{review.omittedNotices} additional notices omitted.</p>}</details>}
    <fieldset disabled={disabled}><legend>Import tags</legend>{(['all', 'existing', 'none'] as const).map(mode => <label className="checkbox" key={mode}><input type="radio" name={groupName} checked={policy === mode} disabled={Boolean(review.modes[mode].blocked)} onChange={() => change(mode)} />Import {mode}{review.modes[mode].blocked && <small>{review.modes[mode].blocked}</small>}</label>)}</fieldset>
    <p className="small">{review.modes[policy].assign} local assignments added · {review.modes[policy].create} tags created. Original embedded metadata is preserved.</p>
  </div>;
}
