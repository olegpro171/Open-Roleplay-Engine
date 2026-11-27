import { useEffect, useState } from 'react';
import { impersonateSchema, type SuggestionChoice } from '../shared/contracts';
import type { StoryGeneration, StorySuggestion } from '../shared/transcript';
import { api, datasetEpoch } from './api';
import { errorText, formatMessage, t, useLocale, type MessageText } from './localization';
import { newId } from './uuid';
import { GenerationProgress, ReasoningPreview } from './Reasoning';
import { VariantSelector } from './ResponseVariants';
import { TurnActionButton } from './TurnActionButton';
import { stagedCommand } from './staged-command';

export function impersonate(chatId: string, revision: number, draft: string, sessionId = newId(), observedRequestId?: string) {
  return stagedCommand('impersonate', chatId, impersonateSchema,
    () => ({ requestId: newId(), sessionId, revision, draft }), command =>
      api(`/chats/${encodeURIComponent(chatId)}/impersonate`, 'POST', command, AbortSignal.timeout(8000)), observedRequestId);
}

const dismissedSessions = new Map<string, string>();
const dismissalKey = (chatId: string) => `ore-dismiss-suggestion:${datasetEpoch()}:${chatId}`;

export function dismissSuggestion(chatId: string, session: string) {
  const key = dismissalKey(chatId);
  dismissedSessions.set(key, session);
  try { sessionStorage.setItem(key, session); } catch { /* Keep the choice in memory. */ }
}

export function SuggestionPanel({ chatId, attempt, generation, showReasoning, stale, draft, disabled, canReplace,
  replace, retry, stop, preparing, cancelDisabled }: {
  chatId: string; generation?: StoryGeneration; showReasoning: boolean; attempt: StorySuggestion; stale: boolean;
  draft: string; disabled: boolean; canReplace: boolean; replace: (text: string) => Promise<boolean>;
  retry: () => void; stop: () => void; preparing: boolean; cancelDisabled: boolean;
}) {
  useLocale();
  const session = attempt.sessionId;
  const key = dismissalKey(chatId);
  const [dismissed, setDismissed] = useState(() => {
    if (dismissedSessions.has(key)) return dismissedSessions.get(key);
    try { return sessionStorage.getItem(key); } catch { return null; }
  });
  const [selected, select] = useState<{ attempt: string; number: number }>();
  const [version, reload] = useState(0);
  const [loaded, setLoaded] = useState<{ request: string; choice: SuggestionChoice | null }>();
  const [failure, setFailure] = useState<{ request: string; error: MessageText }>();
  const running = attempt.status === 'running';
  const hidden = dismissed === session || dismissedSessions.get(key) === session;
  const number = selected?.attempt === attempt.id ? selected.number : attempt.completedCount;
  const request = [attempt.id, attempt.status, number, version].join(':');
  useEffect(() => {
    if (hidden || running || !number) return;
    const controller = new AbortController();
    const path = `/chats/${encodeURIComponent(chatId)}/suggestions/${encodeURIComponent(session)}`;
    api<SuggestionChoice | null>(path + '?version=' + number, 'GET', undefined, controller.signal)
      .then(choice => { if (!controller.signal.aborted) setLoaded({ request, choice }); })
      .catch(reason => { if (!controller.signal.aborted) setFailure({ request, error: errorText(reason) }); });
    return () => controller.abort();
  }, [request, chatId, session, number, hidden, running]);
  if (hidden) return null;
  function dismiss() {
    setDismissed(session);
    dismissSuggestion(chatId, session);
  }
  async function apply(text: string) {
    const composer = document.getElementById('turn-input');
    if (!await replace(text)) return;
    dismiss();
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
  const canApply = ready && visibleChoice && !disabled && canReplace && !running && !stale && visibleChoice.text !== draft;
  const nextAction = error ? { label: t('app.retry_loading'), run: () => reload(v => v + 1) }
    : ready && !disabled && activeNumber === total ? { label: t('impersonate.generate'), run: retry } : undefined;

  return <section className="suggestion-panel" aria-label={t('impersonate.title')}>
    <strong>{t('impersonate.title')}</strong>
    <div className="suggestion-content">
      {running ? <>
        {showReasoning && reasoning && !partial && <ReasoningPreview text={reasoning} />}
        <div className="suggestion-prose">{partial}<GenerationProgress streaming={Boolean(partial)} preparing={preparing} reasoning={Boolean(reasoning)} /></div>
      </> : <>
        {attempt.status !== 'succeeded' && <p className="muted" role="status">{formatMessage(attempt.errorMessage ?? attempt.error)}</p>}
        {stale && <p className="muted" role="status">{t('impersonate.stale')}</p>}
        {visibleChoice && <div className="suggestion-prose">{visibleChoice.text}</div>}
      </>}
      {error && <p role="alert">{formatMessage(error)}</p>}
    </div>
    <div className="turn-controls suggestion-controls">
      <VariantSelector kind="suggestion" number={activeNumber} total={total} selectionIdentity={request}
        locked={running || (!ready && !error)} nextAction={nextAction}
        choose={number => select({ attempt: attempt.id, number })} />
      <div className="turn-actions">
        <TurnActionButton action="cancel" label={t('character_import.cancel')} aria-hidden={!running || undefined}
          disabled={!running || cancelDisabled} onClick={stop} />
        <TurnActionButton action="apply" label={t(draft ? 'impersonate.replace' : 'impersonate.use')}
          alternateLabel={t(draft ? 'impersonate.use' : 'impersonate.replace')} disabled={!canApply}
          onClick={() => { if (visibleChoice) void apply(visibleChoice.text); }} />
        <TurnActionButton action="dismiss" label={t('app.dismiss')} disabled={running} onClick={dismiss} />
      </div>
    </div>
  </section>;
}
