import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { z } from 'zod';
import {
  libraryDeletionCommandSchema, libraryDeletionResultSchema, libraryDeletionReviewSchema,
  type LibraryDeletionChoice, type LibraryDeletionCommand, type LibraryDeletionReview,
} from '../shared/library-deletion';
import { api, ApiError, datasetEpoch } from './api';
import { Dropdown } from './Controls';
import { dismissModalFromAction, openModal } from './dialog-focus';
import { LibrarySearchField } from './LibrarySearchField';
import { displayLibraryRecord } from './localization-labels';
import { errorText, formatMessage, locale, message, t, useLocale, type MessageText } from './localization';
import { ModalDialog } from './ModalDialog';
import { newId } from './uuid';

export type LibraryDeletionTarget = { id: string; kind: LibraryDeletionCommand['kind'] };
type NamedItem = LibraryDeletionReview['target'];
type ReviewBlocker = LibraryDeletionReview['blockers'][number];
const retryKey = 'ore-library-deletion';
const retrySchema = z.object({
  epoch: z.string(), id: z.string().min(1).max(100), command: libraryDeletionCommandSchema,
}).strict();
type Retry = z.infer<typeof retrySchema>;
let inMemoryRetry: Retry | null = null;

export function readDeletionRetry() {
  try {
    const saved = retrySchema.safeParse(JSON.parse(sessionStorage.getItem(retryKey) ?? 'null'));
    if (saved.success && !inMemoryRetry) inMemoryRetry = saved.data;
  } catch { /* Session storage can be unavailable. */ }
  if (inMemoryRetry && inMemoryRetry.epoch !== datasetEpoch()) stageDeletionRetry(null);
  if (!inMemoryRetry) return null;
  const { id, command } = inMemoryRetry;
  return { target: { id, kind: command.kind }, command };
}

function stageDeletionRetry(retry: Retry | null) {
  inMemoryRetry = retry;
  try {
    if (retry) sessionStorage.setItem(retryKey, JSON.stringify(retry));
    else sessionStorage.removeItem(retryKey);
  } catch { /* The current tab can still retry from memory. */ }
}

const pageSize = 30;
const searchValue = (value: string) => value.normalize('NFC').toLocaleLowerCase(locale());
function displayNames(items: NamedItem[]) {
  const counts = new Map<string, number>();
  for (const { name } of items) counts.set(name, (counts.get(name) ?? 0) + 1);
  return items.map(item => ({
    ...item, name: (counts.get(item.name) ?? 0) > 1 ? t('library_delete.duplicate_name', item) : item.name,
  }));
}

function DependencyList({ dependencies, kind }: { dependencies: LibraryDeletionReview['dependencies']; kind: LibraryDeletionTarget['kind'] }) {
  const [search, setSearch] = useState('');
  const list = useRef<HTMLDivElement>(null);
  const groups = [
    { kind: 'chats', items: dependencies.chats.map(chat => ({
      id: chat.id, name: chat.name,
      reasons: [
        ...(kind === 'connections' && chat.direct ? [t('library_delete.roleplay_connection')] : []),
        ...(chat.memoryPreset ? [t('library_delete.memory_through', { preset: displayLibraryRecord(chat.memoryPreset).name })] : []),
      ],
    })) },
    { kind: 'characters', items: dependencies.characters.map(item => ({ ...item, reasons: [t('library_delete.character_default')] })) },
    { kind: 'contexts', items: dependencies.contexts.map(item => ({ ...displayLibraryRecord(item), reasons: [t('library_delete.summary_connection')] })) },
  ] as const;
  const query = searchValue(search.trim());
  const order = new Intl.Collator(locale(), { numeric: true });
  const shown = groups.map(group => ({
    kind: group.kind, count: group.items.length,
    items: displayNames(group.items).map((item, index) => ({ ...item, reasons: group.items[index].reasons }))
      .filter(item => searchValue([item.name, ...item.reasons].join(' ')).includes(query))
      .sort((a, b) => order.compare(a.name, b.name) || a.id.localeCompare(b.id)),
  }));
  const label = t('library_delete.search');
  return <div className="library-deletion-dependencies">
    <LibrarySearchField label={label} value={search} change={value => {
      setSearch(value);
      if (list.current) list.current.scrollTop = 0;
    }} />
    <div className="library-deletion-list" ref={list} tabIndex={-1} role="region" aria-label={t('library_delete.linked_items')}>
      {!shown.some(group => group.items.length) && <p role="status">{t('library_delete.no_matches')}</p>}
      {shown.filter(group => group.items.length).map(({ kind, count, items }) =>
        <DependencyGroup key={`${kind}:${query}`} heading={t(`library_delete.${kind}`, { count })} items={items} />)}
    </div>
  </div>;
}

