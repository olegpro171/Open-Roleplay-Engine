import { applyTheme } from './theme';
import { stateLabel } from './localization-labels';
import type { MessageText } from './localization';
import { LocalizedError, formatMessage, useTextState, errorText, t, message as msg, useLocale, locale } from './localization';
import { chatBehaviorStatusSchema, type ChatBehaviorStatus } from '../shared/chat-behavior';
import { isComposerSendKey, isMacKeyboard, isPhoneOrTablet } from './composer-shortcuts';
import { appearanceStatusSchema, defaultAppearance, type AppearanceStatus } from '../shared/appearance';
import { chatDefaultsStatusSchema, initialChatDefaults, type ChatDefaultsStatus } from '../shared/chat-defaults';
import { newId } from './uuid';
import { Icon } from './Icon';
import { ApplicationSettings } from './ApplicationSettings';
import { useConfirmation } from './Confirmation';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import type { ChatToolsSnapshot, RequestPreview } from '../shared/contracts';
import { api, ApiError, datasetChanged } from './api';
import { changeSchema } from '../shared/changes';
import { RefreshQueue, fullRefresh, scopeForChange, type RefreshScope } from './refresh-queue';
import { useRequestPreview } from './useRequestPreview';
import { useGenerationHistory } from './useGenerationHistory';
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
import { ChatCharacterPortrait } from './Pictures';
import { useComposerKeyboard } from './useComposerKeyboard';
import { useTouchScrollGuard } from './useTouchScrollGuard';
import { useSettingsAutosave } from './useSettingsAutosave';
import { useAuthorNote } from './useAuthorNote';
import { AuthorNoteDialog, AuthorNoteSaveStatus } from './AuthorNote';
import { lanStatusSchema, type LanSettings, type LanStatus } from '../shared/lan';

type Session = { setupRequired: boolean; authenticated: boolean };
type Edit = { turnId: string; part: 'user' | 'assistant'; text: string; revision: number };
type AppFailure =
  | { kind: 'loading'; reason: 'connection' | 'request'; message: MessageText }
  | { kind: 'action'; message: MessageText };
