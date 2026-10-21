import { useEffect, useRef, useState, type FormEvent } from 'react';
import { appearanceStatusSchema, chatTextScales, chatTextScaleSchema, type AppearanceStatus } from '../shared/appearance';
import { api } from './api';
import { ChatMarkdown } from './ChatMarkdown';

export function ChatAppearanceSettings({ status, committed }: { status: AppearanceStatus; committed: (value: AppearanceStatus) => void }) {
  const [draft, setDraft] = useState(status);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const mounted = useRef(false), pending = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const conflict = status.revision !== draft.revision;

  async function save(event: FormEvent) {
    event.preventDefault();
    if (pending.current || conflict) return;
    pending.current = true; setBusy(true); setError(''); setMessage('');
    try {
      const value = appearanceStatusSchema.parse(await api<unknown>('/application/appearance', 'PUT', draft));
      if (mounted.current) { setDraft(value); committed(value); setMessage('Chat appearance saved.'); }
    } catch (error) {
      if (mounted.current) setError(`${error instanceof Error ? error.message : 'Chat appearance could not be saved.'} Your edits are retained. Reload chat appearance to check the saved result.`);
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function reload() {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(''); setMessage('');
    try {
      const value = appearanceStatusSchema.parse(await api<unknown>('/application/appearance'));
      if (mounted.current) { setDraft(value); committed(value); }
    } catch (error) {
      if (mounted.current) setError(error instanceof Error ? error.message : 'Chat appearance could not be loaded.');
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return <section className="settings-section" aria-labelledby="chat-appearance-heading">
    <h2 id="chat-appearance-heading" tabIndex={-1}>Chat appearance</h2>
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    {conflict && <p role="alert">Chat appearance changed in another window. Reload chat appearance before saving. Your edits are retained until you reload.</p>}
    <form onSubmit={event => void save(event)}>
      <fieldset disabled={busy || conflict}><legend>Chat text size</legend>
        <label htmlFor="chat-text-scale">Text scale — {draft.settings.chatTextScale}%{draft.settings.chatTextScale === 100 ? ' (default)' : ''}</label>
        <p className="small muted" id="chat-text-scale-help">Adjust message text independently of the rest of the interface.</p>
        <div className="chat-text-scale-control">
          <input id="chat-text-scale" type="range" min={90} max={120} step={10} list="chat-text-scale-ticks" value={draft.settings.chatTextScale}
            aria-describedby="chat-text-scale-help" aria-valuetext={`${draft.settings.chatTextScale}%${draft.settings.chatTextScale === 100 ? ' (default)' : ''}`}
            onChange={event => {
              const chatTextScale = chatTextScaleSchema.parse(Number(event.target.value));
              setDraft({ ...draft, settings: { ...draft.settings, chatTextScale } });
              setMessage('');
            }} />
          <datalist id="chat-text-scale-ticks">{chatTextScales.map(scale => <option key={scale} value={scale} />)}</datalist>
          <div className="chat-text-scale-labels" aria-hidden="true">{chatTextScales.map(scale => <span key={scale}>{scale}%{scale === 100 && <small>Default</small>}</span>)}</div>
        </div>
        <div className="chat-text-preview prose" role="region" aria-label="Chat text preview">
          <ChatMarkdown text={'The story continues. “Hello!”'} textScale={draft.settings.chatTextScale} speechColor={draft.settings.characterSpeechColor} />
        </div>
      </fieldset>
      <p>Default direct speech colors for cards with Speech color set to Not set. A color saved on a character or persona takes precedence.</p>
      <fieldset disabled={busy || conflict}><legend>Default speech colors</legend><div className="form-grid">
        <label className="speech-color-selector">Character speech color<input aria-label="Default character speech color" type="color" value={draft.settings.characterSpeechColor} onChange={event => { setDraft({ ...draft, settings: { ...draft.settings, characterSpeechColor: event.target.value } }); setMessage(''); }} /></label>
        <label className="speech-color-selector">Persona speech color<input aria-label="Default persona speech color" type="color" value={draft.settings.personaSpeechColor} onChange={event => { setDraft({ ...draft, settings: { ...draft.settings, personaSpeechColor: event.target.value } }); setMessage(''); }} /></label>
      </div></fieldset>
      <div className="actions"><button disabled={busy || conflict}>Save chat appearance</button><button type="button" className="secondary" disabled={busy} onClick={() => void reload()}>Reload chat appearance</button></div>
    </form>
  </section>;
}
