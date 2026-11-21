import { useId, useRef } from 'react';
import { t, useLocale } from './localization';
import { chatTextScales, chatTextScaleSchema, themeSchema, type Appearance, type AppearanceStatus, type Theme } from '../shared/appearance';
import type { MessageKey } from '../shared/localization';
import { SettingsSaveStatus, useSettingsState } from './useSettingsAutosave';
import { ChatTextPreview, type ChatPreviewAppearance } from './ChatTextPreview';
import { Dropdown } from './Controls';
import { themeSpeechColor, useTheme } from './theme';
import { ColorPicker } from './ColorPicker';
import type { SettingsAutosave } from './settings-autosave';

const themeLabels: Record<Theme, MessageKey> = {
  dark: 'appearance.dark',
  light: 'appearance.light',
  'midnight-black': 'appearance.midnight_black',
  porcelain: 'appearance.porcelain',
};

const defaultSpeechColorLabels = {
  character: {
    field: 'chat_appearance_settings.character_speech_color',
    picker: 'chat_appearance_settings.default_character_speech_color',
    reset: 'appearance.use_theme_character_color',
  },
  persona: {
    field: 'chat_appearance_settings.persona_speech_color',
    picker: 'chat_appearance_settings.default_persona_speech_color',
    reset: 'appearance.use_theme_persona_color',
  },
} as const;

function DefaultSpeechColor({ speaker, appearance, onChange }: {
  speaker: 'character' | 'persona'; onChange: (value: string | null) => void;
  appearance: ChatPreviewAppearance;
}) {
  const labels = defaultSpeechColorLabels[speaker];
  const value = speaker === 'character' ? appearance.characterSpeechColor : appearance.personaSpeechColor;
  const statusId = useId();
  const pickerTrigger = useRef<HTMLButtonElement>(null);

  return <div className="speech-color-default">
    <span className="speech-color-label">{t(labels.field)}</span>
    <div className="speech-color-default-controls">
      <ColorPicker instant label={t(labels.picker)} speaker={speaker} appearance={appearance}
        value={value ?? themeSpeechColor(speaker)} onChange={onChange}
        triggerRef={pickerTrigger} describedBy={value === null ? statusId : undefined} />
      {value === null ? <small id={statusId} className="muted">{t('appearance.using_theme_color')}</small>
        : <button type="button" className="quiet" aria-label={t(labels.reset)} onClick={event => {
          if (event.currentTarget === document.activeElement) pickerTrigger.current?.focus({ preventScroll: true });
          onChange(null);
        }}>{t('appearance.restore_theme_color')}</button>}
    </div>
  </div>;
}

export function ChatAppearanceSettings({ autosave }: { autosave: SettingsAutosave<Appearance, AppearanceStatus> }) {
  useLocale();
  useTheme();
  const { draft, saving, error } = useSettingsState(autosave);
  if (!draft) return null;

  return <section className="settings-section" aria-labelledby="chat-appearance-heading">
    <h2 id="chat-appearance-heading" tabIndex={-1}>{t("application_settings.chat_appearance")}</h2>
    <SettingsSaveStatus saving={saving} error={error} retry={autosave.retry} />
    <div className="settings-rows">
      <div className="settings-row">
        <label className="settings-field">{t('appearance.theme')}<Dropdown aria-label={t('appearance.theme')} value={draft.theme} onChange={value => autosave.update({ theme: themeSchema.parse(value) })}
          options={themeSchema.options.map(value => ({ value, label: t(themeLabels[value]) }))} /></label>
        <p className="field-help small muted">{t('appearance.theme_help')}</p>
      </div>
      <div className="settings-row">
        <label className="checkbox"><input type="checkbox" checked={draft.displayCharacterPicture} onChange={event => {
          autosave.update({ displayCharacterPicture: event.target.checked });
        }} />{t("chat_appearance_settings.display_character_picture")}</label>
      </div>
      <div className="settings-row">
        <label className="checkbox"><input type="checkbox" checked={draft.showReasoningDuringGeneration} aria-describedby="show-reasoning-help" onChange={event => {
          autosave.update({ showReasoningDuringGeneration: event.target.checked });
        }} />{t("chat_appearance_settings.show_reasoning_during_generation")}</label>
        <p className="field-help small muted" id="show-reasoning-help">{t("chat_appearance_settings.show_reasoning_help")}</p>
      </div>
      <fieldset className="settings-row" aria-labelledby="chat-text-size-heading">
        <h3 id="chat-text-size-heading">{t("chat_appearance_settings.chat_text_size")}</h3>
        <label htmlFor="chat-text-scale">{t("chat_appearance_settings.text_scale", { chatTextScale: draft.chatTextScale, value: '' })}</label>
        <p className="small muted" id="chat-text-scale-help">{t("chat_appearance_settings.adjust_message_text_independently_of_the_rest")}</p>
        <div className="chat-text-scale-control">
          <input id="chat-text-scale" type="range" min={90} max={120} step={10} list="chat-text-scale-ticks" value={draft.chatTextScale}
            aria-describedby="chat-text-scale-help" aria-valuetext={`${draft.chatTextScale}%`}
            onChange={event => {
              const chatTextScale = chatTextScaleSchema.parse(Number(event.target.value));
              autosave.update({ chatTextScale });
            }} />
          <datalist id="chat-text-scale-ticks">{chatTextScales.map(scale => <option key={scale} value={scale} />)}</datalist>
          <div className="chat-text-scale-labels" aria-hidden="true">{chatTextScales.map(scale => <span key={scale}>{scale}%{scale === 100 && <small>{t("chat_appearance_settings.default")}</small>}</span>)}</div>
        </div>
        <ChatTextPreview {...draft} />
      </fieldset>
      <fieldset className="settings-row" aria-labelledby="default-speech-colors-heading">
        <h3 id="default-speech-colors-heading">{t("chat_appearance_settings.default_speech_colors")}</h3>
        <div className="speech-color-defaults">
          <DefaultSpeechColor speaker="character" appearance={draft}
            onChange={characterSpeechColor => autosave.update({ characterSpeechColor })} />
          <DefaultSpeechColor speaker="persona" appearance={draft}
            onChange={personaSpeechColor => autosave.update({ personaSpeechColor })} />
        </div>
      </fieldset>
    </div>
  </section>;
}
