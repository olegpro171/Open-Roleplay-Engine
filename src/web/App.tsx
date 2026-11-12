import { PinnedTurns, saveTurnPin } from './PinnedTurns';
import { ChatBranches } from './ChatBranches';
import { chatGroupId, preferredBranch, readBranchSelections, storeBranchSelection } from './chat-selection';
import { applyTheme } from './theme';
import { stateLabel } from './localization-labels';
import type { MessageText } from './localization';
import { LocalizedError, formatMessage, useTextState, errorText, t, message as msg, useLocale, locale } from './localization';
import { chatBehaviorStatusSchema, type ChatBehaviorStatus } from '../shared/chat-behavior';
import { isComposerSendKey, isMacKeyboard, isPhoneOrTablet } from './composer-shortcuts';
import { appearanceStatusSchema, defaultAppearance, type AppearanceStatus, type ChatTextScale } from '../shared/appearance';
import { chatDefaultsStatusSchema, initialChatDefaults, type ChatDefaultsStatus } from '../shared/chat-defaults';
import { newId } from './uuid';
import { Icon } from './Icon';
import { ApplicationSettings } from './ApplicationSettings';
import { useMemoryCleanup } from './MemoryCleanupReview';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { ChatToolsSnapshot, RequestPreview } from '../shared/contracts';
import { api, ApiError, datasetChanged } from './api';
import { changeSchema } from '../shared/changes';
import { RefreshQueue, fullRefresh, scopeForChange, type RefreshScope } from './refresh-queue';
import { useRequestPreview } from './useRequestPreview';
import { useGenerationHistory } from './useGenerationHistory';
import { hasPromptMarker, type LibrarySnapshot, type UnchangedLibrary } from '../shared/library';
import { ChatSetup, Libraries, type LibraryTarget } from './Libraries';
import { LibraryDraftContext, useLibraryLeaveGuard } from './LibraryDraft';
import { Dropdown } from './Controls';
import { appendContinuation, trimBoundaryNewlines } from '../shared/text';
import { Memory } from './Memory';
import { PreparationStatus } from './PreparationStatus';
import { transcriptInitialSize, transcriptBatchSize, transcriptWindowLimit, type StorySnapshot } from '../shared/transcript';
import { BudgetBreakdown, InputMeter, PromptPeek, LoreInspection, requestWarnings } from './PromptPeek';
import { WarningDetails, WarningDialog, WarningMessages } from './WarningDialog';
import { useTranscriptScroll } from './useTranscriptScroll';
import { useChatDraft } from './useChatDraft';
import { continueResponse } from './continue-response';
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
type TranscriptJump = { chatId: string; turnId: string; revision: number };
type Edit = { turnId: string; part: 'user' | 'assistant'; text: string; revision: number };
type AppFailure =
  | { kind: 'loading'; message: MessageText }
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

function UnfinishedContinuation({ text, textScale, speechColor }: { text: string; textScale: ChatTextScale; speechColor: string }) {
  useLocale();
  const [open, setOpen] = useState(false);
  return <details onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{t('continue.partial_output')}</summary>
    {open && <ChatMarkdown text={text} textScale={textScale} speechColor={speechColor} />}
  </details>;
}

