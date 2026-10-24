import { useEffect, useRef, useState, type FormEvent } from 'react';
import { chatBehaviorStatusSchema, type ChatBehaviorStatus, type EnterKeyBehavior } from '../shared/chat-behavior';
import { api } from './api';
import { errorText, message, t, useLocale, useTextState } from './localization';
import { isMacKeyboard } from './composer-shortcuts';

export function ChatBehaviorSettings({ status, committed }: {
  status: ChatBehaviorStatus | null; committed: (value: ChatBehaviorStatus) => void;
}) {
  useLocale();
  const [draft, setDraft] = useState(status);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useTextState('');
  const [notice, setNotice] = useTextState('');
  const pending = useRef(false), mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (!draft && status) setDraft(status); }, [draft, status]);
  const conflict = Boolean(status && draft && status.revision !== draft.revision);
  const mac = isMacKeyboard(navigator);

  async function loadOrSave(save: boolean) {
    if (pending.current || (save && (!draft || conflict))) return;
    pending.current = true;
    setBusy(true); setError(''); setNotice('');
    try {
      const value = chatBehaviorStatusSchema.parse(await api<unknown>('/application/chat-behavior', save ? 'PUT' : 'GET', save ? draft : undefined));
      if (mounted.current) {
        setDraft(value); committed(value);
        if (save) setNotice(message('chat_behavior.saved'));
      }
    } catch (cause) {
      if (mounted.current) setError(errorText(cause, message(save ? 'chat_behavior.write_failed' : 'chat_behavior.read_failed')));
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  function save(event: FormEvent) { event.preventDefault(); void loadOrSave(true); }
  const options: { value: EnterKeyBehavior; label: string; help: string }[] = [
    { value: 'ctrl-enter', label: t(mac ? 'chat_behavior.ctrl_enter_mac' : 'chat_behavior.ctrl_enter'), help: t('chat_behavior.ctrl_help') },
    { value: 'enter', label: t('chat_behavior.enter'), help: t('chat_behavior.enter_help') },
    { value: 'button-only', label: t('chat_behavior.button_only'), help: t('chat_behavior.button_help') },
  ];

  return <section className="settings-section" aria-labelledby="chat-behavior-heading">
    <h2 id="chat-behavior-heading" tabIndex={-1}>{t('chat_behavior.heading')}</h2>
    {error && <p role="alert">{t('chat_behavior.edits_retained')} {error}</p>}{notice && <p role="status">{notice}</p>}
    {conflict && <p role="alert">{t('chat_behavior.conflict')}</p>}
    <form onSubmit={save}>
      <fieldset className="chat-behavior-options" disabled={busy || conflict || !draft} aria-describedby="chat-behavior-description chat-behavior-phone-help">
        <legend>{t('chat_behavior.enter_key')}</legend>
        <p id="chat-behavior-description">{t('chat_behavior.description')}</p>
        <p className="small muted" id="chat-behavior-phone-help"><strong>{t('chat_behavior.physical_only')}</strong><br />{t(mac ? 'chat_behavior.phone_help_mac' : 'chat_behavior.phone_help')}</p>
        {options.map(option => <label className="radio-option" key={option.value}>
          <input type="radio" name="enter-key-behavior" value={option.value} checked={draft?.settings.enterKeyBehavior === option.value}
            onChange={() => { if (draft) setDraft({ ...draft, settings: { enterKeyBehavior: option.value } }); setNotice(''); }} />
          <span>{option.label}<small>{option.help}</small></span>
        </label>)}
      </fieldset>
      <div className="actions"><button disabled={busy || conflict || !draft}>{t('chat_behavior.save')}</button>
        <button type="button" className="secondary" disabled={busy} onClick={() => void loadOrSave(false)}>{t('chat_behavior.reload')}</button></div>
    </form>
  </section>;
}
