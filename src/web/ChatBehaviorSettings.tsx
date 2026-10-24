import { type ChatBehaviorStatus, type EnterKeyBehavior } from '../shared/chat-behavior';
import { SettingsSaveStatus, useSettingsState } from './useSettingsAutosave';
import { t, useLocale } from './localization';
import { isMacKeyboard } from './composer-shortcuts';
import type { SettingsAutosave } from './settings-autosave';

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
    </div>
  </section>;
}
