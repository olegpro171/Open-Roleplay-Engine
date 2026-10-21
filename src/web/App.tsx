import type { MessageText } from './localization';
import { LocalizedError, formatMessage, useTextState, errorText, t, message as msg, useLocale, locale } from './localization';
import { appearanceStatusSchema, defaultAppearance, type AppearanceStatus } from '../shared/appearance';
import { newId } from './uuid';
import { Icon } from './Icon';
import { ApplicationSettings } from './ApplicationSettings';
import { useConfirmation } from './Confirmation';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { ChatSnapshot, RequestPreview } from '../shared/contracts';
import { api, ApiError, datasetChanged } from './api';
import { hasPromptMarker, type LibrarySnapshot, type UnchangedLibrary } from '../shared/library';
import { ChatSetup, Libraries, type LibraryTarget } from './Libraries';
import { Dropdown } from './Controls';
import { trimBoundaryNewlines } from '../shared/text';
import { Memory } from './Memory';
import { transcriptInitialSize, transcriptBatchSize, transcriptWindowLimit, type StorySnapshot } from '../shared/transcript';
import { BudgetBreakdown, InputMeter, PromptPeek, LoreInspection } from './PromptPeek';
import { useTranscriptScroll } from './useTranscriptScroll';
import { useChatDraft } from './useChatDraft';
import { TurnControls } from './TurnControls';
import { ReasoningPreview } from './Reasoning';
import { ChatMarkdown } from './ChatMarkdown';
import { ChatTextarea } from './ChatTextarea';
import { ChatDetailsTarget, ChatWorkspace } from './ChatWorkspace';

type Session = { setupRequired: boolean; authenticated: boolean };
type Edit = { turnId: string; part: 'user' | 'assistant'; text: string; revision: number };
const serverUnavailable = msg("app.cannot_reach_the_server_check_that_it");
function lastChat() {
  try { return localStorage.getItem('roleplay-chat') ?? 'main'; }
  catch { return 'main'; }
}
function rememberChat(id: string | null) {
  try {
    if (id) localStorage.setItem('roleplay-chat', id);
    else localStorage.removeItem('roleplay-chat');
  } catch { /* Selection is optional; the composer separately reports draft storage failures. */ }
}

