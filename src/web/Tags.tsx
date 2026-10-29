import { openModal } from './dialog-focus';
import { useTextState, errorText, t, message as msg, useLocale } from './localization';
import { Icon } from './Icon';
import { useConfirmation } from './Confirmation';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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
function TagPagination({ shown, last, disabled = false, change }: { shown: number; last: number; disabled?: boolean; change: (page: number) => void }) {
  useLocale();
  if (!last) return null;
  return <div className="tag-pagination">
    <button type="button" className="quiet" aria-label={t("tags.previous_tags")} title={t("tags.previous_tags")} disabled={disabled || shown === 0} onClick={() => change(shown - 1)}><Icon name="ArrowShortBack" /></button>
    <span>{shown + 1} / {last + 1}</span>
    <button type="button" className="quiet" aria-label={t("tags.next_tags")} title={t("tags.next_tags")} disabled={disabled || shown === last} onClick={() => change(shown + 1)}><Icon name="ArrowShortForward" /></button>
  </div>;
}
export function TagChooser({ tags, selected, change, label, disabled = false, showSelected = true, variant = 'assignment', onSearchChange, onPageChange }: { tags: Tag[]; selected: string[]; change: (ids: string[]) => void; label: string; disabled?: boolean; showSelected?: boolean; variant?: 'assignment' | 'filter'; onSearchChange?: (search: string) => void; onPageChange?: () => void }) {
  useLocale();
  const [search, setSearch] = useState(''), [page, setPage] = useState(0);
  const results = useRef<HTMLDivElement>(null);
  const pageScroll = useRef<{ element: HTMLElement; top: number }[]>([]);
  const [resultsMinHeight, setResultsMinHeight] = useState<number>();
  const query = canonicalTagName(search), chosen = useMemo(() => new Set(selected), [selected]);
  const matches = useMemo(() => tags.filter(tag => canonicalTagName(tag.name).includes(query)).sort((a, b) => a.name.localeCompare(b.name)), [tags, query]);
  const last = Math.max(0, Math.ceil(matches.length / tagLimits.page) - 1), shown = Math.min(page, last);
  useLayoutEffect(() => {
    // WebKit can move scrolling ancestors when the old checkbox rows disappear,
    // even when the reserved result area keeps exactly the same dimensions.
    const positions = pageScroll.current;
    pageScroll.current = [];
    for (const { element, top } of positions) element.scrollTo({ top, behavior: 'instant' });
  }, [shown]);
  const controls = <>
    {showSelected && <TagChips tags={tags} selected={selected} remove={id => change(selected.filter(value => value !== id))} />}
    <label>{variant === 'assignment' && t("tags.search_tags")}<span className="search-field"><Icon name="Search" /><input type="search" disabled={disabled} aria-label={t("tags.search_tags")} placeholder={variant === 'filter' ? t("tags.search_tags") : undefined} value={search} onChange={event => {
      const next = event.target.value;
      // Rows, empty notices and pagination share one reserved area during search,
      // so filtering cannot shrink the page and clamp its scroll position.
      if (variant === 'assignment') {
        if (next) setResultsMinHeight(results.current?.getBoundingClientRect().height);
        else setResultsMinHeight(undefined);
      }
      onSearchChange?.(next);
      setSearch(next); setPage(0);
    }} /></span></label>
    <div className="tag-chooser-results" ref={results} style={{ minHeight: resultsMinHeight }}>
      <div className="tag-options">{matches.slice(shown * tagLimits.page, (shown + 1) * tagLimits.page).map(tag => <label className="checkbox" key={tag.id}><input type="checkbox" disabled={disabled} checked={chosen.has(tag.id)} onChange={event => change(event.target.checked ? [...selected, tag.id] : selected.filter(id => id !== tag.id))} /><span className="tag-option-name">{tag.name}</span></label>)}</div>
      {!matches.length && <p className="small muted">{tags.length ? t("tags.no_tags_match_your_search") : t("tags.no_tags_yet_create_one_in_manage")}</p>}
      <TagPagination shown={shown} last={last} disabled={disabled} change={next => {
        const positions: { element: HTMLElement; top: number }[] = [];
        for (let element = results.current?.parentElement; element; element = element.parentElement) {
          if (element.scrollTop > 0) positions.push({ element, top: element.scrollTop });
        }
        pageScroll.current = positions;
        if (variant === 'assignment') setResultsMinHeight(results.current?.getBoundingClientRect().height);
        onPageChange?.();
        setPage(next);
      }} />
    </div>
  </>;
  return variant === 'filter'
    ? <div className="tag-chooser" role="group" aria-label={label} aria-disabled={disabled || undefined}><div className="tag-chooser-title">{label}</div>{controls}</div>
    : <fieldset className="tag-chooser" disabled={disabled}><legend>{label}</legend>{controls}</fieldset>;
}
export function TagFilterMenu({ library, busy, run, selected, change }: { library: LibrarySnapshot; busy: boolean; run: Run; selected: string[]; change: (ids: string[]) => void }) {
  useLocale();
  const [open, setOpen] = useState(false), [manager, setManager] = useState(false);
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [reservedHeight, setReservedHeight] = useState<number>();
  const [position, setPosition] = useState({ left: 0, top: 0, width: 380, maxHeight: 624 });
  const panelId = useId();
  useLayoutEffect(() => {
    if (!open) {
      setReservedHeight(undefined);
      return;
    }
    const row = root.current?.parentElement;
    const workspace = root.current?.closest('.library-workspace');
    if (!row || !workspace) return;
    const mobile = window.matchMedia('(max-width: 800px)');
    const viewport = window.visualViewport;
    const place = () => {
      const topEdge = viewport?.offsetTop ?? 0;
      const leftEdge = viewport?.offsetLeft ?? 0;
      const viewportWidth = viewport?.width ?? innerWidth;
      const bottom = topEdge + (viewport?.height ?? innerHeight);
      const anchor = row.getBoundingClientRect();
      const width = Math.max(0, Math.min(380, mobile.matches ? viewportWidth - 24 : anchor.width));
      const top = mobile.matches ? Math.max(topEdge, workspace.getBoundingClientRect().top) + 12 : anchor.bottom + 8;
      const next = {
        left: mobile.matches ? leftEdge + viewportWidth - width - 12 : anchor.right - width,
        top, width,
        maxHeight: Math.max(0, Math.min(624, bottom - top - 12)),
      };
      setPosition(previous => previous.left === next.left && previous.top === next.top && previous.width === next.width && previous.maxHeight === next.maxHeight ? previous : next);
    };
    const observer = new ResizeObserver(place);
    observer.observe(row);
    observer.observe(workspace);
    place();
    mobile.addEventListener('change', place);
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    viewport?.addEventListener('resize', place);
    viewport?.addEventListener('scroll', place);
    return () => {
      observer.disconnect();
      mobile.removeEventListener('change', place);
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
      viewport?.removeEventListener('resize', place);
      viewport?.removeEventListener('scroll', place);
    };
  }, [open]);
  useLayoutEffect(() => {
    if (!open || manager) return;
    const interceptOutside = (event: Event) => {
      if (!(event.target instanceof Node) || root.current?.contains(event.target) || panel.current?.contains(event.target)) return;
      // Consume activation before controls receive it, retaining the guard until
      // click completes. Leaving wheel/touch-move events alone preserves native scrolling.
      event.preventDefault();
      event.stopPropagation();
      if (event.type === 'click') {
        setOpen(false);
        trigger.current?.focus({ preventScroll: true });
      }
    };
    const dismissAfterTab = (event: KeyboardEvent) => {
      if (event.key === 'Tab' && !root.current?.contains(document.activeElement) && !panel.current?.contains(document.activeElement)) setOpen(false);
    };
    document.addEventListener('pointerdown', interceptOutside, true);
    document.addEventListener('pointerup', interceptOutside, true);
    document.addEventListener('click', interceptOutside, true);
    document.addEventListener('keyup', dismissAfterTab);
    return () => {
      document.removeEventListener('pointerdown', interceptOutside, true);
      document.removeEventListener('pointerup', interceptOutside, true);
      document.removeEventListener('click', interceptOutside, true);
      document.removeEventListener('keyup', dismissAfterTab);
    };
  }, [open, manager]);
  return <div className="tag-filter-menu" ref={root} onKeyDown={event => {
    if (event.key === 'Escape' && open && !manager) {
      event.preventDefault(); setOpen(false); trigger.current?.focus({ preventScroll: true });
    }
    // The panel stays in one portal across viewport changes. Connect its first
    // control to the trigger in both directions without trapping keyboard focus.
    if (event.key === 'Tab' && open && !manager) {
      const first = panel.current?.querySelector<HTMLElement>('input:not(:disabled), button:not(:disabled)');
      if (!event.shiftKey && event.target === trigger.current && first) {
        event.preventDefault(); first.focus({ preventScroll: true });
      } else if (event.shiftKey && event.target === first) {
        event.preventDefault(); trigger.current?.focus({ preventScroll: true });
      }
    }
  }}>
    <button type="button" className="secondary tag-filter-trigger" ref={trigger} aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(!open)}>
      {t("character_editor.tags")}{selected.length > 0 && <span className="tag-filter-count">{selected.length}</span>}<Icon name="ArrowShortBottom" />
    </button>
    {open && createPortal(<div id={panelId} ref={panel} className="tag-filter-panel" style={{ ...position, minHeight: reservedHeight === undefined ? undefined : Math.min(reservedHeight, position.maxHeight) }}>
        <TagChooser label={t("tags.filter_characters_by_tags")} tags={library.tags} selected={selected} change={change} showSelected={false} variant="filter" onSearchChange={search => {
          // Reserve the popup rather than its rows: broader searches may grow,
          // while a shorter viewport can still shrink the list around its controls.
          setReservedHeight(search ? panel.current?.getBoundingClientRect().height : undefined);
        }} onPageChange={() => setReservedHeight(panel.current?.getBoundingClientRect().height)} />
        <div className="tag-filter-footer"><button type="button" className="quiet" onClick={() => setManager(true)}>{t("character_editor.manage_tags")}</button></div>
        <button type="button" className="quiet tag-filter-close" aria-label={t("tags.close_filters")} title={t("tags.close_filters")} onClick={() => {
          setOpen(false); trigger.current?.focus({ preventScroll: true });
        }}><Icon name="Close" /></button>
    </div>, document.body)}
    {manager && <TagManager library={library} busy={busy} run={run} close={() => setManager(false)} />}
  </div>;
}
export function TagManager({ library, busy, run, committed, close }: { library: LibrarySnapshot; busy: boolean; run: Run; committed?: TagCommit; close: () => void }) {
  useLocale();
  const confirmAction = useConfirmation();
  const [search, setSearch] = useState(''), [name, setName] = useState(''), [rename, setRename] = useState<{ id: string; name: string; revision: number } | null>(null);
  const [error, setError] = useTextState(''), [pending, setPending] = useState(false), [page, setPage] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const backdropPointer = useRef(false);
  const titleId = useId();
  useLayoutEffect(() => {
    const trigger = document.activeElement;
    const node = dialog.current;
    openModal(node);
    return () => { node?.close(); if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus({ preventScroll: true }); };
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
  function outsideDialog(x: number, y: number) {
    const bounds = dialog.current?.getBoundingClientRect();
    return bounds !== undefined && (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom);
  }
  return <dialog ref={dialog} className="tag-manager" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); if (!pending) close(); }} onPointerDown={event => {
    backdropPointer.current = event.target === event.currentTarget && outsideDialog(event.clientX, event.clientY);
  }} onClick={event => {
    if (!pending && backdropPointer.current && event.target === event.currentTarget && outsideDialog(event.clientX, event.clientY)) close();
    backdropPointer.current = false;
  }}>
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
      </form> : <><span>{tag.name}<small>{t('tags.character_count', { count: tag.usageCount })}</small></span><div className="actions"><button type="button" className="quiet" aria-label={t("tags.rename", { name: tag.name })} disabled={busy || pending} onClick={() => setRename({ id: tag.id, name: tag.name, revision: library.revision })}>{t("tags.rename_2")}</button><button type="button" className="quiet" aria-label={t("tags.delete", { name: tag.name })} disabled={busy || pending} onClick={() => { confirmAction({ title: t("tags.delete_tag"), message: t("tags.delete_characters_will_lose_this_local_assignment", { name: tag.name, usageCount: tag.usageCount }), actionLabel: t("tags.delete_tag_2"), onConfirm: () => { void mutate('DELETE', `/library/tags/${tag.id}`, { revision: library.revision }, tag.id); } }); }}><Icon name="TrashOutline" />{t("libraries.delete_2")}</button></div></>}
    </div>)}
    {!matches.length && <p className="muted tag-manager-empty">{library.tags.length ? t("tags.no_tags_match_your_search") : t("tags.no_tags_yet_create_your_first_tag")}</p>}
    </div>
    <footer className="tag-manager-footer"><span className="small muted">{t(search ? 'tags.found_count' : 'tags.catalog_count', { count: matches.length })}</span>
      <TagPagination shown={shown} last={last} disabled={pending} change={next => {
        setPage(next);
        dialog.current?.querySelector('.tag-catalog')?.scrollTo({ top: 0 });
      }} />
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
