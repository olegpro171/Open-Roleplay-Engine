import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { ChatSnapshot, Connection, RequestPreview, Turn } from '../shared/contracts';
import { api, ApiError } from './api';

type Session = { setupRequired: boolean; authenticated: boolean };
type Edit = { turnId: string; part: 'user' | 'assistant'; text: string; revision: number };
const defaultConnection: Connection = {
  name: 'My Connection', endpoint: 'https://api.openai.com/v1', model: '',
  contextWindow: 128_000, maxOutputTokens: 2048, customParameters: {},
};

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [snapshot, setSnapshot] = useState<ChatSnapshot | null>(null);
  const [error, setError] = useState('');
  const [online, setOnline] = useState(false);
  const [tab, setTab] = useState<'story' | 'settings' | 'request'>('story');
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
      const state = await api<ChatSnapshot>('/chat');
      if (id === loadId.current) setSnapshot(state);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) void refreshSession();
    }
  }, [refreshSession]);
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

  const active = snapshot?.generations.find((generation) => generation.status === 'running');
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
    if (!snapshot || busy || pending || draft === '') return;
    if (!submission.current || submission.current.text !== draft) submission.current = { requestId: crypto.randomUUID(), revision: snapshot.revision, text: draft };
    if (await command(() => api('/turns', 'POST', submission.current))) {
      submission.current = null; setDraft(''); setPreview(null); following.current = true;
    } else {
      // A revision conflict is reconciled by the refresh; preserve identity on an ambiguous network failure.
      const state = await api<ChatSnapshot>('/chat').catch(() => null);
      if (state && state.revision !== submission.current?.revision) submission.current = null;
    }
  }
  async function saveEdit(event: FormEvent) {
    event.preventDefault();
    if (!edit) return;
    if (await command(() => api(`/turns/${edit.turnId}/${edit.part}`, 'PATCH', { revision: edit.revision, text: edit.text }))) setEdit(null);
  }

  if (!session) return <main className="login"><p>Opening Roleplay Engine…</p>{error && <p role="alert">{error}</p>}</main>;
  if (!session.authenticated) return <Login session={session} onLogin={async () => { setError(''); await refreshSession(); }} />;
  if (!snapshot) return <main className="login"><p>Loading your story…</p></main>;

  return <div className="app">
    <header className="topbar">
      <div className="brand"><span className="brand-mark" aria-hidden="true">R</span><div><strong>Roleplay Engine</strong><small>One story. Room to continue.</small></div></div>
      <div className="connection-status"><span className={online ? 'dot online' : 'dot'} />{online ? 'Connected' : 'Reconnecting'}</div>
      <button className="quiet signout" onClick={() => void command(async () => { await api('/logout', 'POST', {}); setSnapshot(null); await refreshSession(); })}>Sign out</button>
    </header>
    <nav className="tabs" aria-label="Workspace">
      <button aria-current={tab === 'story' ? 'page' : undefined} onClick={() => setTab('story')}>Story</button>
      <button aria-current={tab === 'settings' ? 'page' : undefined} onClick={() => setTab('settings')}>Setup</button>
      <button aria-current={tab === 'request' ? 'page' : undefined} onClick={() => setTab('request')}>Request inspector</button>
    </nav>
    {error && <div className="error-banner" role="alert"><span>{error}</span><button className="quiet" onClick={() => setError('')}>Dismiss</button></div>}
    {tab === 'story' && <main className="story-layout">
      <aside className="story-meta">
        <p className="eyebrow">CURRENT CHAT</p><h1>{snapshot.settings.title}</h1>
        <p>{snapshot.connection ? `${snapshot.connection.name} · ${snapshot.connection.model}` : 'Set up a Connection to begin.'}</p>
        <dl><div><dt>Saved turns</dt><dd>{snapshot.turns.length}</dd></div><div><dt>Input target</dt><dd>{snapshot.settings.targetInputTokens.toLocaleString()}</dd></div><div><dt>Context</dt><dd>Full history</dd></div></dl>
        <p className="muted small">Token budgets use a conservative estimate. Layered summaries arrive in the next milestone.</p>
        <button className="secondary" onClick={() => setTab('settings')}>Edit setup</button>
      </aside>
      <section className="conversation" aria-label="Conversation">
        <div className="transcript" onScroll={(event) => { const node = event.currentTarget; following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 100; }}>
          {snapshot.turns.length === 0 && <div className="empty-state"><span className="eyebrow">A PLACE TO BEGIN</span><h2>Make room for a story.</h2><p>Choose a model, add your character and persona, then write the first turn.</p><button className="secondary" onClick={() => setTab('settings')}>Set up your story</button></div>}
          {snapshot.turns.map((turn, index) => <article className="turn" key={turn.id} aria-label={`Turn ${index + 1}`}>
            <div className="turn-heading"><span>TURN {index + 1} {turn.complete ? '' : '· PENDING'}</span><button className="quiet" disabled={Boolean(active) || busy} onClick={() => {
              if (confirm('Delete this entire turn, including its saved request records?')) void command(() => api(`/turns/${turn.id}`, 'DELETE', { revision: snapshot.revision }));
            }}>Delete turn</button></div>
            {(['user', 'assistant'] as const).map((part) => <div className={`part ${part}`} key={part}>
              <div className="part-heading"><strong>{part === 'user' ? 'You' : 'Character'}</strong><button className="quiet" disabled={Boolean(active) || busy || (part === 'assistant' && !turn.complete)} onClick={() => setEdit({ turnId: turn.id, part, text: turn[part].text, revision: snapshot.revision })}>Edit {part === 'user' ? 'input' : 'response'}</button></div>
              {edit?.turnId === turn.id && edit.part === part ? <form onSubmit={saveEdit} className="edit-form"><textarea aria-label={`Edit ${part} text`} value={edit.text} onChange={(event) => setEdit({ ...edit, text: event.target.value })} /><div className="actions"><button disabled={busy}>Save edit</button><button type="button" className="quiet" onClick={() => setEdit(null)}>Cancel edit</button></div></form> : <div className="prose">{part === 'assistant' && !turn.complete ? <>{partial || <span className="muted">{active ? 'Waiting for the model…' : 'Awaiting a response.'}</span>}{active && <span className="cursor" aria-label="Generating" />}</> : turn[part].text || <span className="muted blank">Intentionally blank</span>}</div>}
            </div>)}
          </article>)}
          <div ref={bottom} />
        </div>
        {pending && <div className="recovery" role="status"><div><strong>{active ? 'The response is running on the Mac.' : 'This turn is still pending.'}</strong><p>{active ? 'You can close this browser and return later.' : latest?.error ?? 'Retry the response or delete the turn to continue.'}</p>{!active && partial && <small>Partial text is preserved for inspection. It has not been accepted as a response.</small>}</div><button className="secondary" disabled={busy} onClick={() => void command(() => active ? api(`/generations/${active.id}/cancel`, 'POST', {}) : api('/retry', 'POST', { revision: snapshot.revision, requestId: crypto.randomUUID() }))}>{active ? 'Cancel response' : 'Retry response'}</button></div>}
        <form className="composer" onSubmit={(event) => void send(event)}>
          <label htmlFor="turn-input">Your next turn</label><textarea id="turn-input" placeholder="What happens next?" value={draft} disabled={pending || busy} onChange={(event) => { setDraft(event.target.value); setPreview(null); }} />
          <div className="composer-bottom"><span>{pending ? 'Resolve the pending turn to continue.' : 'Your transcript is saved on the Mac.'}</span><button disabled={pending || busy || !snapshot.connection || draft === ''}>{busy ? 'Saving…' : 'Send turn'} <span aria-hidden="true">↗</span></button></div>
        </form>
      </section>
    </main>}
    {tab === 'settings' && <Settings snapshot={snapshot} busy={busy || Boolean(active)} onSave={async (value) => {
      if (await command(() => api('/settings', 'PUT', value))) { setTab('story'); setPreview(null); }
    }} />}
    {tab === 'request' && <main className="document-panel"><p className="eyebrow">REQUEST INSPECTOR</p><h1>See what the model receives.</h1><p className="muted">Saved requests contain the exact body sent for that attempt. Credentials stay on the server.</p><div className="inspector-controls"><label>Saved attempt<select aria-label="Saved attempt" value={shownGeneration?.id ?? ''} onChange={(event) => { setGenerationId(event.target.value); setPreview(null); }}><option value="" disabled>No saved attempts</option>{snapshot.generations.map((generation) => <option key={generation.id} value={generation.id}>{new Date(generation.createdAt).toLocaleString()} · {generation.status}</option>)}</select></label><button className="secondary" disabled={!snapshot.connection || busy} onClick={() => void command(async () => { setPreview(await api<RequestPreview>('/preview', 'POST', { revision: snapshot.revision, ...(!pending && draft !== '' ? { text: draft } : {}) })); })}>Preview {pending ? 'pending turn' : 'next request'}</button></div>
      <p className="small muted">{preview ? 'Live preview of the current setup and composer. It becomes a saved request when generation starts.' : shownGeneration ? `Saved attempt: ${shownGeneration.status}. ${shownGeneration.error ?? ''}` : 'Send a turn or preview the current setup.'}</p>
      {shownRequest && <><div className="budget"><strong>Estimated input: {shownRequest.budget.inputTokens.toLocaleString()} / {shownRequest.budget.targetInputTokens.toLocaleString()}</strong><span>Reserved output: {shownRequest.budget.reservedOutputTokens.toLocaleString()} · Model window: {shownRequest.budget.contextWindow.toLocaleString()}</span><small>{shownRequest.budget.method}. This is not a verified provider token count.</small></div><h2>Endpoint</h2><pre>{shownRequest.endpoint}</pre><h2>Request body</h2><pre data-testid="request-body">{JSON.stringify(shownRequest.body, null, 2)}</pre><details><summary>Turn identities and source revisions</summary><pre>{JSON.stringify(shownRequest.coverage, null, 2)}</pre></details></>}
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

function Settings({ snapshot, busy, onSave }: { snapshot: ChatSnapshot; busy: boolean; onSave: (input: unknown) => Promise<void> }) {
  const [connection, setConnection] = useState(snapshot.connection ?? defaultConnection);
  const [settings, setSettings] = useState(snapshot.settings);
  const [revision] = useState(snapshot.revision);
  const [apiKey, setApiKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [parameters, setParameters] = useState(JSON.stringify(connection.customParameters, null, 2));
  const [error, setError] = useState('');
  return <main className="document-panel"><p className="eyebrow">STORY SETUP</p><h1>A model and a starting point.</h1><p className="muted">One reusable Connection and a simple prompt for this first milestone.</p><form onSubmit={async (event) => {
    event.preventDefault(); setError('');
    try {
      const customParameters: unknown = JSON.parse(parameters);
      await onSave({ revision, settings, connection: { ...connection, customParameters }, ...(clearKey || apiKey !== '' ? { apiKey: clearKey ? '' : apiKey } : {}) });
    } catch { setError('Custom parameters must be a JSON object.'); }
  }}>
    <fieldset disabled={busy}><legend>Connection</legend><div className="form-grid"><label>Connection name<input required value={connection.name} onChange={(event) => setConnection({ ...connection, name: event.target.value })} /></label><label>Model identifier<input required placeholder="Enter the model name" value={connection.model} onChange={(event) => setConnection({ ...connection, model: event.target.value })} /></label><label className="full">API base URL<input required type="url" value={connection.endpoint} onChange={(event) => setConnection({ ...connection, endpoint: event.target.value })} /><small>Chat Completions is added to this URL, for example /v1/chat/completions.</small></label><label className="full">API key<input type="password" autoComplete="new-password" placeholder={snapshot.hasApiKey ? 'Saved · leave blank to keep it' : 'Optional for endpoints without authentication'} value={apiKey} onChange={(event) => setApiKey(event.target.value)} disabled={clearKey} /></label>{snapshot.hasApiKey && <label className="checkbox full"><input type="checkbox" checked={clearKey} onChange={(event) => setClearKey(event.target.checked)} />Remove the saved API key</label>}<label>Model context window<input type="number" required min={1} value={connection.contextWindow} onChange={(event) => setConnection({ ...connection, contextWindow: Number(event.target.value) })} /></label><label>Reserved output tokens<input type="number" required min={1} value={connection.maxOutputTokens} onChange={(event) => setConnection({ ...connection, maxOutputTokens: Number(event.target.value) })} /></label><label className="full">Custom request parameters<textarea className="code-input" value={parameters} onChange={(event) => setParameters(event.target.value)} /><small>Supports temperature, top_p, presence_penalty, frequency_penalty, seed, stop, and reasoning_effort. Request structure is protected.</small></label></div></fieldset>
    <fieldset disabled={busy}><legend>Prompt and chat</legend><div className="form-grid"><label>Chat title<input required value={settings.title} onChange={(event) => setSettings({ ...settings, title: event.target.value })} /></label><label>Target input tokens<input type="number" required min={1} value={settings.targetInputTokens} onChange={(event) => setSettings({ ...settings, targetInputTokens: Number(event.target.value) })} /></label><label className="full">Instructions<textarea value={settings.instructions} onChange={(event) => setSettings({ ...settings, instructions: event.target.value })} /></label><label className="full">Character text<textarea placeholder="Who does the model play?" value={settings.character} onChange={(event) => setSettings({ ...settings, character: event.target.value })} /></label><label className="full">Persona text<textarea placeholder="Who do you play?" value={settings.persona} onChange={(event) => setSettings({ ...settings, persona: event.target.value })} /></label></div><p className="small muted">Prompt order: instructions, character, persona, then full conversation history. Blank parts are omitted. All content counts toward the estimated input target.</p></fieldset>
    {error && <p role="alert">{error}</p>}{snapshot.revision !== revision && <p role="status">The chat changed while this form was open. Reopen Setup to load the current revision before saving.</p>}
    <button disabled={busy || snapshot.revision !== revision}>Save setup</button>
  </form></main>;
}
