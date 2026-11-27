import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { impersonateSchema, type SuggestionChoice } from '../shared/contracts';
import type { StoryGeneration, StorySuggestion } from '../shared/transcript';
import { api } from './api';
import { errorText, formatMessage, t, useLocale, type MessageText } from './localization';
import { newId } from './uuid';
import { GenerationProgress, ReasoningPreview } from './Reasoning';
import { VariantSelector } from './ResponseVariants';
import { TurnActionButton } from './TurnActionButton';
import { ScrollFollow } from './scroll-follow';
import { stagedCommand } from './staged-command';

export function impersonate(chatId: string, revision: number, draft: string, sessionId = newId(), observedRequestId?: string) {
  return stagedCommand('impersonate', chatId, impersonateSchema,
    () => ({ requestId: newId(), sessionId, revision, draft }), command =>
      api(`/chats/${encodeURIComponent(chatId)}/impersonate`, 'POST', command, AbortSignal.timeout(8000)), observedRequestId);
}

export function SuggestionPanel({ chatId, attempt, generation, showReasoning, draft, canGenerate, canReplace,
  replace, retry, stop, dismiss, preparing, actionsBlocked }: {
  chatId: string; generation?: StoryGeneration; showReasoning: boolean; attempt: StorySuggestion;
  draft: string; canGenerate: boolean; canReplace: boolean; replace: (text: string) => Promise<boolean>;
  retry: () => void; stop: () => void; dismiss: () => void; preparing: boolean; actionsBlocked: boolean;
}) {
  useLocale();
  const session = attempt.sessionId;
  const [selected, select] = useState<{ attempt: string; number: number }>();
  const [version, reload] = useState(0);
  const [loaded, setLoaded] = useState<{ request: string; choice: SuggestionChoice | null }>();
  const [failure, setFailure] = useState<{ request: string; error: MessageText }>();
  const [streamed, setStreamed] = useState<{ attemptId: string; text: string }>();
  const content = useRef<HTMLDivElement>(null);
  const follow = useRef(new ScrollFollow()).current;
  const lastView = useRef<string | null>(null);
  const running = attempt.status === 'running';
  const number = selected?.attempt === attempt.id ? selected.number : attempt.completedCount;
  const request = [attempt.id, attempt.status, number, version].join(':');
  useEffect(() => {
    if (running || !number) return;
    const controller = new AbortController();
    const path = `/chats/${encodeURIComponent(chatId)}/suggestions/${encodeURIComponent(session)}`;
    api<SuggestionChoice | null>(path + '?version=' + number, 'GET', undefined, controller.signal)
      .then(choice => { if (!controller.signal.aborted) setLoaded({ request, choice }); })
      .catch(reason => { if (!controller.signal.aborted) setFailure({ request, error: errorText(reason) }); });
    return () => controller.abort();
  }, [request, chatId, session, number, running]);
  async function apply(text: string) {
    const composer = document.getElementById('turn-input');
    if (!await replace(text)) return;
    if (composer?.isConnected) composer.focus();
  }
  const choice = loaded?.choice;
  const ready = !number || loaded?.request === request;
  const error = !ready && failure?.request === request ? failure.error : undefined;
  const total = attempt.completedCount + Number(running);
  const activeNumber = running ? total : number;
  const visibleChoice = choice?.number === activeNumber ? choice : null;
  const partial = generation?.partialText ?? '';
  const reasoning = generation?.reasoningText?.trim() ? generation.reasoningText : '';
  // Story can report success before the separate read of the saved choice returns.
  if (partial && (streamed?.attemptId !== attempt.id || streamed.text !== partial)) {
    setStreamed({ attemptId: attempt.id, text: partial });
  }
  const awaitingSavedText = attempt.status === 'succeeded' && !ready && number === attempt.completedCount;
  const text = running ? partial : visibleChoice?.text
    ?? (awaitingSavedText && streamed?.attemptId === attempt.id ? streamed.text : '');
  const preview = running && showReasoning && !partial ? reasoning : '';
  const loadingText = awaitingSavedText && !text && !error;
  // A live slot and its saved version share their reading position.
  const view = `${attempt.id}:${activeNumber}`;
  useLayoutEffect(() => {
    const node = content.current;
    if (!node) return;
    if (lastView.current !== view) {
      lastView.current = view;
      follow.following = running;
      node.scrollTop = 0;
      follow.rememberPosition(node);
    } else follow.readMovement(node);
    if (follow.following) follow.scrollToEnd(node);
  }, [follow, view, running, text, preview, loadingText]);

  const canApply = ready && visibleChoice && !actionsBlocked && canReplace && !running && visibleChoice.text !== draft;
  const nextAction = error ? { label: t('app.retry_loading'), run: () => reload(v => v + 1) }
    : ready && canGenerate && activeNumber === total ? { label: t('impersonate.generate'), run: retry } : undefined;

  return <section className="suggestion-panel" aria-label={t('impersonate.title')}>
    <strong>{t('impersonate.title')}</strong>
    <div className="suggestion-content" ref={content} tabIndex={0} onScroll={event => follow.readMovement(event.currentTarget)}>
      {preview && <ReasoningPreview text={preview} />}
      {!running && attempt.status !== 'succeeded' && <p className="muted" role="status">{formatMessage(attempt.errorMessage ?? attempt.error)}</p>}
      <div className="suggestion-prose">
        {text}{running && <GenerationProgress streaming={Boolean(partial)} preparing={preparing} reasoning={Boolean(reasoning)} />}
        {loadingText && <span className="muted" role="status">{t('impersonate.loading')}</span>}
      </div>
      {error && <p role="alert">{formatMessage(error)}</p>}
    </div>
    <div className="turn-controls suggestion-controls">
      <VariantSelector kind="suggestion" number={activeNumber} total={total} selectionIdentity={request}
        locked={running || (!ready && !error)} nextAction={nextAction}
        choose={number => select({ attempt: attempt.id, number })} />
      <div className="turn-actions">
        <TurnActionButton action="cancel" label={t('character_import.cancel')} aria-hidden={!running || undefined}
          disabled={!running || actionsBlocked} onClick={stop} />
        <TurnActionButton action="apply" label={t(draft ? 'impersonate.replace' : 'impersonate.use')}
          alternateLabel={t(draft ? 'impersonate.use' : 'impersonate.replace')} disabled={!canApply}
          onClick={() => { if (visibleChoice) void apply(visibleChoice.text); }} />
        <TurnActionButton action="dismiss" label={t('app.dismiss')} disabled={running || actionsBlocked} onClick={dismiss} />
      </div>
    </div>
  </section>;
}
