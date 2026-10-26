import { t, useLocale } from './localization';
import { chatTextScales, chatTextScaleSchema, themeSchema, type Appearance, type AppearanceStatus } from '../shared/appearance';
import { SettingsSaveStatus, useSettingsState } from './useSettingsAutosave';
import { ChatMarkdown } from './ChatMarkdown';
import { Dropdown } from './Controls';
import { themeSpeechColor, useTheme } from './theme';
import { ColorPicker } from './ColorPicker';
import type { SettingsAutosave } from './settings-autosave';

export function ChatAppearanceSettings({ autosave }: { autosave: SettingsAutosave<Appearance, AppearanceStatus> }) {
  useLocale();
  useTheme();
  const { draft, saving, error } = useSettingsState(autosave);
  if (!draft) return null;

  return <section className="settings-section" aria-labelledby="chat-appearance-heading">
    <h2 id="chat-appearance-heading" tabIndex={-1}>{t("application_settings.chat_appearance")}</h2>
    <SettingsSaveStatus saving={saving} error={error} retry={autosave.retry} />
    <div>
      <fieldset>
        <label>{t('appearance.theme')}<Dropdown aria-label={t('appearance.theme')} value={draft.theme} onChange={value => autosave.update({ theme: themeSchema.parse(value) })}
          options={[{ value: 'dark', label: t('appearance.dark') }, { value: 'light', label: t('appearance.light') }]} /></label>
        <p className="small muted">{t('appearance.theme_help')}</p>
      </fieldset>
      <fieldset>
        <label className="checkbox"><input type="checkbox" checked={draft.displayCharacterPicture} onChange={event => {
          autosave.update({ displayCharacterPicture: event.target.checked });
        }} />{t("chat_appearance_settings.display_character_picture")}</label>
      </fieldset>
      <fieldset><legend>{t("chat_appearance_settings.chat_text_size")}</legend>
        <label htmlFor="chat-text-scale">{draft.chatTextScale === 100 ? t("chat_appearance_settings.text_scale_default", { scale: draft.chatTextScale }) : t("chat_appearance_settings.text_scale", { chatTextScale: draft.chatTextScale, value: '' })}</label>
        <p className="small muted" id="chat-text-scale-help">{t("chat_appearance_settings.adjust_message_text_independently_of_the_rest")}</p>
        <div className="chat-text-scale-control">
          <input id="chat-text-scale" type="range" min={90} max={120} step={10} list="chat-text-scale-ticks" value={draft.chatTextScale}
            aria-describedby="chat-text-scale-help" aria-valuetext={draft.chatTextScale === 100 ? t("chat_appearance_settings.scale_default", { scale: draft.chatTextScale }) : `${draft.chatTextScale}%`}
            onChange={event => {
              const chatTextScale = chatTextScaleSchema.parse(Number(event.target.value));
              autosave.update({ chatTextScale });
            }} />
          <datalist id="chat-text-scale-ticks">{chatTextScales.map(scale => <option key={scale} value={scale} />)}</datalist>
          <div className="chat-text-scale-labels" aria-hidden="true">{chatTextScales.map(scale => <span key={scale}>{scale}%{scale === 100 && <small>{t("chat_appearance_settings.default")}</small>}</span>)}</div>
        </div>
        <div className="chat-text-preview prose" role="region" aria-label={t("chat_appearance_settings.chat_text_preview")}>
          <ChatMarkdown text={t("chat_appearance_settings.the_story_continues_hello")} textScale={draft.chatTextScale} speechColor={draft.characterSpeechColor ?? undefined} />
        </div>
      </fieldset>
      <fieldset><legend>{t("chat_appearance_settings.default_speech_colors")}</legend><div className="speech-color-defaults">
        <div className="speech-color-selector"><span className="speech-color-label">{t("chat_appearance_settings.character_speech_color")}</span><ColorPicker instant label={t("chat_appearance_settings.default_character_speech_color")} value={draft.characterSpeechColor ?? themeSpeechColor('character')} onChange={characterSpeechColor => autosave.update({ characterSpeechColor })} />
          {draft.characterSpeechColor === null ? <small className="muted">{t('appearance.using_theme_color')}</small> : <button type="button" className="secondary" onClick={() => autosave.update({ characterSpeechColor: null })}>{t('appearance.use_theme_character_color')}</button>}</div>
        <div className="speech-color-selector"><span className="speech-color-label">{t("chat_appearance_settings.persona_speech_color")}</span><ColorPicker instant label={t("chat_appearance_settings.default_persona_speech_color")} value={draft.personaSpeechColor ?? themeSpeechColor('persona')} onChange={personaSpeechColor => autosave.update({ personaSpeechColor })} />
          {draft.personaSpeechColor === null ? <small className="muted">{t('appearance.using_theme_color')}</small> : <button type="button" className="secondary" onClick={() => autosave.update({ personaSpeechColor: null })}>{t('appearance.use_theme_persona_color')}</button>}</div>
      </div></fieldset>
    </div>
  </section>;
}
