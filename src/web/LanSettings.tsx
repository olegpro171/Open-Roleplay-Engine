import { formatMessage, t, useLocale } from './localization';
import { useEffect } from 'react';
import { lanSettingsSchema, type LanSettings as Settings, type LanStatus } from '../shared/lan';
import { SettingsSaveStatus, useSettingsState } from './useSettingsAutosave';
import { Dropdown, NumberInput } from './Controls';
import type { SettingsAutosave } from './settings-autosave';

export function LanSettings({ autosave }: { autosave: SettingsAutosave<Settings, LanStatus> }) {
  useLocale();
  const { status, draft, saving, error } = useSettingsState(autosave);
  useEffect(() => {
    void autosave.refresh();
    const timer = setInterval(() => void autosave.refresh(), 5000);
    return () => clearInterval(timer);
  }, [autosave]);
  const disabled = !status?.canConfigure;
  const options = [{ value: '', label: t("lan_settings.select_a_local_network") }, ...(status?.interfaces.map(item => ({ value: item.id, label: `${item.name} · ${item.address}/${item.prefix}` })) ?? [])];
  if (draft?.interfaceId && !options.some(option => option.value === draft.interfaceId)) options.push({ value: draft.interfaceId, label: `${draft.interfaceId} (unavailable)` });
  return <section className="settings-section lan-settings" aria-labelledby="lan-heading">
    <h2 id="lan-heading" tabIndex={-1}>{t("application_settings.phone_lan_access")}</h2>
    <p>{t("lan_settings.use_ore_on_a_phone_connected_to")}</p>
    {!status && !error && <p role="status">{t("lan_settings.loading_lan_settings")}</p>}
    <SettingsSaveStatus saving={saving} error={error} retry={autosave.retry} />
    {status && !status.canConfigure && <p>{t("lan_settings.change_lan_settings_from_ore_s_local")}</p>}
    {status?.runtime.state === 'unavailable' && <div role="alert"><p>{formatMessage(status.runtime.localized ?? status.runtime.message)}</p>
      {status.canConfigure && error == null && <button type="button" className="secondary" disabled={saving} onClick={() => { if (draft) autosave.update(draft, true); }}>{t('settings.retry')}</button>}
    </div>}
    {draft && <div className="lan-settings-controls">
      <label className="checkbox"><input type="checkbox" checked={draft.enabled} disabled={disabled} onChange={event => autosave.update({ enabled: event.target.checked })} />{t("lan_settings.enable_http_access_from_the_local_network")}</label>
      <label className="checkbox"><input type="checkbox" checked={draft.automatic} disabled={disabled} onChange={event => autosave.update({ automatic: event.target.checked, port: event.target.checked ? 3000 : draft.port, interfaceId: event.target.checked ? null : draft.interfaceId ?? status?.interfaces[0]?.id ?? null })} />{t("lan_settings.select_network_automatically")}</label>
      {!draft.automatic && <div className="form-grid">
        <label>{t("lan_settings.local_network")}<Dropdown aria-label={t("lan_settings.local_network")} value={draft.interfaceId ?? ''} disabled={disabled} options={options} onChange={value => autosave.update({ interfaceId: value || null })} /></label>
        <label>{t("lan_settings.lan_port")}<NumberInput min={1024} max={65535} required value={draft.port} disabled={disabled} onChange={port => { if (lanSettingsSchema.shape.port.safeParse(port).success) autosave.update({ port }); }} /></label>
      </div>}
    </div>}
    {status?.runtime.state === 'listening' && <label className="lan-address">{t("lan_settings.open_this_address_on_your_phone")}<input aria-label={t("lan_settings.phone_address")} type="text" readOnly spellCheck={false} value={status.runtime.url} /></label>}
    {status && !draft?.automatic && status.interfaces.length === 0 && <p>{t("lan_settings.no_supported_private_ipv4_network_is_available")}</p>}
  </section>;
}