function DependencyGroup({ heading, items }: { heading: string; items: (NamedItem & { reasons: string[] })[] }) {
  const [limit, setLimit] = useState(pageSize);
  return <section>
    <h3>{heading}</h3>
    <ul>{items.slice(0, limit).map(item => <li key={item.id}>
      <span>{item.name}</span>
      {item.reasons.map(reason => <small className="muted" key={reason}>{reason}</small>)}
    </li>)}</ul>
    {limit < items.length && <button type="button" className="secondary" onClick={() => setLimit(limit + pageSize)}>{t('library_delete.more')}</button>}
  </section>;
}

function BlockerList({ blockers }: { blockers: ReviewBlocker[] }) {
  return blockers.map(({ reason, branches }) => <div className="library-deletion-blocker" key={reason}>
    <p role="status">{t(`library_delete.${reason}`)}</p>
    {branches.length > 0 && <BlockedBranches branches={branches} />}
  </div>);
}

function BlockedBranches({ branches }: { branches: ReviewBlocker['branches'] }) {
  const [limit, setLimit] = useState(pageSize);
  const items = displayNames(branches.map(branch => ({
    id: branch.id, name: t('library_delete.branch', { chat: branch.name, branch: branch.branchName ?? t('branches.main') }),
  })));
  return <>
    <ul>{items.slice(0, limit).map(item => <li key={item.id}>{item.name}</li>)}</ul>
    {limit < items.length && <button type="button" className="secondary" onClick={() => setLimit(limit + pageSize)}>{t('library_delete.more')}</button>}
  </>;
}

function clearConsequences(kind: LibraryDeletionTarget['kind'], { chats, characters, contexts }: LibraryDeletionReview['dependencies']) {
  if (kind === 'connections') return [
    ...(chats.some(chat => chat.direct) ? ['library_delete.clear_chat_connections' as const] : []),
    ...(contexts.length ? ['library_delete.clear_preset_connections' as const] : []),
  ];
  if (kind === 'lorebooks') return [chats.length && characters.length ? 'library_delete.clear_lorebooks' as const
    : chats.length ? 'library_delete.clear_chat_lorebooks' as const : 'library_delete.clear_character_lorebooks' as const];
  return [`library_delete.clear_${kind}` as const];
}

type Phase = 'loading' | 'ready' | 'failed' | 'submitting' | 'uncertain';

