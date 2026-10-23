import { openModal } from './dialog-focus';
import { useTextState, errorText, t, message as msg, useLocale } from './localization';
import { Icon } from './Icon';
import { useConfirmation } from './Confirmation';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { LibrarySnapshot } from '../shared/library';
import { canonicalTagName, tagLimits, type Tag, type TagPolicy, type TagReview } from '../shared/tags';
import { api } from './api';

type Run = (action: () => Promise<unknown>) => Promise<boolean>;
export type TagCommit = (before: number, after: number, snapshot: LibrarySnapshot, deletedId?: string) => void;

export function TagChips({ tags, selected, remove, catalog }: { catalog?: ReadonlyMap<string, Tag>; tags: Tag[]; selected: readonly string[]; remove?: (id: string) => void }) {
  useLocale();
  const byId = useMemo(() => catalog ?? new Map(tags.map(tag => [tag.id, tag])), [tags, catalog]);
  return <div className="tag-chips">{selected.map(id => <span className="tag-chip" key={id}>{byId.get(id)?.name ?? t("tags.unavailable_tag")}{remove && <button type="button" className="quiet" aria-label={t("tags.remove", { value: byId.get(id)?.name ?? t("interface.unavailable_tag") })} onClick={() => remove(id)}><Icon name="Close" /></button>}</span>)}</div>;
}
export function TagChooser({ tags, selected, change, label, disabled = false, showSelected = true }: { tags: Tag[]; selected: string[]; change: (ids: string[]) => void; label: string; disabled?: boolean; showSelected?: boolean }) {
  useLocale();
  const [search, setSearch] = useState(''), [page, setPage] = useState(0);
  const results = useRef<HTMLDivElement>(null);
  const [resultsMinHeight, setResultsMinHeight] = useState<number>();
  const query = canonicalTagName(search), chosen = useMemo(() => new Set(selected), [selected]);
  const matches = useMemo(() => tags.filter(tag => canonicalTagName(tag.name).includes(query)).sort((a, b) => a.name.localeCompare(b.name)), [tags, query]);
  const last = Math.max(0, Math.ceil(matches.length / tagLimits.page) - 1), shown = Math.min(page, last);
  return <fieldset className="tag-chooser" disabled={disabled}><legend>{label}</legend>
    {showSelected && <TagChips tags={tags} selected={selected} remove={id => change(selected.filter(value => value !== id))} />}
    <label>{t("tags.search_tags")}<span className="search-field"><Icon name="Search" /><input type="search" value={search} onChange={event => {
      const next = event.target.value;
      // Rows, empty notices and pagination share one reserved area during search,
      // so filtering cannot shrink the page and clamp its scroll position.
      if (next) setResultsMinHeight(results.current?.getBoundingClientRect().height);
      else setResultsMinHeight(undefined);
      setSearch(next); setPage(0);
    }} /></span></label>
    <div className="tag-chooser-results" ref={results} style={{ minHeight: resultsMinHeight }}>
      <div className="tag-options">{matches.slice(shown * tagLimits.page, (shown + 1) * tagLimits.page).map(tag => <label className="checkbox" key={tag.id}><input type="checkbox" checked={chosen.has(tag.id)} onChange={event => change(event.target.checked ? [...selected, tag.id] : selected.filter(id => id !== tag.id))} /><span className="tag-option-name">{tag.name}</span></label>)}</div>
      {!matches.length && <p className="small muted">{tags.length ? t("tags.no_tags_match_your_search") : t("tags.no_tags_yet_create_one_in_manage")}</p>}
      {last > 0 && <div className="actions"><button type="button" disabled={shown === 0} onClick={() => setPage(shown - 1)}>{t("tags.previous_tags")}</button><span>{shown + 1} / {last + 1}</span><button type="button" disabled={shown === last} onClick={() => setPage(shown + 1)}>{t("tags.next_tags")}</button></div>}
    </div>
  </fieldset>;
}
export function TagFilterMenu({ library, busy, run, selected, change }: { library: LibrarySnapshot; busy: boolean; run: Run; selected: string[]; change: (ids: string[]) => void }) {
  useLocale();
  const [open, setOpen] = useState(false), [manager, setManager] = useState(false);
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  useEffect(() => {
    if (!open || manager) return;
    const dismiss = (event: Event) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    const dismissAfterTab = (event: KeyboardEvent) => {
      if (event.key === 'Tab' && !root.current?.contains(document.activeElement)) setOpen(false);
    };
    // Let an outside action finish before closing: removing the panel can shrink
    // the scroll area and move the clicked control between pointerdown and click.
    document.addEventListener('click', dismiss);
    document.addEventListener('keyup', dismissAfterTab);
    return () => {
      document.removeEventListener('click', dismiss);
      document.removeEventListener('keyup', dismissAfterTab);
    };
  }, [open, manager]);
  return <div className="tag-filter-menu" ref={root} onKeyDown={event => {
    if (event.key === 'Escape' && open && !manager) {
      event.preventDefault(); setOpen(false); trigger.current?.focus();
    }
  }}>
    <button type="button" className="secondary tag-filter-trigger" ref={trigger} aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(!open)}>
      {t("character_editor.tags")}{selected.length > 0 && <span className="tag-filter-count">{selected.length}</span>}<Icon name="ArrowShortBottom" />
    </button>
    {open && <div id={panelId} className="tag-filter-panel">
      <TagChooser label={t("tags.filter_characters_by_tags")} tags={library.tags} selected={selected} change={change} showSelected={false} />
      <div className="tag-filter-footer"><small className="muted">{t("tags.match_all_selected_tags")}</small><button type="button" className="quiet" onClick={() => setManager(true)}>{t("character_editor.manage_tags")}</button></div>
    </div>}
    {manager && <TagManager library={library} busy={busy} run={run} close={() => setManager(false)} />}
  </div>;
}
export function TagManager({ library, busy, run, committed, close }: { library: LibrarySnapshot; busy: boolean; run: Run; committed?: TagCommit; close: () => void }) {
  useLocale();
  const confirmAction = useConfirmation();
  const [search, setSearch] = useState(''), [name, setName] = useState(''), [rename, setRename] = useState<{ id: string; name: string; revision: number } | null>(null);
  const [error, setError] = useTextState(''), [pending, setPending] = useState(false), [page, setPage] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const trigger = document.activeElement;
    const node = dialog.current;
    openModal(node);
    return () => { node?.close(); if (trigger instanceof HTMLElement) trigger.focus(); };
  }, []);
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
      } catch (error) { setError(errorText(error, msg("tags.could_not_save_tags"))); throw error; }
    });
    setPending(false); return ok;
  }
  return <dialog ref={dialog} className="tag-manager" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); if (!pending) close(); }}>
    <header className="tag-manager-heading"><div><h2 id={titleId}>{t("character_editor.manage_tags")}</h2><p className="small muted">{t("tags.organize_your_characters_changes_save_immediately")}</p></div><button type="button" className="quiet" aria-label={t("tags.close_tag_manager")} disabled={pending} onClick={close}><Icon name="Close" /></button></header>
    <div className="tag-manager-controls">
      <form onSubmit={async event => { event.preventDefault(); if (await mutate('POST', '/library/tags', { revision: library.revision, name })) setName(''); }}><label>{t("tags.new_tag_name")}<input required value={name} onChange={event => setName(event.target.value)} /></label><button disabled={busy || pending}>{t("tags.create_tag")}</button></form>
      <label>{t("tags.search_catalog")}<span className="search-field"><Icon name="Search" /><input type="search" value={search} onChange={event => { setSearch(event.target.value); setPage(0); }} /></span></label>
      {error && <p role="alert">{error}</p>}
    </div>
    <div className="tag-catalog">{matches.slice(shown * tagLimits.page, (shown + 1) * tagLimits.page).map(tag => <div key={tag.id} className="tag-catalog-row">
      {rename?.id === tag.id ? <form className="tag-rename" onSubmit={async event => { event.preventDefault(); if (await mutate('PUT', `/library/tags/${rename.id}`, { revision: rename.revision, name: rename.name })) setRename(null); }}>
        <label>{t("tags.rename_tag")}<input required value={rename.name} onChange={event => setRename({ ...rename, name: event.target.value })} /></label>
        <div className="actions"><button disabled={busy || pending || rename.revision !== library.revision}>{t("tags.save_tag_name")}</button><button type="button" className="quiet" disabled={pending} onClick={() => setRename(null)}>{t("tags.cancel_rename")}</button></div>
        {rename.revision !== library.revision && <p role="status">{t("tags.the_catalog_changed_your_draft_remains_here")}</p>}
      </form> : <><span>{tag.name}<small>{tag.usageCount} {tag.usageCount === 1 ? 'character' : 'characters'}</small></span><div className="actions"><button type="button" className="quiet" aria-label={t("tags.rename", { name: tag.name })} disabled={busy || pending} onClick={() => setRename({ id: tag.id, name: tag.name, revision: library.revision })}>{t("tags.rename_2")}</button><button type="button" className="quiet" aria-label={t("tags.delete", { name: tag.name })} disabled={busy || pending} onClick={() => { confirmAction({ title: t("tags.delete_tag"), message: t("tags.delete_characters_will_lose_this_local_assignment", { name: tag.name, usageCount: tag.usageCount }), actionLabel: t("tags.delete_tag_2"), onConfirm: () => { void mutate('DELETE', `/library/tags/${tag.id}`, { revision: library.revision }, tag.id); } }); }}><Icon name="TrashOutline" />{t("libraries.delete_2")}</button></div></>}
    </div>)}</div>
    {!matches.length && <p className="muted tag-manager-empty">{library.tags.length ? t("tags.no_tags_match_your_search") : t("tags.no_tags_yet_create_your_first_tag")}</p>}
    <footer className="tag-manager-footer"><span className="small muted">{matches.length} {matches.length === 1 ? 'tag' : 'tags'}{search && ' found'}</span>
      {last > 0 && <div className="actions"><button type="button" className="quiet" disabled={!shown} onClick={() => setPage(shown - 1)}>{t("tags.previous_tags")}</button><span className="small">{shown + 1} / {last + 1}</span><button type="button" className="quiet" disabled={shown === last} onClick={() => setPage(shown + 1)}>{t("tags.next_tags")}</button></div>}
    </footer>
  </dialog>;
}
export function TagImportOptions({ review, policy, change, disabled }: { review: TagReview; policy: TagPolicy; change: (policy: TagPolicy) => void; disabled?: boolean }) {
  useLocale();
  const [page, setPage] = useState(0);
  const groupName = useId();
  const candidates = [...review.existing.map(tag => ({ ...tag, group: 'Existing', eligible: true })), ...review.newTags.map(tag => ({ ...tag, group: 'New' }))];
  const last = Math.max(0, Math.ceil(candidates.length / tagLimits.page) - 1), shown = Math.min(page, last);
  return <div className="tag-import-options"><p>{t("tags.existing_new_tags", { length: review.existing.length, length2: review.newTags.length })}</p>
    <details><summary>{t("tags.review_tags")}</summary>
      <fieldset className="tag-import-policy" disabled={disabled}><legend>{t("tags.import_tags")}</legend>
        <div className="tag-import-modes">{(['all', 'existing', 'none'] as const).map(mode => <label className="radio-option" key={mode}>
          <input type="radio" name={groupName} aria-label={t("tags.import", { mode: mode })} checked={policy === mode} disabled={Boolean(review.modes[mode].blocked)} aria-describedby={review.modes[mode].blocked ? `${groupName}-${mode}-blocked` : undefined} onChange={() => change(mode)} />
          <span>{t("tags.import", { mode: mode })}</span>
          {review.modes[mode].blocked && <small id={`${groupName}-${mode}-blocked`}>{review.modes[mode].blocked}</small>}
        </label>)}</div>
      </fieldset>
      {candidates.length > 0 && <table className="tag-review-table" aria-label={t("tags.embedded_tags")}><colgroup><col className="tag-review-name-column" /><col /></colgroup><thead><tr><th scope="col">{t("tags.tag")}</th><th scope="col">{t("tags.status")}</th></tr></thead><tbody>
        {candidates.slice(shown * tagLimits.page, (shown + 1) * tagLimits.page).map(tag => <tr key={tag.sourceIndexes[0]}>
          <td><span className="tag-review-name" title={tag.name} tabIndex={0}>{tag.name}</span></td><td>{tag.group}{!tag.eligible && <small>{t("tags.exceeds_local_limit")}</small>}</td>
        </tr>)}
      </tbody></table>}
      {last > 0 && <div className="actions"><button type="button" disabled={!shown} onClick={() => setPage(shown - 1)}>{t("tags.previous_candidates")}</button><span>{shown + 1} / {last + 1}</span><button type="button" disabled={shown === last} onClick={() => setPage(shown + 1)}>{t("tags.next_candidates")}</button></div>}
    </details>
    {review.notices.length > 0 && <details><summary>{t("tags.tag_compatibility_notices", { value: review.notices.length + review.omittedNotices })}</summary><ul>{review.notices.map((notice, i) => <li key={i}>{notice}</li>)}</ul>{review.omittedNotices > 0 && <p>{t("tags.additional_notices_omitted", { omittedNotices: review.omittedNotices })}</p>}</details>}
    <p className="small">{policy === 'all' ? t("tags.matching_tags_new_tags", { length: review.existing.length, create: review.modes.all.create }) : policy === 'existing' ? t("tags.matching_tags", { length: review.existing.length }) : t("tags.tags_are_not_imported")}</p>
  </div>;
}
