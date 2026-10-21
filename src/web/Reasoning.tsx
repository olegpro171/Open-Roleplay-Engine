import { useTextState, errorText, t, message as msg, useLocale } from './localization';
import { Icon } from './Icon';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from './api';
import { TurnActionButton } from './TurnActionButton';

export type ReasoningProps = { text: string; live: boolean; chatId: string; generationId: string; length: number };

export function ReasoningPreview({ text }: { text: string }) {
  useLocale();
  return <div className="reasoning-preview" aria-label={t("reasoning.latest_model_reasoning")}>
    <span className="reasoning-heading">{t("reasoning.reasoning")}</span>
    <span className="reasoning-tail"><span>{text}</span></span>
  </div>;
}

export function Reasoning(props: ReasoningProps) {
  useLocale();
  const [open, setOpen] = useState(false);
  return <>
    <TurnActionButton action="reasoning" label={t("reasoning.show_reasoning")} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)} />
    {open && <ReasoningDialog {...props} close={() => setOpen(false)} />}
  </>;
}

function ReasoningDialog({ text: preview, live, chatId, generationId, length, close }: ReasoningProps & { close: () => void }) {
  useLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const stream = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useTextState('');
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
      if (current) setError(errorText(error, msg("reasoning.could_not_load_reasoning")));
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
    <header className="reasoning-dialog-heading"><h2 id={titleId}>{t("reasoning.model_reasoning")}</h2><button type="button" className="secondary" onClick={close} title={t("reasoning.close")}><Icon name="Close" /><span className="sr-only">{t("reasoning.close")}</span></button></header>
    {error && <p className="reasoning-error" role="alert">{error} <button type="button" className="quiet" onClick={() => setRetry(value => value + 1)}>{t("reasoning.retry")}</button></p>}
    <div className="reasoning-stream prose" ref={stream} tabIndex={0} aria-label={t("reasoning.model_reasoning_stream")} onScroll={() => {
      const node = stream.current;
      if (!node) return;
      following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40;
      setAwayFromLatest(!following.current);
    }}>{text ?? t("reasoning.loading_reasoning")}</div>
    <footer className="reasoning-dialog-footer"><span>{live ? t("reasoning.live_reasoning") : t("reasoning.saved_reasoning")}</span>{awayFromLatest && <button type="button" className="quiet" onClick={latest}>{t("reasoning.latest_reasoning")}<Icon name="ArrowLongBottom" /></button>}</footer>
  </dialog>, document.body);
}
