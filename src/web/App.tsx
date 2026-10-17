import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { ChatSnapshot, RequestPreview } from '../shared/contracts';
import { api, ApiError } from './api';
import { hasPromptMarker, type LibrarySnapshot } from '../shared/library';
import { ChatSetup, Libraries } from './Libraries';
import { Dropdown } from './Controls';
import { trimBoundaryNewlines } from '../shared/text';
import { Memory } from './Memory';
import { staleSummaries } from '../core/context';
import { refKey } from '../shared/context';
import { BudgetBreakdown, InputMeter, PromptPeek } from './PromptPeek';
import { useTranscriptScroll } from './useTranscriptScroll';
import { useChatDraft } from './useChatDraft';

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
  const [session, setSession] = useState<Session | null>(null);
  const [chatId, setChatId] = useState<string | null>(lastChat);
  const [library, setLibrary] = useState<LibrarySnapshot | null>(null);
  const [snapshot, setSnapshot] = useState<ChatSnapshot | null>(null);
  const [error, setError] = useState('');
  const [online, setOnline] = useState(false);
  const [tab, setTab] = useState<'story' | 'settings' | 'request' | 'library' | 'memory'>('story');
  const drafts = useChatDraft(chatId);
  const draft = drafts.text;
  const [settledDraft, setSettledDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState<Edit | null>(null);
  const [peek, setPeek] = useState(false);
  const [generationId, setGenerationId] = useState('');
  const loadId = useRef(0);
  const { transcript, awayFromLatest, scrollToLatest } = useTranscriptScroll(tab === 'story' ? snapshot?.id ?? null : null, snapshot);
  const clearServerError = useCallback(() => setError(current => current === serverUnavailable ? '' : current), []);
  const refreshSession = useCallback(async () => {
    try { setSession(await api<Session>('/session')); clearServerError(); } catch { setError(serverUnavailable); }
  }, [clearServerError]);
  const refresh = useCallback(async () => {
    const id = ++loadId.current;
    try {
      const items = await api<LibrarySnapshot>('/library');
      const selected = items.chats.find(chat => chat.id === chatId)?.id ?? items.chats[0]?.id ?? null;
      const state = selected ? await api<ChatSnapshot>(`/chats/${selected}`) : null;
      if (id === loadId.current) {
        setSnapshot(state); setLibrary(items); clearServerError();
        if (selected !== chatId) {
          setChatId(selected); setEdit(null); setPeek(false); setGenerationId('');
          rememberChat(selected);
        }
        if (!selected) setTab('library');
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
  const shownRequest = generationId ? shownGeneration?.request : currentRequest;
  const archivedIds = new Set(snapshot?.context.archivedTurnIds);
  const activeTurns = currentRequest?.history?.verbatimTurnIds.filter(id => id !== 'draft').length ?? (snapshot?.turns.filter(turn => !archivedIds.has(turn.id)).length ?? 0);
  const inputLimit = currentRequest ? Math.min(currentRequest.budget.targetInputTokens, currentRequest.budget.contextWindow - currentRequest.budget.reservedOutputTokens) : 0;
  const turnUsage = new Map(snapshot?.generations.filter(generation => generation.status === 'succeeded').slice().reverse().map(generation => [generation.turnId, generation.usage]));
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
    if (!snapshot || busy || pending || !text.trim()) return;
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
  function openChat(id: string) {
    loadId.current++; rememberChat(id); setChatId(id); setTab('story'); setEdit(null); setPeek(false); setGenerationId(''); if (id !== chatId) setSnapshot(null);
  }
  if (!library) return <main className="login"><p>Loading your story…</p>{error && <p role="alert">{error}</p>}</main>;

  return <div className="app">
    <header className="topbar">
      <div className="brand"><span className="brand-mark" aria-hidden="true">O</span><div><strong>ORE</strong><small>Your stories. Room to continue.</small></div></div>
      <nav className="tabs" aria-label="Workspace">
        <button disabled={!snapshot} aria-current={tab === 'story' ? 'page' : undefined} onClick={() => setTab('story')}>Story</button>
        <button disabled={!snapshot} aria-current={tab === 'settings' ? 'page' : undefined} onClick={() => setTab('settings')}>Setup</button>
        <button disabled={!snapshot} aria-current={tab === 'memory' ? 'page' : undefined} onClick={() => setTab('memory')}>Memory</button>
        <button aria-current={tab === 'library' ? 'page' : undefined} onClick={() => setTab('library')}>Libraries</button>
        <button disabled={!snapshot} aria-current={tab === 'request' ? 'page' : undefined} onClick={() => setTab('request')}>Request inspector</button>
      </nav>
      <div className="connection-status"><span className={online ? 'dot online' : 'dot'} />{online ? 'Connected' : 'Reconnecting'}</div>
      <button className="quiet signout" onClick={() => void command(async () => { await api('/logout', 'POST', {}); setSnapshot(null); await refreshSession(); })}>Sign out</button>
    </header>
    {error && <div className="error-banner" role="alert"><span>{error}</span><button className="quiet" onClick={() => setError('')}>Dismiss</button></div>}
    {tab === 'story' && snapshot && <main className="story-layout">
      <aside className="story-meta">
        <p className="eyebrow">CURRENT CHAT</p><h1>{snapshot.settings.title}</h1>
        <p>{snapshot.connection ? `${snapshot.connection.name} · ${snapshot.connection.model}` : 'Set up a Connection to begin.'}</p>
        <dl><div><dt>Total turns</dt><dd>{snapshot.turns.length}</dd></div><div title="Saved turns kept verbatim in the current input, including a pending turn"><dt>Active turns</dt><dd>{activeTurns}</dd></div><div><dt>Input target</dt><dd>{snapshot.settings.targetInputTokens.toLocaleString()}</dd></div><div><dt>Estimated input</dt><dd className={currentRequest && currentRequest.budget.inputTokens > inputLimit ? 'over-limit' : ''}>{currentRequest?.budget.inputTokens.toLocaleString() ?? '—'}</dd></div></dl>
        <details className="context-dropdown"><summary>Context <span>{!summariesEnabled ? 'Summaries are disabled' : snapshot.context.selected.length ? `${snapshot.context.selected.length} summaries` : 'Full history'}</span></summary>{currentRequest ? <><InputMeter input={currentRequest.budget.inputTokens} limit={inputLimit} /><BudgetBreakdown request={currentRequest} /><button className="secondary" disabled={!inspectionCurrent} onClick={() => setPeek(true)}>Prompt peek</button></> : <p className="small muted">{inspectionError || 'Select a Connection to inspect input.'}</p>}</details>
        <button className="secondary" onClick={() => setTab('settings')}>Edit setup</button>
        <button className="quiet" onClick={() => setTab('memory')}>Inspect memory</button>
      </aside>
      <section className="conversation" aria-label="Conversation">
        {memoryStale && <div className="recovery" role="status"><div><strong>Memory needs review.</strong><p>Archived history changed. Repair the affected summaries before continuing.</p></div><button className="secondary" onClick={() => setTab('memory')}>Review memory</button></div>}
        <div className="transcript-frame"><div className="transcript" ref={transcript}>
          {snapshot.turns.length === 0 && <div className="empty-state"><h2>Set up your story</h2><button className="secondary" onClick={() => setTab('settings')}>Setup</button></div>}
          {snapshot.turns.map((turn, index) => <article className="turn" key={turn.id} data-turn-id={turn.id} aria-label={`Turn ${index + 1}`}>
            <div className="turn-heading"><span>TURN {index + 1} {turn.complete ? summariesEnabled && snapshot.context.archivedTurnIds.includes(turn.id) ? '· ARCHIVED' : '' : '· PENDING'}</span>{turn.complete && turnUsage.has(turn.id) && <span className="turn-usage" title="Provider-reported counts for the saved response, before any later edits. Output may include reasoning tokens.">{turnUsage.get(turn.id) ? `${turnUsage.get(turn.id)!.inputTokens.toLocaleString()} in · ${turnUsage.get(turn.id)!.outputTokens.toLocaleString()} out` : 'Usage unavailable'}</span>}<button className="quiet" disabled={working || busy} onClick={() => {
              if (confirm('Delete this entire turn, including its saved request records?')) void command(() => api(`/chats/${chatId}/turns/${turn.id}`, 'DELETE', { revision: snapshot.revision }));
            }}>Delete turn</button></div>
            {(['user', 'assistant'] as const).filter(part => !(part === 'user' && turn.complete && turn.user.text === '' && turn.user.revision === 0 && !(edit?.turnId === turn.id && edit.part === 'user'))).map((part) => <div className={`part ${part}`} key={part}>
              <div className="part-heading"><strong>{part === 'user' ? snapshot.sources.persona?.name ?? 'You' : snapshot.sources.character?.name ?? 'Character'}</strong><button className="quiet" disabled={working || busy || (part === 'assistant' && !turn.complete)} onClick={() => setEdit({ turnId: turn.id, part, text: turn[part].text, revision: snapshot.revision })}>Edit {part === 'user' ? 'input' : 'response'}</button></div>
              {edit?.turnId === turn.id && edit.part === part ? <form onSubmit={saveEdit} className="edit-form"><textarea aria-label={`Edit ${part} text`} value={edit.text} onChange={(event) => setEdit({ ...edit, text: event.target.value })} /><div className="actions"><button disabled={busy}>Save edit</button><button type="button" className="quiet" onClick={() => setEdit(null)}>Cancel edit</button></div></form> : <div className="prose">{part === 'assistant' && !turn.complete ? <>{trimBoundaryNewlines(partial ?? '') || <span className="muted">{active ? 'Waiting for the model…' : 'Awaiting response.'}</span>}{active && <span className="cursor" aria-label="Generating" />}</> : turn[part].text || <span className="muted blank">blank</span>}</div>}
            </div>)}
          </article>)}
        </div>{awayFromLatest && <button className="latest-turn secondary" onClick={scrollToLatest}>Latest turn <span aria-hidden="true">↓</span></button>}</div>
        {active ? <div className="generation-status" role="status"><span>Generating…</span><button className="quiet" disabled={busy} onClick={() => void command(() => api(`/generations/${active.id}/cancel`, 'POST', {}))}>Cancel</button></div> : pending && <div className="recovery" role="status"><div><strong>Last turn is still pending.</strong><p>{latest?.status === 'cancelled' ? 'Response cancelled. Generate response before next turn.' : latest?.error ?? 'Generate response before next turn.'}</p>{partial && <small>Partial text is preserved for inspection. It has not been accepted as a response.</small>}</div><button className="secondary" disabled={busy} onClick={() => void command(() => api(`/chats/${chatId}/retry`, 'POST', { revision: snapshot.revision, requestId: crypto.randomUUID() }))}>Retry response</button></div>}
        <form className="composer" onSubmit={(event) => void send(event)}>
          <textarea aria-label="Your next turn" id="turn-input" placeholder="What happens next?" value={draft} disabled={pending || busy || Boolean(preparing)} onChange={(event) => { drafts.change(event.target.value); setPeek(false); }} />
          <button className="send-turn" disabled={pending || busy || Boolean(preparing) || memoryStale || !snapshot.connection || !draft.trim()}>{busy ? 'Saving…' : 'Send'} <span aria-hidden="true">↗</span></button>
          {drafts.storageError && <span className="composer-status" role="alert">Draft could not be saved in this browser. Keep this page open and copy your text before leaving.</span>}
          {preparing && <span className="composer-status">Preparing memory…</span>}
        </form>
      </section>
    </main>}
    {tab === 'library' && <Libraries library={library} currentChatId={chatId} busy={busy} run={command} openChat={openChat} />}
    {tab === 'settings' && snapshot && <ChatSetup key={snapshot.id} snapshot={snapshot} library={library} busy={busy || working} run={command} saved={() => { setTab('story'); setPeek(false); setGenerationId(''); }} />}
    {tab === 'memory' && snapshot && <Memory key={snapshot.id} snapshot={snapshot} library={library} busy={busy} run={command} />}
    {tab === 'request' && snapshot && <main className="document-panel"><p className="eyebrow">REQUEST INSPECTOR</p><h1>See what the model receives.</h1><p className="muted">Current input follows your saved setup and composer. Saved attempts preserve the exact request and limits used at that time. Credentials stay on the server.</p><div className="inspector-controls"><label>Inspect request<Dropdown aria-label="Inspect request" value={generationId} onChange={setGenerationId} options={[{ value: '', label: 'Current request' }, ...snapshot.generations.map(generation => ({ value: generation.id, label: `${new Date(generation.createdAt).toLocaleString()} · ${generation.status}` }))]} /></label><button className="secondary" disabled={!snapshot.connection || busy} onClick={() => { setGenerationId(''); setSettledDraft(draft); }}>Preview {pending ? 'pending turn' : 'next request'}</button><button className="secondary" disabled={!currentRequest || !inspectionCurrent} onClick={() => setPeek(true)}>Prompt peek</button></div>
      <p className="small muted">{generationId ? `Saved attempt: ${shownGeneration?.status ?? 'unavailable'}. Its ceiling is historical. ${shownGeneration?.error ?? ''}` : 'Live preview of the current setup and composer, before any preparation. It becomes a saved request when generation starts.'}</p>
      {!generationId && memoryStale && <p role="status">Memory is out of date. This inspection includes stale summaries; repair and review them before sending.</p>}
      {!generationId && inspectionError && <p role="status">{inspectionError}</p>}
      {shownGeneration?.usage && <p className="small">Provider reported: {shownGeneration.usage.inputTokens.toLocaleString()} input · {shownGeneration.usage.outputTokens.toLocaleString()} output tokens.</p>}
      {shownRequest && <>{shownRequest.warnings?.map(warning => <p role="status" key={warning}>{warning}</p>)}<div className="budget"><strong>Estimated input: {shownRequest.budget.inputTokens.toLocaleString()} / {shownRequest.budget.targetInputTokens.toLocaleString()}</strong><InputMeter input={shownRequest.budget.inputTokens} limit={Math.min(shownRequest.budget.targetInputTokens, shownRequest.budget.contextWindow - shownRequest.budget.reservedOutputTokens)} /><span>Reserved output: {shownRequest.budget.reservedOutputTokens.toLocaleString()} · Model window: {shownRequest.budget.contextWindow.toLocaleString()}</span></div>{shownRequest.layout && <BudgetBreakdown request={shownRequest} />}<details className="request-details"><summary>Endpoint and request body</summary><h2>Endpoint</h2><pre>{shownRequest.endpoint}</pre><h2>Request body</h2><pre data-testid="request-body">{JSON.stringify(shownRequest.body, null, 2)}</pre></details><details><summary>Turn identities and source revisions</summary><pre>{JSON.stringify(shownRequest.coverage, null, 2)}</pre></details></>}
    </main>}
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
