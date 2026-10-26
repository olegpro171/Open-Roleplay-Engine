import { t, useLocale } from './localization';
import { themeSpeechColor } from './theme';
import { ColorPicker } from './ColorPicker';

export function SpeechColorSelector({ value, change, disabled = false }: { value?: string | null; change: (value: string | null) => void; disabled?: boolean }) {
  useLocale();
  return <fieldset className="full speech-color-selector" aria-label={t("speech_color_selector.speech_color_selection")}>
    <legend>{t("character_editor.speech_color")}</legend>
    <div className="speech-color-controls">
      {value ? <>
        <ColorPicker label={t("character_editor.speech_color")} value={value} onChange={change} disabled={disabled} />
        <button type="button" className="secondary" onClick={() => change(null)}>{t("speech_color_selector.clear_color")}</button>
      </> : <>
        <span className="speech-color-unset">{t("character_editor.not_set")}</span>
        <button type="button" className="secondary" onClick={() => change(themeSpeechColor('character'))}>{t("speech_color_selector.set_color")}</button>
      </>}
    </div>
  </fieldset>;
}
