import { useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ChatSummary } from '../shared/library';
import { api, ApiError } from './api';
import { useConfirmation } from './Confirmation';
import { openModal } from './dialog-focus';
import { ModalDialog } from './ModalDialog';
import { startDownload } from './downloads';
import { Icon } from './Icon';
import { ActionMenu } from './ActionMenu';
import { LibrarySearchField } from './LibrarySearchField';
import { errorText, formatMessage, locale, message, t, useLocale, type MessageText } from './localization';
import { newId } from './uuid';
import { chatGroupId } from './chat-selection';
import { TranscriptImport } from './TranscriptImport';

type Fork = { id: string; ordinal: number };
type Edit =
  | { kind: 'rename'; branch: ChatSummary; name: string }
  | { kind: 'copy'; branch: ChatSummary; name: string; through?: string; requestId: string };

const branchName = (branch: ChatSummary) => branch.branchName ?? t('branches.main');

export function ChatBranches({ current, branches, fork, locked, close, open, refresh }: {
  current: ChatSummary; branches: ChatSummary[]; fork?: Fork; locked: boolean; close: () => void;
  open: (id: string) => void; refresh: () => Promise<void>;
}) {
  useLocale();
  const confirmAction = useConfirmation(current.id);
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  const [search, setSearch] = useState('');
  const [edit, setEdit] = useState<Edit | null>(() => fork ? {
    kind: 'copy', branch: current, name: t('branches.fork_title', { turn: fork.ordinal }), through: fork.id, requestId: newId(),
  } : null);
  const [failure, setFailure] = useState<MessageText>('');
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  useLayoutEffect(() => {
    const trigger = document.activeElement;
    const node = dialog.current;
    openModal(node);
    return () => {
      node?.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus({ preventScroll: true });
    };
  }, []);

  const query = search.trim().normalize('NFC').toLowerCase();
  const visible = branches.filter(branch => branchName(branch).normalize('NFC').toLowerCase().includes(query));
  const begin = (next: Edit) => { setFailure(''); setEdit(next); };
  async function perform(action: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setFailure('');
    try { await action(); }
    catch (error) {
      setFailure(errorText(error, message('app.the_request_failed')));
      if (error instanceof ApiError && error.status === 409) await refresh();
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }
  async function save() {
    if (!edit) return;
    const { id, revision } = edit.branch;
    const route = `/chats/${encodeURIComponent(id)}`;
    if (edit.kind === 'copy') {
      const result = await api<{ id: string }>(`${route}/branches`, 'POST', {
        revision, requestId: edit.requestId, name: edit.name, through: edit.through,
      });
      open(result.id);
      return;
    }
    await api(`${route}/branch`, 'PATCH', { revision, name: edit.name });
    setEdit(null);
    await refresh();
  }
  function confirmDelete(branch: ChatSummary) {
    const { id, revision } = branch;
    confirmAction({
      confirmOnEnter: true,
      title: t('branches.delete_title'),
      message: t('branches.delete_prompt', { name: branchName(branch) }),
      actionLabel: t('branches.delete'),
      onConfirm: () => { void perform(async () => {
        const result = await api<{ id: string }>(`/chats/${encodeURIComponent(id)}/branch`, 'DELETE', { revision });
        if (!dialog.current) return;
        if (id === current.id) {
          open(result.id);
          return;
        }
        setEdit(null);
        await refresh();
      }); },
    });
  }
  function dismiss() { if (!inFlight.current) close(); }

  return createPortal(<ModalDialog ref={dialog} className={fork ? 'prompt-peek' : 'catalog-dialog chat-branches-dialog'} aria-labelledby={title}
    onDismiss={dismiss}>
    <div className={fork ? 'peek-content' : 'branch-manager-content'}>
      <header className={fork ? 'peek-heading' : 'catalog-dialog-heading'}>
        <h2 id={title}>{fork ? t('branches.fork_title', { turn: fork.ordinal }) : t('branches.title')}</h2>
        <button type="button" className={fork ? 'secondary' : 'quiet'} aria-label={t('author_note.close')} disabled={pending} onClick={dismiss}><Icon name="Close" /></button>
      </header>
      <div className={fork ? undefined : 'branch-manager-controls'}>
        {failure && <p className="error-banner" role="alert">{formatMessage(failure)}</p>}
        {edit && <form onSubmit={event => { event.preventDefault(); void perform(save); }}>
          <label>{t('branches.name')}<input required maxLength={100} disabled={pending} value={edit.name} onChange={event => {
            const name = event.target.value;
            setEdit(edit.kind === 'copy' ? { ...edit, name, requestId: newId() } : { ...edit, name });
          }} /></label>
          <div className="actions">
            <button type="submit" disabled={pending || !edit.name.trim()}>
              {t(edit.kind === 'copy' ? 'branches.create' : 'branches.rename')}
            </button>
            <button type="button" className="secondary" disabled={pending} onClick={() => { if (fork) dismiss(); else setEdit(null); }}>{t('character_import.cancel')}</button>
          </div>
        </form>}
        {!fork && <div className="branch-manager-actions">
          <LibrarySearchField label={t('branches.search')} value={search} change={setSearch} />
          <TranscriptImport destination={{ kind: 'branch', groupId: chatGroupId(current), title: current.title }} disabled={pending} created={open} />
        </div>}
      </div>
      {!fork && <div className="branch-manager-results">
        {visible.length === 0 && <p role="status">{t('branches.no_matches')}</p>}
        <div className="library-list branch-list">{visible.map(branch => <article className="library-card" key={branch.id}>
          <div className="library-card-body">
            <div className="library-card-content">
              <div className="library-card-heading">
                <h2><button type="button" className="library-card-open" aria-current={branch.id === current.id ? 'true' : undefined} disabled={pending} onClick={() => open(branch.id)}>
                  <span className="library-card-title">{branchName(branch)}</span>
                </button></h2>
                <div className="library-card-tools">
                  <ActionMenu label={t('libraries.actions_for', { name: branchName(branch) })} disabled={pending} revision={branch.revision}>
                    <button type="button" className="secondary" role="menuitem" tabIndex={-1} disabled={branch.running}
                      onClick={() => begin({ kind: 'rename', branch, name: branchName(branch) })}><Icon name="EditOutline" />{t('branches.rename')}</button>
                    <button type="button" className="secondary" role="menuitem" tabIndex={-1} disabled={branch.running || (locked && branch.id === current.id)}
                      onClick={() => begin({ kind: 'copy', branch, name: t('branches.copy_name', { name: branchName(branch) }).slice(0, 100), requestId: newId() })}><Icon name="CopyOutline" />{t('branches.duplicate')}</button>
                    <button type="button" className="secondary" role="menuitem" tabIndex={-1} onClick={() => void perform(async () => {
                      startDownload(await api(`/chats/${encodeURIComponent(branch.id)}/export`, 'POST', { revision: branch.revision }));
                    })}><Icon name="Upload" />{t('libraries.export_chat_jsonl')}</button>
                    <button type="button" className="secondary" role="menuitem" tabIndex={-1} disabled={branch.running || branches.length === 1}
                      onClick={() => confirmDelete(branch)}><Icon name="TrashOutline" />{t('branches.delete')}</button>
                  </ActionMenu>
                </div>
              </div>
              <p className="branch-row-details">
                <span>{t('counts.turns', { count: branch.turnCount })}</span>
                {branch.id === current.id && <span>{t('branches.current')}</span>}
                {branch.running && <span>{t('branches.response_running')}</span>}
                {branch.lastMessageAt && <time dateTime={branch.lastMessageAt}>{new Date(branch.lastMessageAt).toLocaleString(locale())}</time>}
              </p>
            </div>
          </div>
        </article>)}</div>
      </div>}
    </div>
  </ModalDialog>, document.body);
}
