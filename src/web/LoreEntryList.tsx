import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { LoreEntry } from '../shared/lorebook';
import { Icon } from './Icon';
import { LibrarySearchField } from './LibrarySearchField';
import { ModalDialog } from './ModalDialog';
import { openModal } from './dialog-focus';
import { t, useLocale } from './localization';
import { useListReorder } from './useListReorder';

export const lorePageSize = 50;

export function LorePagination({ page, last, change }: { page: number; last: number; change: (page: number) => void }) {
  useLocale();
  return <div className="tag-pagination lore-pagination">
    <button type="button" className="quiet" aria-label={t('lorebook_editor.previous_page')} title={t('lorebook_editor.previous_page')}
      disabled={page === 0} onClick={() => change(page - 1)}><Icon name="ArrowShortBack" /></button>
    <span>{t('lorebook_editor.page_of', { value: page + 1, value2: last + 1 })}</span>
    <button type="button" className="quiet" aria-label={t('lorebook_editor.next_page')} title={t('lorebook_editor.next_page')}
      disabled={page === last} onClick={() => change(page + 1)}><Icon name="ArrowShortForward" /></button>
  </div>;
}

function MoveEntryDialog({ ordered, from, move, close }: {
  ordered: LoreEntry[]; from: number; move: (to: number) => void; close: () => void;
}) {
  useLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  const [position, setPosition] = useState(String(from + 1));
  useLayoutEffect(() => openModal(dialog.current), []);
  const to = Number(position) - 1;
  const neighbor = ordered[to];
  return createPortal(<ModalDialog ref={dialog} className="confirmation-dialog lore-move-dialog" aria-labelledby={title} onDismiss={close}>
    <h2 id={title}>{t('lorebook_editor.move_named', { name: ordered[from].name || t('lorebook_editor.unnamed_entry') })}</h2>
    <form onSubmit={event => {
      event.preventDefault();
      event.stopPropagation();
      if (Number.isInteger(to) && neighbor) move(to);
    }}>
      <label>{t('lorebook_editor.new_position', { total: ordered.length })}
        <input type="number" inputMode="numeric" required min={1} max={ordered.length} step={1} value={position}
          onChange={event => setPosition(event.target.value)} />
      </label>
      {neighbor && to !== from && <p className="small muted">{t(to < from ? 'lorebook_editor.before_entry' : 'lorebook_editor.after_entry',
        { name: neighbor.name || t('lorebook_editor.unnamed_entry') })}</p>}
      <div className="actions"><button type="submit">{t('lorebook_editor.move')}</button>
        <button type="button" className="secondary" onClick={close}>{t('character_import.cancel')}</button></div>
    </form>
  </ModalDialog>, document.body);
}