export function App() {
  useLocale();
  const [dataChanged, setDataChanged] = useState(false);
  useEffect(() => { const changed = () => setDataChanged(true); window.addEventListener('ore-dataset-changed', changed); return () => window.removeEventListener('ore-dataset-changed', changed); }, []);
  const [session, setSession] = useState<Session | null>(null);
  const [chatId, setChatId] = useState<string | null>(lastChat);
  const [appearance, setAppearance] = useState<AppearanceStatus>({ revision: 0, settings: defaultAppearance });
  const [appearanceError, setAppearanceError] = useTextState(null);
  const [library, setLibrary] = useState<LibrarySnapshot | null>(null);
  const libraryCache = useRef<LibrarySnapshot | null>(null);
  const [snapshot, setSnapshot] = useState<StorySnapshot | null>(null);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const [toolSnapshot, setToolSnapshot] = useState<ChatSnapshot | null>(null);
  const [toolError, setToolError] = useTextState('');
  const [toolRetry, setToolRetry] = useState(0);
  const [pageLoading, setPageLoading] = useState(false);
  const pageBusy = useRef(false);
  const pageRequest = useRef<AbortController | null>(null);
  const refreshPending = useRef(false);
  const forceLatest = useRef(false);
  const [pageError, setPageError] = useTextState('');
  const [error, setError] = useTextState('');
  const [online, setOnline] = useState(false);
  const [tab, setTab] = useState<'story' | 'settings' | 'request' | 'library' | 'memory' | 'data'>('story');
  const [libraryTarget, setLibraryTarget] = useState<LibraryTarget | null>(null);
  const confirmAction = useConfirmation(`${chatId}:${tab}:${session?.authenticated}`);
  const drafts = useChatDraft(chatId);
  const draft = drafts.text;
  const [settledDraft, setSettledDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState<Edit | null>(null);
  const [peek, setPeek] = useState(false);
  const [contextExpanded, setContextExpanded] = useState(false);
  const [chatDetailsTarget, setChatDetailsTarget] = useState<HTMLDivElement | null>(null);
  const [generationId, setGenerationId] = useState('');
  const loadId = useRef(0);
  const { transcript, awayFromLatest, scrollToLatest, preservePosition, followingLatest } = useTranscriptScroll(tab === 'story' ? snapshot?.id ?? null : null, snapshot, edit);
  const clearServerError = useCallback(() => setError(current => formatMessage(current) === formatMessage(serverUnavailable) ? '' : current), []);
  const refreshSession = useCallback(async () => {
    try { setSession(await api<Session>('/session')); clearServerError(); } catch { setError(serverUnavailable); }
  }, [clearServerError]);
  const editRef = useRef(edit);
  editRef.current = edit;
  const refresh = useCallback(async () => {
    if (pageBusy.current) { refreshPending.current = true; return; }
    const id = ++loadId.current;
    try {
      const cached = libraryCache.current;
      const [update, appearanceResult] = await Promise.all([
        api<LibrarySnapshot | UnchangedLibrary>(`/library${cached ? `?knownRevision=${cached.revision}` : ''}`),
        api<unknown>('/application/appearance')
          .then(value => ({ value: appearanceStatusSchema.parse(value), error: null }))
          .catch(error => ({ value: null, error: errorText(error, msg("app.chat_appearance_could_not_be_loaded")) })),
      ]);
      // Keep existing editors/transcript available to copy after a dataset replacement.
      if (datasetChanged()) return;
      let items: LibrarySnapshot;
      if ('unchanged' in update) {
        if (!cached || cached.revision !== update.revision) throw new LocalizedError(msg("app.library_refresh_has_no_matching_saved_version"));
        items = { ...cached, chats: update.chats };
      } else items = update;
      const selected = items.chats.find(chat => chat.id === chatId)?.id ?? items.chats[0]?.id ?? null;
      const current = forceLatest.current ? null : snapshotRef.current;
      const keepWindow = current?.id === selected && (current.page.hasNewer || !followingLatest() || Boolean(editRef.current));
      const parameters = new URLSearchParams({ limit: String(current?.id === selected ? Math.max(transcriptInitialSize, current.page.turns.length) : transcriptInitialSize) });
      const first = current?.page.turns[0];
      if (keepWindow && first) parameters.set('anchor', first.id);
      let state: StorySnapshot | null;
      let windowReset = false;
      try { state = selected ? await api<StorySnapshot>(`/chats/${selected}/story?${parameters}`) : null; }
      catch (error) {
        if (id !== loadId.current) return;
        if (!(error instanceof ApiError) || error.status !== 409 || !selected) throw error;
        state = await api<StorySnapshot>(`/chats/${selected}/story`);
        windowReset = true;
      }
      if (id === loadId.current && !datasetChanged()) {
        libraryCache.current = items;
        forceLatest.current = false;
        preservePosition(Boolean(current?.page.hasNewer));
        if (windowReset) {
          scrollToLatest();
          setPageError(msg("app.the_displayed_history_was_removed_or_replaced"));
        }
        snapshotRef.current = state;
        setSnapshot(state);
        setLibrary(items);
        // A settings save can commit while this refresh is waiting for chat state.
        if (appearanceResult.value) {
          const nextAppearance = appearanceResult.value;
          setAppearance(current => nextAppearance.revision >= current.revision ? nextAppearance : current);
        }
        setAppearanceError(appearanceResult.error);
        clearServerError();
        if (selected !== chatId) {
          setChatId(selected); setEdit(null); setPeek(false); setGenerationId('');
          rememberChat(selected);
        }
        if (!selected) setTab(current => current === 'data' ? current : 'library');
      }
    } catch (error) {
      if (id !== loadId.current) return;
      if (error instanceof ApiError && error.status === 401) void refreshSession();
      else if (error instanceof ApiError && error.status === 404) { setChatId(null); }
      else setError(error instanceof ApiError ? errorText(error) : serverUnavailable);
    }
  }, [refreshSession, chatId, clearServerError]);
  const latestRefresh = useRef(refresh);
  latestRefresh.current = refresh;
  const selectedChat = useRef(chatId);
  selectedChat.current = chatId;
  useEffect(() => { void refreshSession(); }, [refreshSession]);
  useEffect(() => {
    if (error !== formatMessage(serverUnavailable)) return;
    let checking = false;
    const timer = setInterval(() => {
      if (!checking) { checking = true; void refreshSession().finally(() => { checking = false; }); }
    }, 2_000);
    return () => clearInterval(timer);
  }, [error, refreshSession]);
  useEffect(() => {
    if (!session?.authenticated) return;
    void refresh();
    const events = new EventSource('/api/events');
    events.onopen = () => { setOnline(true); clearServerError(); void refresh(); };
    events.onmessage = () => { void refresh(); };
    events.onerror = () => { setOnline(false); void refreshSession(); };
    const visible = () => { if (document.visibilityState === 'visible') { void refreshSession(); void refresh(); } };
    document.addEventListener('visibilitychange', visible);
    return () => { events.close(); setOnline(false); document.removeEventListener('visibilitychange', visible); };
  }, [session?.authenticated, refresh, refreshSession, clearServerError]);

  useEffect(() => {
    const timer = setTimeout(() => setSettledDraft(draft), 1_000);
    return () => clearTimeout(timer);
  }, [draft]);

  useEffect(() => { setPeek(false); setGenerationId(''); }, [snapshot?.id]);
  useEffect(() => {
    if (!snapshot || !['settings', 'memory', 'request'].includes(tab)) {
      setToolSnapshot(null);
      setToolError('');
      return;
    }
    const controller = new AbortController();
    setToolError('');
    void api<ChatSnapshot>(`/chats/${snapshot.id}`, 'GET', undefined, controller.signal).then(value => {
      if (!controller.signal.aborted && !datasetChanged()) setToolSnapshot(value);
    }).catch(error => { if (!controller.signal.aborted) setToolError(errorText(error, msg("app.cannot_load_chat_tools"))); });
    return () => controller.abort();
  }, [tab, snapshot, toolRetry]);

  useEffect(() => {
    return () => { pageRequest.current?.abort(); };
  }, [chatId, tab, session?.authenticated]);
  useEffect(() => { if (dataChanged) pageRequest.current?.abort(); }, [dataChanged]);

  async function moveTranscript(direction: 'older' | 'newer' | 'latest', automatic = false) {
    const current = snapshotRef.current;
    if (!current || pageBusy.current || editRef.current || datasetChanged()) return;
    if (automatic && (document.activeElement?.closest('[data-turn-id]') || document.querySelector('dialog[open]'))) return;
    if (direction === 'older' && !current.page.hasOlder || direction === 'newer' && !current.page.hasNewer) return;
    const parameters = new URLSearchParams();
    if (direction !== 'latest') {
      const first = current.page.turns[0];
      if (!first) return;
      parameters.set('anchor', first.id);
      parameters.set('shift', String(direction === 'older' ? -transcriptBatchSize : transcriptBatchSize));
      parameters.set('limit', String(Math.min(transcriptWindowLimit, current.page.turns.length + transcriptBatchSize)));
      parameters.set('revision', String(current.revision));
    }
    const id = ++loadId.current;
    const controller = new AbortController();
    pageRequest.current = controller;
    pageBusy.current = true;
    setPageLoading(true);
    setPageError('');
    try {
      let state = await api<StorySnapshot>(`/chats/${current.id}/story?${parameters}`, 'GET', undefined, controller.signal);
      // Notifications received during a page load may invalidate its captured revision.
      // Recheck that same revision before presenting a delayed page; stream-only
      // notifications remain compatible and reconcile the latest partial output.
      if (refreshPending.current && direction !== 'latest') {
        state = await api<StorySnapshot>(`/chats/${current.id}/story?${parameters}`, 'GET', undefined, controller.signal);
      }
      if (id !== loadId.current || controller.signal.aborted || datasetChanged() || editRef.current) return;
      const focusedTurnId = document.activeElement?.closest<HTMLElement>('[data-turn-id]')?.dataset.turnId;
      if (document.querySelector('dialog[open]') || (focusedTurnId && !state.page.turns.some(turn => turn.id === focusedTurnId))) return;
      preservePosition(direction !== 'latest');
      if (direction === 'latest') scrollToLatest();
      snapshotRef.current = state;
      setSnapshot(state);
    } catch (error) {
      if (id !== loadId.current || controller.signal.aborted) return;
      setPageError(errorText(error, msg("app.cannot_load_this_part_of_the_story")));
      if (error instanceof ApiError && error.status === 409) refreshPending.current = true;
      if (error instanceof ApiError && error.status === 401) void refreshSession();
    } finally {
      if (id === loadId.current) {
        pageBusy.current = false;
        setPageLoading(false);
        if (refreshPending.current) {
          refreshPending.current = false;
          void latestRefresh.current();
        }
      }
    }
  }
  const moveRef = useRef(moveTranscript);
  moveRef.current = moveTranscript;
  useEffect(() => {
    const root = transcript.current;
    if (!root || tab !== 'story' || !snapshot || edit || pageError) return;
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) {
        const direction = entry.target.getAttribute('data-history-direction');
        if (direction === 'older' || direction === 'newer') void moveRef.current(direction, true);
      }
    }, { root, rootMargin: '160px 0px' });
    for (const sentinel of root.querySelectorAll('[data-history-direction]')) observer.observe(sentinel);
    return () => observer.disconnect();
  }, [tab, snapshot?.id, snapshot?.page, edit, pageError]);

  const active = snapshot?.latestGeneration?.status === 'running' ? snapshot.latestGeneration : undefined;
  const preparing = snapshot?.preparing;
  const working = Boolean(active || preparing);
  const summariesEnabled = hasPromptMarker(snapshot?.sources.prompt, 'summary');
  const memoryStale = summariesEnabled && Boolean(snapshot?.memory.stale);
  const pending = snapshot?.latestTurn?.complete === false;
  const latest = snapshot?.latestGeneration;
  const currentToolSnapshot = toolSnapshot?.id === snapshot?.id ? toolSnapshot : null;
  const shownGeneration = currentToolSnapshot?.generations.find((generation) => generation.id === generationId);
  const [inspection, setInspection] = useState<{ chatId: string | null; key: string; request: RequestPreview | null; error: MessageText }>({ chatId: null, key: '', request: null, error: '' });
  const inspectionKey = JSON.stringify([snapshot?.id, snapshot?.revision, snapshot?.memory.revision, snapshot?.connection, draft, pending]);
  useEffect(() => {
    if (!snapshot?.connection || (!pending && draft !== settledDraft)) return;
    let current = true;
    api<RequestPreview>(`/chats/${snapshot.id}/preview`, 'POST', { revision: snapshot.revision, inspection: true, ...(!pending ? { text: draft } : {}) })
      .then(request => { if (current) setInspection({ chatId: snapshot.id, key: inspectionKey, request, error: '' }); })
      .catch(error => { if (current) setInspection(previous => ({ chatId: snapshot.id, key: inspectionKey, request: previous.chatId === snapshot.id ? previous.request : null, error: errorText(error) })); });
    return () => { current = false; };
  }, [inspectionKey, settledDraft]);
  const currentRequest = snapshot?.connection && inspection.chatId === snapshot.id ? inspection.request : null;
  const inspectionCurrent = inspection.key === inspectionKey && !inspection.error;
  const inspectionError = inspection.key === inspectionKey ? formatMessage(inspection.error) : currentRequest ? '' : snapshot?.connection ? t("app.counting_current_input") : '';
  const [savedInspection, setSavedInspection] = useState<{ chatId: string; generationId: string; request: RequestPreview | null; error: MessageText } | null>(null);
  const savedRequestPresent = Boolean(shownGeneration?.request);
  useEffect(() => {
    if (!snapshot || !generationId || !savedRequestPresent) return;
    let current = true;
    api<RequestPreview | null>(`/chats/${snapshot.id}/generations/${generationId}/request`).then(request => {
      if (current) setSavedInspection({ chatId: snapshot.id, generationId, request, error: '' });
    }).catch(error => { if (current) setSavedInspection({ chatId: snapshot.id, generationId, request: null, error: errorText(error) }); });
    return () => { current = false; };
  }, [snapshot?.id, generationId, savedRequestPresent]);
  const matchingSavedInspection = savedInspection?.chatId === snapshot?.id && savedInspection?.generationId === generationId ? savedInspection : null;
  const shownRequest = generationId ? matchingSavedInspection?.request ?? shownGeneration?.request : currentRequest;
  const activeTurns = currentRequest?.history?.verbatimTurnIds.filter(id => id !== 'draft').length ?? (snapshot ? snapshot.totalTurns - snapshot.memory.archivedCount : 0);
  const inputLimit = currentRequest ? Math.min(currentRequest.budget.targetInputTokens, currentRequest.budget.contextWindow - currentRequest.budget.reservedOutputTokens) : 0;
  const generationById = new Map(snapshot?.page.generations.map(generation => [generation.id, generation]));
  const turnUsage = new Map(snapshot?.page.turns.flatMap(turn => {
    const variant = turn.variants?.find(item => item.id === turn.assistant.variantId);
    const generation = variant?.generationId ? generationById.get(variant.generationId) : undefined;
    return generation ? [[turn.id, generation.usage] as const] : [];
  }));
  const partial = active?.partialText ?? (pending ? latest?.partialText : '');

  async function command(action: () => Promise<unknown>): Promise<boolean> {
    setBusy(true); setError('');
    try { await action(); await refresh(); return true; }
    catch (error) {
      setError(errorText(error, msg("app.the_request_failed")));
      await refresh(); return false;
    } finally { setBusy(false); }
  }
  async function send(event: FormEvent) {
    event.preventDefault();
    const text = trimBoundaryNewlines(draft);
    if (!snapshot || busy || pending || dataChanged || drafts.needsReview || !text.trim()) return;
    const id = snapshot.id;
    const sent = drafts.stage(id, snapshot.revision);
    setBusy(true); setError('');
    try {
      await api(`/chats/${id}/turns`, 'POST', sent.submission);
      drafts.acknowledge(id, sent);
      if (selectedChat.current === id) { setPeek(false); scrollToLatest(); forceLatest.current = true; }
    } catch (error) {
      // A server rejection is definite; a lost response is ambiguous, so retain its request identity.
      if (error instanceof ApiError && error.status < 500) drafts.reject(id, sent);
      setError(errorText(error, msg("app.the_request_failed")));
    } finally {
      setBusy(false);
      await latestRefresh.current();
    }
  }

  async function saveEdit(event: FormEvent) {
    event.preventDefault();
    if (!edit) return;
    if (await command(() => api(`/chats/${chatId}/turns/${edit.turnId}/${edit.part}`, 'PATCH', { revision: edit.revision, text: edit.text }))) setEdit(null);
  }

  if (!session) return <main className="login"><p>{t("app.opening_ore")}</p>{error && <p role="alert">{error}</p>}</main>;
  if (!session.authenticated) return <Login session={session} onLogin={async () => { setError(''); await refreshSession(); }} />;
  function openChat(id: string, destination: 'story' | 'settings' = 'story') {
    loadId.current++;
    pageRequest.current?.abort();
    pageBusy.current = false;
    setPageLoading(false);
    setPageError('');
    rememberChat(id);
    setChatId(id);
    setTab(destination);
    setEdit(null);
    setPeek(false);
    setGenerationId('');
    if (id !== chatId) {
      snapshotRef.current = null;
      setSnapshot(null);
      setToolSnapshot(null);
    }
  }
  if (!library) return <main className="login"><p>{t("app.loading_your_story")}</p>{error && <p role="alert">{error}</p>}</main>;
  const selectedCharacter = library.characters.find(character => character.id === snapshot?.settings.characterId);
  const selectedPersona = library.personas.find(persona => persona.id === snapshot?.settings.personaId);
  const selectedCharacterName = selectedCharacter?.name ?? snapshot?.sources.character?.name ?? t("app.character");
  const selectedPersonaName = selectedPersona?.name ?? snapshot?.sources.persona?.name ?? t("app.you");

  const sidebar = snapshot && <>
        <p className="eyebrow">{t("app.current_chat")}</p><h1>{snapshot.settings.title}</h1>
        <p>{snapshot.connection ? `${snapshot.connection.name} · ${snapshot.connection.model}` : t("app.set_up_a_connection_to_begin")}</p>
        <dl><div><dt>{t("app.total_turns")}</dt><dd>{snapshot.totalTurns}</dd></div><div title={t("app.saved_turns_kept_verbatim_in_the_current")}><dt>{t("app.active_turns")}</dt><dd>{activeTurns}</dd></div><div><dt>{t("app.input_target")}</dt><dd>{snapshot.settings.targetInputTokens.toLocaleString(locale())}</dd></div><div><dt>{t("app.estimated_input")}</dt><dd className={currentRequest && currentRequest.budget.inputTokens > inputLimit ? 'over-limit' : ''}>{currentRequest?.budget.inputTokens.toLocaleString(locale()) ?? '—'}</dd></div></dl>
        <details className="context-dropdown" open={contextExpanded} onToggle={event => setContextExpanded(event.currentTarget.open)}><summary>{t("app.context")}<span>{!summariesEnabled ? t("app.summaries_are_disabled") : snapshot.memory.selectedCount ? t('counts.summaries', { count: snapshot.memory.selectedCount }) : t("app.full_history")}</span></summary>{currentRequest ? <><InputMeter input={currentRequest.budget.inputTokens} limit={inputLimit} /><BudgetBreakdown request={currentRequest} /><button className="secondary" disabled={!inspectionCurrent} onClick={() => setPeek(true)}>{t("app.prompt_peek")}</button></> : <p className="small muted">{inspectionError || t("app.select_a_connection_to_inspect_input")}</p>}</details>
  </>;
  const returnToChat = () => { setTab('story'); setPeek(false); setGenerationId(''); };

  return <ChatDetailsTarget.Provider value={chatDetailsTarget}><div className="app">
    <header className="topbar">
      <div className="brand"><span className="brand-mark" aria-hidden="true">{t("app.o")}</span><div><strong>{t("app.ore")}</strong><small>{t("app.your_stories_room_to_continue")}</small></div></div>
      <nav className="tabs" aria-label={t("app.workspace")}>
        <button disabled={!snapshot} aria-current={tab !== 'library' && tab !== 'data' ? 'page' : undefined} onClick={() => setTab('story')}>{t("app.story")}</button>
        <button aria-current={tab === 'library' ? 'page' : undefined} onClick={() => { setLibraryTarget(null); setTab('library'); }}>{t("app.libraries")}</button>
        <button aria-current={tab === 'data' ? 'page' : undefined} onClick={() => setTab('data')}>{t("app.settings")}</button>
      </nav>
      <div className="chat-details-slot" ref={setChatDetailsTarget} />
      <div className="connection-status"><span className={online ? 'dot online' : 'dot'} />{online ? t("app.connected") : t("app.reconnecting")}</div>
      <button className="quiet signout" onClick={() => void command(async () => { await api('/logout', 'POST', {}); setSnapshot(null); await refreshSession(); })}>{t("app.sign_out")}</button>
    </header>
    {dataChanged && <div className="error-banner" role="alert"><span>{t("app.application_data_was_imported_or_wiped_in")}</span><button onClick={() => window.location.reload()}>{t("app.reload_current_data")}</button></div>}
    {error && <div className="error-banner" role="alert"><span>{error}</span><button className="quiet" onClick={() => setError('')}>{t("app.dismiss")}</button></div>}
    {appearanceError && <div className="error-banner" role="alert"><span>{t("app.using_the_last_loaded_chat_appearance_or", { appearanceError: appearanceError })}</span><button className="quiet" onClick={() => void refresh()}>{t("app.retry_chat_appearance")}</button></div>}
    {tab === 'data' && <ApplicationSettings appearance={appearance} appearanceCommitted={value => { setAppearance(current => value.revision >= current.revision ? value : current); setAppearanceError(null); }} openLibraries={() => { setLibraryTarget(null); setTab('library'); }} />}
    {snapshot && ['settings', 'memory', 'request'].includes(tab) && toolError && <div className="error-banner" role="alert">{toolError}<button onClick={() => setToolRetry(value => value + 1)}>{t("app.retry_loading")}</button></div>}
    {snapshot && ['settings', 'memory'].includes(tab) && toolSnapshot?.id !== snapshot.id && <main className="document-panel"><p role="status">{t("app.loading_chat_tools")}</p></main>}
    {tab === 'story' && snapshot && <ChatWorkspace sidebar={sidebar} navigation actions={<>
        <button className="quiet chat-navigation-action" aria-label={t("app.chat_settings")} onClick={() => setTab('settings')}><Icon name="Settings" />{t("app.chat_settings_2", { value: snapshot.promptDiagnostics?.length ? ` (${snapshot.promptDiagnostics.length})` : '' })}</button>
        <button className="quiet chat-navigation-action" onClick={() => setTab('memory')}><Icon name="List" />{t("app.inspect_memory")}</button>
        <button className="quiet chat-navigation-action" onClick={() => setTab('request')}><Icon name="Menu" />{t("app.request_inspector")}</button>
      </>}>
      <section className="conversation" aria-label={t("app.conversation")}>
        {memoryStale && <div className="recovery" role="status"><div><strong>{t("app.memory_needs_review")}</strong><p>{t("app.archived_history_changed_repair_the_affected_summaries")}</p></div><button className="secondary" onClick={() => setTab('memory')}>{t("app.review_memory")}</button></div>}
        {pageError && <div className="recovery" role="alert">{pageError}<button className="secondary" onClick={() => setPageError('')}>{t("app.dismiss")}</button></div>}
        <div className="transcript-frame"><div className="transcript" ref={transcript}>
          {snapshot.page.hasOlder && <div className="history-page-control" data-history-direction="older"><button className="secondary" disabled={pageLoading || Boolean(edit)} onClick={() => void moveTranscript('older')}>{pageLoading ? t("app.loading_history") : t("app.load_older_turns")}</button></div>}
          {snapshot.totalTurns === 0 && <div className="empty-state"><h2>{t("app.set_up_your_story")}</h2><button className="secondary" onClick={() => setTab('settings')}>{t("app.open_chat_settings")}</button></div>}
          {snapshot.page.turns.map((turn) => {
            const generating = active?.turnId === turn.id;
            const cancelled = !turn.complete && latest?.turnId === turn.id && latest.status === 'cancelled';
            const responseText = generating ? active.partialText : !turn.complete && latest?.turnId === turn.id ? latest.partialText : '';
            const selectedVariant = turn.variants?.find(variant => variant.id === turn.assistant.variantId);
            const reasoningGeneration = generating ? active : !turn.complete && latest?.turnId === turn.id ? latest
              : selectedVariant?.generationId ? generationById.get(selectedVariant.generationId) : undefined;
            const reasoning = reasoningGeneration?.reasoningText?.trim() ? {
              text: reasoningGeneration.reasoningText, live: generating, chatId: snapshot.id,
              generationId: reasoningGeneration.id, length: reasoningGeneration.reasoningLength ?? 0,
            } : null;
            const inputVisible = !(turn.complete && turn.user.text === '' && turn.user.revision === 0)
              || (edit?.turnId === turn.id && edit.part === 'user');
            return <article className="turn" key={turn.id} data-turn-id={turn.id} aria-label={t("app.turn", { ordinal: turn.ordinal })}>
            <div className="turn-heading"><span>{t("app.turn_2", { ordinal: turn.ordinal, value: turn.complete ? summariesEnabled && turn.archived ? t("interface.archived") : '' : t("interface.pending") })}</span>{turn.complete && !generating && turnUsage.has(turn.id) && <span className="turn-usage" title={t("app.provider_reported_counts_for_the_saved_response")}>{turnUsage.get(turn.id) ? t("app.in_out", { value: turnUsage.get(turn.id)!.inputTokens.toLocaleString(locale()), value2: turnUsage.get(turn.id)!.outputTokens.toLocaleString(locale()) }) : t("app.usage_unavailable")}</span>}</div>
            {(['user', 'assistant'] as const).filter(part => part !== 'user' || inputVisible).map((part) => <div className={`part ${part}`} key={part}>
              <div className="part-heading"><strong>{part === 'user' ? selectedPersonaName : selectedCharacterName}</strong></div>
              {part === 'assistant' && reasoning && generating && !responseText && <ReasoningPreview text={reasoning.text} />}
              {edit?.turnId === turn.id && edit.part === part ? <form onSubmit={saveEdit} className="edit-form"><ChatTextarea autoSize aria-label={t("app.edit_text", { part: part })} value={edit.text} onValueChange={text => setEdit({ ...edit, text })} /><p className="small muted">{snapshot.settings.lorebookId ? t("app.saving_a_history_edit_starts_fresh_lore") : ""}</p><div className="actions"><button disabled={busy}>{t("app.save_edit")}</button><button type="button" className="quiet" onClick={() => setEdit(null)}>{t("app.cancel_edit")}</button></div></form> : <div className="prose">
                {part === 'assistant' && (!turn.complete || generating)
                  ? <>{trimBoundaryNewlines(responseText) ? <ChatMarkdown textScale={appearance.settings.chatTextScale} text={trimBoundaryNewlines(responseText)} speechColor={selectedCharacter?.speechColor ?? appearance.settings.characterSpeechColor} /> : <span className="muted">{generating ? t("app.waiting_for_first_token") : cancelled ? t("app.generation_cancelled") : t("app.awaiting_response")}</span>}{generating && <span className="cursor" aria-label={t("app.generating")} />}</>
                  : turn[part].text ? <ChatMarkdown textScale={appearance.settings.chatTextScale} text={turn[part].text} speechColor={part === 'user' ? selectedPersona?.speechColor ?? appearance.settings.personaSpeechColor : selectedCharacter?.speechColor ?? appearance.settings.characterSpeechColor} /> : <span className="muted blank">{t("app.blank")}</span>}
              </div>}
            </div>)}
            <TurnControls turn={turn} locked={working || busy} editing={Boolean(edit)} inputVisible={inputVisible} reasoning={reasoning}
              action={generating
                ? { kind: 'cancel', disabled: busy, run: () => void command(() => api(`/generations/${active.id}/cancel`, 'POST', {})) }
                : turn.complete && turn.id === snapshot.latestTurn?.id && snapshot.connection
                  ? { kind: 'regenerate', disabled: working || busy || Boolean(edit), run: () => void command(() => api(`/chats/${snapshot.id}/turns/${turn.id}/regenerate`, 'POST', { revision: snapshot.revision, requestId: newId() })) }
                  : null}
              select={id => command(() => api(`/chats/${snapshot.id}/turns/${turn.id}/variants/${id}/select`, 'POST', { revision: snapshot.revision }))}
              edit={part => setEdit({ turnId: turn.id, part, text: turn[part].text, revision: snapshot.revision })}
              remove={() => {
                confirmAction({ title: t("app.delete_turn"), message: t("app.delete_this_entire_turn_including_its_saved", { value: snapshot.settings.lorebookId ? t("interface.lore_activation_history_for_this_chat_will_start") : '' }), actionLabel: t("app.delete_turn_2"), onConfirm: () => { void command(() => api(`/chats/${chatId}/turns/${turn.id}`, 'DELETE', { revision: snapshot.revision })); } });
              }} />
          </article>;
          })}
          {snapshot.page.hasNewer && <div className="history-page-control" data-history-direction="newer"><button className="secondary" disabled={pageLoading || Boolean(edit)} onClick={() => void moveTranscript('newer')}>{pageLoading ? t("app.loading_history") : t("app.load_newer_turns")}</button></div>}
          {edit && !snapshot.page.turns.some(turn => turn.id === edit.turnId) && <div className="recovery" role="alert"><div><p>{t("app.the_edited_turn_was_removed_or_replaced")}</p><ChatTextarea aria-label={t("app.unsaved_turn_edit")} value={edit.text} onValueChange={text => setEdit({ ...edit, text })} /><button onClick={() => setEdit(null)}>{t("app.close_edit")}</button></div></div>}
        </div>{(awayFromLatest || snapshot.page.hasNewer) && <button className="latest-turn secondary" disabled={pageLoading || Boolean(edit)} onClick={() => snapshot.page.hasNewer ? void moveTranscript('latest') : scrollToLatest()}>{t("app.latest_turn")}<Icon name="ArrowLongBottom" /></button>}</div>
        {!active && pending && <div className="recovery" role="status"><div><strong>{t("app.last_turn_is_still_pending")}</strong><p>{latest?.status === 'cancelled' ? t("app.response_cancelled_generate_response_before_next_turn") : (latest?.errorMessage ? formatMessage(latest.errorMessage) : latest?.error) ?? t("app.generate_response_before_next_turn")}</p>{partial && <small>{t("app.partial_text_is_preserved_for_inspection_it")}</small>}</div><button className="secondary" disabled={busy} onClick={() => void command(() => api(`/chats/${chatId}/retry`, 'POST', { revision: snapshot.revision, requestId: newId() }))}>{t("app.retry_response")}</button></div>}
        {!active && latest?.kind === 'regeneration' && (latest.status === 'failed' || latest.status === 'interrupted') && <p className="recovery" role="status">{(latest.errorMessage ? formatMessage(latest.errorMessage) : latest.error) ?? t("app.regeneration_did_not_finish_try_again")}</p>}
        {drafts.needsReview && <div className="recovery" role="alert"><p>{t("app.this_browser_draft_predates_a_backup_import")}</p><button onClick={drafts.review}>{t("app.use_recovered_draft")}</button></div>}
        <form className="composer" onSubmit={(event) => void send(event)}>
          <ChatTextarea autoSize rows={1} aria-label={t("app.your_next_turn")} id="turn-input" placeholder={t("app.what_happens_next")} value={draft} disabled={pending || busy || working} onValueChange={text => { drafts.change(text); setPeek(false); }} />
          <button className="send-turn" aria-label={t("app.send")} title={busy ? t("app.saving_changes") : t("app.send")} disabled={pending || busy || working || memoryStale || dataChanged || drafts.needsReview || !snapshot.connection || !draft.trim()}><span className="send-icon" aria-hidden="true" /></button>
          {drafts.storageError && <span className="composer-status" role="alert">{t("app.draft_could_not_be_saved_in_this")}</span>}
          {preparing && <span className="composer-status">{t("app.preparing_memory")}</span>}
        </form>
      </section>
    </ChatWorkspace>}
    {tab === 'library' && <Libraries library={library} currentChatId={chatId} busy={busy} run={command} openChat={openChat} initialTarget={libraryTarget} />}
    {tab === 'settings' && snapshot && toolSnapshot?.id === snapshot.id && <ChatSetup key={snapshot.id} snapshot={toolSnapshot} library={library} busy={busy || working} run={command} sidebar={sidebar} returnToChat={returnToChat} saved={returnToChat} openLibraryItem={target => { setLibraryTarget(target); setTab('library'); }} />}
    {tab === 'memory' && snapshot && toolSnapshot?.id === snapshot.id && <ChatWorkspace sidebar={sidebar} actions={<button className="secondary" onClick={returnToChat}>{t("app.return_to_chat")}</button>}><Memory key={snapshot.id} snapshot={toolSnapshot} library={library} busy={busy} run={command} /></ChatWorkspace>}
    {tab === 'request' && snapshot && <ChatWorkspace sidebar={sidebar} actions={<button className="secondary" onClick={returnToChat}>{t("app.return_to_chat")}</button>}><section className="document-panel chat-panel" aria-label={t("app.request_inspector")}><p className="eyebrow">{t("app.request_inspector_2")}</p><h1>{t("app.see_what_the_model_receives")}</h1><p className="muted">{t("app.current_input_follows_your_saved_setup_and")}</p><div className="inspector-controls"><label>{t("app.inspect_request")}<Dropdown aria-label={t("app.inspect_request")} value={generationId} onChange={setGenerationId} options={[{ value: '', label: t("app.current_request") }, ...(currentToolSnapshot?.generations ?? []).map(generation => ({ value: generation.id, label: `${new Date(generation.createdAt).toLocaleString(locale())} · ${generation.status}` }))]} /></label><button className="secondary" disabled={!snapshot.connection || busy} onClick={() => { setGenerationId(''); setSettledDraft(draft); }}>{t("app.preview", { value: pending ? t("interface.pending_turn") : t("interface.next_request") })}</button><button className="secondary" disabled={!currentRequest || !inspectionCurrent} onClick={() => setPeek(true)}>{t("app.prompt_peek")}</button></div>
      <p className="small muted">{generationId ? t("app.saved_attempt_its_ceiling_is_historical", { value: shownGeneration?.status ?? 'unavailable', value2: formatMessage(shownGeneration?.errorMessage ?? shownGeneration?.error) }) : t("app.live_preview_of_the_current_setup_and")}</p>
      {!generationId && memoryStale && <p role="status">{t("app.memory_is_out_of_date_this_inspection")}</p>}
      {!generationId && inspectionError && <p role="status">{inspectionError}</p>}{generationId && matchingSavedInspection?.error && <p role="alert">{formatMessage(matchingSavedInspection.error)}</p>}
      {shownGeneration?.usage && <p className="small">{t("app.provider_reported_input_output_tokens", { value: shownGeneration.usage.inputTokens.toLocaleString(locale()), value2: shownGeneration.usage.outputTokens.toLocaleString(locale()) })}</p>}
      {shownRequest && <>{shownRequest.warnings?.map((warning, index) => <p role="status" key={warning}>{formatMessage(shownRequest.warningMessages?.[index] ?? warning)}</p>)}<div className="budget"><strong>{t("app.estimated_input_2", { value: shownRequest.budget.inputTokens.toLocaleString(locale()), value2: shownRequest.budget.targetInputTokens.toLocaleString(locale()) })}</strong><InputMeter input={shownRequest.budget.inputTokens} limit={Math.min(shownRequest.budget.targetInputTokens, shownRequest.budget.contextWindow - shownRequest.budget.reservedOutputTokens)} /><span>{t("app.reserved_output_model_window", { value: shownRequest.budget.reservedOutputTokens.toLocaleString(locale()), value2: shownRequest.budget.contextWindow.toLocaleString(locale()) })}</span></div>{shownRequest.layout && <BudgetBreakdown request={shownRequest} />}<LoreInspection request={shownRequest} historical={Boolean(generationId)} /><details className="request-details"><summary>{t("app.endpoint_and_request_body")}</summary><h2>{t("app.endpoint")}</h2><pre>{shownRequest.endpoint}</pre><h2>{t("app.request_body")}</h2><pre data-testid="request-body">{JSON.stringify(shownRequest.body, null, 2)}</pre></details><details><summary>{t("app.turn_identities_and_source_revisions")}</summary><pre>{JSON.stringify(shownRequest.coverage, null, 2)}</pre></details></>}
    </section></ChatWorkspace>}
    {peek && currentRequest && <PromptPeek stale={memoryStale} request={currentRequest} close={() => setPeek(false)} />}

  </div></ChatDetailsTarget.Provider>;
}

