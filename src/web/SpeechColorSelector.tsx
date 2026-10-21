import { t, useLocale } from './localization';
import { defaultSpeechColor } from '../shared/appearance';

export function SpeechColorSelector({ value, change }: { value?: string | null; change: (value: string | null) => void }) {
  useLocale();
  return <div className="full speech-color-selector" role="group" aria-label={t("speech_color_selector.speech_color_selection")}>
    <span className="speech-color-label">{t("character_editor.speech_color")}</span>
    <div className="speech-color-controls">
      {value ? <>
        <input type="color" aria-label={t("character_editor.speech_color")} value={value} onChange={event => change(event.target.value)} />
        <button type="button" className="secondary" onClick={() => change(null)}>{t("speech_color_selector.clear_color")}</button>
      </> : <>
        <span>{t("character_editor.not_set")}</span>
        <button type="button" className="secondary" onClick={() => change(defaultSpeechColor)}>{t("speech_color_selector.set_color")}</button>
      </>}
    </div>
    <small className="muted">{t("speech_color_selector.not_set_uses_the_default_from_chat")}</small>
  </div>;
}
