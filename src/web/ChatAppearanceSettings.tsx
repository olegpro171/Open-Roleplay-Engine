import { useEffect, useRef, useState, type FormEvent } from 'react';
import { appearanceStatusSchema, type AppearanceStatus } from '../shared/appearance';
import { api } from './api';

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
    <p>Default direct speech colors for cards with Speech color set to Not set. A color saved on a character or persona takes precedence.</p>
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    {conflict && <p role="alert">Chat appearance changed in another window. Reload chat appearance before saving. Your edits are retained until you reload.</p>}
    <form onSubmit={event => void save(event)}>
      <fieldset disabled={busy || conflict}><legend>Default speech colors</legend><div className="form-grid">
        <label className="speech-color-selector">Character speech color<input aria-label="Default character speech color" type="color" value={draft.settings.characterSpeechColor} onChange={event => { setDraft({ ...draft, settings: { ...draft.settings, characterSpeechColor: event.target.value } }); setMessage(''); }} /></label>
        <label className="speech-color-selector">Persona speech color<input aria-label="Default persona speech color" type="color" value={draft.settings.personaSpeechColor} onChange={event => { setDraft({ ...draft, settings: { ...draft.settings, personaSpeechColor: event.target.value } }); setMessage(''); }} /></label>
      </div></fieldset>
      <div className="actions"><button disabled={busy || conflict}>Save chat appearance</button><button type="button" className="secondary" disabled={busy} onClick={() => void reload()}>Reload chat appearance</button></div>
    </form>
  </section>;
}
