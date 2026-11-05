import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { RequestEstimate } from '../shared/contracts';
import type { PinList } from '../shared/transcript';
import { api, datasetChanged } from './api';
import { openModal } from './dialog-focus';
import { Icon } from './Icon';
import { LibrarySearchField } from './LibrarySearchField';
import { errorText, formatMessage, locale, message, t, useLocale, type MessageText } from './localization';
import { BudgetBreakdown, InputMeter } from './PromptPeek';
import { TurnActionButton } from './TurnActionButton';

type Row = PinList['turns'][number];
type PinChange = { row: Row; pinned: boolean };
type Failure = { message: MessageText; change?: PinChange };

export function saveTurnPin(branch: string, turn: string, revision: number, pinned: boolean) {
  return api<{ revision: number; pinned: boolean }>(
    `/chats/${encodeURIComponent(branch)}/turns/${encodeURIComponent(turn)}/pin`, 'PUT', { revision, pinned },
  );
}

const normalize = (value: string) => value.normalize('NFC').toLowerCase();
const pageSize = 30;
const excerpt = (text: string) => text.length > 240 ? `${text.slice(0, 240)}…` : text;

export function PinnedTurns({ branch, revision, estimate, estimateCurrent, estimateError, retryEstimate, locked, close, refresh, jump }: {
  branch: string;
  revision: number;
  estimate: RequestEstimate | null;
  estimateCurrent: boolean;
  estimateError: MessageText;
  retryEstimate: () => void;
  locked: boolean;
  close: () => void;
  refresh: () => Promise<void>;
  jump: (turnId: string, revision: number) => Promise<void>;
}) {
  useLocale();
  const title = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const alive = useRef(false);
  const [list, setList] = useState<PinList | null>(null);
  const [retained, setRetained] = useState<Row[]>([]);
  const [search, setSearch] = useState('');
  const [visibleRows, setVisibleRows] = useState(pageSize);
  const [reload, setReload] = useState(0);
  const [readError, setReadError] = useState<MessageText>('');
  const [failure, setFailure] = useState<Failure | null>(null);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);

  useLayoutEffect(() => {
    alive.current = true;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = dialog.current;
    openModal(node);
    return () => { alive.current = false; node?.close(); trigger?.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setReadError('');
    void api<PinList>(`/chats/${encodeURIComponent(branch)}/pins`, 'GET', undefined, controller.signal).then(value => {
      if (!controller.signal.aborted && !datasetChanged()) setList(current => current && current.revision > value.revision ? current : value);
    }).catch(error => {
      if (!controller.signal.aborted) setReadError(errorText(error, message('pins.loading_failed')));
    });
    return () => controller.abort();
  }, [branch, revision, reload]);

  async function perform(action: () => Promise<void>, fallback: MessageText, change?: PinChange) {
    if (inFlight.current || datasetChanged()) return;
    inFlight.current = true;
    setPending(true);
    setFailure(null);
    try { await action(); }
    catch (error) {
      if (alive.current) {
        setFailure({ message: errorText(error, fallback), change });
        setReload(value => value + 1);
      }
      await refresh();
    } finally {
      inFlight.current = false;
      if (alive.current) setPending(false);
    }
  }
  function changePin(change: PinChange) {
    if (locked || !list || list.revision < revision || readError) return;
    void perform(async () => {
      const saved = await saveTurnPin(branch, change.row.id, list.revision, change.pinned);
      if (!alive.current || datasetChanged()) return;
      const row = change.row;
      setRetained(current => saved.pinned ? current.filter(turn => turn.id !== row.id)
        : [...current.filter(turn => turn.id !== row.id), row]);
      setList(current => current && current.revision <= saved.revision ? {
        ...current, revision: saved.revision,
        turns: [...current.turns.filter(turn => turn.id !== row.id), ...(saved.pinned ? [row] : [])],
      } : current);
      await refresh();
    }, message('pins.change_failed'), change);
  }

  const rows = useMemo(() => {
    const active = new Set(list?.turns.map(turn => turn.id));
    return [...(list?.turns ?? []), ...retained.filter(turn => !active.has(turn.id))]
      .sort((a, b) => a.ordinal - b.ordinal)
      .map(turn => ({ turn, pinned: active.has(turn.id), searchable: normalize(`${turn.ordinal}\n${turn.user}\n${turn.assistant}`) }));
  }, [list, retained]);
  const query = normalize(search.trim());
  const matches = rows.filter(row => row.searchable.includes(query));
  const listCurrent = Boolean(list && list.revision >= revision && !readError);
  const limit = estimate ? Math.min(estimate.budget.targetInputTokens,
    estimate.budget.contextWindow - estimate.budget.reservedOutputTokens) : 0;

  function dismiss() {
    if (!inFlight.current) close();
  }

  return createPortal(<dialog ref={dialog} className="catalog-dialog chat-branches-dialog" aria-labelledby={title}
    onCancel={event => { event.preventDefault(); dismiss(); }}
    onClick={event => {
      if (event.target !== event.currentTarget) return;
      const { left, top, right, bottom } = event.currentTarget.getBoundingClientRect();
      if (event.clientX < left || event.clientX > right || event.clientY < top || event.clientY > bottom) dismiss();
    }}>
    <div className="branch-manager-content">
      <header className="catalog-dialog-heading">
        <h2 id={title}>{t('pins.title')}</h2>
        <button type="button" className="quiet" aria-label={t('pins.close')} disabled={pending} onClick={dismiss}><Icon name="Close" /></button>
      </header>
      <div className="branch-manager-controls">
        <LibrarySearchField label={t('pins.search')} value={search} change={value => { setSearch(value); setVisibleRows(pageSize); }} />
      </div>
      <div className="branch-manager-results">
        {list?.hasConnection && <>
          {estimate && <div className="budget pinned-budget" aria-busy={!estimateError && (!estimateCurrent || list.revision > revision)}>
            <strong>{t('app.estimated_input_2', { value: estimate.budget.inputTokens.toLocaleString(locale()), value2: limit.toLocaleString(locale()) })}</strong>
            <InputMeter input={estimate.budget.inputTokens} limit={limit} />
            <BudgetBreakdown request={estimate} />
          </div>}
          {estimateError ? <p role="status">{formatMessage(estimateError)}{' '}
            <button type="button" className="secondary" onClick={retryEstimate}>{t('app.retry_preview')}</button>
          </p> : !estimate && <p role="status">{t('app.counting_current_input')}</p>}
        </>}
        {readError ? <p role="alert">{formatMessage(readError)}{' '}
          <button type="button" className="secondary" onClick={() => setReload(value => value + 1)}>{t('app.retry_loading')}</button>
        </p> : !list && <p role="status">{t('pins.loading')}</p>}
        {failure && <p role="alert">{formatMessage(failure.message)}{' '}
          {failure.change && <button type="button" className="secondary" disabled={locked || pending || !listCurrent}
            onClick={() => { if (failure.change) changePin(failure.change); }}>{t('settings.retry')}</button>}
        </p>}
        {list && matches.length === 0 && <p role="status">{t(query ? 'pins.no_matches' : 'pins.empty')}</p>}
        <div className="library-list branch-list">{matches.slice(0, visibleRows).map(({ turn, pinned }) => {
          const status = !pinned ? 'pins.unpinned' : !list?.markerEnabled ? 'pins.omitted'
            : !turn.hasModelText ? 'pins.no_text' : !list.hasConnection ? 'pins.no_connection' : null;
          return <article className="library-card" key={turn.id}>
            <div className="library-card-body pinned-row">
              <div className="pinned-row-header">
                <h3><button type="button" className="library-card-open" aria-disabled={pending || !listCurrent}
                  onClick={() => { if (listCurrent && list) void perform(() => jump(turn.id, list.revision), message('pins.jump_failed')); }}>
                  {t('app.turn', { ordinal: turn.ordinal })}
                </button></h3>
                <TurnActionButton action={pinned ? 'unpin' : 'pin'} label={t(pinned ? 'pins.unpin_short' : 'pins.pin_short')}
                  aria-disabled={pending || locked || !listCurrent} onClick={() => changePin({ row: turn, pinned: !pinned })} />
              </div>
              {status && <p className="small muted">{t(status)}</p>}
              {turn.user && <p className="pin-excerpt">{excerpt(turn.user)}</p>}
              {turn.assistant && <p className="pin-excerpt">{excerpt(turn.assistant)}</p>}
            </div>
          </article>;
        })}</div>
        {visibleRows < matches.length && <button type="button" className="secondary" onClick={() => setVisibleRows(visibleRows + pageSize)}>{t('pins.show_more')}</button>}
      </div>
    </div>
  </dialog>, document.body);
}
