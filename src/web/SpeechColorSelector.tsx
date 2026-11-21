import { t, useLocale } from './localization';
import { themeSpeechColor } from './theme';
import { ColorPicker } from './ColorPicker';
import type { ChatPreviewAppearance } from './ChatTextPreview';

export function SpeechColorSelector({ value, change, appearance, speaker = 'character', disabled = false }: {
  value?: string | null; speaker?: 'character' | 'persona'; appearance: ChatPreviewAppearance;
  change: (value: string | null) => void; disabled?: boolean;
}) {
  useLocale();
  return <fieldset className="full speech-color-selector" aria-label={t("speech_color_selector.speech_color_selection")}>
    <legend>{t("character_editor.speech_color")}</legend>
    <div className="speech-color-controls">
      {value ? <>
        <ColorPicker label={t("character_editor.speech_color")} speaker={speaker} appearance={appearance} value={value} onChange={change} disabled={disabled} />
        <button type="button" className="secondary" onClick={() => change(null)}>{t("speech_color_selector.clear_color")}</button>
      </> : <>
        <span className="speech-color-unset">{t("character_editor.not_set")}</span>
        <button type="button" className="secondary" onClick={() => change(themeSpeechColor(speaker))}>{t("speech_color_selector.set_color")}</button>
      </>}
    </div>
  </fieldset>;
}
