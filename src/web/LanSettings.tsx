import { useTextState, errorText, t, message as msg, useLocale } from './localization';
import { useEffect, useRef, useState } from 'react';
import { lanStatusSchema, type LanSettings as Settings, type LanStatus } from '../shared/lan';
import { api } from './api';
import { Dropdown, NumberInput } from './Controls';

export function LanSettings() {
  useLocale();
  const [status, setStatus] = useState<LanStatus | null>(null);
  const [draft, setDraft] = useState<{ revision: number; settings: Settings } | null>(null);
  const [error, setError] = useTextState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const mounted = useRef(false);
  const saving = useRef(false);
  const readGeneration = useRef(0);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    setLoading(true); setError('');
    let reading = false;
    const refresh = async (initial: boolean) => {
      if (saving.current || reading) return;
      reading = true;
      const generation = readGeneration.current;
      try {
        const value = lanStatusSchema.parse(await api<unknown>('/application/lan', 'GET', undefined, controller.signal));
        if (controller.signal.aborted || saving.current || generation !== readGeneration.current) return;
        setStatus(value);
        if (initial) {
          const settings = { ...value.settings };
          if (!settings.interfaceId && value.interfaces.length === 1) settings.interfaceId = value.interfaces[0].id;
          setDraft({ revision: value.revision, settings });
        }
      } catch (error) {
        if (!controller.signal.aborted && !saving.current && generation === readGeneration.current) setError(errorText(error, msg("lan_settings.lan_settings_could_not_be_loaded")));
      } finally { reading = false; if (initial && !controller.signal.aborted) setLoading(false); }
    };
    void refresh(true);
    const timer = setInterval(() => void refresh(false), 5000);
    return () => { mounted.current = false; controller.abort(); clearInterval(timer); };
  }, [attempt]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!draft || saving.current) return;
    readGeneration.current += 1;
    saving.current = true; setBusy(true); setError('');
    try {
      const value = lanStatusSchema.parse(await api<unknown>('/application/lan', 'PUT', { revision: draft.revision, ...draft.settings }));
      if (!mounted.current) return;
      setStatus(value); setDraft({ revision: value.revision, settings: value.settings });
    } catch (error) {
      if (mounted.current) setError(msg("lan_settings.your_edits_are_retained_if_the_connection", { value: error instanceof Error ? error.message : t("interface.lan_settings_could_not_be_saved") }));
    } finally {
      saving.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const conflict = status && draft && status.revision !== draft.revision;
  const disabled = loading || busy || !status?.canConfigure;
  const options = [{ value: '', label: t("lan_settings.select_a_local_network") }, ...(status?.interfaces.map(item => ({ value: item.id, label: `${item.name} · ${item.address}/${item.prefix}` })) ?? [])];
  if (draft?.settings.interfaceId && !options.some(option => option.value === draft.settings.interfaceId)) options.push({ value: draft.settings.interfaceId, label: `${draft.settings.interfaceId} (unavailable)` });
  return <section className="settings-section lan-settings" aria-labelledby="lan-heading">
    <h2 id="lan-heading" tabIndex={-1}>{t("application_settings.phone_lan_access")}</h2>
    <p>{t("lan_settings.use_ore_on_a_phone_connected_to")}</p>
    {loading && <p role="status">{t("lan_settings.loading_lan_settings")}</p>}
    {error && <p role="alert">{error}</p>}
    {status && !status.canConfigure && <p>{t("lan_settings.change_lan_settings_from_ore_s_local")}</p>}
    {status?.runtime.state === 'unavailable' && <p role="alert">{status.runtime.message}</p>}
    {conflict && <p role="alert">{t("lan_settings.another_window_changed_lan_settings_reload_lan")}</p>}
    {draft && <form onSubmit={event => void save(event)}>
      <label className="checkbox"><input type="checkbox" checked={draft.settings.enabled} disabled={disabled} onChange={event => setDraft({ ...draft, settings: { ...draft.settings, enabled: event.target.checked } })} />{t("lan_settings.enable_http_access_from_the_local_network")}</label>
      <label className="checkbox"><input type="checkbox" checked={draft.settings.automatic} disabled={disabled} onChange={event => setDraft({ ...draft, settings: { ...draft.settings, automatic: event.target.checked, port: event.target.checked ? 3000 : draft.settings.port, interfaceId: event.target.checked ? null : draft.settings.interfaceId ?? status?.interfaces[0]?.id ?? null } })} />{t("lan_settings.select_network_automatically")}</label>
      {!draft.settings.automatic && <div className="form-grid">
        <label>{t("lan_settings.local_network")}<Dropdown aria-label={t("lan_settings.local_network")} value={draft.settings.interfaceId ?? ''} disabled={disabled} options={options} onChange={value => setDraft({ ...draft, settings: { ...draft.settings, interfaceId: value || null } })} /></label>
        <label>{t("lan_settings.lan_port")}<NumberInput min={1024} max={65535} required value={draft.settings.port} disabled={disabled} onChange={port => setDraft({ ...draft, settings: { ...draft.settings, port } })} /></label>
      </div>}
      <div className="actions"><button disabled={disabled || Boolean(conflict)}>{busy ? t("lan_settings.saving_lan_settings") : t("lan_settings.save_lan_settings")}</button><button type="button" className="secondary" disabled={busy || loading} onClick={() => setAttempt(value => value + 1)}>{t("lan_settings.reload_lan_settings")}</button></div>
    </form>}
    {!draft && <div className="actions"><button type="button" className="secondary" disabled={busy || loading} onClick={() => setAttempt(value => value + 1)}>{t("lan_settings.reload_lan_settings")}</button></div>}
    {status?.runtime.state === 'listening' && <label className="lan-address">{t("lan_settings.open_this_address_on_your_phone")}<input aria-label={t("lan_settings.phone_address")} type="text" readOnly spellCheck={false} value={status.runtime.url} /></label>}
    {status && !draft?.settings.automatic && status.interfaces.length === 0 && <p>{t("lan_settings.no_supported_private_ipv4_network_is_available")}</p>}
  </section>;
}