export function LibraryDeletionDialog({ target, name, busy, run, cancel, complete }: {
  target: LibraryDeletionTarget; name?: string; busy: boolean;
  run: (action: () => Promise<unknown>) => Promise<boolean>; cancel: () => void; complete: () => void;
}) {
  useLocale();
  const { id, kind } = target;
  const dialog = useRef<HTMLDialogElement>(null), cancelButton = useRef<HTMLButtonElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const title = useId(), description = useId(), choiceGroup = useId();
  const [staged, setStaged] = useState(() => {
    const retry = readDeletionRetry();
    return retry?.target.id === id && retry.target.kind === kind ? retry.command : null;
  });
  const [phase, setPhase] = useState<Phase>(staged ? 'uncertain' : 'loading');
  const [review, setReview] = useState<LibraryDeletionReview | null>(null);
  const [feedback, setFeedback] = useState<MessageText>(staged ? message('library_delete.uncertain') : '');
  const [mode, setMode] = useState<LibraryDeletionChoice['mode']>(staged?.choice.mode ?? 'clear');
  const [replacement, setReplacement] = useState(staged?.choice.mode === 'replace' ? staged.choice.replacementId : '');
  const [attempt, setAttempt] = useState(0);
  const active = useRef(false);
  const previousReview = useRef<LibraryDeletionReview | null>(null);
  const candidate = mode === 'replace' ? replacement : '';
  const path = `/library/${encodeURIComponent(id)}/deletion`;
  const locked = busy || phase === 'submitting' || phase === 'uncertain';
  const linked = Boolean(review && Object.values(review.dependencies).some(items => items.length));
  const actionMatches = Boolean(review && review.action.choice.mode === mode &&
    (mode === 'clear' || review.action.choice.mode === 'replace' && review.action.choice.replacementId === replacement));
  const blockers = review ? [...review.blockers, ...(actionMatches ? review.action.blockers : [])] : [];
  const canConfirm = !locked && phase === 'ready' && actionMatches && blockers.length === 0;
  const nameForReview = review?.target.name ?? name;

  useLayoutEffect(() => openModal(dialog.current), []);
  const reading = !staged;
  useEffect(() => {
    if (!reading) return;
    const controller = new AbortController();
    const query = new URLSearchParams({ kind, ...(candidate ? { replacementId: candidate } : {}) });
    setPhase('loading');
    void (async () => {
      try {
        const next = libraryDeletionReviewSchema.parse(await api<unknown>(`${path}?${query}`, 'GET', undefined, controller.signal));
        if (controller.signal.aborted) return;
        const previous = previousReview.current;
        if (previous && previous.version !== next.version) setFeedback(message('library_delete.stale'));
        previousReview.current = next;
        setReview(next);
        if (!Object.values(next.dependencies).some(items => items.length)) setMode('clear');
        setPhase('ready');
      } catch (error) {
        if (!controller.signal.aborted) {
          setFeedback(error instanceof ApiError && error.status === 404
            ? errorText(error, message('library_delete.load_failed')) : message('library_delete.load_failed'));
          setPhase('failed');
        }
      }
    })();
    return () => controller.abort();
  }, [path, kind, candidate, attempt, reading]);

  function reload(notice: MessageText = '') {
    setFeedback(notice);
    setPhase('loading');
    setAttempt(current => current + 1);
  }

  async function submit(command: LibraryDeletionCommand) {
    if (active.current || busy) return;
    active.current = true;
    const epoch = datasetEpoch();
    stageDeletionRetry({ epoch, id, command });
    setPhase('submitting');
    setFeedback('');
    try {
      let succeeded = false;
      await run(async () => {
        try {
          libraryDeletionResultSchema.parse(await api<unknown>(path, 'POST', command));
          stageDeletionRetry(null);
          succeeded = true;
        } catch (error) {
          const confirmed = error instanceof ApiError && (error.code === 'library_deletion_rolled_back' ||
            (error.status < 500 && Boolean(error.code) && (!staged || (error.status !== 401 && error.status !== 403))));
          if (!confirmed) {
            setStaged(command);
            setFeedback(message('library_delete.uncertain'));
            setPhase('uncertain');
            return;
          }
          stageDeletionRetry(null);
          setStaged(null);
          if (error.code === 'library_deletion_stale' || error.code === 'item_not_found') {
            reload(message('library_delete.stale'));
          } else if (error.code === 'library_deletion_blocked' || !review) {
            reload(errorText(error, message('library_delete.rollback')));
          } else {
            setFeedback(errorText(error, message('library_delete.rollback')));
            setPhase('ready');
          }
        }
      });
      if (succeeded) complete();
    } finally {
      active.current = false;
    }
  }

  function confirm() {
    if (canConfirm && review) {
      void submit({ kind, requestId: newId(), token: review.action.token, choice: review.action.choice });
    }
  }

  const confirmLabel = !linked ? 'libraries.delete_2' : mode === 'replace' || kind === 'prompts'
    ? 'library_delete.replace_and_delete' : 'library_delete.unlink';
  return createPortal(<ModalDialog ref={dialog}
    className={`confirmation-dialog library-deletion-dialog${linked ? ' library-deletion-linked' : ''}`}
    aria-labelledby={title} aria-describedby={description} onDismiss={() => { if (!locked) cancel(); }}
    onKeyDown={event => {
      if (event.key === 'Tab' && !linked && canConfirm) {
        event.preventDefault();
        const active = document.activeElement;
        const next = active === cancelButton.current ? confirmButton.current
          : active === confirmButton.current || !event.shiftKey ? cancelButton.current : confirmButton.current;
        next?.focus();
      }
      if (event.key === 'Enter' && !linked && canConfirm && event.target !== cancelButton.current &&
        !event.repeat && !event.nativeEvent.isComposing && event.keyCode !== 229 &&
        !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        event.preventDefault();
        confirm();
      }
    }}>
    <header>
      <span className="confirmation-symbol" aria-hidden="true">!</span>
      <h2 id={title}>{t('libraries.delete_library_item')}</h2>
      <p id={description}>{nameForReview && (linked ? t('library_delete.linked', { name: nameForReview })
        : review ? t('libraries.delete_from_the_library', { value: nameForReview }) : nameForReview)}</p>
    </header>
    <div className="library-deletion-body">
      {feedback && <p className="library-deletion-feedback" role="alert">{formatMessage(feedback)}</p>}
      {phase === 'loading' && <p role="status">{t('library_delete.loading')}</p>}
      {linked && review && <>
        <DependencyList key={review.version} dependencies={review.dependencies} kind={kind} />
        <fieldset disabled={locked}>
          <legend>{t('library_delete.before_deleting')}</legend>
          <label className="radio-option">
            <input type="radio" name={choiceGroup} checked={mode === 'clear'} onChange={() => { setFeedback(''); setMode('clear'); }} />
            {t(kind === 'prompts' ? 'library_delete.use_default_prompt' : 'library_delete.clear')}
          </label>
          {mode === 'clear' && !blockers.some(blocker => blocker.reason === 'excluded') && <div className="library-deletion-clear-help">
            {clearConsequences(kind, review.dependencies).map(key => <p key={key} className="small">{t(key)}</p>)}
          </div>}
          {(review.replacements.length > 0 || mode === 'replace') && <>
            <label className="radio-option">
              <input type="radio" name={choiceGroup} checked={mode === 'replace'} onChange={() => { setFeedback(''); setMode('replace'); }} />
              {t('library_delete.replace')}
            </label>
            {mode === 'replace' && <>
              <div className="library-deletion-replacement">
                <span>{t('library_delete.replacement_label')}</span>
                <Dropdown value={review.replacements.some(item => item.id === replacement) ? replacement : ''}
                  aria-label={t('library_delete.replacement_label')} disabled={locked}
                  options={[
                    { value: '', label: t('library_delete.select_replacement'), disabled: true },
                    ...displayNames(review.replacements.map(displayLibraryRecord)).map(item => ({ value: item.id, label: item.name })),
                  ]} onChange={value => { setFeedback(''); setReplacement(value); }} />
              </div>
              <p className="small">{t('library_delete.replacement_explanation')}</p>
            </>}
          </>}
        </fieldset>
      </>}
      {review?.bookmark && <div className="library-deletion-bookmark">
        <p>{t('library_delete.bookmark')}</p>
        <p>{t('library_delete.fallback', { name: review.bookmark.fallback ? displayLibraryRecord(review.bookmark.fallback).name : t('character_editor.none') })}</p>
      </div>}
      <BlockerList blockers={blockers} />
    </div>
    <div className="actions library-deletion-footer">
      {!staged && <button type="button" className="secondary" ref={cancelButton} disabled={locked}
        onClick={() => dismissModalFromAction(dialog.current, cancel)}>{t('character_import.cancel')}</button>}
      {phase === 'uncertain' && staged
        ? <button type="button" className="secondary" disabled={busy} onClick={() => void submit(staged)}>{t('library_delete.retry')}</button>
        : phase === 'failed' || phase === 'ready' && blockers.some(blocker => blocker.reason === 'busy' || blocker.reason === 'repair')
          ? <button type="button" className="secondary" disabled={busy} onClick={() => reload()}>{t('library_delete.retry')}</button>
          : <button type="button" className="danger" ref={confirmButton} disabled={!canConfirm} onClick={confirm}>
            {t(phase === 'submitting' ? 'library_delete.submitting' : confirmLabel)}
          </button>}
    </div>
  </ModalDialog>, document.body);
}
