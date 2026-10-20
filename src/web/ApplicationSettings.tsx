import { Dropdown } from './Controls';
import { useEffect, useRef, useState } from 'react';
import { backupLimits, backupTables, type BackupTable, type BackupReview, type BackupPage, type BackupLeaf, type DataOutcome } from '../shared/backups';
import { api, ApiError } from './api';
import { z } from 'zod';
import { dataCommandSchema } from '../shared/backups';
import { useConfirmation } from './Confirmation';

const labels: Record<BackupTable,string> = {
  chats: 'Chats and selections', turns: 'Turns and parts', response_variants: 'Response variants', generations: 'Saved requests and generations',
  summaries: 'Memory versions and corrections', context_states: 'Selected memory and cutoff', context_jobs: 'Preparation history', context_steps: 'Preparation steps and requests',
  library: 'Characters, personas, prompts, context presets and lorebooks', connections: 'Connections', credentials: 'Credential presence', tags: 'Tag catalog', character_tags: 'Character tags',
  picture_assets: 'Original pictures and previews', character_pictures: 'Picture associations and crops', lore_epochs: 'Lore epochs', lore_states: 'Lore activation state', lore_operations: 'Saved lore provenance',
};
const commandSchema = z.object({ path: z.string().regex(/^\/data\/(wipe|stages\/[0-9a-f-]+\/import)$/), body: dataCommandSchema });
type Command = z.infer<typeof commandSchema>;
const commandKey = 'ore-data-management-command';
function recoveredCommand(): Command | null {
  try { const saved = localStorage.getItem(commandKey); return saved ? commandSchema.parse(JSON.parse(saved)) : null; }
  catch { return null; }
}
export function ApplicationSettings({ openLibraries }: { openLibraries: () => void }) {
  const [review,setReview] = useState<BackupReview|null>(null);
  const [offset,setOffset] = useState(0);
  const [busy,setBusy] = useState(false), [error,setError] = useState(''), [message,setMessage] = useState('');
  const [uncertain,setUncertain] = useState<Command|null>(recoveredCommand);
  const [loading,setLoading] = useState(false);
  const mounted = useRef(true), pending = useRef(false), stage = useRef<string|null>(null);
  const confirm = useConfirmation();
  function scrollToCategory(id: string) {
    const heading = document.getElementById(id);
    heading?.focus({ preventScroll: true });
    heading?.scrollIntoView({ block: 'start' });
  }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; if (stage.current && !pending.current) void api(`/data/stages/${stage.current}`,'DELETE',{}).catch(() => {}); }; },[]);
  async function run(action: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(''); setMessage('');
    try { await action(); } catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : 'Data management failed. Try again.'); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  async function download() {
    await run(async () => {
      const response = await fetch('/api/data/backup',{ credentials: 'same-origin' });
      if (!response.ok) throw new Error('The backup could not be created. Check free disk space and try again.');
      const blob = await response.blob(), url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = response.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1] ?? 'ORE-backup.sqlite';
      link.click(); setTimeout(() => URL.revokeObjectURL(url),60_000);
      if (mounted.current) setMessage('Backup created. Your browser handles the download; check its download list.');
    });
  }
  async function select(file: File) {
    await run(async () => {
      if (file.size > backupLimits.bytes) throw new Error('Select an ORE SQLite backup no larger than 128 MiB.');
      if (stage.current) { await api(`/data/stages/${stage.current}`,'DELETE',{}); stage.current = null; }
      const response = await fetch('/api/data/stages',{ method: 'POST',credentials: 'same-origin',headers: { 'Content-Type': 'application/octet-stream' },body: file });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? 'Backup validation failed.');
      const value: BackupReview = result;
      if (!mounted.current) { await api(`/data/stages/${value.stageId}`,'DELETE',{}); return; }
      stage.current = value.stageId; setOffset(0); setReview(value); setUncertain(null);
    });
  }
  async function refresh(next = 0) {
    if (!review) return;
    setLoading(true); setError('');
    try {
      const value = await api<BackupReview>(`/data/stages/${review.stageId}?offset=${next}`);
      if (mounted.current) { setOffset(next); setReview(value); }
    } catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : 'Review could not be loaded. Retry.'); }
    finally { if (mounted.current) setLoading(false); }
  }
  async function execute(command: Command) {
    setUncertain(command);
    // Persist only command identity/digests; no file bytes or credentials enter browser storage.
    localStorage.setItem(commandKey,JSON.stringify(command));
    let result: DataOutcome;
    try { result = await api<DataOutcome>(command.path,'POST',command.body); }
    catch (error) {
      if (error instanceof ApiError && error.status < 500) { localStorage.removeItem(commandKey); setUncertain(null); }
      throw error;
    }
    if (result.ok) {
      localStorage.removeItem(commandKey); if (stage.current && command.path === '/data/wipe') await api(`/data/stages/${stage.current}`,'DELETE',{}); stage.current = null; setUncertain(null); setReview(null);
      // Reload all authoritative state only after committed success. Browser drafts retain their old epoch for review.
      window.location.reload();
    }
  }
  return <main className="library-layout application-settings">
    <aside className="library-sidebar">
      <p className="eyebrow" id="application-settings-heading">APPLICATION SETTINGS</p>
      <nav className="library-tabs" aria-label="Settings categories">
        <button type="button" onClick={() => scrollToCategory('data-backup-heading')}>Data backup</button>
        <button type="button" onClick={() => scrollToCategory('wipe-data-heading')}>Wipe application data</button>
      </nav>
    </aside>
    <div className="document-panel library-panel settings-panel" aria-labelledby="application-settings-heading">
    {busy && <p role="status">Working… Upload, validation and snapshot work must finish before a result is shown.</p>}
    {message && <p role="status">{message}</p>}{error && <p role="alert">{error}</p>}
    {uncertain && <div className="recovery"><p>The command may have committed. Retry this exact command to retrieve its saved outcome. Do not start a different import or wipe.</p><button disabled={busy} onClick={() => void run(() => execute(uncertain))}>Retry data command</button></div>}
    <section className="settings-section" aria-labelledby="data-backup-heading">
    <h2 id="data-backup-heading" tabIndex={-1}>Data backup</h2>
    <p>Backups include saved stories, memory, libraries, pictures and <strong>saved API keys</strong>. Keep the downloaded file private. Browser-local drafts are not included.</p>
    <button disabled={busy} onClick={() => void download()}>Save backup</button>
    <section className="settings-subsection" aria-labelledby="import-backup-heading">
    <h3 id="import-backup-heading">Import backup</h3>
    <label className="backup-file">Inspect &amp; import backup<input type="file" accept=".sqlite,.db,application/octet-stream" disabled={busy || Boolean(uncertain)} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void select(file); }} /></label>
  {review && <section className="backup-inspection" aria-label="Backup inspection"><h4>Backup inspection</h4>
    <p>{review.metadata ? `ORE ${review.metadata.build} · schema ${review.metadata.schema} · ${new Date(review.metadata.createdAt).toLocaleString()}` : 'Legacy ORE schema 12/13 database; no backup creation metadata.'}</p>
    <p>Inspection changes no application content. This private inspection expires at {new Date(review.expiresAt).toLocaleTimeString()}.</p>
    <BackupTree key={review.stageId} stageId={review.stageId} />
    <h4>Import review</h4><p>{review.additions} additions · {review.overlaps} overlapping identities. Names do not determine identity.</p>
    <p>Overlapping chats are replaced completely, removing their current-only turns, variants, memory and request/preparation history. Incoming records also replace keys, tags, pictures and links, including clearing absent values.</p>
    <ul>{review.units.map(unit => <li key={`${unit.kind}:${unit.id}`}><strong>{unit.name}</strong> · {unit.kind} · {unit.overlap ? 'Overwrite' : 'Add'} <code>{unit.id}</code>{unit.children > 0 ? ` · ${unit.children} current dependent records in the replaced chat aggregate` : ''}</li>)}</ul>
    <div className="actions"><button className="secondary" disabled={busy || loading || offset === 0} onClick={() => void refresh(Math.max(0,offset-backupLimits.page))}>Previous review page</button><span>{offset+1}–{Math.min(offset+backupLimits.page,review.totalUnits)} of {review.totalUnits}</span><button className="secondary" disabled={busy || loading || offset+backupLimits.page >= Math.max(review.totalUnits,review.totalEffects)} onClick={() => void refresh(offset+backupLimits.page)}>Next review page</button></div>
    {review.totalEffects > 0 && <><h5>Retained chats using incoming shared records ({review.totalEffects})</h5><ul>{review.effects.map(effect => <li key={effect.id}><strong>{effect.title}</strong>: {effect.reason}</li>)}</ul></>}
    {review.blockers.map((blocker,index) => <p role="alert" key={index}>{blocker}</p>)}
    <p>To preserve another copy, cancel and use existing library copy/edit actions in <a href="#" onClick={event => { event.preventDefault(); openLibraries(); }}>Libraries</a>, or Save backup first. Library copies may share a lorebook; a complete independent chat-copy workflow is not available.</p>
    <div className="actions"><button disabled={busy || loading || Boolean(uncertain)} className="secondary" onClick={() => void refresh()}>Refresh import review</button><button disabled={busy || loading || Boolean(uncertain)} className="secondary" onClick={() => void run(async () => { await api(`/data/stages/${review.stageId}`,'DELETE',{}); stage.current = null; setReview(null); })}>Cancel inspection</button>
    <button disabled={busy || loading || Boolean(uncertain) || review.blockers.length > 0} onClick={() => confirm({ title: review.overlaps ? 'Overwrite overlapping records?' : 'Import backup?',message: `${review.additions} additions and ${review.overlaps} overwrites. Overlapping chats lose all current-only children. Other chats remain saved. This imports the entire backup.`,actionLabel: review.overlaps ? 'Overwrite and import' : 'Import backup',onConfirm: () => void run(() => execute({ path: `/data/stages/${review.stageId}/import`,body: { requestId: crypto.randomUUID(),digest: review.digest,token: review.token,overwrite: review.overlaps > 0 } })) })}>Import entire backup</button></div>
  </section>}
  </section></section>
  <section className="settings-section" aria-labelledby="wipe-data-heading"><h2 id="wipe-data-heading" tabIndex={-1}>Wipe application data</h2><p>Delete all chats, memory, libraries, API keys, tags and other content. Retain the local owner login.</p>
    <p>Save backup above before continuing.</p>
    <button className="danger" disabled={busy || Boolean(uncertain)} onClick={() => void run(async () => {
      const preview = await api<{ token: string; digest: string }>('/data/wipe-preview');
      confirm({ title: 'Wipe application data?',message: 'All saved story content, libraries, API keys and pictures will be deleted. Your local owner login and mandatory factory presets remain. Other sessions are revoked.',actionLabel: 'Wipe application data',onConfirm: () => void run(() => execute({ path: '/data/wipe',body: { ...preview,requestId: crypto.randomUUID(),overwrite: true } })) });
    })}>Wipe application data</button>
  </section></div></main>;
}