export function LoreEntryList({ ordered, selectedId, select, arrange, move, page, setPage, query, search, add, canAdd }: {
  ordered: LoreEntry[]; selectedId: string; select: (id: string) => void; arrange: boolean;
  move: (from: number, to: number) => void; page: number; setPage: (page: number) => void;
  query: string; search: (value: string) => void; add: () => void; canAdd: boolean;
}) {
  useLocale();
  const list = useRef<HTMLDivElement>(null);
  const focusAfterMove = useRef<{ id: string; action: string } | null>(null);
  const [movingId, setMovingId] = useState<string | null>(null);
  const needle = query.normalize('NFC').toLowerCase();
  const matching = useMemo(() => {
    const indexed = ordered.map((entry, position) => ({ entry, position }));
    return needle ? indexed.filter(({ entry }) => [entry.name, entry.comment, entry.content, ...entry.keys, ...entry.secondaryKeys]
      .some(value => value.normalize('NFC').toLowerCase().includes(needle))) : indexed;
  }, [ordered, needle]);
  const last = Math.max(0, Math.ceil(matching.length / lorePageSize) - 1);
  const shown = Math.min(page, last);
  const start = shown * lorePageSize;
  const visible = matching.slice(start, start + lorePageSize);
  const movingFrom = movingId === null ? -1 : ordered.findIndex(entry => entry.id === movingId);

  function moveRow(from: number, to: number, action?: string) {
    if (!arrange || needle || from === to || !ordered[from] || !ordered[to]) return;
    if (action) focusAfterMove.current = { id: ordered[from].id, action };
    move(from, to);
    setPage(Math.floor(to / lorePageSize));
  }
  const reorder = useListReorder((from, to) => moveRow(start + from, start + to), arrange && !needle);
  useLayoutEffect(() => {
    const target = focusAfterMove.current;
    focusAfterMove.current = null;
    if (!target) return;
    const row = list.current?.querySelector(`[data-entry-id="${CSS.escape(target.id)}"]`);
    const control = row?.querySelector<HTMLButtonElement>(`[data-action="${target.action}"]:enabled`)
      ?? row?.querySelector<HTMLButtonElement>('[data-action="position"]');
    control?.focus({ preventScroll: true });
    control?.scrollIntoView({ block: 'nearest' });
  }, [ordered]);
  return <div className={arrange ? 'lore-organizer' : 'lore-navigator'}>
    <div className="lore-list-heading"><strong>{t('lorebook_editor.entries', { length: ordered.length })}</strong>
      {!arrange && <button type="button" className="secondary" disabled={!canAdd} onClick={add}><Icon name="AddToList" />{t('lorebook_editor.add_entry')}</button>}
    </div>
    <LibrarySearchField label={t('lorebook_editor.search_entries')} value={query} change={value => { search(value); setPage(0); }} />
    {last > 0 && <LorePagination page={shown} last={last} change={next => {
      setPage(next);
      list.current?.scrollTo({ top: 0, behavior: 'instant' });
    }} />}
    {arrange && needle && <p className="small muted">{t('lorebook_editor.clear_search_to_reorder')}</p>}
    <div className="lore-entry-list" ref={list} role="group" aria-label={t('lorebook_editor.lorebook_entries')}>
      <div className="lore-entry-rows" {...reorder.list}>
        {visible.map(({ entry, position }, index) => {
          const name = entry.name || t('lorebook_editor.unnamed_entry');
          const description = <><strong>{name}</strong><small>{t('lorebook_editor.order_priority', {
            value: t(entry.enabled ? 'interface.enabled' : 'interface.disabled'), insertionOrder: position + 1, priority: entry.priority,
          })}</small></>;
          return <div key={entry.id} data-entry-id={entry.id} className={`lore-entry-row${reorder.rowClass(index, visible.length)}`}>
            {arrange ? <>
              <span className="drag-handle" {...reorder.handle(index, entry.id)} aria-hidden="true" title={t('libraries.drag_to_reorder')}><Icon name="Menu" /></span>
              <div className="lore-row-label">{description}</div>
              <div className="lore-order-actions">
                {([-1, 1] as const).map(direction => <button key={direction} type="button" className="quiet" data-action={direction}
                  disabled={Boolean(needle) || !ordered[position + direction]} title={t(direction < 0 ? 'libraries.move_up' : 'libraries.move_down')}
                  aria-label={t(direction < 0 ? 'lorebook_editor.move_entry_up' : 'lorebook_editor.move_entry_down', { name })}
                  onClick={() => moveRow(position, position + direction, String(direction))}><Icon name={direction < 0 ? 'ArrowLongTop' : 'ArrowLongBottom'} /></button>)}
                <button type="button" className="quiet" data-action="position" disabled={Boolean(needle) || ordered.length < 2}
                  aria-label={t('lorebook_editor.move_to_position', { name })} onClick={() => setMovingId(entry.id)}>{t('lorebook_editor.move_ellipsis')}</button>
              </div>
            </> : <button type="button" className="quiet lore-entry-select lore-row-label" aria-pressed={entry.id === selectedId}
              onClick={() => select(entry.id)}>{description}</button>}
          </div>;
        })}
      </div>
      {!matching.length && <p className="small muted">{t(ordered.length ? 'lorebook_editor.no_entries_match_your_search' : 'lorebook_editor.this_book_is_empty_add_an_entry')}</p>}
    </div>
    {movingFrom >= 0 && <MoveEntryDialog ordered={ordered} from={movingFrom} close={() => setMovingId(null)}
      move={to => { setMovingId(null); moveRow(movingFrom, to, 'position'); }} />}
  </div>;
}
