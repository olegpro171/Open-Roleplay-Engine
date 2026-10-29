import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api } from './api';
import { SettingsAutosave, type SettingsStatus } from './settings-autosave';
import { errorText, formatMessage, t, useLocale } from './localization';

export function useSettingsAutosave<Settings extends object, Status extends SettingsStatus<Settings>>({
  status, path, parse, committed, body = value => value,
}: {
  status: Status | null; path: string; parse: (value: unknown) => Status;
  committed?: (value: Status) => void; body?: (value: SettingsStatus<Settings>) => unknown;
}) {
  const callback = useRef(committed);
  callback.current = committed;
  const [autosave] = useState(() => new SettingsAutosave<Settings, Status>(status, {
    read: async () => parse(await api<unknown>(path)),
    write: async value => parse(await api<unknown>(path, 'PUT', body(value))),
    // A request and queued edits finish even if Settings is closed in the meantime.
    committed: value => callback.current?.(value),
  }));
  useEffect(() => { if (status) autosave.observe(status); }, [autosave, status]);
  return autosave;
}

export function useSettingsState<Settings extends object, Status extends SettingsStatus<Settings>>(autosave: SettingsAutosave<Settings, Status>) {
  return useSyncExternalStore(autosave.subscribe, autosave.getSnapshot);
}

export function SettingsSaveStatus({ saving, error, retry }: { saving: boolean; error: unknown; retry: () => Promise<void> }) {
  useLocale();
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (!saving) return;
    const timer = window.setTimeout(() => setSlow(true), 1000);
    return () => window.clearTimeout(timer);
  }, [saving]);
  return <>
    {saving && slow && error == null && <div className="error-banner settings-save-status" role="alert">{t('settings.save_slow')}</div>}
    {error != null && <div className="error-banner settings-save-status" role="alert"><p>{t('settings.save_failed', { error: formatMessage(errorText(error)) })}</p>
      <button type="button" className="secondary" disabled={saving} onClick={() => void retry()}>{t('settings.retry')}</button></div>}
  </>;
}
