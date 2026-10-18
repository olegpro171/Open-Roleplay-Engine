import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from './api';

type ReasoningProps = { text: string; live: boolean; chatId: string; generationId: string; length: number };

export function Reasoning(props: ReasoningProps) {
  const [open, setOpen] = useState(false);
  return <div className="reasoning">
    <button type="button" className="reasoning-preview" aria-label="View model reasoning" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
      <span className="reasoning-heading">Reasoning <span aria-hidden="true">↗</span></span>
      <span className="reasoning-tail" aria-hidden="true"><span>{props.text}</span></span>
    </button>
    {open && <ReasoningDialog {...props} close={() => setOpen(false)} />}
  </div>;
}

function ReasoningDialog({ text: preview, live, chatId, generationId, length, close }: ReasoningProps & { close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const stream = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const titleId = useId();

  useEffect(() => {
    let current = true;
    api<{ text: string }>(`/chats/${chatId}/generations/${generationId}/reasoning`).then(result => {
      if (current) {
        setText(result.text);
        setError('');
      }
    }).catch(error => {
      if (current) setError(error instanceof Error ? error.message : 'Could not load reasoning.');
    });
    return () => { current = false; };
  }, [chatId, generationId, preview, length, live, retry]);

  function latest() {
    following.current = true;
    if (stream.current) stream.current.scrollTop = stream.current.scrollHeight;
    setAwayFromLatest(false);
  }
  useLayoutEffect(() => {
    const trigger = document.activeElement;
    const node = dialog.current;
    node?.showModal();
    return () => {
      node?.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, []);
  useLayoutEffect(() => {
    if (following.current) latest();
  }, [text]);

  return createPortal(<dialog ref={dialog} className="reasoning-dialog" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); close(); }}>
    <header className="reasoning-dialog-heading"><h2 id={titleId}>Model reasoning</h2><button type="button" className="secondary" onClick={close}>Close</button></header>
    {error && <p className="reasoning-error" role="alert">{error} <button type="button" className="quiet" onClick={() => setRetry(value => value + 1)}>Retry</button></p>}
    <div className="reasoning-stream prose" ref={stream} tabIndex={0} aria-label="Model reasoning stream" onScroll={() => {
      const node = stream.current;
      if (!node) return;
      following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40;
      setAwayFromLatest(!following.current);
    }}>{text ?? 'Loading reasoning…'}</div>
    <footer className="reasoning-dialog-footer"><span>{live ? 'Live reasoning' : 'Saved reasoning'}</span>{awayFromLatest && <button type="button" className="quiet" onClick={latest}>Latest reasoning ↓</button>}</footer>
  </dialog>, document.body);
}