function BackupTree({ stageId }: { stageId: string }) {
  return <div className="backup-tree" aria-label="Saved content tree">{backupTables.map(table => <BackupBranch key={table} stageId={stageId} table={table} />)}</div>;
}
function BackupBranch({ stageId,table,chat }: { stageId: string; table: BackupTable; chat?: string }) {
  const [open,setOpen] = useState(false), [page,setPage] = useState<BackupPage|null>(null), [offset,setOffset] = useState(0), [error,setError] = useState(''), [attempt,setAttempt] = useState(0);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController(); setError(''); setPage(null);
    api<BackupPage>(`/data/stages/${stageId}/records/${table}?offset=${offset}${chat ? `&chat=${encodeURIComponent(chat)}` : ''}`,'GET',undefined,controller.signal).then(setPage).catch(error => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  },[open,offset,attempt,stageId,table,chat]);
  return <details open={open} onToggle={event => setOpen(event.currentTarget.open)}><summary>{labels[table]}</summary>{open && <>
    {error ? <p role="alert">{error} <button onClick={() => setAttempt(value => value+1)}>Retry branch</button></p> : !page ? <p role="status">Loading records…</p> : <>
      {page.total === 0 && <p>No saved records.</p>}{page.items.map(item => <BackupRecord key={item.key} stageId={stageId} table={table} item={item} />)}
      <div className="actions"><button className="secondary" disabled={offset === 0} onClick={() => setOffset(value => Math.max(0,value-backupLimits.page))}>Previous records</button><span>{page.total} records · page {Math.floor(offset/backupLimits.page)+1}</span><button className="secondary" disabled={offset+backupLimits.page >= page.total} onClick={() => setOffset(value => value+backupLimits.page)}>Next records</button></div>
    </>}
  </>}</details>;
}
function BackupRecord({ stageId,table,item }: { stageId: string; table: BackupTable; item: BackupPage['items'][number] }) {
  const [field,setField] = useState('');
  const [open,setOpen] = useState(false),[leaf,setLeaf] = useState<BackupLeaf|null>(null),[offset,setOffset] = useState(0),[error,setError] = useState(''),[attempt,setAttempt] = useState(0);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController(); setError(''); setLeaf(null);
    api<BackupLeaf>(`/data/stages/${stageId}/records/${table}/${item.key}?offset=${offset}${field ? `&field=${encodeURIComponent(field)}` : ''}`,'GET',undefined,controller.signal).then(setLeaf).catch(error => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  },[open,offset,attempt,stageId,table,item.key,field]);
  return <details className="backup-record" open={open} onToggle={event => setOpen(event.currentTarget.open)}><summary>{item.label}</summary>{open && <>
    {error ? <p role="alert">{error} <button onClick={() => setAttempt(value => value+1)}>Retry record</button></p> : !leaf ? <p role="status">Loading record…</p> : <>
      {item.chatId && <div className="backup-chat-children">{(['turns','response_variants','generations','context_states','summaries','context_jobs','context_steps','lore_epochs','lore_states','lore_operations'] as const).map(child => <BackupBranch key={child} stageId={stageId} table={child} chat={item.chatId} />)}</div>}
      {leaf.imageUrl && <img src={leaf.imageUrl} alt="Saved picture" loading="lazy" />}
      <dl>{leaf.fields.map(field => <div key={field.name}><dt>{field.name}</dt><dd>{field.value}</dd></div>)}</dl>
      {leaf.textFields && leaf.textFields.length > 0 && <label>Record text field<Dropdown aria-label="Record text field" value={leaf.field ?? ''} onChange={value => { setOffset(0); setField(value); }} options={leaf.textFields.map(name => ({ value: name,label: name }))} /></label>}
      {leaf.text !== null && <pre>{leaf.text}</pre>}{leaf.total > 8192 && <div className="actions"><button disabled={offset === 0} onClick={() => setOffset(value => Math.max(0,value-8192))}>Previous text</button><span>{offset+1}–{Math.min(offset+8192,leaf.total)} of {leaf.total} characters</span><button disabled={offset+8192 >= leaf.total} onClick={() => setOffset(value => value+8192)}>Next text</button></div>}
    </>}
  </>}</details>;
}