const serverUnavailable = msg("app.cannot_reach_the_server_check_that_it");
// iPadOS can advertise a Mac when requesting desktop sites.
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
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
  const [appearanceLoaded, setAppearanceLoaded] = useState(false);
  useLayoutEffect(() => { if (appearanceLoaded) applyTheme(appearance.settings.theme); }, [appearanceLoaded, appearance.settings.theme]);
  const [chatDefaults, setChatDefaults] = useState<ChatDefaultsStatus>(initialChatDefaults);
  const [appearanceError, setAppearanceError] = useTextState(null);
  const [chatBehavior, setChatBehavior] = useState<ChatBehaviorStatus | null>(null);
  const [chatBehaviorError, setChatBehaviorError] = useTextState(null);
  // Keep settings queues and failed choices through workspace navigation and reopening Settings.
  const appearanceEditor = useSettingsAutosave<AppearanceStatus['settings'], AppearanceStatus>({
    status: appearance, path: '/application/appearance', parse: value => appearanceStatusSchema.parse(value),
    committed: value => { setAppearanceLoaded(true); setAppearance(current => value.revision >= current.revision ? value : current); setAppearanceError(null); },
  });
  const behaviorEditor = useSettingsAutosave<ChatBehaviorStatus['settings'], ChatBehaviorStatus>({
    status: chatBehavior, path: '/application/chat-behavior', parse: value => chatBehaviorStatusSchema.parse(value),
    committed: value => { setChatBehavior(current => !current || value.revision >= current.revision ? value : current); setChatBehaviorError(null); },
  });
  const lanEditor = useSettingsAutosave<LanSettings, LanStatus>({
    status: null, path: '/application/lan', parse: value => lanStatusSchema.parse(value),
    body: ({ revision, settings }) => ({ revision, ...settings }),
  });
  const sendInFlight = useRef(false);
  const [library, setLibrary] = useState<LibrarySnapshot | null>(null);
  const libraryCache = useRef<LibrarySnapshot | null>(null);
  const [snapshot, setSnapshot] = useState<StorySnapshot | null>(null);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const [toolSnapshot, setToolSnapshot] = useState<ChatToolsSnapshot | null>(null);
  const [toolError, setToolError] = useTextState('');
  const [toolRetry, setToolRetry] = useState(0);
  const [toolRefresh, setToolRefresh] = useState(0);
  const [pageLoading, setPageLoading] = useState(false);
  const pageBusy = useRef(false);
  const pageRequest = useRef<AbortController | null>(null);
  const refreshPending = useRef(false);
  const deferredRefresh = useRef<RefreshScope | null>(null);
  const forceLatest = useRef(false);
  const [pageError, setPageError] = useTextState('');
  const [failure, setFailure] = useState<AppFailure | null>(null);
  const error = formatMessage(failure?.message);
  const serverUnreachable = failure?.kind === 'loading' && failure.reason === 'connection';
  const reportLoadFailure = useCallback((message: MessageText, reason: 'connection' | 'request') => {
    // A failed background read must not replace the action the user needs to resolve.
    setFailure(current => current?.kind === 'action' ? current : { kind: 'loading', reason, message });
  }, []);
  const [online, setOnline] = useState(false);
  const [tab, setTab] = useState<'story' | 'settings' | 'request' | 'library' | 'memory' | 'data'>('story');
  const visibleTab = useRef(tab);
  visibleTab.current = tab;
  const composerKeyboard = useComposerKeyboard(isIOS && tab === 'story');
  useTouchScrollGuard(isIOS && session?.authenticated === true && tab === 'story');
  const [libraryTarget, setLibraryTarget] = useState<LibraryTarget | null>(null);
  const confirmAction = useConfirmation(`${chatId}:${tab}:${session?.authenticated}`);
  const drafts = useChatDraft(chatId);
  const draft = drafts.text;
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState<Edit | null>(null);
  const editForm = useRef<HTMLFormElement>(null);
  const [peek, setPeek] = useState(false);
  const [authorNoteOpen, setAuthorNoteOpen] = useState(false);
  useEffect(() => { setAuthorNoteOpen(false); }, [chatId, tab]);
  const [contextExpanded, setContextExpanded] = useState(false);
  const [chatDetailsTarget, setChatDetailsTarget] = useState<HTMLDivElement | null>(null);
  const [generationId, setGenerationId] = useState('');
  const loadId = useRef(0);
  const { transcript, awayFromLatest, scrollToLatest, preservePosition, followingLatest } = useTranscriptScroll(tab === 'story' ? snapshot?.id ?? null : null, snapshot, Boolean(edit));
  useLayoutEffect(() => {
    const scroller = transcript.current;
    const form = editForm.current;
    if (!edit || !form || !scroller) return;
    scroller.scrollTop += form.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 16;
  }, [edit?.turnId, edit?.part]);
  const clearServerError = useCallback(() => setFailure(current => current?.kind === 'loading'
    && current.reason === 'connection' ? null : current), []);
  const refreshSession = useCallback(async () => {
    try { setSession(await api<Session>('/session')); clearServerError(); } catch { reportLoadFailure(serverUnavailable, 'connection'); }
  }, [clearServerError, reportLoadFailure]);
  const editRef = useRef(edit);
  editRef.current = edit;
  const refreshReader = useRef<(scope: RefreshScope) => Promise<void>>(async () => {});
  const [refreshQueue] = useState(() => new RefreshQueue(scope => refreshReader.current(scope)));
  const refresh = useCallback((scope: RefreshScope = fullRefresh) => refreshQueue.request(scope), [refreshQueue]);
  refreshReader.current = async (requested: RefreshScope) => {
    if (pageBusy.current) {
      refreshPending.current = true;
      deferredRefresh.current = { ...deferredRefresh.current, ...requested };
      return;
    }
    const requestedChat = chatId;
    const id = ++loadId.current;
    try {
      const cached = libraryCache.current;
      const scope = cached ? requested : fullRefresh;
      const [update, appearanceResult, defaults, behaviorResult] = await Promise.all([
        scope.library ? api<LibrarySnapshot | UnchangedLibrary>(`/library${cached ? `?knownRevision=${cached.revision}` : ''}`) : null,
        scope.appearance ? api<unknown>('/application/appearance')
          .then(value => ({ value: appearanceStatusSchema.parse(value), error: null }))
          .catch(error => ({ value: null, error: errorText(error, msg("app.chat_appearance_could_not_be_loaded")) })) : null,
        scope['chat-defaults'] ? api<unknown>('/application/chat-defaults').then(value => chatDefaultsStatusSchema.parse(value)) : null,
        scope['chat-behavior'] ? api<unknown>('/application/chat-behavior')
          .then(value => ({ value: chatBehaviorStatusSchema.parse(value), error: null }))
          .catch(error => ({ value: null, error: errorText(error, msg('chat_behavior.read_failed')) })) : null,
      ]);
      // Keep existing editors/transcript available to copy after a dataset replacement.
      if (datasetChanged()) return;
      let items: LibrarySnapshot;
      if (!update) {
        if (!cached) throw new LocalizedError(msg('app.library_refresh_has_no_matching_saved_version'));
        items = cached;
      } else if ('unchanged' in update) {
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
      const readStory = scope.story || current?.id !== selected;
      try { state = !readStory ? current : selected ? await api<StorySnapshot>(`/chats/${selected}/story?${parameters}`) : null; }
      catch (error) {
        if (id !== loadId.current) return;
        if (!(error instanceof ApiError) || error.status !== 409 || !selected) throw error;
        state = await api<StorySnapshot>(`/chats/${selected}/story`);
        windowReset = true;
      }
      if (id === loadId.current && requestedChat === selectedChat.current && !datasetChanged()) {
        libraryCache.current = items;
        forceLatest.current = false;
        if (readStory) preservePosition(Boolean(current?.page.hasNewer));
        if (windowReset) {
          scrollToLatest();
          setPageError(msg("app.the_displayed_history_was_removed_or_replaced"));
        }
        if (readStory) {
          snapshotRef.current = state;
          setSnapshot(state);
        }
        if (update) setLibrary(items);
        if (scope.tools) setToolRefresh(value => value + 1);
        if (defaults) setChatDefaults(current => defaults.revision >= current.revision ? defaults : current);
        // A settings save can commit while this refresh is waiting for chat state.
        if (appearanceResult?.value) {
          const nextAppearance = appearanceResult.value;
          setAppearanceLoaded(true);
          setAppearance(current => nextAppearance.revision >= current.revision ? nextAppearance : current);
        }
        if (appearanceResult) setAppearanceError(appearanceResult.error);
        if (behaviorResult?.value) {
          const nextBehavior = behaviorResult.value;
          setChatBehavior(current => !current || nextBehavior.revision >= current.revision ? nextBehavior : current);
        }
        if (behaviorResult) setChatBehaviorError(behaviorResult.error);
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
      else if (error instanceof ApiError) reportLoadFailure(errorText(error), 'request');
      else reportLoadFailure(serverUnavailable, 'connection');
    } finally {
      // Page movement and chat switches invalidate reads already in flight.
      // Retain their scopes: without periodic polling, dropping a settings
      // notification here could leave its new value unseen indefinitely.
      if (!datasetChanged() && (id !== loadId.current || requestedChat !== selectedChat.current)) void refresh(requested);
    }
  };
  const latestRefresh = useRef(refresh);
  latestRefresh.current = refresh;
  const selectedChat = useRef(chatId);
  selectedChat.current = chatId;
  useEffect(() => { void refreshSession(); }, [refreshSession]);
  useEffect(() => {
    if (!serverUnreachable) return;
    let checking = false;
    const timer = setInterval(() => {
      if (!checking) { checking = true; void refreshSession().finally(() => { checking = false; }); }
    }, 2_000);
    return () => clearInterval(timer);
  }, [serverUnreachable, refreshSession]);
  useEffect(() => {
    if (!session?.authenticated) return;
    // Reading saved state must also work when the observer cannot connect.
    void refresh();
    const events = new EventSource('/api/events');
    events.onopen = () => { setOnline(true); clearServerError(); void refresh(); };
    events.onmessage = event => {
      let scope: RefreshScope | null = fullRefresh;
      try {
        const parsed = changeSchema.safeParse(JSON.parse(event.data));
        if (parsed.success) scope = scopeForChange(parsed.data, selectedChat.current, visibleTab.current === 'story');
      } catch { /* Unknown/older notifications reconcile from authoritative state. */ }
      if (scope) void refresh(scope);
    };
    events.onerror = () => { setOnline(false); void refreshSession(); };
    const visible = () => { if (document.visibilityState === 'visible') { void refreshSession(); void refresh(); } };
    document.addEventListener('visibilitychange', visible);
    return () => { events.close(); setOnline(false); document.removeEventListener('visibilitychange', visible); };
  }, [session?.authenticated, refresh, refreshSession, clearServerError]);
  useEffect(() => {
    if (session?.authenticated && libraryCache.current) void refresh({ library: true, story: true, tools: true });
  }, [chatId, session?.authenticated, refresh]);
  useEffect(() => {
    if (tab === 'story' && session?.authenticated && libraryCache.current) void refresh({ story: true });
  }, [tab, session?.authenticated, refresh]);

  useEffect(() => { setPeek(false); setGenerationId(''); }, [snapshot?.id]);
  useEffect(() => {
    if (!snapshot || !['settings', 'memory'].includes(tab)) {
      setToolSnapshot(null);
      setToolError('');
      return;
    }
    const controller = new AbortController();
    setToolError('');
    void api<ChatToolsSnapshot>(`/chats/${snapshot.id}/tools`, 'GET', undefined, controller.signal).then(value => {
      if (!controller.signal.aborted && !datasetChanged()) setToolSnapshot(value);
    }).catch(error => { if (!controller.signal.aborted) setToolError(errorText(error, msg("app.cannot_load_chat_tools"))); });
    return () => controller.abort();
  }, [tab, snapshot?.id, snapshot?.revision, snapshot?.memory.revision, toolRefresh, toolRetry]);

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
          const scope = deferredRefresh.current ?? fullRefresh;
          deferredRefresh.current = null;
          void latestRefresh.current(scope);
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
  const authorNote = useAuthorNote(snapshot, working || busy || dataChanged, (id, status) => {
    const current = snapshotRef.current;
    if (current?.id !== id || status.revision < current.revision) return;
    // Retire pagination together with its read identity; its old finally block
    // can no longer release the loading flag after that identity changes.
    loadId.current++;
    pageRequest.current?.abort();
    pageBusy.current = false;
    setPageLoading(false);
    refreshPending.current = false;
    const next = { ...current, revision: status.revision, settings: { ...current.settings, authorNote: status.settings } };
    snapshotRef.current = next;
    setSnapshot(next);
    void latestRefresh.current();
  });
  const summariesEnabled = hasPromptMarker(snapshot?.sources.prompt, 'summary');
  const memoryStale = summariesEnabled && Boolean(snapshot?.memory.stale || snapshot?.memory.refusalBlocked);
  const pending = snapshot?.latestTurn?.complete === false;
  const latest = snapshot?.latestGeneration;
  const history = useGenerationHistory(snapshot?.id ?? null, tab === 'request', `${toolRefresh}:${snapshot?.latestGeneration?.id}:${snapshot?.latestGeneration?.status}:${snapshot?.latestGeneration?.requestAvailable}`, generationId);
  useEffect(() => {
    if (tab === 'request' && history.missingSelected && !history.loading && !history.error && generationId) setGenerationId('');
  }, [tab, history.missingSelected, history.loading, history.error, generationId]);
  const shownGeneration = history.items.find(generation => generation.id === generationId)
    ?? (history.selected?.id === generationId ? history.selected : null);
  const requestOptions = shownGeneration && !history.items.some(item => item.id === shownGeneration.id)
    ? [shownGeneration, ...history.items] : history.items;
  const preview = useRequestPreview(snapshot, draft, tab !== 'library' && tab !== 'data', tab === 'request' && !generationId || peek);
  const currentRequest = snapshot?.connection ? preview.estimate : null;
  const inspectionCurrent = preview.current;
  const inspectionError = formatMessage(preview.error) || (!currentRequest && snapshot?.connection ? t('app.counting_current_input') : '');
  const [savedInspection, setSavedInspection] = useState<{ chatId: string; generationId: string; request: RequestPreview | null; error: MessageText } | null>(null);
  const [savedInspectionRetry, setSavedInspectionRetry] = useState(0);
  const savedRequestPresent = Boolean(shownGeneration?.requestAvailable);
  useEffect(() => {
    if (tab !== 'request' || !snapshot || !generationId || !savedRequestPresent) {
      setSavedInspection(null);
      return;
    }
    const controller = new AbortController();
    api<RequestPreview | null>(`/chats/${snapshot.id}/generations/${encodeURIComponent(generationId)}/request`, 'GET', undefined, controller.signal).then(request => {
      if (!controller.signal.aborted) setSavedInspection({ chatId: snapshot.id, generationId, request, error: '' });
    }).catch(error => { if (!controller.signal.aborted) setSavedInspection({ chatId: snapshot.id, generationId, request: null, error: errorText(error) }); });
    return () => controller.abort();
  }, [tab, snapshot?.id, generationId, savedRequestPresent, savedInspectionRetry]);
  const matchingSavedInspection = savedInspection?.chatId === snapshot?.id && savedInspection?.generationId === generationId ? savedInspection : null;
  const shownRequest = generationId ? matchingSavedInspection?.request : preview.request;
  const activeTurns = currentRequest?.history?.verbatimTurns ?? (snapshot ? snapshot.totalTurns - snapshot.memory.archivedCount : 0);
  const inputLimit = currentRequest ? Math.min(currentRequest.budget.targetInputTokens, currentRequest.budget.contextWindow - currentRequest.budget.reservedOutputTokens) : 0;
  const generationById = new Map(snapshot?.page.generations.map(generation => [generation.id, generation]));
  const turnUsage = new Map(snapshot?.page.turns.flatMap(turn => {
    const variant = turn.variants?.find(item => item.id === turn.assistant.variantId);
    const generation = variant?.generationId ? generationById.get(variant.generationId) : undefined;
    return generation ? [[turn.id, generation.usage] as const] : [];
  }));
  const partial = active?.partialText ?? (pending ? latest?.partialText : '');

  async function command(action: () => Promise<unknown>): Promise<boolean> {
    setBusy(true); setFailure(null);
    try { await action(); await refresh(); return true; }
    catch (error) {
      setFailure({ kind: 'action', message: errorText(error, msg("app.the_request_failed")) });
      await refresh(); return false;
    } finally { setBusy(false); }
  }
  const canSend = Boolean(snapshot?.connection && !busy && !pending && !working && !memoryStale && !authorNote.pending
    && !dataChanged && !drafts.needsReview && draft.trim());
  const enterKeyBehavior = chatBehaviorError ? 'button-only' : chatBehavior?.settings.enterKeyBehavior ?? 'button-only';
  const mobileKeyboard = isPhoneOrTablet(navigator);
  const macKeyboard = isMacKeyboard(navigator);
  const sendTitle = authorNote.pending ? t('author_note.pending') : busy ? t('app.saving_changes')
    : enterKeyBehavior === 'ctrl-enter' ? t(macKeyboard ? 'chat_behavior.send_ctrl_mac' : 'chat_behavior.send_ctrl')
      : enterKeyBehavior === 'enter' && !mobileKeyboard ? t('chat_behavior.send_enter') : t('app.send');

  async function send(event: FormEvent) {
    event.preventDefault();
    if (!snapshot || !canSend || authorNote.editor.getSnapshot().pending || sendInFlight.current) return;
    const id = snapshot.id;
    const sent = drafts.stage(id, snapshot.revision);
    sendInFlight.current = true;
    setBusy(true); setFailure(null);
    try {
      await api(`/chats/${id}/turns`, 'POST', sent.submission);
      drafts.acknowledge(id, sent);
      if (selectedChat.current === id) { setPeek(false); scrollToLatest(); forceLatest.current = true; }
    } catch (error) {
      // A server rejection is definite; a lost response is ambiguous, so retain its request identity.
      if (error instanceof ApiError && error.status < 500) drafts.reject(id, sent);
      setFailure({ kind: 'action', message: errorText(error, msg("app.the_request_failed")) });
    } finally {
      await latestRefresh.current();
      sendInFlight.current = false;
      setBusy(false);
    }
  }

  async function saveEdit(event: FormEvent) {
    event.preventDefault();
    if (!edit) return;
    if (await command(() => api(`/chats/${chatId}/turns/${edit.turnId}/${edit.part}`, 'PATCH', { revision: edit.revision, text: edit.text }))) setEdit(null);
  }

  if (!session) return <main className="login"><p>{t("app.opening_ore")}</p>{error && <p role="alert">{error}</p>}</main>;
  if (!session.authenticated) return <Login session={session} onLogin={async () => { setFailure(null); await refreshSession(); }} />;
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
    if (snapshotRef.current?.id !== id) {
      snapshotRef.current = null;
      setSnapshot(null);
      setToolSnapshot(null);
    }
  }
  if (!library) return <main className="login"><p>{t("app.loading_your_story")}</p>{error && <p role="alert">{error}</p>}</main>;
  const selectedCharacter = library.characters.find(character => character.id === snapshot?.settings.characterId);
  const selectedCharacterPicture = library.characterPictures.find(picture => picture.characterId === snapshot?.settings.characterId);
  const selectedPersona = library.personas.find(persona => persona.id === snapshot?.settings.personaId);
  const selectedCharacterName = selectedCharacter?.name ?? snapshot?.sources.character?.name ?? t("app.character");
  const selectedPersonaName = selectedPersona?.name ?? snapshot?.sources.persona?.name ?? t("app.you");

  const sidebar = snapshot && <>
        <p className="eyebrow">{t("app.current_chat")}</p>
        {appearance.settings.displayCharacterPicture && <ChatCharacterPortrait key={`${snapshot.id}:${selectedCharacterPicture?.key ?? ''}`} picture={selectedCharacterPicture} />}
        <h1>{snapshot.settings.title}</h1>
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
    {error && <div className="error-banner" role="alert"><span>{error}</span><div className="actions error-banner-actions">
      {failure?.kind === 'loading' && <button className="quiet" disabled={busy} onClick={() => { setFailure(null); void refresh(); }}>{t("app.retry_loading")}</button>}
      <button className="quiet" onClick={() => setFailure(null)}>{t("app.dismiss")}</button>
    </div></div>}
    {appearanceError && <div className="error-banner" role="alert"><span>{t("app.using_the_last_loaded_chat_appearance_or", { appearanceError: appearanceError })}</span><button className="quiet" onClick={() => void refresh()}>{t("app.retry_chat_appearance")}</button></div>}
    {chatBehaviorError && <div className="error-banner" role="alert"><span>{t('chat_behavior.shortcuts_unavailable', { error: chatBehaviorError })}</span><button className="quiet" onClick={() => void refresh()}>{t('chat_behavior.retry')}</button></div>}
    {tab === 'data' && <ApplicationSettings chatBehavior={behaviorEditor} appearance={appearanceEditor} lan={lanEditor} openLibraries={() => { setLibraryTarget(null); setTab('library'); }} />}
    {snapshot && ['settings', 'memory', 'request'].includes(tab) && toolError && <div className="error-banner" role="alert">{toolError}<button onClick={() => setToolRetry(value => value + 1)}>{t("app.retry_loading")}</button></div>}
    {snapshot && ['settings', 'memory'].includes(tab) && toolSnapshot?.id !== snapshot.id && <main className="document-panel"><p role="status">{t("app.loading_chat_tools")}</p></main>}
    {tab === 'story' && snapshot && <ChatWorkspace sidebar={sidebar} navigation actions={<>
        <button className="quiet chat-navigation-action" aria-label={t("app.chat_settings")} onClick={() => setTab('settings')}><Icon name="Settings" />{t("app.chat_settings_2", { value: snapshot.promptDiagnostics?.length ? ` (${snapshot.promptDiagnostics.length})` : '' })}</button>
        <button className="quiet chat-navigation-action" onClick={() => setTab('memory')}><Icon name="List" />{t("app.inspect_memory")}</button>
        <button className="quiet chat-navigation-action" onClick={() => setAuthorNoteOpen(true)}><Icon name="TagOutline" />{t('author_note.title')}</button>
        <button className="quiet chat-navigation-action" onClick={() => setTab('request')}><Icon name="Menu" />{t("app.request_inspector")}</button>
      </>}>
      <section className="conversation" aria-label={t("app.conversation")}>
        {Boolean(snapshot.memory.refusalCount) && <div className="recovery" role="status"><div><strong>{t('refusals.notice', { count: snapshot.memory.refusalCount })}</strong></div><button className="secondary" onClick={() => setTab('memory')}>{t('refusals.review')}</button></div>}
        {memoryStale && !snapshot.memory.refusalCount && <div className="recovery" role="status"><div><strong>{t("app.memory_needs_review")}</strong><p>{t("app.archived_history_changed_repair_the_affected_summaries")}</p></div><button className="secondary" onClick={() => setTab('memory')}>{t("app.review_memory")}</button></div>}
        {pageError && <div className="recovery" role="alert">{pageError}<button className="secondary" onClick={() => setPageError('')}>{t("app.dismiss")}</button></div>}
        <div className="transcript-frame">{preparing && !active && <div className="memory-preparation-status" role="status">{t("app.preparing_memory")}</div>}<div className="transcript" ref={transcript}>
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
              {part === 'assistant' && appearance.settings.showReasoningDuringGeneration && reasoning && generating && !responseText && <ReasoningPreview text={reasoning.text} />}
              {edit?.turnId === turn.id && edit.part === part ? <form ref={editForm} onSubmit={saveEdit} className="edit-form"><ChatTextarea autoSize aria-label={t("app.edit_text", { part: part })} value={edit.text} onValueChange={text => setEdit({ ...edit, text })} /><p className="small muted">{snapshot.settings.lorebookId ? t("app.saving_a_history_edit_starts_fresh_lore") : ""}</p><div className="actions"><button disabled={busy}>{t("app.save_edit")}</button><button type="button" className="quiet" onClick={() => setEdit(null)}>{t("app.cancel_edit")}</button></div></form> : <div className="prose">
                {part === 'assistant' && (!turn.complete || generating)
                  ? <>{trimBoundaryNewlines(responseText) ? <ChatMarkdown textScale={appearance.settings.chatTextScale} text={trimBoundaryNewlines(responseText)} speechColor={selectedCharacter?.speechColor ?? appearance.settings.characterSpeechColor ?? 'var(--speech-character)'} /> : <span className="muted">{generating ? t(preparing ? "app.preparing_memory" : reasoning ? "app.reasoning" : "app.waiting_for_first_token") : cancelled ? t("app.generation_cancelled") : t("app.awaiting_response")}</span>}{generating && <span className="cursor" aria-label={t("app.generating")} />}</>
                  : turn[part].text ? <ChatMarkdown textScale={appearance.settings.chatTextScale} text={turn[part].text} speechColor={part === 'user' ? selectedPersona?.speechColor ?? appearance.settings.personaSpeechColor ?? 'var(--speech-persona)' : selectedCharacter?.speechColor ?? appearance.settings.characterSpeechColor ?? 'var(--speech-character)'} /> : <span className="muted blank">{t("app.blank")}</span>}
              </div>}
            </div>)}
            <TurnControls turn={turn} locked={working || busy} editing={Boolean(edit)} inputVisible={inputVisible} reasoning={reasoning}
              action={generating
                ? { kind: 'cancel', disabled: busy, run: () => void command(() => api(`/generations/${active.id}/cancel`, 'POST', {})) }
                : turn.complete && turn.id === snapshot.latestTurn?.id && snapshot.connection
                  ? { kind: 'regenerate', disabled: working || busy || authorNote.pending || Boolean(edit), run: () => void command(() => api(`/chats/${snapshot.id}/turns/${turn.id}/regenerate`, 'POST', { revision: snapshot.revision, requestId: newId() })) }
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
        {!active && pending && <div className="recovery" role="status"><div><strong>{t("app.last_turn_is_still_pending")}</strong><p>{latest?.status === 'cancelled' ? t("app.response_cancelled_generate_response_before_next_turn") : (latest?.errorMessage ? formatMessage(latest.errorMessage) : latest?.error) ?? t("app.generate_response_before_next_turn")}</p>{partial && <small>{t("app.partial_text_is_preserved_for_inspection_it")}</small>}</div><button className="secondary" disabled={busy || working || authorNote.pending} onClick={() => void command(() => api(`/chats/${chatId}/retry`, 'POST', { revision: snapshot.revision, requestId: newId() }))}>{t("app.retry_response")}</button></div>}
        {!active && latest?.kind === 'regeneration' && (latest.status === 'failed' || latest.status === 'interrupted') && <p className="recovery" role="status">{(latest.errorMessage ? formatMessage(latest.errorMessage) : latest.error) ?? t("app.regeneration_did_not_finish_try_again")}</p>}
        {drafts.needsReview && <div className="recovery" role="alert"><p>{t("app.this_browser_draft_predates_a_backup_import")}</p><button onClick={drafts.review}>{t("app.use_recovered_draft")}</button></div>}
        {drafts.storageError && <div className="recovery" role="alert">{t("app.draft_could_not_be_saved_in_this")}</div>}
        {!authorNoteOpen && <AuthorNoteSaveStatus saving={authorNote.saving} error={authorNote.error} retry={authorNote.editor.retry} disabled={working || busy || dataChanged} />}
        {!authorNoteOpen && authorNote.storageError && authorNote.pending && <p role="alert">{t('author_note.storage_failed')}</p>}
        <form className={isIOS ? 'composer composer-ios' : 'composer'} data-keyboard-visible={composerKeyboard || undefined} onSubmit={(event) => void send(event)}>
          <ChatTextarea autoSize textScale={appearance.settings.chatTextScale} rows={1} aria-label={t("app.your_next_turn")} id="turn-input" enterKeyHint="enter" onKeyDown={event => {
            if (!isComposerSendKey(event.nativeEvent, enterKeyBehavior, mobileKeyboard, macKeyboard)) return;
            event.preventDefault();
            if (!event.repeat && canSend && !sendInFlight.current) event.currentTarget.form?.requestSubmit();
          }} placeholder={t("app.what_happens_next")} value={draft} disabled={busy} onValueChange={text => { drafts.change(text); setPeek(false); }} />
          <button className="send-turn" aria-label={t("app.send")} title={sendTitle} disabled={!canSend}><span className="send-icon" aria-hidden="true" /></button>
        </form>
      </section>
    </ChatWorkspace>}
    {tab === 'library' && <Libraries library={library} defaults={chatDefaults} currentChatId={chatId} busy={busy} run={command} openChat={openChat} initialTarget={libraryTarget} />}
    {tab === 'settings' && snapshot && toolSnapshot?.id === snapshot.id && <ChatSetup key={snapshot.id} snapshot={toolSnapshot} library={library} busy={busy || working} run={command} sidebar={sidebar} returnToChat={returnToChat} saved={returnToChat} openLibraryItem={target => { setLibraryTarget(target); setTab('library'); }} />}
    {tab === 'memory' && snapshot && toolSnapshot?.id === snapshot.id && <ChatWorkspace sidebar={sidebar} actions={<button type="button" className="secondary" onClick={returnToChat} aria-label={t("app.return_to_chat")} title={t("app.return_to_chat")}><Icon name="Close" /><span>{t("app.return_to_chat")}</span></button>}><Memory behavior={behaviorEditor} key={snapshot.id} snapshot={toolSnapshot} library={library} busy={busy} run={command} editPreset={id => { setLibraryTarget({ kind: 'contexts', id }); setTab('library'); }} /></ChatWorkspace>}
    {tab === 'request' && snapshot && <ChatWorkspace sidebar={sidebar} actions={<button type="button" className="secondary" onClick={returnToChat} aria-label={t("app.return_to_chat")} title={t("app.return_to_chat")}><Icon name="Close" /><span>{t("app.return_to_chat")}</span></button>}><section className="document-panel chat-panel" aria-label={t("app.request_inspector")}><p className="eyebrow">{t("app.request_inspector_2")}</p><h1>{t("app.see_what_the_model_receives")}</h1><p className="muted">{t("app.current_input_follows_your_saved_setup_and")}</p><div className="inspector-controls"><label>{t("app.inspect_request")}<Dropdown aria-label={t("app.inspect_request")} value={generationId} disabled={history.loading} onChange={setGenerationId} options={[{ value: '', label: t("app.current_request") }, ...requestOptions.map(generation => ({ value: generation.id, label: `${new Date(generation.createdAt).toLocaleString(locale())} · ${stateLabel(generation.status)}` }))]} /></label><button className="secondary" disabled={!currentRequest || !inspectionCurrent} onClick={() => setPeek(true)}>{t("app.prompt_peek")}</button></div>
      <div className="actions">{history.newer && <button type="button" className="secondary" disabled={history.loading} onClick={() => void history.move('latest').then(moved => { if (moved) setGenerationId(''); })}>{t('app.latest_requests')}</button>}{history.newer && <button type="button" className="secondary" disabled={history.loading} onClick={() => void history.move('newer').then(moved => { if (moved) setGenerationId(''); })}>{t('app.newer_requests')}</button>}{history.older && <button type="button" className="secondary" disabled={history.loading} onClick={() => void history.move('older').then(moved => { if (moved) setGenerationId(''); })}>{t('app.older_requests')}</button>}</div>
      {history.error && <p role="alert">{formatMessage(history.error)} <button type="button" className="secondary" onClick={history.retry}>{t('app.retry_loading')}</button></p>}
      <p className="small muted">{generationId ? t("app.saved_attempt_its_ceiling_is_historical", { value: shownGeneration ? stateLabel(shownGeneration.status) : t("app.usage_unavailable"), value2: formatMessage(shownGeneration?.errorMessage ?? shownGeneration?.error) }) : t("app.live_preview_of_the_current_setup_and")}</p>
      {!generationId && memoryStale && <p role="status">{t("app.memory_is_out_of_date_this_inspection")}</p>}
      {!generationId && inspectionCurrent && currentRequest && currentRequest.budget.inputTokens > inputLimit && <div className="recovery" role="status"><p>{t(currentRequest.budget.inputTokens > currentRequest.budget.targetInputTokens ? "errors.the_estimated_input_exceeds_your_target_prepare_context" : "errors.the_estimated_input_plus_reserved_output_exceeds_the")}</p>{summariesEnabled && <button className="secondary" onClick={() => setTab('memory')}>{t("app.review_memory")}</button>}</div>}
      {!generationId && (inspectionError || currentRequest && !inspectionCurrent) && <div role="status">
        <p>{inspectionError || t("app.counting_current_input")}</p>
        {preview.error && <button type="button" className="secondary" onClick={preview.retry}>{t("app.retry_preview")}</button>}
      </div>}{generationId && matchingSavedInspection?.error && <p role="alert">{formatMessage(matchingSavedInspection.error)} <button type="button" className="secondary" onClick={() => setSavedInspectionRetry(value => value + 1)}>{t("app.retry_loading")}</button></p>}
      {shownGeneration?.usage && <p className="small">{t("app.provider_reported_input_output_tokens", { value: shownGeneration.usage.inputTokens.toLocaleString(locale()), value2: shownGeneration.usage.outputTokens.toLocaleString(locale()) })}</p>}
      {shownRequest && <>{shownRequest.warnings?.map((warning, index) => <p role="status" key={warning}>{formatMessage(shownRequest.warningMessages?.[index] ?? warning)}</p>)}<div className="budget"><strong>{t("app.estimated_input_2", { value: shownRequest.budget.inputTokens.toLocaleString(locale()), value2: shownRequest.budget.targetInputTokens.toLocaleString(locale()) })}</strong><InputMeter input={shownRequest.budget.inputTokens} limit={Math.min(shownRequest.budget.targetInputTokens, shownRequest.budget.contextWindow - shownRequest.budget.reservedOutputTokens)} /><span>{t("app.reserved_output_model_window", { value: shownRequest.budget.reservedOutputTokens.toLocaleString(locale()), value2: shownRequest.budget.contextWindow.toLocaleString(locale()) })}</span></div>{shownRequest.layout && <BudgetBreakdown request={shownRequest} />}<LoreInspection request={shownRequest} historical={Boolean(generationId)} /><details className="request-details"><summary>{t("app.endpoint_and_request_body")}</summary><h2>{t("app.endpoint")}</h2><pre>{shownRequest.endpoint}</pre><h2>{t("app.request_body")}</h2><pre data-testid="request-body">{JSON.stringify(shownRequest.body, null, 2)}</pre></details><details><summary>{t("app.turn_identities_and_source_revisions")}</summary><pre>{JSON.stringify(shownRequest.coverage, null, 2)}</pre></details></>}
    </section></ChatWorkspace>}
    {peek && <PromptPeek stale={memoryStale} request={inspectionCurrent ? preview.request : null} error={inspectionError} retry={preview.retry} close={() => setPeek(false)} />}
    {authorNoteOpen && tab === 'story' && snapshot && authorNote.draft && <AuthorNoteDialog key={snapshot.id} note={authorNote.draft} editor={authorNote.editor}
      locked={working || busy || dataChanged} missingMessages={!hasPromptMarker(snapshot.sources.prompt, 'messages')}
      saving={authorNote.saving} error={authorNote.error} storageError={authorNote.storageError} close={() => setAuthorNoteOpen(false)} />}

  </div></ChatDetailsTarget.Provider>;
}

