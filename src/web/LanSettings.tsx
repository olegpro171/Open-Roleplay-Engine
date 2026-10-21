import { useEffect, useRef, useState } from 'react';
import { lanStatusSchema, type LanSettings as Settings, type LanStatus } from '../shared/lan';
import { api } from './api';
import { Dropdown, NumberInput } from './Controls';

export function LanSettings() {
  const [status, setStatus] = useState<LanStatus | null>(null);
  const [draft, setDraft] = useState<{ revision: number; settings: Settings } | null>(null);
  const [error, setError] = useState('');
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
        if (!controller.signal.aborted && !saving.current && generation === readGeneration.current) setError(error instanceof Error ? error.message : 'LAN settings could not be loaded.');
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
      if (mounted.current) setError(`${error instanceof Error ? error.message : 'LAN settings could not be saved.'} Your edits are retained. If the connection was lost, reload LAN settings to check the saved result.`);
    } finally {
      saving.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const conflict = status && draft && status.revision !== draft.revision;
  const disabled = loading || busy || !status?.canConfigure;
  const options = [{ value: '', label: 'Select a local network' }, ...(status?.interfaces.map(item => ({ value: item.id, label: `${item.name} · ${item.address}/${item.prefix}` })) ?? [])];
  if (draft?.settings.interfaceId && !options.some(option => option.value === draft.settings.interfaceId)) options.push({ value: draft.settings.interfaceId, label: `${draft.settings.interfaceId} (unavailable)` });
  return <section className="settings-section lan-settings" aria-labelledby="lan-heading">
    <h2 id="lan-heading" tabIndex={-1}>Phone / LAN access</h2>
    <p>Use ORE on a phone connected to the same local network. Keep this computer awake and ORE server running. Enable access only on a trusted local network.</p>
    {loading && <p role="status">Loading LAN settings…</p>}
    {error && <p role="alert">{error}</p>}
    {status && !status.canConfigure && <p>Change LAN settings from ORE’s local address on the server computer.</p>}
    {status?.runtime.state === 'unavailable' && <p role="alert">{status.runtime.message}</p>}
    {conflict && <p role="alert">Another window changed LAN settings. Reload LAN settings before saving.</p>}
    {draft && <form onSubmit={event => void save(event)}>
      <label className="checkbox"><input type="checkbox" checked={draft.settings.enabled} disabled={disabled} onChange={event => setDraft({ ...draft, settings: { ...draft.settings, enabled: event.target.checked } })} />Enable HTTP access from the local network</label>
      <label className="checkbox"><input type="checkbox" checked={draft.settings.automatic} disabled={disabled} onChange={event => setDraft({ ...draft, settings: { ...draft.settings, automatic: event.target.checked, port: event.target.checked ? 3000 : draft.settings.port, interfaceId: event.target.checked ? null : draft.settings.interfaceId ?? status?.interfaces[0]?.id ?? null } })} />Select network automatically</label>
      {!draft.settings.automatic && <div className="form-grid">
        <label>Local network<Dropdown aria-label="Local network" value={draft.settings.interfaceId ?? ''} disabled={disabled} options={options} onChange={value => setDraft({ ...draft, settings: { ...draft.settings, interfaceId: value || null } })} /></label>
        <label>LAN port<NumberInput min={1024} max={65535} required value={draft.settings.port} disabled={disabled} onChange={port => setDraft({ ...draft, settings: { ...draft.settings, port } })} /></label>
      </div>}
      <div className="actions"><button disabled={disabled || Boolean(conflict)}>{busy ? 'Saving LAN settings…' : 'Save LAN settings'}</button></div>
    </form>}
    <button type="button" className="secondary" disabled={busy || loading} onClick={() => setAttempt(value => value + 1)}>Reload LAN settings</button>
    {status?.runtime.state === 'listening' && <label className="lan-address">Open this address on your phone:<input aria-label="Phone address" type="text" readOnly spellCheck={false} value={status.runtime.url} /></label>}
    {status && !draft?.settings.automatic && status.interfaces.length === 0 && <p>No supported private IPv4 network is available. Connect this computer to Wi-Fi or Ethernet, then reload LAN settings.</p>}
  </section>;
}
