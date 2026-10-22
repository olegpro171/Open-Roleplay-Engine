import { useTextState, errorText, t, message as msg, useLocale } from './localization';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { appearanceStatusSchema, chatTextScales, chatTextScaleSchema, type AppearanceStatus } from '../shared/appearance';
import { api } from './api';
import { ChatMarkdown } from './ChatMarkdown';
import { ColorPicker } from './ColorPicker';

export function ChatAppearanceSettings({ status, committed }: { status: AppearanceStatus; committed: (value: AppearanceStatus) => void }) {
  useLocale();
  const [draft, setDraft] = useState(status);
  const [busy, setBusy] = useState(false), [error, setError] = useTextState(''), [message, setMessage] = useTextState('');
  const mounted = useRef(false), pending = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const conflict = status.revision !== draft.revision;

  async function save(event: FormEvent) {
    event.preventDefault();
    if (pending.current || conflict) return;
    pending.current = true; setBusy(true); setError(''); setMessage('');
    try {
      const value = appearanceStatusSchema.parse(await api<unknown>('/application/appearance', 'PUT', draft));
      if (mounted.current) { setDraft(value); committed(value); setMessage(msg("chat_appearance_settings.chat_appearance_saved")); }
    } catch (error) {
      if (mounted.current) setError(msg("chat_appearance_settings.your_edits_are_retained_reload_chat_appearance", { value: error instanceof Error ? error.message : t("interface.chat_appearance_could_not_be_saved") }));
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
      if (mounted.current) setError(errorText(error, msg("app.chat_appearance_could_not_be_loaded")));
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return <section className="settings-section" aria-labelledby="chat-appearance-heading">
    <h2 id="chat-appearance-heading" tabIndex={-1}>{t("application_settings.chat_appearance")}</h2>
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    {conflict && <p role="alert">{t("chat_appearance_settings.chat_appearance_changed_in_another_window_reload")}</p>}
    <form onSubmit={event => void save(event)}>
      <fieldset disabled={busy || conflict}><legend>{t("chat_appearance_settings.chat_text_size")}</legend>
        <label htmlFor="chat-text-scale">{t("chat_appearance_settings.text_scale", { chatTextScale: draft.settings.chatTextScale, value: draft.settings.chatTextScale === 100 ? ' (default)' : '' })}</label>
        <p className="small muted" id="chat-text-scale-help">{t("chat_appearance_settings.adjust_message_text_independently_of_the_rest")}</p>
        <div className="chat-text-scale-control">
          <input id="chat-text-scale" type="range" min={90} max={120} step={10} list="chat-text-scale-ticks" value={draft.settings.chatTextScale}
            aria-describedby="chat-text-scale-help" aria-valuetext={`${draft.settings.chatTextScale}%${draft.settings.chatTextScale === 100 ? ' (default)' : ''}`}
            onChange={event => {
              const chatTextScale = chatTextScaleSchema.parse(Number(event.target.value));
              setDraft({ ...draft, settings: { ...draft.settings, chatTextScale } });
              setMessage('');
            }} />
          <datalist id="chat-text-scale-ticks">{chatTextScales.map(scale => <option key={scale} value={scale} />)}</datalist>
          <div className="chat-text-scale-labels" aria-hidden="true">{chatTextScales.map(scale => <span key={scale}>{scale}%{scale === 100 && <small>{t("chat_appearance_settings.default")}</small>}</span>)}</div>
        </div>
        <div className="chat-text-preview prose" role="region" aria-label={t("chat_appearance_settings.chat_text_preview")}>
          <ChatMarkdown text={t("chat_appearance_settings.the_story_continues_hello")} textScale={draft.settings.chatTextScale} speechColor={draft.settings.characterSpeechColor} />
        </div>
      </fieldset>
      <fieldset disabled={busy || conflict}><legend>{t("chat_appearance_settings.default_speech_colors")}</legend><div className="speech-color-defaults">
        <div className="speech-color-selector"><span className="speech-color-label">{t("chat_appearance_settings.character_speech_color")}</span><ColorPicker label={t("chat_appearance_settings.default_character_speech_color")} value={draft.settings.characterSpeechColor} disabled={busy || conflict} onChange={characterSpeechColor => { setDraft({ ...draft, settings: { ...draft.settings, characterSpeechColor } }); setMessage(''); }} /></div>
        <div className="speech-color-selector"><span className="speech-color-label">{t("chat_appearance_settings.persona_speech_color")}</span><ColorPicker label={t("chat_appearance_settings.default_persona_speech_color")} value={draft.settings.personaSpeechColor} disabled={busy || conflict} onChange={personaSpeechColor => { setDraft({ ...draft, settings: { ...draft.settings, personaSpeechColor } }); setMessage(''); }} /></div>
      </div></fieldset>
      <div className="actions"><button disabled={busy || conflict}>{t("chat_appearance_settings.save_chat_appearance")}</button><button type="button" className="secondary" disabled={busy} onClick={() => void reload()}>{t("chat_appearance_settings.reload_chat_appearance")}</button></div>
    </form>
  </section>;
}