function Login({ session, onLogin }: { session: Session; onLogin: () => Promise<void> }) {
  useLocale();
  const [password, setPassword] = useState('');
  const [error, setError] = useTextState('');
  const [busy, setBusy] = useState(false);
  return <main className="login"><div className="login-card"><span className="brand-mark">{t("app.o")}</span><h1>{session.setupRequired ? t("app.your_stories_start_here") : t("app.welcome_back")}</h1>{session.setupRequired && <p>{t("app.create_the_owner_password_on_the_server")}</p>}<form onSubmit={async (event) => {
    event.preventDefault(); setBusy(true); setError('');
    try { await api(session.setupRequired ? '/setup' : '/login', 'POST', { password }); setPassword(''); await onLogin(); }
    catch (error) { setError(errorText(error, msg("app.could_not_sign_in"))); } finally { setBusy(false); }
  }}><label>{t("app.owner_password")}<input type="password" required minLength={12} maxLength={256} autoComplete={session.setupRequired ? 'new-password' : 'current-password'} value={password} onChange={(event) => setPassword(event.target.value)} /></label>{error && <p role="alert">{error}</p>}<button disabled={busy}>{busy ? t("app.opening") : session.setupRequired ? t("app.create_owner_account") : t("app.sign_in")}</button></form></div></main>;
}
