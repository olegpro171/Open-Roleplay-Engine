import { t, useLocale } from './localization';
import { chatTextScales, chatTextScaleSchema, type Appearance, type AppearanceStatus } from '../shared/appearance';
import { SettingsSaveStatus, useSettingsState } from './useSettingsAutosave';
import { ChatMarkdown } from './ChatMarkdown';
import { ColorPicker } from './ColorPicker';
import type { SettingsAutosave } from './settings-autosave';

export function ChatAppearanceSettings({ autosave }: { autosave: SettingsAutosave<Appearance, AppearanceStatus> }) {
  useLocale();
  const { draft, saving, error } = useSettingsState(autosave);
  if (!draft) return null;

  return <section className="settings-section" aria-labelledby="chat-appearance-heading">
    <h2 id="chat-appearance-heading" tabIndex={-1}>{t("application_settings.chat_appearance")}</h2>
    <SettingsSaveStatus saving={saving} error={error} retry={autosave.retry} />
    <div>
      <fieldset>
        <label className="checkbox"><input type="checkbox" checked={draft.displayCharacterPicture} onChange={event => {
          autosave.update({ displayCharacterPicture: event.target.checked });
        }} />{t("chat_appearance_settings.display_character_picture")}</label>
      </fieldset>
      <fieldset><legend>{t("chat_appearance_settings.chat_text_size")}</legend>
        <label htmlFor="chat-text-scale">{t("chat_appearance_settings.text_scale", { chatTextScale: draft.chatTextScale, value: draft.chatTextScale === 100 ? ' (default)' : '' })}</label>
        <p className="small muted" id="chat-text-scale-help">{t("chat_appearance_settings.adjust_message_text_independently_of_the_rest")}</p>
        <div className="chat-text-scale-control">
          <input id="chat-text-scale" type="range" min={90} max={120} step={10} list="chat-text-scale-ticks" value={draft.chatTextScale}
            aria-describedby="chat-text-scale-help" aria-valuetext={`${draft.chatTextScale}%${draft.chatTextScale === 100 ? ' (default)' : ''}`}
            onChange={event => {
              const chatTextScale = chatTextScaleSchema.parse(Number(event.target.value));
              autosave.update({ chatTextScale });
            }} />
          <datalist id="chat-text-scale-ticks">{chatTextScales.map(scale => <option key={scale} value={scale} />)}</datalist>
          <div className="chat-text-scale-labels" aria-hidden="true">{chatTextScales.map(scale => <span key={scale}>{scale}%{scale === 100 && <small>{t("chat_appearance_settings.default")}</small>}</span>)}</div>
        </div>
        <div className="chat-text-preview prose" role="region" aria-label={t("chat_appearance_settings.chat_text_preview")}>
          <ChatMarkdown text={t("chat_appearance_settings.the_story_continues_hello")} textScale={draft.chatTextScale} speechColor={draft.characterSpeechColor} />
        </div>
      </fieldset>
      <fieldset><legend>{t("chat_appearance_settings.default_speech_colors")}</legend><div className="speech-color-defaults">
        <div className="speech-color-selector"><span className="speech-color-label">{t("chat_appearance_settings.character_speech_color")}</span><ColorPicker instant label={t("chat_appearance_settings.default_character_speech_color")} value={draft.characterSpeechColor} onChange={characterSpeechColor => autosave.update({ characterSpeechColor })} /></div>
        <div className="speech-color-selector"><span className="speech-color-label">{t("chat_appearance_settings.persona_speech_color")}</span><ColorPicker instant label={t("chat_appearance_settings.default_persona_speech_color")} value={draft.personaSpeechColor} onChange={personaSpeechColor => autosave.update({ personaSpeechColor })} /></div>
      </div></fieldset>
    </div>
  </section>;
}
