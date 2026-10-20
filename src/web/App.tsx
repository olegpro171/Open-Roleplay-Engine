import { Icon } from './Icon';
import { ApplicationSettings } from './ApplicationSettings';
import { useConfirmation } from './Confirmation';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { ChatSnapshot, RequestPreview } from '../shared/contracts';
import { api, ApiError, datasetChanged } from './api';
import { characterLabel, personaLabel, hasPromptMarker, type LibrarySnapshot, type UnchangedLibrary } from '../shared/library';
import { ChatSetup, Libraries, type LibraryTarget } from './Libraries';
import { Dropdown } from './Controls';
import { trimBoundaryNewlines } from '../shared/text';
import { Memory } from './Memory';
import { staleSummaries } from '../core/context';
import { refKey } from '../shared/context';
import { BudgetBreakdown, InputMeter, PromptPeek, LoreInspection } from './PromptPeek';
import { useTranscriptScroll } from './useTranscriptScroll';
import { useChatDraft } from './useChatDraft';
import { TurnControls } from './TurnControls';
import { ReasoningPreview } from './Reasoning';
import { ChatMarkdown } from './ChatMarkdown';
import { ChatTextarea } from './ChatTextarea';
import { ChatWorkspace } from './ChatWorkspace';

type Session = { setupRequired: boolean; authenticated: boolean };
type Edit = { turnId: string; part: 'user' | 'assistant'; text: string; revision: number };
const serverUnavailable = 'Cannot reach the server. Check that it is running.';
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
  const [dataChanged, setDataChanged] = useState(false);
  useEffect(() => { const changed = () => setDataChanged(true); window.addEventListener('ore-dataset-changed', changed); return () => window.removeEventListener('ore-dataset-changed', changed); }, []);
  const [session, setSession] = useState<Session | null>(null);
  const [chatId, setChatId] = useState<string | null>(lastChat);
  const [library, setLibrary] = useState<LibrarySnapshot | null>(null);
  const libraryCache = useRef<LibrarySnapshot | null>(null);
  const [snapshot, setSnapshot] = useState<ChatSnapshot | null>(null);
  const [error, setError] = useState('');
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
  const [generationId, setGenerationId] = useState('');
  const loadId = useRef(0);
  const { transcript, awayFromLatest, scrollToLatest } = useTranscriptScroll(tab === 'story' ? snapshot?.id ?? null : null, snapshot, edit);
  const clearServerError = useCallback(() => setError(current => current === serverUnavailable ? '' : current), []);
  const refreshSession = useCallback(async () => {
    try { setSession(await api<Session>('/session')); clearServerError(); } catch { setError(serverUnavailable); }
  }, [clearServerError]);
  const refresh = useCallback(async () => {
    const id = ++loadId.current;
    try {
      const cached = libraryCache.current;
      const update = await api<LibrarySnapshot | UnchangedLibrary>(`/library${cached ? `?knownRevision=${cached.revision}` : ''}`);
      // Keep existing editors/transcript available to copy after a dataset replacement.
      if (datasetChanged()) return;
      let items: LibrarySnapshot;
      if ('unchanged' in update) {
        if (!cached || cached.revision !== update.revision) throw new Error('Library refresh has no matching saved version. Reload this page.');
        items = { ...cached, chats: update.chats };
      } else items = update;
      const selected = items.chats.find(chat => chat.id === chatId)?.id ?? items.chats[0]?.id ?? null;
      const state = selected ? await api<ChatSnapshot>(`/chats/${selected}`) : null;
      if (id === loadId.current && !datasetChanged()) {
        libraryCache.current = items;
        setSnapshot(state); setLibrary(items); clearServerError();
        if (selected !== chatId) {
          setChatId(selected); setEdit(null); setPeek(false); setGenerationId('');
          rememberChat(selected);
        }
        if (!selected) setTab(current => current === 'data' ? current : 'library');
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) void refreshSession();
      else if (error instanceof ApiError && error.status === 404) { setChatId(null); }
      else setError(error instanceof ApiError ? error.message : serverUnavailable);
    }
  }, [refreshSession, chatId, clearServerError]);
  const latestRefresh = useRef(refresh);
  latestRefresh.current = refresh;
  const selectedChat = useRef(chatId);
  selectedChat.current = chatId;
  useEffect(() => { void refreshSession(); }, [refreshSession]);
  useEffect(() => {
    if (error !== serverUnavailable) return;
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
  const active = snapshot?.generations.find((generation) => generation.status === 'running');
  const preparing = snapshot?.context.jobs.find(job => job.status === 'running');
  const working = Boolean(active || preparing);
  const outdated = snapshot ? staleSummaries(snapshot.turns, snapshot.context) : new Set<string>();
  const summariesEnabled = hasPromptMarker(snapshot?.sources.prompt, 'summary');
  const memoryStale = summariesEnabled && (snapshot?.context.selected.some(ref => outdated.has(refKey(ref))) ?? false);
  const pending = snapshot?.turns.at(-1)?.complete === false;
  const latest = snapshot?.generations[0];
  const shownGeneration = snapshot?.generations.find((generation) => generation.id === generationId);
  const [inspection, setInspection] = useState<{ chatId: string | null; key: string; request: RequestPreview | null; error: string }>({ chatId: null, key: '', request: null, error: '' });
  const inspectionKey = JSON.stringify([snapshot?.id, snapshot?.revision, snapshot?.context.revision, snapshot?.connection, draft, pending]);
  useEffect(() => {
    if (!snapshot?.connection || (!pending && draft !== settledDraft)) return;
    let current = true;
    api<RequestPreview>(`/chats/${snapshot.id}/preview`, 'POST', { revision: snapshot.revision, inspection: true, ...(!pending ? { text: draft } : {}) })
      .then(request => { if (current) setInspection({ chatId: snapshot.id, key: inspectionKey, request, error: '' }); })
      .catch(error => { if (current) setInspection(previous => ({ chatId: snapshot.id, key: inspectionKey, request: previous.chatId === snapshot.id ? previous.request : null, error: error.message })); });
    return () => { current = false; };
  }, [inspectionKey, settledDraft]);
  const currentRequest = snapshot?.connection && inspection.chatId === snapshot.id ? inspection.request : null;
  const inspectionCurrent = inspection.key === inspectionKey && !inspection.error;
  const inspectionError = inspection.key === inspectionKey ? inspection.error : currentRequest ? '' : snapshot?.connection ? 'Counting current input…' : '';
  const [savedInspection, setSavedInspection] = useState<{ chatId: string; generationId: string; request: RequestPreview | null; error: string } | null>(null);
  const savedRequestPresent = Boolean(shownGeneration?.request);
  useEffect(() => {
    if (!snapshot || !generationId || !savedRequestPresent) return;
    let current = true;
    api<RequestPreview | null>(`/chats/${snapshot.id}/generations/${generationId}/request`).then(request => {
      if (current) setSavedInspection({ chatId: snapshot.id, generationId, request, error: '' });
    }).catch(error => { if (current) setSavedInspection({ chatId: snapshot.id, generationId, request: null, error: error.message }); });
    return () => { current = false; };
  }, [snapshot?.id, generationId, savedRequestPresent]);
  const matchingSavedInspection = savedInspection?.chatId === snapshot?.id && savedInspection?.generationId === generationId ? savedInspection : null;
  const shownRequest = generationId ? matchingSavedInspection?.request ?? shownGeneration?.request : currentRequest;
  const archivedIds = new Set(snapshot?.context.archivedTurnIds);
  const activeTurns = currentRequest?.history?.verbatimTurnIds.filter(id => id !== 'draft').length ?? (snapshot?.turns.filter(turn => !archivedIds.has(turn.id)).length ?? 0);
  const inputLimit = currentRequest ? Math.min(currentRequest.budget.targetInputTokens, currentRequest.budget.contextWindow - currentRequest.budget.reservedOutputTokens) : 0;
  const generationById = new Map(snapshot?.generations.map(generation => [generation.id, generation]));
  const turnUsage = new Map(snapshot?.turns.flatMap(turn => {
    const variant = turn.variants?.find(item => item.id === turn.assistant.variantId);
    const generation = variant?.generationId ? generationById.get(variant.generationId) : undefined;
    return generation ? [[turn.id, generation.usage] as const] : [];
  }));
  const partial = active?.partialText ?? (pending ? latest?.partialText : '');

  async function command(action: () => Promise<unknown>): Promise<boolean> {
    setBusy(true); setError('');
    try { await action(); await refresh(); return true; }
    catch (error) {
      setError(error instanceof Error ? error.message : 'The request failed.');
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
      if (selectedChat.current === id) { setPeek(false); scrollToLatest(); }
    } catch (error) {
      // A server rejection is definite; a lost response is ambiguous, so retain its request identity.
      if (error instanceof ApiError && error.status < 500) drafts.reject(id, sent);
      setError(error instanceof Error ? error.message : 'The request failed.');
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

  if (!session) return <main className="login"><p>Opening ORE…</p>{error && <p role="alert">{error}</p>}</main>;
  if (!session.authenticated) return <Login session={session} onLogin={async () => { setError(''); await refreshSession(); }} />;
  function openChat(id: string, destination: 'story' | 'settings' = 'story') {
    loadId.current++; rememberChat(id); setChatId(id); setTab(destination); setEdit(null); setPeek(false); setGenerationId(''); if (id !== chatId) setSnapshot(null);
  }
  if (!library) return <main className="login"><p>Loading your story…</p>{error && <p role="alert">{error}</p>}</main>;
  const selectedCharacterLabel = characterLabel(library.characters.find(character => character.id === snapshot?.settings.characterId) ?? snapshot?.sources.character ?? { name: 'Character' });
  const selectedPersonaLabel = personaLabel(library.personas.find(persona => persona.id === snapshot?.settings.personaId) ?? snapshot?.sources.persona ?? { name: 'You' });

  const sidebar = snapshot && <>
        <p className="eyebrow">CURRENT CHAT</p><h1>{snapshot.settings.title}</h1>
        <p>{snapshot.connection ? `${snapshot.connection.name} · ${snapshot.connection.model}` : 'Set up a Connection to begin.'}</p>
        <dl><div><dt>Total turns</dt><dd>{snapshot.turns.length}</dd></div><div title="Saved turns kept verbatim in the current input, including a pending turn"><dt>Active turns</dt><dd>{activeTurns}</dd></div><div><dt>Input target</dt><dd>{snapshot.settings.targetInputTokens.toLocaleString()}</dd></div><div><dt>Estimated input</dt><dd className={currentRequest && currentRequest.budget.inputTokens > inputLimit ? 'over-limit' : ''}>{currentRequest?.budget.inputTokens.toLocaleString() ?? '—'}</dd></div></dl>
        <details className="context-dropdown" open={contextExpanded} onToggle={event => setContextExpanded(event.currentTarget.open)}><summary>Context <span>{!summariesEnabled ? 'Summaries are disabled' : snapshot.context.selected.length ? `${snapshot.context.selected.length} summaries` : 'Full history'}</span></summary>{currentRequest ? <><InputMeter input={currentRequest.budget.inputTokens} limit={inputLimit} /><BudgetBreakdown request={currentRequest} /><button className="secondary" disabled={!inspectionCurrent} onClick={() => setPeek(true)}>Prompt peek</button></> : <p className="small muted">{inspectionError || 'Select a Connection to inspect input.'}</p>}</details>
  </>;
  const returnToChat = () => { setTab('story'); setPeek(false); setGenerationId(''); };

  return <div className="app">
    <header className="topbar">
      <div className="brand"><span className="brand-mark" aria-hidden="true">O</span><div><strong>ORE</strong><small>Your stories. Room to continue.</small></div></div>
      <nav className="tabs" aria-label="Workspace">
        <button disabled={!snapshot} aria-current={tab !== 'library' && tab !== 'data' ? 'page' : undefined} onClick={() => setTab('story')}>Story</button>
        <button aria-current={tab === 'library' ? 'page' : undefined} onClick={() => { setLibraryTarget(null); setTab('library'); }}>Libraries</button>
        <button aria-current={tab === 'data' ? 'page' : undefined} onClick={() => setTab('data')}>Settings</button>
      </nav>
      <div className="connection-status"><span className={online ? 'dot online' : 'dot'} />{online ? 'Connected' : 'Reconnecting'}</div>
      <button className="quiet signout" onClick={() => void command(async () => { await api('/logout', 'POST', {}); setSnapshot(null); await refreshSession(); })}>Sign out</button>
    </header>
    {dataChanged && <div className="error-banner" role="alert"><span>Application data was imported or wiped in another tab. Old edits cannot be saved. Copy any unsaved editor text, then reload to review the current data. Browser composer drafts remain recoverable.</span><button onClick={() => window.location.reload()}>Reload current data</button></div>}
    {error && <div className="error-banner" role="alert"><span>{error}</span><button className="quiet" onClick={() => setError('')}>Dismiss</button></div>}
    {tab === 'data' && <ApplicationSettings openLibraries={() => { setLibraryTarget(null); setTab('library'); }} />}
    {tab === 'story' && snapshot && <ChatWorkspace sidebar={sidebar} actions={<>
        <button className="secondary" aria-label="Chat settings" onClick={() => setTab('settings')}>Chat settings{snapshot.promptDiagnostics?.length ? ` (${snapshot.promptDiagnostics.length})` : ''}</button>
        <button className="secondary" onClick={() => setTab('memory')}>Inspect memory</button>
        <button className="secondary" onClick={() => setTab('request')}>Request inspector</button>
      </>}>
      <section className="conversation" aria-label="Conversation">
        {memoryStale && <div className="recovery" role="status"><div><strong>Memory needs review.</strong><p>Archived history changed. Repair the affected summaries before continuing.</p></div><button className="secondary" onClick={() => setTab('memory')}>Review memory</button></div>}
        <div className="transcript-frame"><div className="transcript" ref={transcript}>
          {snapshot.turns.length === 0 && <div className="empty-state"><h2>Set up your story</h2><button className="secondary" onClick={() => setTab('settings')}>Open chat settings</button></div>}
          {snapshot.turns.map((turn, index) => {
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
            return <article className="turn" key={turn.id} data-turn-id={turn.id} aria-label={`Turn ${index + 1}`}>
            <div className="turn-heading"><span>TURN {index + 1} {turn.complete ? summariesEnabled && snapshot.context.archivedTurnIds.includes(turn.id) ? '· ARCHIVED' : '' : '· PENDING'}</span>{turn.complete && !generating && turnUsage.has(turn.id) && <span className="turn-usage" title="Provider-reported counts for the saved response, before any later edits. Output may include reasoning tokens.">{turnUsage.get(turn.id) ? `${turnUsage.get(turn.id)!.inputTokens.toLocaleString()} in · ${turnUsage.get(turn.id)!.outputTokens.toLocaleString()} out` : 'Usage unavailable'}</span>}</div>
            {(['user', 'assistant'] as const).filter(part => part !== 'user' || inputVisible).map((part) => <div className={`part ${part}`} key={part}>
              <div className="part-heading"><strong>{part === 'user' ? selectedPersonaLabel : selectedCharacterLabel}</strong></div>
              {part === 'assistant' && reasoning && generating && !responseText && <ReasoningPreview text={reasoning.text} />}
              {edit?.turnId === turn.id && edit.part === part ? <form onSubmit={saveEdit} className="edit-form"><ChatTextarea autoSize aria-label={`Edit ${part} text`} value={edit.text} onValueChange={text => setEdit({ ...edit, text })} /><p className="small muted">{snapshot.settings.lorebookId ? "Saving a history edit starts fresh lore activation history for this chat." : ""}</p><div className="actions"><button disabled={busy}>Save edit</button><button type="button" className="quiet" onClick={() => setEdit(null)}>Cancel edit</button></div></form> : <div className="prose">
                {part === 'assistant' && (!turn.complete || generating)
                  ? <>{trimBoundaryNewlines(responseText) ? <ChatMarkdown text={trimBoundaryNewlines(responseText)} /> : <span className="muted">{generating ? 'Waiting for first token…' : cancelled ? 'Generation cancelled.' : 'Awaiting response.'}</span>}{generating && <span className="cursor" aria-label="Generating" />}</>
                  : turn[part].text ? <ChatMarkdown text={turn[part].text} /> : <span className="muted blank">blank</span>}
              </div>}
            </div>)}
            <TurnControls turn={turn} locked={working || busy} editing={Boolean(edit)} inputVisible={inputVisible} reasoning={reasoning}
              action={generating
                ? { kind: 'cancel', disabled: busy, run: () => void command(() => api(`/generations/${active.id}/cancel`, 'POST', {})) }
                : turn.complete && index === snapshot.turns.length - 1 && snapshot.connection
                  ? { kind: 'regenerate', disabled: working || busy || Boolean(edit), run: () => void command(() => api(`/chats/${snapshot.id}/turns/${turn.id}/regenerate`, 'POST', { revision: snapshot.revision, requestId: crypto.randomUUID() })) }
                  : null}
              select={id => command(() => api(`/chats/${snapshot.id}/turns/${turn.id}/variants/${id}/select`, 'POST', { revision: snapshot.revision }))}
              edit={part => setEdit({ turnId: turn.id, part, text: turn[part].text, revision: snapshot.revision })}
              remove={() => {
                confirmAction({ title: 'Delete turn?', message: `Delete this entire turn, including its saved request records?${snapshot.settings.lorebookId ? ' Lore activation history for this chat will start fresh.' : ''}`, actionLabel: 'Delete turn', onConfirm: () => { void command(() => api(`/chats/${chatId}/turns/${turn.id}`, 'DELETE', { revision: snapshot.revision })); } });
              }} />
          </article>;
          })}
        </div>{awayFromLatest && <button className="latest-turn secondary" onClick={scrollToLatest}>Latest turn <Icon name="ArrowLongBottom" /></button>}</div>
        {!active && pending && <div className="recovery" role="status"><div><strong>Last turn is still pending.</strong><p>{latest?.status === 'cancelled' ? 'Response cancelled. Generate response before next turn.' : latest?.error ?? 'Generate response before next turn.'}</p>{partial && <small>Partial text is preserved for inspection. It has not been accepted as a response.</small>}</div><button className="secondary" disabled={busy} onClick={() => void command(() => api(`/chats/${chatId}/retry`, 'POST', { revision: snapshot.revision, requestId: crypto.randomUUID() }))}>Retry response</button></div>}
        {!active && latest?.kind === 'regeneration' && (latest.status === 'failed' || latest.status === 'interrupted') && <p className="recovery" role="status">{latest.error ?? 'Regeneration did not finish. Try again.'}</p>}
        {drafts.needsReview && <div className="recovery" role="alert"><p>This browser draft predates a backup import or wipe. Review its text and the restored story before sending. Its previous staged send has no retry authority.</p><button onClick={drafts.review}>Use recovered draft</button></div>}
        <form className="composer" onSubmit={(event) => void send(event)}>
          <ChatTextarea autoSize rows={1} aria-label="Your next turn" id="turn-input" placeholder="What happens next?" value={draft} disabled={pending || busy || working} onValueChange={text => { drafts.change(text); setPeek(false); }} />
          <button className="send-turn" title={busy ? 'Saving changes…' : undefined} disabled={pending || busy || working || memoryStale || dataChanged || drafts.needsReview || !snapshot.connection || !draft.trim()}>Send <Icon name="ArrowShortForward" /></button>
          {drafts.storageError && <span className="composer-status" role="alert">Draft could not be saved in this browser. Keep this page open and copy your text before leaving.</span>}
          {preparing && <span className="composer-status">Preparing memory…</span>}
        </form>
      </section>
    </ChatWorkspace>}
    {tab === 'library' && <Libraries library={library} currentChatId={chatId} busy={busy} run={command} openChat={openChat} initialTarget={libraryTarget} />}
    {tab === 'settings' && snapshot && <ChatSetup key={snapshot.id} snapshot={snapshot} library={library} busy={busy || working} run={command} sidebar={sidebar} returnToChat={returnToChat} saved={returnToChat} openLibraryItem={target => { setLibraryTarget(target); setTab('library'); }} />}
    {tab === 'memory' && snapshot && <ChatWorkspace sidebar={sidebar} actions={<button className="secondary" onClick={returnToChat}>Return to chat</button>}><Memory key={snapshot.id} snapshot={snapshot} library={library} busy={busy} run={command} /></ChatWorkspace>}
    {tab === 'request' && snapshot && <ChatWorkspace sidebar={sidebar} actions={<button className="secondary" onClick={returnToChat}>Return to chat</button>}><section className="document-panel chat-panel" aria-label="Request inspector"><p className="eyebrow">REQUEST INSPECTOR</p><h1>See what the model receives.</h1><p className="muted">Current input follows your saved setup and composer. Saved attempts preserve the exact request and limits used at that time. Credentials stay on the server.</p><div className="inspector-controls"><label>Inspect request<Dropdown aria-label="Inspect request" value={generationId} onChange={setGenerationId} options={[{ value: '', label: 'Current request' }, ...snapshot.generations.map(generation => ({ value: generation.id, label: `${new Date(generation.createdAt).toLocaleString()} · ${generation.status}` }))]} /></label><button className="secondary" disabled={!snapshot.connection || busy} onClick={() => { setGenerationId(''); setSettledDraft(draft); }}>Preview {pending ? 'pending turn' : 'next request'}</button><button className="secondary" disabled={!currentRequest || !inspectionCurrent} onClick={() => setPeek(true)}>Prompt peek</button></div>
      <p className="small muted">{generationId ? `Saved attempt: ${shownGeneration?.status ?? 'unavailable'}. Its ceiling is historical. ${shownGeneration?.error ?? ''}` : 'Live preview of the current setup and composer, before any preparation. It becomes a saved request when generation starts.'}</p>
      {!generationId && memoryStale && <p role="status">Memory is out of date. This inspection includes stale summaries; repair and review them before sending.</p>}
      {!generationId && inspectionError && <p role="status">{inspectionError}</p>}{generationId && matchingSavedInspection?.error && <p role="alert">{matchingSavedInspection.error}</p>}
      {shownGeneration?.usage && <p className="small">Provider reported: {shownGeneration.usage.inputTokens.toLocaleString()} input · {shownGeneration.usage.outputTokens.toLocaleString()} output tokens.</p>}
      {shownRequest && <>{shownRequest.warnings?.map(warning => <p role="status" key={warning}>{warning}</p>)}<div className="budget"><strong>Estimated input: {shownRequest.budget.inputTokens.toLocaleString()} / {shownRequest.budget.targetInputTokens.toLocaleString()}</strong><InputMeter input={shownRequest.budget.inputTokens} limit={Math.min(shownRequest.budget.targetInputTokens, shownRequest.budget.contextWindow - shownRequest.budget.reservedOutputTokens)} /><span>Reserved output: {shownRequest.budget.reservedOutputTokens.toLocaleString()} · Model window: {shownRequest.budget.contextWindow.toLocaleString()}</span></div>{shownRequest.layout && <BudgetBreakdown request={shownRequest} />}<LoreInspection request={shownRequest} historical={Boolean(generationId)} /><details className="request-details"><summary>Endpoint and request body</summary><h2>Endpoint</h2><pre>{shownRequest.endpoint}</pre><h2>Request body</h2><pre data-testid="request-body">{JSON.stringify(shownRequest.body, null, 2)}</pre></details><details><summary>Turn identities and source revisions</summary><pre>{JSON.stringify(shownRequest.coverage, null, 2)}</pre></details></>}
    </section></ChatWorkspace>}
    {peek && currentRequest && <PromptPeek stale={memoryStale} request={currentRequest} close={() => setPeek(false)} />}

  </div>;
}

function Login({ session, onLogin }: { session: Session; onLogin: () => Promise<void> }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return <main className="login"><div className="login-card"><span className="brand-mark">O</span><p className="eyebrow">ORE</p><h1>{session.setupRequired ? 'Your stories start here.' : 'Welcome back.'}</h1><p>{session.setupRequired ? 'Create the owner password on the server computer. Use it to access your saved chat from your devices.' : 'Sign in to continue your story.'}</p><form onSubmit={async (event) => {
    event.preventDefault(); setBusy(true); setError('');
    try { await api(session.setupRequired ? '/setup' : '/login', 'POST', { password }); setPassword(''); await onLogin(); }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not sign in.'); } finally { setBusy(false); }
  }}><label>Owner password<input type="password" required minLength={12} maxLength={256} autoComplete={session.setupRequired ? 'new-password' : 'current-password'} value={password} onChange={(event) => setPassword(event.target.value)} /></label><small className="muted">At least 12 characters.</small>{error && <p role="alert">{error}</p>}<button disabled={busy}>{busy ? 'Opening…' : session.setupRequired ? 'Create owner account' : 'Sign in'}</button></form><p className="small muted">Access from other devices requires HTTPS.</p></div></main>;
}