function Login({ session, onLogin }: { session: Session; onLogin: () => Promise<void> }) {
  useLocale();
  const [password, setPassword] = useState('');
  const [error, setError] = useTextState('');
  const [busy, setBusy] = useState(false);
  return <main className="login"><div className="login-card"><span className="brand-mark">{t("app.o")}</span><p className="eyebrow">{t("app.ore")}</p><h1>{session.setupRequired ? t("app.your_stories_start_here") : t("app.welcome_back")}</h1><p>{session.setupRequired ? t("app.create_the_owner_password_on_the_server") : t("app.sign_in_to_continue_your_story")}</p><form onSubmit={async (event) => {
    event.preventDefault(); setBusy(true); setError('');
    try { await api(session.setupRequired ? '/setup' : '/login', 'POST', { password }); setPassword(''); await onLogin(); }
    catch (error) { setError(errorText(error, msg("app.could_not_sign_in"))); } finally { setBusy(false); }
  }}><label>{t("app.owner_password")}<input type="password" required minLength={12} maxLength={256} autoComplete={session.setupRequired ? 'new-password' : 'current-password'} value={password} onChange={(event) => setPassword(event.target.value)} /></label><small className="muted">{t("app.at_least_12_characters")}</small>{error && <p role="alert">{error}</p>}<button disabled={busy}>{busy ? t("app.opening") : session.setupRequired ? t("app.create_owner_account") : t("app.sign_in")}</button></form><p className="small muted">{t("app.access_from_other_devices_requires_https")}</p></div></main>;
}
