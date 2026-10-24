import { type ChatBehaviorStatus, type EnterKeyBehavior } from '../shared/chat-behavior';
import { SettingsSaveStatus, useSettingsState } from './useSettingsAutosave';
import { t, useLocale } from './localization';
import { isMacKeyboard } from './composer-shortcuts';
import type { SettingsAutosave } from './settings-autosave';
import { NumberInput } from './Controls';

export function ChatBehaviorSettings({ autosave }: { autosave: SettingsAutosave<ChatBehaviorStatus['settings'], ChatBehaviorStatus> }) {
  useLocale();
  const { draft, saving, error } = useSettingsState(autosave);
  const mac = isMacKeyboard(navigator);

  const options: { value: EnterKeyBehavior; label: string; help: string }[] = [
    { value: 'ctrl-enter', label: t(mac ? 'chat_behavior.ctrl_enter_mac' : 'chat_behavior.ctrl_enter'), help: t('chat_behavior.ctrl_help') },
    { value: 'enter', label: t('chat_behavior.enter'), help: t('chat_behavior.enter_help') },
    { value: 'button-only', label: t('chat_behavior.button_only'), help: t('chat_behavior.button_help') },
  ];

  return <section className="settings-section" aria-labelledby="chat-behavior-heading">
    <h2 id="chat-behavior-heading" tabIndex={-1}>{t('chat_behavior.heading')}</h2>
    <SettingsSaveStatus saving={saving} error={error} retry={autosave.retry} />
    <div>
      <fieldset className="chat-behavior-options" disabled={!draft} aria-describedby="chat-behavior-description chat-behavior-phone-help">
        <legend>{t('chat_behavior.enter_key')}</legend>
        <p id="chat-behavior-description">{t('chat_behavior.description')}</p>
        <p className="small muted" id="chat-behavior-phone-help"><strong>{t('chat_behavior.physical_only')}</strong><br />{t(mac ? 'chat_behavior.phone_help_mac' : 'chat_behavior.phone_help')}</p>
        {options.map(option => <label className="radio-option" key={option.value}>
          <input type="radio" name="enter-key-behavior" value={option.value} checked={draft?.enterKeyBehavior === option.value}
            onChange={() => autosave.update({ enterKeyBehavior: option.value })} />
          <span>{option.label}<small>{option.help}</small></span>
        </label>)}
      </fieldset>
      <fieldset disabled={!draft} className="summary-retry-controls">
        <legend className="sr-only">{t('chat_behavior.input_target')}</legend>
        <label className="checkbox"><input type="checkbox" checked={draft?.allowInputOvershoot ?? true}
          onChange={event => autosave.update({ allowInputOvershoot: event.target.checked })} />{t('chat_behavior.allow_input_overshoot')}</label>
        <label>{t('chat_behavior.maximum_overshoot_tokens')}<NumberInput required min={0} max={Number.MAX_SAFE_INTEGER}
          disabled={!draft?.allowInputOvershoot} value={draft?.maximumOvershootTokens ?? 100}
          onChange={value => { if (Number.isSafeInteger(value) && value >= 0) autosave.update({ maximumOvershootTokens: value }); }} /></label>
        <p className="small muted">{t('chat_behavior.overshoot_help')}</p>
      </fieldset>
    </div>
  </section>;
}
