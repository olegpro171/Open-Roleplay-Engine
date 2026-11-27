import { openModal } from './dialog-focus';
import { ModalDialog } from './ModalDialog';
import { useTextState, errorText, t, message as msg, useLocale } from './localization';
import { Icon } from './Icon';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from './api';
import { ScrollFollow } from './scroll-follow';

export type ReasoningProps = { text: string; live: boolean; chatId: string; generationId: string; length: number };

export function GenerationProgress({ streaming, preparing, reasoning }: {
  streaming: boolean; preparing?: boolean; reasoning?: boolean;
}) {
  useLocale();
  return <>{!streaming && <span className="muted" role="status">
    {t(preparing ? 'app.preparing_memory' : reasoning ? 'app.reasoning' : 'app.waiting_for_first_token')}
  </span>}<span className="cursor" aria-label={t('app.generating')} /></>;
}

export function ReasoningPreview({ text }: { text: string }) {
  useLocale();
  return <div className="reasoning-preview" aria-label={t("reasoning.latest_model_reasoning")}>
    <span className="reasoning-heading">{t("reasoning.reasoning")}</span>
    <span className="reasoning-tail"><span>{text.replace(/(?:\r\n|[\r\n]){1,2}$/, '')}</span></span>
  </div>;
}

export function ReasoningDialog({ text: preview, live, chatId, generationId, length, close }: ReasoningProps & { close: () => void }) {
  useLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const stream = useRef<HTMLDivElement>(null);
  const follow = useRef(new ScrollFollow()).current;
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
    if (stream.current) follow.scrollToEnd(stream.current);
    setAwayFromLatest(false);
  }
  useLayoutEffect(() => openModal(dialog.current), []);
  useLayoutEffect(() => {
    const node = stream.current;
    if (!node) return;
    follow.readMovement(node);
    if (follow.following) follow.scrollToEnd(node);
    setAwayFromLatest(!follow.following);
  }, [follow, text]);

  return createPortal(<ModalDialog ref={dialog} className="reasoning-dialog" aria-labelledby={titleId} onDismiss={close}>
    <header className="reasoning-dialog-heading"><h2 id={titleId}>{t("reasoning.model_reasoning")}</h2><button type="button" className="secondary" onClick={close} title={t("reasoning.close")}><Icon name="Close" /><span className="sr-only">{t("reasoning.close")}</span></button></header>
    {error && <p className="reasoning-error" role="alert">{error} <button type="button" className="quiet" onClick={() => setRetry(value => value + 1)}>{t("reasoning.retry")}</button></p>}
    <div className="reasoning-stream prose" ref={stream} tabIndex={0} aria-label={t("reasoning.model_reasoning_stream")} onScroll={event => {
      if (follow.readMovement(event.currentTarget)) setAwayFromLatest(!follow.following);
    }}>{text ?? t("reasoning.loading_reasoning")}</div>
    <footer className="reasoning-dialog-footer"><span>{live ? t("reasoning.live_reasoning") : t("reasoning.saved_reasoning")}</span>{awayFromLatest && <button type="button" className="quiet" onClick={latest}>{t("reasoning.latest_reasoning")}<Icon name="ArrowLongBottom" /></button>}</footer>
  </ModalDialog>, document.body);
}