export function App() {
  useLocale();
  const [dataChanged, setDataChanged] = useState(false);
  useEffect(() => { const changed = () => setDataChanged(true); window.addEventListener('ore-dataset-changed', changed); return () => window.removeEventListener('ore-dataset-changed', changed); }, []);
  const [session, setSession] = useState<Session | null>(null);
  const libraryLeave = useLibraryLeaveGuard(session?.authenticated === true);
  const [chatId, setChatId] = useState<string | null>(lastChat);
  const [branchSelections, setBranchSelections] = useState(readBranchSelections);
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
  const [connectionWarning, setConnectionWarning] = useState<'visible' | 'dismissed' | null>(null);
  const reportLoadFailure = useCallback((message: MessageText) => {
    // A failed background read must not replace the action the user needs to resolve.
    setFailure(current => current?.kind === 'action' ? current : { kind: 'loading', message });
  }, []);
  const [online, setOnline] = useState(false);
  const connected = online && !connectionWarning;
  const [tab, setTab] = useState<'story' | 'settings' | 'request' | 'library' | 'memory' | 'data'>(() => libraryLeave.drafts.recovered() ? 'library' : 'story');
  const visibleTab = useRef(tab);
  visibleTab.current = tab;
  const composerKeyboard = useComposerKeyboard(isIOS && tab === 'story');
  useTouchScrollGuard(isIOS && session?.authenticated === true && tab === 'story');
  const [libraryTarget, setLibraryTarget] = useState<LibraryTarget | null>(null);
  const reviewMemoryCleanup = useMemoryCleanup(command, `${chatId}:${tab}:${session?.authenticated}`);
  const drafts = useChatDraft(chatId);
  const draft = drafts.text;
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState<Edit | null>(null);
  const editForm = useRef<HTMLFormElement>(null);
  const editSaveInFlight = useRef(false);
  const [peek, setPeek] = useState(false);
  const [pinnedChat, setPinnedChat] = useState<string | null>(null);
  const [jumpTarget, setJumpTarget] = useState<TranscriptJump | null>(null);
  const [branchDialog, setBranchDialog] = useState<{ through?: { id: string; ordinal: number } } | null>(null);
  const [authorNoteOpen, setAuthorNoteOpen] = useState(false);
  useEffect(() => { setAuthorNoteOpen(false); setBranchDialog(null); }, [chatId, tab]);
  const [contextExpanded, setContextExpanded] = useState(false);
  const [chatDetailsTarget, setChatDetailsTarget] = useState<HTMLDivElement | null>(null);
  const [generationId, setGenerationId] = useState('');
  const loadId = useRef(0);
  const { transcript, awayFromLatest, scrollToLatest, preservePosition, followingLatest, jumpToTurn } = useTranscriptScroll(tab === 'story' ? snapshot?.id ?? null : null, snapshot, Boolean(edit));
  useLayoutEffect(() => {
    const scroller = transcript.current;
    const form = editForm.current;
    if (!edit || !form || !scroller) return;
    scroller.scrollTop += form.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 16;
  }, [edit?.turnId, edit?.part]);
  const reportServerError = useCallback(() => setConnectionWarning(current => current ?? 'visible'), []);
  const clearServerError = useCallback(() => setConnectionWarning(null), []);
  const refreshSession = useCallback(async () => {
    try {
      const current = await api<Session>('/session');
      if (!current.authenticated && libraryCache.current) {
        // Validate a resumed editor against a fresh Library after sign-in.
        loadId.current++;
        libraryCache.current = null;
        setLibrary(null);
      }
      setSession(current);
      clearServerError();
      return current.authenticated;
    } catch {
      reportServerError();
      return false;
    }
  }, [clearServerError, reportServerError]);
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
      const previousGroup = snapshotRef.current?.groupId;
      let selected = items.chats.find(branch => branch.id === requestedChat)?.id ?? null;
      if (!selected) {
        const groupId = previousGroup && items.chats.some(branch => chatGroupId(branch) === previousGroup)
          ? previousGroup : items.chats[0] && chatGroupId(items.chats[0]);
        if (groupId) {
          const branches = items.chats.filter(branch => chatGroupId(branch) === groupId);
          selected = preferredBranch(branches, branchSelections.get(groupId))?.id ?? null;
        }
      }
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
          const selectionChanged = snapshotRef.current?.id !== state?.id;
          snapshotRef.current = state;
          setSnapshot(state);
          if (state && selectionChanged) {
            const groupId = state.groupId ?? state.id;
            if (branchSelections.get(groupId) !== state.id) {
              setBranchSelections(previous => new Map(previous).set(groupId, state.id));
            }
            storeBranchSelection(groupId, state.id);
            rememberChat(state.id);
          }
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
          if (!selected) rememberChat(null);
        }
        if (!selected) setTab(current => current === 'data' ? current : 'library');
      }
    } catch (error) {
      if (id !== loadId.current) return;
      if (error instanceof ApiError && error.status === 401) void refreshSession();
      else if (error instanceof ApiError && error.status === 404) { setChatId(null); }
      else if (error instanceof ApiError) reportLoadFailure(errorText(error));
      else reportServerError();
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
  const recoverConnection = useCallback(async () => {
    if (await refreshSession()) await refresh();
  }, [refreshSession, refresh]);
  useEffect(() => { void refreshSession(); }, [refreshSession]);
  useEffect(() => {
    if (!connectionWarning) return;
    let checking = false;
    const timer = setInterval(() => {
      if (!checking) { checking = true; void recoverConnection().finally(() => { checking = false; }); }
    }, 2_000);
    return () => clearInterval(timer);
  }, [connectionWarning, recoverConnection]);
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
    const offline = reportServerError;
    const online = () => { void recoverConnection(); };
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('offline', offline);
    window.addEventListener('online', online);
    if (!navigator.onLine) offline();
    return () => {
      events.close();
      setOnline(false);
      document.removeEventListener('visibilitychange', visible);
      window.removeEventListener('offline', offline);
      window.removeEventListener('online', online);
    };
  }, [session?.authenticated, refresh, refreshSession, clearServerError, reportServerError, recoverConnection]);
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

  useLayoutEffect(() => {
    if (!jumpTarget) return;
    if (snapshot?.id === jumpTarget.chatId && tab === 'story') jumpToTurn(jumpTarget.turnId);
    setJumpTarget(null);
  }, [jumpTarget, snapshot?.id, tab, jumpToTurn]);

  async function moveTranscript(direction: 'older' | 'newer' | 'latest' | TranscriptJump, automatic = false) {
    const jump = typeof direction === 'object' ? direction : null;
    const current = snapshotRef.current;
    if (!current || pageBusy.current || editRef.current || datasetChanged() || (jump && current.id !== jump.chatId)) {
      if (jump) throw new LocalizedError(msg('pins.jump_failed'));
      return;
    }
    // The floating action menu takes focus outside the transcript while open.
    const focusedTurn = () => document.activeElement?.closest<HTMLElement>('[data-turn-id]') ??
      transcript.current?.querySelector('[data-turn-id] [aria-haspopup="menu"][aria-expanded="true"]')?.closest<HTMLElement>('[data-turn-id]');
    if (automatic && (focusedTurn() || document.querySelector('dialog[open]'))) return;
    if (direction === 'older' && !current.page.hasOlder || direction === 'newer' && !current.page.hasNewer) return;
    const parameters = new URLSearchParams();
    if (jump) {
      parameters.set('anchor', jump.turnId);
      parameters.set('revision', String(jump.revision));
    } else if (direction !== 'latest') {
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
      if (id !== loadId.current || controller.signal.aborted || datasetChanged() || editRef.current) {
        if (jump) throw new LocalizedError(msg('pins.jump_failed'));
        return;
      }
      const focusedTurnId = focusedTurn()?.dataset.turnId;
      if (jump) {
        if (!state.page.turns.some(turn => turn.id === jump.turnId)) throw new LocalizedError(msg('pins.jump_failed'));
        setPinnedChat(null);
        setJumpTarget(jump);
      } else if (document.querySelector('dialog[open]') || (focusedTurnId && !state.page.turns.some(turn => turn.id === focusedTurnId))) return;
      preservePosition(direction !== 'latest');
      if (direction === 'latest') scrollToLatest();
      snapshotRef.current = state;
      setSnapshot(state);
    } catch (error) {
      if (id === loadId.current && !controller.signal.aborted) {
        if (error instanceof ApiError && error.status === 409) refreshPending.current = true;
        if (error instanceof ApiError && error.status === 401) void refreshSession();
        if (!jump) setPageError(errorText(error, msg("app.cannot_load_this_part_of_the_story")));
      }
      if (jump) throw new LocalizedError(msg('pins.jump_failed'));
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
  const preparation = snapshot?.preparation;
  const preparing = preparation?.status === 'running' ? preparation : undefined;
  const regenerationPreparation = active?.kind === 'regeneration' && preparing?.generationId === active.id;
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
  const hasDraft = Boolean(draft.trim());
  const continuationTarget = !hasDraft && snapshot?.latestTurn?.complete ? snapshot.latestTurn : null;
  const continuationBlocked = continuationTarget?.continuationBlocked;
  const continuationPreview = !continuationBlocked && (!working || active?.kind === 'continuation') && !drafts.needsReview
    ? continuationTarget?.id : undefined;
  const interruption = preparation?.status === 'interrupted' && preparation.generationId === latest?.id
    ? preparation.errorMessage ?? preparation.error : null;
  const latestError = interruption ?? latest?.errorMessage ?? latest?.error;
  const history = useGenerationHistory(snapshot?.id ?? null, tab === 'request', `${toolRefresh}:${snapshot?.latestGeneration?.id}:${snapshot?.latestGeneration?.status}:${snapshot?.latestGeneration?.requestAvailable}`, generationId);
  useEffect(() => {
    if (tab === 'request' && history.missingSelected && !history.loading && !history.error && generationId) setGenerationId('');
  }, [tab, history.missingSelected, history.loading, history.error, generationId]);
  const shownGeneration = history.items.find(generation => generation.id === generationId)
    ?? (history.selected?.id === generationId ? history.selected : null);
  const requestOptions = shownGeneration && !history.items.some(item => item.id === shownGeneration.id)
    ? [shownGeneration, ...history.items] : history.items;
  const savedRequestOptions = requestOptions.map(generation => {
    const date = new Date(generation.createdAt).toLocaleString(locale());
    const status = stateLabel(generation.status);
    return { value: generation.id, label: generation.kind === 'continuation' ? t('continue.attempt_label', { date, status }) : `${date} · ${status}` };
  });
  const preview = useRequestPreview(snapshot, preparing?.mode === 'prepare' || regenerationPreparation ? '' : draft,
    tab !== 'library' && tab !== 'data', tab === 'request' && !generationId || peek,
    tab === 'memory' || tab === 'settings' ? undefined : continuationPreview);
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
  const inspectedBudget = inspectionCurrent ? currentRequest?.budget : undefined;
  const physicalOverflow = Boolean(inspectedBudget && inspectedBudget.inputTokens + inspectedBudget.reservedOutputTokens > inspectedBudget.contextWindow);
  const targetOverflow = Boolean(inspectedBudget && inspectedBudget.inputTokens > inspectedBudget.targetInputTokens);
  const pinsIncluded = Boolean(currentRequest?.allocations.pinned);
  const pinBudgetWarning = physicalOverflow ? 'pins.physical_budget'
    : targetOverflow && !summariesEnabled ? 'pins.required_budget' : null;
  const inspectionBudgetWarning = pinsIncluded ? pinBudgetWarning
    : targetOverflow ? 'errors.the_estimated_input_exceeds_your_target_prepare_context'
    : physicalOverflow ? 'errors.the_estimated_input_plus_reserved_output_exceeds_the' : null;
  const generationById = new Map(snapshot?.page.generations.map(generation => [generation.id, generation]));
  const selectedGenerations = new Map(snapshot?.page.turns.flatMap(turn => {
    const variant = turn.variants?.find(item => item.id === turn.assistant.variantId);
    const generation = variant?.generationId ? generationById.get(variant.generationId) : undefined;
    return generation ? [[turn.id, generation] as const] : [];
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
  const canSubmit = Boolean(snapshot?.connection && !busy && !pending && !working && !memoryStale && !authorNote.pending
    && !dataChanged && !drafts.needsReview && (hasDraft || continuationTarget && !continuationBlocked && !edit));
  const canSaveEdit = Boolean(edit && snapshot?.id === chatId && !busy && !working && !dataChanged);
  const enterKeyBehavior = chatBehaviorError ? 'button-only' : chatBehavior?.settings.enterKeyBehavior ?? 'button-only';
  const mobileKeyboard = isPhoneOrTablet(navigator);
  const macKeyboard = isMacKeyboard(navigator);
  const sendTitle = authorNote.pending ? t('author_note.pending') : busy ? t('app.saving_changes')
    : continuationTarget
      ? formatMessage(continuationBlocked) || (enterKeyBehavior === 'ctrl-enter' ? t(macKeyboard ? 'continue.shortcut_mac' : 'continue.shortcut_ctrl')
        : enterKeyBehavior === 'enter' && !mobileKeyboard ? t('continue.shortcut_enter') : t('continue.action'))
      : enterKeyBehavior === 'ctrl-enter' ? t(macKeyboard ? 'chat_behavior.send_ctrl_mac' : 'chat_behavior.send_ctrl')
        : enterKeyBehavior === 'enter' && !mobileKeyboard ? t('chat_behavior.send_enter') : t('app.send');
  const saveEditTitle = enterKeyBehavior === 'ctrl-enter' ? t(macKeyboard ? 'chat_behavior.save_edit_ctrl_mac' : 'chat_behavior.save_edit_ctrl')
    : enterKeyBehavior === 'enter' && !mobileKeyboard ? t('chat_behavior.save_edit_enter') : t('app.save_edit');

  function submitWithChatShortcut(event: KeyboardEvent<HTMLTextAreaElement>, allowed: boolean) {
    if (!isComposerSendKey(event.nativeEvent, enterKeyBehavior, mobileKeyboard, macKeyboard)) return;
    event.preventDefault();
    if (!event.repeat && allowed) event.currentTarget.form?.requestSubmit();
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    if (!snapshot || !canSubmit || authorNote.editor.getSnapshot().pending || sendInFlight.current) return;
    const id = snapshot.id;
    const sent = continuationTarget ? null : drafts.stage(id, snapshot.revision);
    sendInFlight.current = true;
    setBusy(true); setFailure(null);
    try {
      if (continuationTarget) await continueResponse(id, continuationTarget.id, snapshot.revision);
      else if (sent) {
        await api(`/chats/${id}/turns`, 'POST', sent.submission);
        drafts.acknowledge(id, sent);
      }
      if (selectedChat.current === id) { setPeek(false); scrollToLatest(); forceLatest.current = true; }
    } catch (error) {
      // A server rejection is definite; a lost response is ambiguous, so retain its request identity.
      if (sent && error instanceof ApiError && error.status < 500) drafts.reject(id, sent);
      setFailure({ kind: 'action', message: errorText(error, msg("app.the_request_failed")) });
    } finally {
      await latestRefresh.current();
      sendInFlight.current = false;
      setBusy(false);
    }
  }

  async function saveEdit(event: FormEvent) {
    event.preventDefault();
    if (!edit || !canSaveEdit || editSaveInFlight.current) return;
    editSaveInFlight.current = true;
    try {
      const saved = await command(() => api(`/chats/${chatId}/turns/${edit.turnId}/${edit.part}`, 'PATCH', { revision: edit.revision, text: edit.text }));
      if (saved) setEdit(current => current === edit ? null : current);
    } finally {
      editSaveInFlight.current = false;
    }
  }

  const connectionDialog = connectionWarning === 'visible' && <WarningDialog message={serverUnavailable}
    close={() => setConnectionWarning(current => current === 'visible' ? 'dismissed' : current)}
    actions={() => <button type="button" className="secondary" disabled={busy} onClick={() => void recoverConnection()}>{t("app.retry_loading")}</button>} />;
  const datasetChangeNotice = dataChanged && <div className="error-banner" role="alert"><span>{t("app.application_data_was_imported_or_wiped_in")}</span><button onClick={() => window.location.reload()}>{t("app.reload_current_data")}</button></div>;
  if (!session) return <main className="login"><p>{t("app.opening_ore")}</p>{error && <p role="alert">{error}</p>}{connectionDialog}</main>;
  if (!session.authenticated) return <Login session={session} onLogin={async () => { setFailure(null); await refreshSession(); }} />;
  function openChat(id: string, destination: 'story' | 'settings' = 'story') {
    loadId.current++;
    pageRequest.current?.abort();
    pageBusy.current = false;
    setPageLoading(false);
    setPageError('');
    setChatId(id);
    setTab(destination);
    setEdit(null);
    setPeek(false);
    setBranchDialog(null);
    setPinnedChat(null);
    setGenerationId('');
    if (snapshotRef.current?.id !== id) {
      snapshotRef.current = null;
      setSnapshot(null);
      setToolSnapshot(null);
    }
  }
  if (!library) return <main className="login">{dataChanged ? datasetChangeNotice : <p>{t("app.loading_your_story")}</p>}{error && <p role="alert">{error}</p>}{connectionDialog}</main>;
  const selectedCharacter = library.characters.find(character => character.id === snapshot?.settings.characterId);
  const selectedCharacterPicture = library.characterPictures.find(picture => picture.characterId === snapshot?.settings.characterId);
  const selectedPersona = library.personas.find(persona => persona.id === snapshot?.settings.personaId);
  const selectedCharacterName = selectedCharacter?.name ?? snapshot?.sources.character?.name ?? t("app.character");
  const selectedPersonaName = selectedPersona?.name ?? snapshot?.sources.persona?.name ?? t("app.you");

  function openPins() {
    if (!snapshot) return;
    setTab('story');
    setPinnedChat(snapshot.id);
  }
  const activeBranch = library.chats.find(branch => branch.id === snapshot?.id);
  const chatBranches = activeBranch ? library.chats.filter(branch => chatGroupId(branch) === chatGroupId(activeBranch)) : [];
  const sidebar = snapshot && <>
        <p className="eyebrow">{t("app.current_chat")}</p>
        {appearance.settings.displayCharacterPicture && <ChatCharacterPortrait key={`${snapshot.id}:${selectedCharacterPicture?.key ?? ''}`} picture={selectedCharacterPicture} />}
        <h1>{snapshot.settings.title}</h1>
        <p>{snapshot.connection ? `${snapshot.connection.name} · ${snapshot.connection.model}` : t("app.set_up_a_connection_to_begin")}</p>
        <dl><div><dt>{t("app.total_turns")}</dt><dd>{snapshot.totalTurns}</dd></div><div title={t("app.saved_turns_kept_verbatim_in_the_current")}><dt>{t("app.active_turns")}</dt><dd>{activeTurns}</dd></div><div><dt>{t("app.input_target")}</dt><dd>{snapshot.settings.targetInputTokens.toLocaleString(locale())}</dd></div><div><dt>{t("app.estimated_input")}</dt><dd className={currentRequest && currentRequest.budget.inputTokens > inputLimit ? 'over-limit' : ''}>{currentRequest?.budget.inputTokens.toLocaleString(locale()) ?? '—'}</dd></div></dl>
        <details className="context-dropdown" open={contextExpanded} onToggle={event => setContextExpanded(event.currentTarget.open)}><summary>{t("app.context")}<span>{!summariesEnabled ? t("app.summaries_are_disabled") : snapshot.memory.selectedCount ? t('counts.summaries', { count: snapshot.memory.selectedCount }) : t("app.full_history")}</span></summary>{currentRequest ? <><InputMeter input={currentRequest.budget.inputTokens} limit={inputLimit} /><BudgetBreakdown request={currentRequest} /><button className="secondary" disabled={!inspectionCurrent} onClick={() => setPeek(true)}>{t("app.prompt_peek")}</button></> : <p className="small muted">{inspectionError || t("app.select_a_connection_to_inspect_input")}</p>}</details>
  </>;
  const returnToChat = () => { setTab('story'); setPeek(false); setGenerationId(''); };
  function signOut(returnFocus: HTMLElement) {
    libraryLeave.leave(() => void command(async () => {
      await api('/logout', 'POST', {});
      libraryLeave.drafts.clear();
      setLibraryTarget(null);
      setTab(current => current === 'library' ? 'story' : current);
      setSnapshot(null);
      await refreshSession();
    }), { returnFocus, deferDiscard: true });
  }

  return <ChatDetailsTarget.Provider value={chatDetailsTarget}><div className="app">
    <header className="topbar">
      <div className="brand"><span className="brand-mark" aria-hidden="true">{t("app.o")}</span><div><strong>{t("app.ore")}</strong><small>{t("app.your_stories_room_to_continue")}</small></div></div>
      <nav className="tabs" aria-label={t("app.workspace")}>
        <button disabled={!snapshot || (busy && tab === 'library')} aria-current={tab !== 'library' && tab !== 'data' ? 'page' : undefined} onClick={event => libraryLeave.leave(() => setTab('story'), { returnFocus: event.currentTarget })}>{t("app.story")}</button>
        <button aria-current={tab === 'library' ? 'page' : undefined} onClick={() => { setLibraryTarget(null); setTab('library'); }}>{t("app.libraries")}</button>
        <button disabled={busy && tab === 'library'} aria-current={tab === 'data' ? 'page' : undefined} onClick={event => libraryLeave.leave(() => setTab('data'), { returnFocus: event.currentTarget })}>{t("app.settings")}</button>
      </nav>
      <div className="chat-details-slot" ref={setChatDetailsTarget} />
      <div className="connection-status" role="img" aria-label={connected ? t("app.connected") : t("app.reconnecting")}><span className={connected ? 'dot online' : 'dot'} /></div>
      <button className="quiet signout" disabled={busy} onClick={event => signOut(event.currentTarget)}>{t("app.sign_out")}</button>
    </header>
    {datasetChangeNotice}
    {error && <div className="error-banner" role="alert"><span>{error}</span><div className="actions error-banner-actions">
      {failure?.kind === 'loading' && <button className="quiet" disabled={busy} onClick={() => { setFailure(null); void refresh(); }}>{t("app.retry_loading")}</button>}
      <button className="quiet" onClick={() => setFailure(null)}>{t("app.dismiss")}</button>
    </div></div>}
    <WarningMessages label={t('warning.application')} messages={[
      ...(appearanceError ? [msg("app.using_the_last_loaded_chat_appearance_or", { appearanceError })] : []),
      ...(chatBehaviorError ? [msg('chat_behavior.shortcuts_unavailable', { error: chatBehaviorError })] : []),
    ]} actions={() => <button type="button" className="secondary" onClick={() => void refresh()}>{t('app.retry_loading')}</button>} />
    {tab === 'data' && <ApplicationSettings chatBehavior={behaviorEditor} appearance={appearanceEditor} lan={lanEditor} openLibraries={() => { setLibraryTarget(null); setTab('library'); }} />}
    {snapshot && ['settings', 'memory', 'request'].includes(tab) && toolError && <div className="error-banner" role="alert">{toolError}<button onClick={() => setToolRetry(value => value + 1)}>{t("app.retry_loading")}</button></div>}
    {snapshot && ['settings', 'memory'].includes(tab) && toolSnapshot?.id !== snapshot.id && <main className="document-panel"><p role="status">{t("app.loading_chat_tools")}</p></main>}
    {tab === 'story' && snapshot && <ChatWorkspace sidebar={sidebar} navigation dismissDetails={jumpTarget?.chatId === snapshot.id} actions={<>
        <button className="quiet chat-navigation-action" aria-label={t("app.chat_settings")} onClick={() => setTab('settings')}><Icon name="Settings" />{t("app.chat_settings_2", { value: snapshot.promptDiagnostics?.length ? ` (${snapshot.promptDiagnostics.length})` : '' })}</button>
        <button className="quiet chat-navigation-action" onClick={() => setTab('memory')}><Icon name="List" />{t("app.inspect_memory")}</button>
        <button className="quiet chat-navigation-action" aria-haspopup="dialog" onClick={() => setBranchDialog({})}><Icon name="GitBranch" />{t("branches.title")}</button>
        <button className="quiet chat-navigation-action" aria-haspopup="dialog" onClick={openPins}><Icon name="BookmarkOutline" />{t('pins.title')}</button>
        <button className="quiet chat-navigation-action" onClick={() => setAuthorNoteOpen(true)}><Icon name="TagOutline" />{t('author_note.title')}</button>
        <button className="quiet chat-navigation-action" onClick={() => setTab('request')}><Icon name="Code" />{t("app.request_inspector")}</button>
      </>}>
      <section className="conversation" aria-label={t("app.conversation")}>
        {snapshot.memory.refusalCount > 0 ? <WarningDetails label={t('refusals.review')} message={msg('refusals.notice', { count: snapshot.memory.refusalCount })}
          actions={() => <button type="button" className="secondary" onClick={() => setTab('memory')}>{t('app.review_memory')}</button>} />
          : memoryStale && <WarningDetails label={t("app.memory_needs_review")} message={msg("app.archived_history_changed_repair_the_affected_summaries")}
            actions={() => <button type="button" className="secondary" onClick={() => setTab('memory')}>{t("app.review_memory")}</button>} />}
        {pageError && <div className="recovery" role="alert">{pageError}<button className="secondary" onClick={() => setPageError('')}>{t("app.dismiss")}</button></div>}
        <div className="transcript-frame"><div className="transcript" ref={transcript}>
          {snapshot.page.hasOlder && <div className="history-page-control" data-history-direction="older"><button className="secondary" disabled={pageLoading || Boolean(edit)} onClick={() => void moveTranscript('older')}>{pageLoading ? t("app.loading_history") : t("app.load_older_turns")}</button></div>}
          {snapshot.totalTurns === 0 && <div className="empty-state"><h2>{t("app.set_up_your_story")}</h2><button className="secondary" onClick={() => setTab('settings')}>{t("app.open_chat_settings")}</button></div>}
          {snapshot.page.turns.map((turn) => {
            const generating = active?.turnId === turn.id;
            const continuing = generating && active.kind === 'continuation';
            const cancelled = !turn.complete && latest?.turnId === turn.id && latest.status === 'cancelled';
            const responseText = generating ? active.partialText : !turn.complete && latest?.turnId === turn.id ? latest.partialText : '';
            const visibleResponse = trimBoundaryNewlines(responseText);
            const streamedAddition = continuing && visibleResponse.trim() ? visibleResponse : '';
            const speechColor = selectedCharacter?.speechColor ?? appearance.settings.characterSpeechColor ?? 'var(--speech-character)';
            const continuationOutcome = latest?.turnId === turn.id && latest.kind === 'continuation'
              && ['failed', 'interrupted', 'cancelled'].includes(latest.status) ? latest : null;
            const selectedGeneration = selectedGenerations.get(turn.id);
            const usage = selectedGeneration?.usage;
            const reasoningGeneration = generating ? active : !turn.complete && latest?.turnId === turn.id ? latest
              : selectedGeneration;
            const reasoning = reasoningGeneration?.reasoningText?.trim() ? {
              text: reasoningGeneration.reasoningText, live: generating, chatId: snapshot.id,
              generationId: reasoningGeneration.id, length: reasoningGeneration.reasoningLength ?? 0,
            } : null;
            const showLiveReasoning = appearance.settings.showReasoningDuringGeneration && reasoning && generating && !(continuing ? streamedAddition : responseText);
            const waiting = preparing && preparing.generationId === active?.id ? "app.preparing_memory"
              : reasoning ? "app.reasoning" : "app.waiting_for_first_token";
            const inputVisible = !(turn.complete && turn.user.text === '' && turn.user.revision === 0)
              || (edit?.turnId === turn.id && edit.part === 'user');
            return <article className="turn" key={turn.id} data-turn-id={turn.id} aria-label={t("app.turn", { ordinal: turn.ordinal })}>
            <div className="turn-heading"><span className="turn-number">{turn.pinned && <span className="turn-pinned" title={t('pins.pinned')}><Icon name="Bookmark" /><span className="sr-only">{t('pins.pinned')}</span></span>}{t("app.turn_2", { ordinal: turn.ordinal, value: turn.complete ? summariesEnabled && turn.archived ? t("interface.archived") : '' : t("interface.pending") })}</span>
              {turn.complete && !generating && selectedGeneration && <span className="turn-usage" title={t(selectedGeneration.kind === 'continuation' ? 'continue.usage' : "app.provider_reported_counts_for_the_saved_response")}>
                {usage ? t("app.in_out", { value: usage.inputTokens.toLocaleString(locale()), value2: usage.outputTokens.toLocaleString(locale()) }) : t("app.usage_unavailable")}
              </span>}
            </div>
            {(['user', 'assistant'] as const).filter(part => part !== 'user' || inputVisible).map((part) => <div className={`part ${part}`} key={part}>
              <div className="part-heading"><strong>{part === 'user' ? selectedPersonaName : selectedCharacterName}</strong></div>
              {part === 'assistant' && showLiveReasoning && !continuing && <ReasoningPreview text={reasoning.text} />}
              {edit?.turnId === turn.id && edit.part === part ? <form ref={editForm} onSubmit={saveEdit} className="edit-form">
                <ChatTextarea autoSize enterKeyHint="enter" aria-label={t("app.edit_text", { part })} value={edit.text} readOnly={busy}
                  onKeyDown={event => submitWithChatShortcut(event, canSaveEdit)}
                  onValueChange={text => setEdit({ ...edit, text })} />
                <p className="small muted">{snapshot.settings.lorebookId ? t("app.saving_a_history_edit_starts_fresh_lore") : ""}</p>
                <div className="actions">
                  <button disabled={!canSaveEdit} title={saveEditTitle}>{t("app.save_edit")}</button>
                  <button type="button" className="quiet" onClick={() => setEdit(null)}>{t("app.cancel_edit")}</button>
                </div>
              </form> : <div className="prose">
                {part === 'assistant' && continuing
                  ? <><ChatMarkdown textScale={appearance.settings.chatTextScale} text={streamedAddition ? appendContinuation(turn.assistant.text, streamedAddition) : turn.assistant.text} speechColor={speechColor} />
                    {streamedAddition ? <span className="cursor" aria-label={t("app.generating")} /> : <div className="continuation-progress">
                      {showLiveReasoning && <ReasoningPreview text={reasoning.text} />}
                      <span className="muted" role="status">{t(waiting)}</span><span className="cursor" aria-label={t("app.generating")} />
                    </div>}</>
                  : part === 'assistant' && (!turn.complete || generating && !regenerationPreparation)
                    ? <>{visibleResponse ? <ChatMarkdown textScale={appearance.settings.chatTextScale} text={visibleResponse} speechColor={speechColor} /> : <span className="muted">{generating ? t(waiting) : cancelled ? t("app.generation_cancelled") : t("app.awaiting_response")}</span>}{generating && <span className="cursor" aria-label={t("app.generating")} />}</>
                    : turn[part].text ? <ChatMarkdown textScale={appearance.settings.chatTextScale} text={turn[part].text} speechColor={part === 'user' ? selectedPersona?.speechColor ?? appearance.settings.personaSpeechColor ?? 'var(--speech-persona)' : speechColor} /> : <span className="muted blank">{t("app.blank")}</span>}
              </div>}
              {part === 'assistant' && continuationOutcome && !edit && <div className="continuation-progress">
                <div className="muted small" role="status">{formatMessage(latestError ?? msg('continue.failed'))}</div>
                {continuationOutcome.partialText.trim() && <UnfinishedContinuation key={continuationOutcome.id}
                  text={continuationOutcome.partialText} textScale={appearance.settings.chatTextScale} speechColor={speechColor} />}
              </div>}
            </div>)}
            <TurnControls turn={turn} revision={snapshot.revision} locked={working || busy} editing={Boolean(edit)} inputVisible={inputVisible} reasoning={reasoning}
              continuing={continuing}
              pin={turn.complete ? {
                disabled: dataChanged || snapshot.memory.awaitingReview,
                toggle: () => void command(() => saveTurnPin(snapshot.id, turn.id, snapshot.revision, !turn.pinned)),
              } : undefined}
              fork={turn.complete ? { disabled: authorNote.pending, open: () => setBranchDialog({ through: { id: turn.id, ordinal: turn.ordinal } }) } : undefined}
              action={generating
                ? { kind: 'cancel', disabled: busy, run: () => void command(() => api(`/generations/${active.id}/cancel`, 'POST', {})) }
                : turn.complete && turn.id === snapshot.latestTurn?.id && snapshot.connection
                  ? { kind: 'regenerate', disabled: working || busy || authorNote.pending || Boolean(edit), run: () => void command(() => api(`/chats/${snapshot.id}/turns/${turn.id}/regenerate`, 'POST', { revision: snapshot.revision, requestId: newId() })) }
                  : null}
              select={id => command(() => api(`/chats/${snapshot.id}/turns/${turn.id}/variants/${id}/select`, 'POST', { revision: snapshot.revision }))}
              edit={part => setEdit({ turnId: turn.id, part, text: turn[part].text, revision: snapshot.revision })}
              remove={() => {
                const path = `/chats/${snapshot.id}/turns/${turn.id}`;
                const revision = snapshot.revision;
                void reviewMemoryCleanup({
                  path: `${path}/deletion-impact`, body: { revision }, alwaysConfirm: true,
                  copy: {
                    confirmOnEnter: true, title: msg('app.delete_turn'), actionLabel: msg('app.delete_turn_2'),
                    message: msg(snapshot.settings.lorebookId ? 'app.delete_turn_with_lore' : 'app.delete_this_entire_turn_including_its_saved'),
                  },
                  commit: memoryImpactToken => api(path, 'DELETE', { revision, memoryImpactToken }),
                });
              }} />
          </article>;
          })}
          {snapshot.page.hasNewer && <div className="history-page-control" data-history-direction="newer"><button className="secondary" disabled={pageLoading || Boolean(edit)} onClick={() => void moveTranscript('newer')}>{pageLoading ? t("app.loading_history") : t("app.load_newer_turns")}</button></div>}
          {edit && !snapshot.page.turns.some(turn => turn.id === edit.turnId) && <div className="recovery" role="alert"><div><p>{t("app.the_edited_turn_was_removed_or_replaced")}</p><ChatTextarea aria-label={t("app.unsaved_turn_edit")} value={edit.text} onValueChange={text => setEdit({ ...edit, text })} /><button onClick={() => setEdit(null)}>{t("app.close_edit")}</button></div></div>}
        </div>
          {preparing && <PreparationStatus preparation={preparing} transcript={transcript} hasOlderTurns={snapshot.page.hasOlder} disabled={busy || dataChanged}
            review={() => setTab('memory')}
            stop={() => void command(() => api(preparing.generationId ? `/generations/${preparing.generationId}/cancel` : `/context/jobs/${preparing.id}/cancel`, 'POST', {}))} />}
          {(awayFromLatest || snapshot.page.hasNewer) && <button className="latest-turn secondary" disabled={pageLoading || Boolean(edit)} onClick={() => snapshot.page.hasNewer ? void moveTranscript('latest') : scrollToLatest()}>{t("app.latest_turn")}<Icon name="ArrowLongBottom" /></button>}
        </div>
        {!working && preparation?.generationId === null && preparation.error && ['failed', 'interrupted'].includes(preparation.status) && <div className="recovery" role="status">
          <p>{formatMessage(preparation.errorMessage ?? preparation.error)}</p>
          <button type="button" className="secondary" onClick={() => setTab('memory')}>{t('story_preparation.open_memory')}</button>
        </div>}
        {!active && pending && <div className="recovery" role="status"><div><strong>{t("app.last_turn_is_still_pending")}</strong><p>{latest?.status === 'cancelled' ? t("app.response_cancelled_generate_response_before_next_turn") : formatMessage(latestError ?? msg("app.generate_response_before_next_turn"))}</p>{partial && <small>{t("app.partial_text_is_preserved_for_inspection_it")}</small>}</div><button className="secondary" disabled={busy || working || authorNote.pending} onClick={() => void command(() => api(`/chats/${chatId}/retry`, 'POST', { revision: snapshot.revision, requestId: newId() }))}>{t("app.retry_response")}</button></div>}
        {!active && latest?.kind === 'regeneration' && (latest.status === 'failed' || latest.status === 'interrupted') && <p className="recovery" role="status">{formatMessage(latestError ?? msg("app.regeneration_did_not_finish_try_again"))}</p>}
        {drafts.needsReview && <div className="recovery" role="alert"><p>{t("app.this_browser_draft_predates_a_backup_import")}</p><button onClick={drafts.review}>{t("app.use_recovered_draft")}</button></div>}
        {drafts.storageError && <div className="recovery" role="alert">{t("app.draft_could_not_be_saved_in_this")}</div>}
        {!authorNoteOpen && <AuthorNoteSaveStatus saving={authorNote.saving} error={authorNote.error} retry={authorNote.editor.retry} disabled={working || busy || dataChanged} />}
        {!authorNoteOpen && authorNote.storageError && authorNote.pending && <p role="alert">{t('author_note.storage_failed')}</p>}
        <form className={isIOS ? 'composer composer-ios' : 'composer'} data-keyboard-visible={composerKeyboard || undefined} onSubmit={(event) => void send(event)}>
          {continuationBlocked && <span className="continuation-unavailable muted small">{formatMessage(continuationBlocked)}</span>}
          <ChatTextarea autoSize textScale={appearance.settings.chatTextScale} rows={1} aria-label={t("app.your_next_turn")} id="turn-input" enterKeyHint="enter"
            onKeyDown={event => submitWithChatShortcut(event, canSubmit)}
            placeholder={t("app.what_happens_next")} value={draft} disabled={busy} onValueChange={text => { drafts.change(text); setPeek(false); }} />
          <button className="send-turn" aria-label={t(continuationTarget ? 'continue.action' : "app.send")} title={sendTitle} disabled={!canSubmit} onMouseDown={event => {
            // Touch taps synthesize mousedown before click. Blurring the iOS
            // composer here changes its padding and moves Send out of the tap.
            if (isIOS && event.button === 0 && document.activeElement?.id === 'turn-input') event.preventDefault();
          }}>{continuationTarget ? <Icon name="PlayOutline" /> : <span className="send-icon" aria-hidden="true" />}</button>
        </form>
      </section>
    </ChatWorkspace>}
    {tab === 'library' && <LibraryDraftContext.Provider value={libraryLeave.drafts}>
      <Libraries library={library} defaults={chatDefaults} currentBranchId={snapshot?.id ?? null} branchSelections={branchSelections}
        busy={busy} run={command} openChat={openChat} initialTarget={libraryTarget} recoveredDraft={libraryLeave.drafts.recovered()}
        leaveEditor={libraryLeave.leave} clearDraft={libraryLeave.drafts.clear} />
    </LibraryDraftContext.Provider>}
    {tab === 'settings' && snapshot && toolSnapshot?.id === snapshot.id && <ChatSetup key={snapshot.id} snapshot={toolSnapshot} library={library} busy={busy || working} run={command} sidebar={sidebar} returnToChat={returnToChat} saved={returnToChat} openLibraryItem={target => { setLibraryTarget(target); setTab('library'); }} />}
    {tab === 'memory' && snapshot && toolSnapshot?.id === snapshot.id && <ChatWorkspace sidebar={sidebar} actions={<button type="button" className="secondary" onClick={returnToChat} aria-label={t("app.return_to_chat")} title={t("app.return_to_chat")}><Icon name="Close" /><span>{t("app.return_to_chat")}</span></button>}><Memory behavior={behaviorEditor} key={snapshot.id} snapshot={toolSnapshot} library={library} busy={busy} run={command} openPins={openPins} preparation={preparing} editPreset={id => { setLibraryTarget({ kind: 'contexts', id }); setTab('library'); }} /></ChatWorkspace>}
    {tab === 'request' && snapshot && <ChatWorkspace sidebar={sidebar} actions={<button type="button" className="secondary" onClick={returnToChat} aria-label={t("app.return_to_chat")} title={t("app.return_to_chat")}><Icon name="Close" /><span>{t("app.return_to_chat")}</span></button>}><section className="document-panel chat-panel" aria-label={t("app.request_inspector")}><p className="eyebrow">{t("app.request_inspector_2")}</p><h1>{t("app.see_what_the_model_receives")}</h1><p className="muted">{t("app.current_input_follows_your_saved_setup_and")}</p><div className="inspector-controls"><label>{t("app.inspect_request")}<Dropdown aria-label={t("app.inspect_request")} value={generationId} disabled={history.loading} onChange={setGenerationId} options={[{ value: '', label: t("app.current_request") }, ...savedRequestOptions]} /></label><button className="secondary" disabled={!currentRequest || !inspectionCurrent} onClick={() => setPeek(true)}>{t("app.prompt_peek")}</button></div>
      <div className="actions">{history.newer && <button type="button" className="secondary" disabled={history.loading} onClick={() => void history.move('latest').then(moved => { if (moved) setGenerationId(''); })}>{t('app.latest_requests')}</button>}{history.newer && <button type="button" className="secondary" disabled={history.loading} onClick={() => void history.move('newer').then(moved => { if (moved) setGenerationId(''); })}>{t('app.newer_requests')}</button>}{history.older && <button type="button" className="secondary" disabled={history.loading} onClick={() => void history.move('older').then(moved => { if (moved) setGenerationId(''); })}>{t('app.older_requests')}</button>}</div>
      {history.error && <p role="alert">{formatMessage(history.error)} <button type="button" className="secondary" onClick={history.retry}>{t('app.retry_loading')}</button></p>}
      <p className="small muted">{generationId ? t("app.saved_attempt_its_ceiling_is_historical", { value: shownGeneration ? stateLabel(shownGeneration.status) : t("app.usage_unavailable"), value2: formatMessage(shownGeneration?.errorMessage ?? shownGeneration?.error) }) : t("app.live_preview_of_the_current_setup_and")}</p>
      <WarningMessages key={generationId} messages={[
        ...(!generationId && memoryStale ? [msg("app.memory_is_out_of_date_this_inspection")] : []),
        ...(!generationId && inspectionBudgetWarning ? [msg(inspectionBudgetWarning)] : []),
        ...requestWarnings(shownRequest),
      ]} actions={close => !generationId && inspectionBudgetWarning && <>
        {pinsIncluded && <button type="button" className="secondary" onClick={() => { close(); openPins(); }}>{t('pins.title')}</button>}
        {summariesEnabled && <button type="button" className="secondary" onClick={() => setTab('memory')}>{t("app.review_memory")}</button>}
      </>} />
      {!generationId && (inspectionError || currentRequest && !inspectionCurrent) && <div role="status">
        <p>{inspectionError || t("app.counting_current_input")}</p>
        {preview.error && <button type="button" className="secondary" onClick={preview.retry}>{t("app.retry_preview")}</button>}
      </div>}{generationId && matchingSavedInspection?.error && <p role="alert">{formatMessage(matchingSavedInspection.error)} <button type="button" className="secondary" onClick={() => setSavedInspectionRetry(value => value + 1)}>{t("app.retry_loading")}</button></p>}
      {shownGeneration?.usage && <p className="small">{t("app.provider_reported_input_output_tokens", { value: shownGeneration.usage.inputTokens.toLocaleString(locale()), value2: shownGeneration.usage.outputTokens.toLocaleString(locale()) })}</p>}
      {shownRequest && <><div className="budget"><strong>{t("app.estimated_input_2", { value: shownRequest.budget.inputTokens.toLocaleString(locale()), value2: shownRequest.budget.targetInputTokens.toLocaleString(locale()) })}</strong><InputMeter input={shownRequest.budget.inputTokens} limit={Math.min(shownRequest.budget.targetInputTokens, shownRequest.budget.contextWindow - shownRequest.budget.reservedOutputTokens)} /><span>{t("app.reserved_output_model_window", { value: shownRequest.budget.reservedOutputTokens.toLocaleString(locale()), value2: shownRequest.budget.contextWindow.toLocaleString(locale()) })}</span></div>{shownRequest.layout && <BudgetBreakdown request={shownRequest} />}<LoreInspection request={shownRequest} historical={Boolean(generationId)} /><details className="request-details"><summary>{t("app.endpoint_and_request_body")}</summary><h2>{t("app.endpoint")}</h2><pre>{shownRequest.endpoint}</pre><h2>{t("app.request_body")}</h2><pre data-testid="request-body">{JSON.stringify(shownRequest.body, null, 2)}</pre></details><details><summary>{t("app.turn_identities_and_source_revisions")}</summary><pre>{JSON.stringify(shownRequest.coverage, null, 2)}</pre></details></>}
    </section></ChatWorkspace>}
    {branchDialog && activeBranch?.id === chatId && tab === 'story' && <ChatBranches key={activeBranch.id} current={{ ...activeBranch, revision: snapshot?.revision ?? activeBranch.revision }}
      branches={chatBranches} fork={branchDialog.through} locked={authorNote.pending} close={() => setBranchDialog(null)}
      open={id => openChat(id)} refresh={refresh} />}
    {snapshot && pinnedChat === snapshot.id && tab === 'story' && <PinnedTurns key={snapshot.id} branch={snapshot.id}
      revision={snapshot.revision} estimate={currentRequest} estimateCurrent={inspectionCurrent}
      estimateError={preview.error} retryEstimate={preview.retry} locked={working || busy || dataChanged || snapshot.memory.awaitingReview}
      close={() => setPinnedChat(null)} refresh={refresh}
      jump={(turnId, revision) => moveTranscript({ chatId: snapshot.id, turnId, revision })} />}
    {peek && <PromptPeek stale={memoryStale} request={inspectionCurrent ? preview.request : null} error={inspectionError} retry={preview.retry} close={() => setPeek(false)} />}
    {authorNoteOpen && tab === 'story' && snapshot && authorNote.draft && <AuthorNoteDialog key={snapshot.id} note={authorNote.draft} editor={authorNote.editor}
      locked={working || busy || dataChanged} preparing={Boolean(preparing)} missingMessages={!hasPromptMarker(snapshot.sources.prompt, 'messages')}
      saving={authorNote.saving} error={authorNote.error} storageError={authorNote.storageError} close={() => setAuthorNoteOpen(false)} />}

    {connectionDialog}
  </div></ChatDetailsTarget.Provider>;
}

function Login({ session, onLogin }: { session: Session; onLogin: () => Promise<void> }) {
  useLocale();
  const [password, setPassword] = useState('');
  const [passwordVisible, setPasswordVisible] = useState(false);
  const passwordId = useId();
  useEffect(() => { setPasswordVisible(false); }, [session.setupRequired]);
  const [error, setError] = useTextState('');
  const [busy, setBusy] = useState(false);
  return <main className="login"><div className="login-card"><span className="brand-mark">{t("app.o")}</span><h1>{session.setupRequired ? t("app.your_stories_start_here") : t("app.welcome_back")}</h1>{session.setupRequired && <p>{t("app.create_the_owner_password_on_the_server")}</p>}<form onSubmit={async (event) => {
    event.preventDefault(); setBusy(true); setError('');
    try { await api(session.setupRequired ? '/setup' : '/login', 'POST', { password }); setPassword(''); setPasswordVisible(false); await onLogin(); }
    catch (error) { setError(errorText(error, msg("app.could_not_sign_in"))); } finally { setBusy(false); }
  }}><label htmlFor={passwordId}>{t("app.owner_password")}</label><div className="password-input-row"><input id={passwordId} type={passwordVisible ? 'text' : 'password'} required minLength={12} maxLength={256} autoComplete={session.setupRequired ? 'new-password' : 'current-password'} value={password} onChange={(event) => setPassword(event.target.value)} /><button type="button" className="secondary" aria-label={t(passwordVisible ? "app.hide_password" : "app.show_password")} title={t(passwordVisible ? "app.hide_password" : "app.show_password")} onClick={() => setPasswordVisible(value => !value)}><Icon name={passwordVisible ? "EyeOffOutline" : "EyeOutline"} /></button></div>{error && <p role="alert">{error}</p>}<button disabled={busy}>{busy ? t("app.opening") : session.setupRequired ? t("app.create_owner_account") : t("app.sign_in")}</button></form></div></main>;
}
