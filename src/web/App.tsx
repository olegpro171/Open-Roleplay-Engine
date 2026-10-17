import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { ChatSnapshot, RequestPreview } from '../shared/contracts';
import { api, ApiError } from './api';
import type { LibrarySnapshot } from '../shared/library';
import { ChatSetup, Libraries } from './Libraries';
import { Dropdown } from './Controls';
import { trimBoundaryNewlines } from '../shared/text';
import { Memory } from './Memory';
import { staleSummaries } from '../core/context';
import { refKey } from '../shared/context';

type Session = { setupRequired: boolean; authenticated: boolean };
type Edit = { turnId: string; part: 'user' | 'assistant'; text: string; revision: number };

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [chatId, setChatId] = useState<string | null>(() => localStorage.getItem('roleplay-chat') ?? 'main');
  const [library, setLibrary] = useState<LibrarySnapshot | null>(null);
  const [snapshot, setSnapshot] = useState<ChatSnapshot | null>(null);
  const [error, setError] = useState('');
  const [online, setOnline] = useState(false);
  const [tab, setTab] = useState<'story' | 'settings' | 'request' | 'library' | 'memory'>('story');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState<Edit | null>(null);
  const [preview, setPreview] = useState<RequestPreview | null>(null);
  const [generationId, setGenerationId] = useState('');
  const loadId = useRef(0);
  const submission = useRef<{ requestId: string; revision: number; text: string } | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const refreshSession = useCallback(async () => {
    try { setSession(await api<Session>('/session')); } catch { setError('Cannot reach the server. Check that it is running.'); }
  }, []);
  const refresh = useCallback(async () => {
    const id = ++loadId.current;
    try {
      const items = await api<LibrarySnapshot>('/library');
      const selected = items.chats.find(chat => chat.id === chatId)?.id ?? items.chats[0]?.id ?? null;
      const state = selected ? await api<ChatSnapshot>(`/chats/${selected}`) : null;
      if (id === loadId.current) {
        setSnapshot(state); setLibrary(items);
        if (selected !== chatId) {
          setChatId(selected); setDraft(''); setEdit(null); setPreview(null); setGenerationId(''); submission.current = null;
          if (selected) localStorage.setItem('roleplay-chat', selected); else localStorage.removeItem('roleplay-chat');
        }
        if (!selected) setTab('library');
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) void refreshSession();
      else if (error instanceof ApiError && error.status === 404) { setChatId(null); }
      else setError(error instanceof Error ? error.message : 'Could not load this chat.');
    }
  }, [refreshSession, chatId]);
  useEffect(() => { void refreshSession(); }, [refreshSession]);
  useEffect(() => {
    if (!session?.authenticated) return;
    void refresh();
    const events = new EventSource('/api/events');
    events.onopen = () => { setOnline(true); void refresh(); };
    events.onmessage = () => { void refresh(); };
    events.onerror = () => { setOnline(false); void refreshSession(); };
    const visible = () => { if (document.visibilityState === 'visible') { void refreshSession(); void refresh(); } };
    document.addEventListener('visibilitychange', visible);
    return () => { events.close(); setOnline(false); document.removeEventListener('visibilitychange', visible); };
  }, [session?.authenticated, refresh, refreshSession]);

  useEffect(() => { setPreview(null); }, [snapshot?.revision, snapshot?.id]);
  const active = snapshot?.generations.find((generation) => generation.status === 'running');
  const preparing = snapshot?.context.jobs.find(job => job.status === 'running');
  const working = Boolean(active || preparing);
  const outdated = snapshot ? staleSummaries(snapshot.turns, snapshot.context) : new Set<string>();
  const memoryStale = snapshot?.context.selected.some(ref => outdated.has(refKey(ref))) ?? false;
  const pending = snapshot?.turns.at(-1)?.complete === false;
  const latest = snapshot?.generations[0];
  const shownGeneration = snapshot?.generations.find((generation) => generation.id === generationId) ?? latest;
  const shownRequest = preview ?? shownGeneration?.request;
  const partial = active?.partialText ?? (pending ? latest?.partialText : '');
  useEffect(() => {
    if (following.current && tab === 'story') bottom.current?.scrollIntoView({ behavior: 'instant', block: 'end' });
  }, [snapshot, tab]);

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
    if (!submission.current || submission.current.text !== text) submission.current = { requestId: crypto.randomUUID(), revision: snapshot.revision, text };
    if (await command(() => api(`/chats/${chatId}/turns`, 'POST', submission.current))) {
      submission.current = null; setDraft(''); setPreview(null); following.current = true;
    } else {
      // A revision conflict is reconciled by the refresh; preserve identity on an ambiguous network failure.
      const state = await api<ChatSnapshot>(`/chats/${chatId}`).catch(() => null);
      if (state && state.revision !== submission.current?.revision) submission.current = null;
    }
  }
  async function saveEdit(event: FormEvent) {
    event.preventDefault();
    if (!edit) return;
    if (await command(() => api(`/chats/${chatId}/turns/${edit.turnId}/${edit.part}`, 'PATCH', { revision: edit.revision, text: edit.text }))) setEdit(null);
  }

  if (!session) return <main className="login"><p>Opening Roleplay Engine…</p>{error && <p role="alert">{error}</p>}</main>;
  if (!session.authenticated) return <Login session={session} onLogin={async () => { setError(''); await refreshSession(); }} />;
  function openChat(id: string) {
    loadId.current++; localStorage.setItem('roleplay-chat', id); setChatId(id); setTab('story'); setDraft(''); setEdit(null); setPreview(null); setGenerationId(''); submission.current = null; following.current = true; if (id !== chatId) setSnapshot(null);
  }
  if (!library) return <main className="login"><p>Loading your story…</p>{error && <p role="alert">{error}</p>}</main>;

  return <div className="app">
    <header className="topbar">
      <div className="brand"><span className="brand-mark" aria-hidden="true">R</span><div><strong>Roleplay Engine</strong><small>Your stories. Room to continue.</small></div></div>
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
        <dl><div><dt>Saved turns</dt><dd>{snapshot.turns.length}</dd></div><div><dt>Input target</dt><dd>{snapshot.settings.targetInputTokens.toLocaleString()}</dd></div><div><dt>Context</dt><dd>{snapshot.context.selected.length ? `${snapshot.context.selected.length} summaries` : 'Full history'}</dd></div></dl>
        <button className="secondary" onClick={() => setTab('settings')}>Edit setup</button>
        <button className="quiet" onClick={() => setTab('memory')}>Inspect memory</button>
      </aside>
      <section className="conversation" aria-label="Conversation">
        {memoryStale && <div className="recovery" role="status"><div><strong>Memory needs review.</strong><p>Archived history changed. Repair the affected summaries before continuing.</p></div><button className="secondary" onClick={() => setTab('memory')}>Review memory</button></div>}
        <div className="transcript" onScroll={(event) => { const node = event.currentTarget; following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 100; }}>
          {snapshot.turns.length === 0 && <div className="empty-state"><h2>Set up your story</h2><button className="secondary" onClick={() => setTab('settings')}>Setup</button></div>}
          {snapshot.turns.map((turn, index) => <article className="turn" key={turn.id} aria-label={`Turn ${index + 1}`}>
            <div className="turn-heading"><span>TURN {index + 1} {turn.complete ? snapshot.context.archivedTurnIds.includes(turn.id) ? '· ARCHIVED' : '' : '· PENDING'}</span><button className="quiet" disabled={working || busy} onClick={() => {
              if (confirm('Delete this entire turn, including its saved request records?')) void command(() => api(`/chats/${chatId}/turns/${turn.id}`, 'DELETE', { revision: snapshot.revision }));
            }}>Delete turn</button></div>
            {(['user', 'assistant'] as const).filter(part => !(part === 'user' && turn.complete && turn.user.text === '' && turn.user.revision === 0 && !(edit?.turnId === turn.id && edit.part === 'user'))).map((part) => <div className={`part ${part}`} key={part}>
              <div className="part-heading"><strong>{part === 'user' ? snapshot.sources.persona?.name ?? 'You' : snapshot.sources.character?.name ?? 'Character'}</strong><button className="quiet" disabled={working || busy || (part === 'assistant' && !turn.complete)} onClick={() => setEdit({ turnId: turn.id, part, text: turn[part].text, revision: snapshot.revision })}>Edit {part === 'user' ? 'input' : 'response'}</button></div>
              {edit?.turnId === turn.id && edit.part === part ? <form onSubmit={saveEdit} className="edit-form"><textarea aria-label={`Edit ${part} text`} value={edit.text} onChange={(event) => setEdit({ ...edit, text: event.target.value })} /><div className="actions"><button disabled={busy}>Save edit</button><button type="button" className="quiet" onClick={() => setEdit(null)}>Cancel edit</button></div></form> : <div className="prose">{part === 'assistant' && !turn.complete ? <>{trimBoundaryNewlines(partial ?? '') || <span className="muted">{active ? 'Waiting for the model…' : 'Awaiting a response.'}</span>}{active && <span className="cursor" aria-label="Generating" />}</> : turn[part].text || <span className="muted blank">blank</span>}</div>}
            </div>)}
          </article>)}
          <div ref={bottom} />
        </div>
        {pending && <div className="recovery" role="status"><div><strong>{active ? 'The response is running on the Mac.' : 'This turn is still pending.'}</strong><p>{active ? 'You can close this browser and return later.' : latest?.error ?? 'Retry the response or delete the turn to continue.'}</p>{!active && partial && <small>Partial text is preserved for inspection. It has not been accepted as a response.</small>}</div><button className="secondary" disabled={busy} onClick={() => void command(() => active ? api(`/generations/${active.id}/cancel`, 'POST', {}) : api(`/chats/${chatId}/retry`, 'POST', { revision: snapshot.revision, requestId: crypto.randomUUID() }))}>{active ? 'Cancel response' : 'Retry response'}</button></div>}
        <form className="composer" onSubmit={(event) => void send(event)}>
          <label htmlFor="turn-input">Your next turn</label><textarea id="turn-input" placeholder="What happens next?" value={draft} disabled={pending || busy || Boolean(preparing)} onChange={(event) => { setDraft(event.target.value); setPreview(null); }} />
          <div className="composer-bottom"><span>{preparing ? 'Preparing memory on the Mac…' : pending ? 'Resolve the pending turn to continue.' : 'Your transcript is saved on the Mac.'}</span><button disabled={pending || busy || Boolean(preparing) || memoryStale || !snapshot.connection || !draft.trim()}>{busy ? 'Saving…' : 'Send turn'} <span aria-hidden="true">↗</span></button></div>
        </form>
      </section>
    </main>}
    {tab === 'library' && <Libraries library={library} currentChatId={chatId} busy={busy} run={command} openChat={openChat} />}
    {tab === 'settings' && snapshot && <ChatSetup key={snapshot.id} snapshot={snapshot} library={library} busy={busy || working} run={command} saved={() => { setTab('story'); setPreview(null); }} />}
    {tab === 'memory' && snapshot && <Memory key={snapshot.id} snapshot={snapshot} library={library} busy={busy} run={command} />}
    {tab === 'request' && snapshot && <main className="document-panel"><p className="eyebrow">REQUEST INSPECTOR</p><h1>See what the model receives.</h1><p className="muted">Saved requests contain the exact body sent for that attempt. Credentials stay on the server.</p><div className="inspector-controls"><label>Saved attempt<Dropdown aria-label="Saved attempt" value={shownGeneration?.id ?? ''} onChange={value => { setGenerationId(value); setPreview(null); }} options={snapshot.generations.length ? snapshot.generations.map(generation => ({ value: generation.id, label: `${new Date(generation.createdAt).toLocaleString()} · ${generation.status}` })) : [{ value: '', label: 'No saved attempts', disabled: true }]} /></label><button className="secondary" disabled={!snapshot.connection || busy} onClick={() => void command(async () => { setPreview(await api<RequestPreview>(`/chats/${chatId}/preview`, 'POST', { revision: snapshot.revision, ...(!pending && draft !== '' ? { text: draft } : {}) })); })}>Preview {pending ? 'pending turn' : 'next request'}</button></div>
      <p className="small muted">{preview ? 'Live preview of the current setup and composer. It becomes a saved request when generation starts.' : shownGeneration ? `Saved attempt: ${shownGeneration.status}. ${shownGeneration.error ?? ''}` : 'Send a turn or preview the current setup.'}</p>
      {shownRequest && <>{shownRequest.warnings?.map(warning => <p role="status" key={warning}>{warning}</p>)}<div className="budget"><strong>Estimated input: {shownRequest.budget.inputTokens.toLocaleString()} / {shownRequest.budget.targetInputTokens.toLocaleString()}</strong><span>Reserved output: {shownRequest.budget.reservedOutputTokens.toLocaleString()} · Model window: {shownRequest.budget.contextWindow.toLocaleString()}</span><small>{shownRequest.budget.method}. This is not a verified provider token count.</small></div><h2>Endpoint</h2><pre>{shownRequest.endpoint}</pre><h2>Request body</h2><pre data-testid="request-body">{JSON.stringify(shownRequest.body, null, 2)}</pre><details><summary>Turn identities and source revisions</summary><pre>{JSON.stringify(shownRequest.coverage, null, 2)}</pre></details></>}
    </main>}
  </div>;
}

function Login({ session, onLogin }: { session: Session; onLogin: () => Promise<void> }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return <main className="login"><div className="login-card"><span className="brand-mark">R</span><p className="eyebrow">ROLEPLAY ENGINE</p><h1>{session.setupRequired ? 'Your stories start here.' : 'Welcome back.'}</h1><p>{session.setupRequired ? 'Create the owner password on your Mac. Use it to access your saved chat from your devices.' : 'Sign in to continue your story.'}</p><form onSubmit={async (event) => {
    event.preventDefault(); setBusy(true); setError('');
    try { await api(session.setupRequired ? '/setup' : '/login', 'POST', { password }); setPassword(''); await onLogin(); }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not sign in.'); } finally { setBusy(false); }
  }}><label>Owner password<input type="password" required minLength={12} maxLength={256} autoComplete={session.setupRequired ? 'new-password' : 'current-password'} value={password} onChange={(event) => setPassword(event.target.value)} /></label><small className="muted">At least 12 characters.</small>{error && <p role="alert">{error}</p>}<button disabled={busy}>{busy ? 'Opening…' : session.setupRequired ? 'Create owner account' : 'Sign in'}</button></form><p className="small muted">Hosted on your Mac. Phone access requires HTTPS.</p></div></main>;
}
