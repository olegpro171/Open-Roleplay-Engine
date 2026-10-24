import { LocalizedError, useTextState, errorText, t, message as msg, useLocale, locale } from './localization';
import { LanguageSettings } from './LanguageSettings';
import { localizedMessageSchema, type LocalizedMessage } from '../shared/localization';
import { newId } from './uuid';
import { About } from './About';
import { BackupFileDialog, type BackupFileAction } from './BackupFileDialog';
import { LanSettings } from './LanSettings';
import { ChatAppearanceSettings } from './ChatAppearanceSettings';
import { ChatBehaviorSettings } from './ChatBehaviorSettings';
import type { ChatBehaviorStatus } from '../shared/chat-behavior';
import type { AppearanceStatus } from '../shared/appearance';
import { Dropdown } from './Controls';
import { useEffect, useRef, useState } from 'react';
import { backupFileMaxBytes, backupLimits, backupTables, type BackupTable, type BackupReview, type BackupPage, type BackupLeaf, type DataOutcome } from '../shared/backups';
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
class BackupUploadError extends Error {
  constructor(message: string, readonly details?: string, readonly localized?: LocalizedMessage) { super(message); }
}
type Command = z.infer<typeof commandSchema>;
const commandKey = 'ore-data-management-command';
function recoveredCommand(): Command | null {
  try { const saved = localStorage.getItem(commandKey); return saved ? commandSchema.parse(JSON.parse(saved)) : null; }
  catch { return null; }
}
export function ApplicationSettings({ openLibraries, appearance, appearanceCommitted, chatBehavior, chatBehaviorCommitted }: { chatBehavior: ChatBehaviorStatus | null; chatBehaviorCommitted: (value: ChatBehaviorStatus) => void; openLibraries: () => void; appearance: AppearanceStatus; appearanceCommitted: (value: AppearanceStatus) => void }) {
  useLocale();
  const [review,setReview] = useState<BackupReview|null>(null);
  const [offset,setOffset] = useState(0);
  const [busy,setBusy] = useState(false), [error,setError] = useTextState(''), [message,setMessage] = useTextState('');
  const [errorDetails,setErrorDetails] = useTextState('');
  const [uncertain,setUncertain] = useState<Command|null>(recoveredCommand);
  const [loading,setLoading] = useState(false);
  const [feedbackArea, setFeedbackArea] = useState<'backup' | 'wipe'>('backup');
  const [fileAction, setFileAction] = useState<BackupFileAction | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const mounted = useRef(true), pending = useRef(false), stage = useRef<string|null>(null);
  const confirm = useConfirmation();
  function scrollToCategory(id: string) {
    const heading = document.getElementById(id);
    heading?.focus({ preventScroll: true });
    heading?.scrollIntoView({ block: 'start' });
  }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; if (stage.current && !pending.current) void api(`/data/stages/${stage.current}`,'DELETE',{}).catch(() => {}); }; },[]);
  async function run(action: () => Promise<void>, area: 'backup' | 'wipe' = 'backup') {
    if (pending.current) return;
    pending.current = true; setFeedbackArea(area); setBusy(true); setError(''); setErrorDetails(''); setMessage('');
    try { await action(); } catch (error) {
      if (mounted.current) {
        setError(errorText(error, msg("application_settings.data_management_failed_try_again")));
        setErrorDetails(error instanceof BackupUploadError ? error.details ?? '' : '');
      }
    }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  async function download(exportPassword: string, confirmedPassword: string) {
    await run(async () => {
      if (exportPassword !== confirmedPassword) throw new LocalizedError(msg('application_settings.backup_password_mismatch'));
      const response = await fetch('/api/data/backup', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: exportPassword }),
      });
      if (!response.ok) {
        const failure = z.object({ message: z.string(), localized: localizedMessageSchema.optional() }).safeParse(await response.json());
        throw failure.success ? new ApiError(failure.data.message, response.status, failure.data.localized)
          : new LocalizedError(msg("application_settings.the_backup_could_not_be_created_check"));
      }
      const blob = await response.blob();
      if (!mounted.current) return;
      const url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = response.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1] ?? 'ORE-backup.orebackup';
      link.click(); setTimeout(() => URL.revokeObjectURL(url),60_000);
      setFileAction(null);
      setMessage(msg("application_settings.backup_created_your_browser_handles_the_download"));
    });
  }
  async function select(file: File, importPassword: string) {
    await run(async () => {
      if (file.size > backupFileMaxBytes) throw new LocalizedError(msg("application_settings.backup_file_too_large"));
      if (stage.current) { await api(`/data/stages/${stage.current}`,'DELETE',{}); stage.current = null; setReview(null); }
      const passwordHeader = btoa(String.fromCharCode(...new TextEncoder().encode(importPassword)));
      const response = await fetch('/api/data/stages',{ method: 'POST',credentials: 'same-origin',headers: { 'Content-Type': 'application/octet-stream', 'X-ORE-File-Password': passwordHeader },body: file });
      const result = await response.json();
      if (!response.ok) {
        const failure = z.object({ message: z.string(), details: z.string().optional(), localized: localizedMessageSchema.optional() }).safeParse(result);
        throw new BackupUploadError(failure.success ? failure.data.message : t("application_settings.backup_validation_failed"), failure.success ? failure.data.details : undefined, failure.success ? failure.data.localized : undefined);
      }
      const value: BackupReview = result;
      if (!mounted.current) { await api(`/data/stages/${value.stageId}`,'DELETE',{}); return; }
      stage.current = value.stageId; setOffset(0); setReview(value); setUncertain(null); setFileAction(null);
      requestAnimationFrame(() => { if (mounted.current) scrollToCategory('import-backup-heading'); });
    });
  }
  async function refresh(next = 0) {
    if (!review) return;
    setFeedbackArea('backup'); setLoading(true); setError(''); setErrorDetails('');
    try {
      const value = await api<BackupReview>(`/data/stages/${review.stageId}?offset=${next}`);
      if (mounted.current) { setOffset(next); setReview(value); }
    } catch (error) { if (mounted.current) setError(errorText(error, msg("application_settings.review_could_not_be_loaded_retry"))); }
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
  const feedback = <>
    {busy && <p role="status">{t("application_settings.working_upload_validation_and_snapshot_work_must")}</p>}
    {message && <p role="status">{message}</p>}{error && <div role="alert"><p>{error}</p>{errorDetails && <details className="backup-error-details"><summary>{t("application_settings.details")}</summary><pre>{errorDetails}</pre></details>}</div>}
  </>;
  return <main className="library-layout application-settings">
    <aside className="library-sidebar">
      <p className="eyebrow" id="application-settings-heading">{t("application_settings.application_settings")}</p>
      <nav className="library-tabs" aria-label={t("application_settings.settings_categories")}><button type="button" onClick={() => scrollToCategory('language-heading')}>{t("language.heading")}</button>
        <button type="button" onClick={() => scrollToCategory('chat-appearance-heading')}>{t("application_settings.chat_appearance")}</button>
        <button type="button" onClick={() => scrollToCategory('chat-behavior-heading')}>{t('chat_behavior.heading')}</button>
        <button type="button" onClick={() => scrollToCategory('lan-heading')}>{t("application_settings.phone_lan_access")}</button>
        <button type="button" onClick={() => scrollToCategory('data-backup-heading')}>{t("application_settings.data_backup")}</button>
        <button type="button" onClick={() => scrollToCategory('wipe-data-heading')}>{t("application_settings.wipe_application_data")}</button>
        <button type="button" onClick={() => scrollToCategory('about-heading')}>{t("about.about_ore")}</button>
      </nav>
    </aside>
    <div className="document-panel library-panel settings-panel" aria-labelledby="application-settings-heading">
    {uncertain && <div className="recovery"><p>{t("application_settings.the_command_may_have_committed_retry_this")}</p><button disabled={busy} onClick={() => void run(() => execute(uncertain), uncertain.path === '/data/wipe' ? 'wipe' : 'backup')}>{t("application_settings.retry_data_command")}</button></div>}
    <LanguageSettings /><ChatAppearanceSettings status={appearance} committed={appearanceCommitted} />
    <ChatBehaviorSettings status={chatBehavior} committed={chatBehaviorCommitted} />
    <LanSettings />
    <section className="settings-section" aria-labelledby="data-backup-heading">
    <h2 id="data-backup-heading" tabIndex={-1}>{t("application_settings.data_backup")}</h2>
    <p>{t('application_settings.backup_contents')}</p>
    {!fileAction && feedbackArea === 'backup' && feedback}
    <button type="button" disabled={busy} aria-haspopup="dialog" onClick={() => { setError(''); setErrorDetails(''); setMessage(''); setFileAction({ kind: 'save' }); }}>{t('application_settings.open_save_backup')}</button>
    <section className="settings-subsection" aria-labelledby="import-backup-heading">
    <h3 id="import-backup-heading">{t("application_settings.import_backup")}</h3>
    <button type="button" className="secondary" disabled={busy || Boolean(uncertain)} onClick={() => fileInput.current?.click()}>{t('application_settings.select_backup_file')}</button>
    <input ref={fileInput} type="file" hidden aria-label={t('application_settings.select_backup_file')} accept=".orebackup,.sqlite,.db,application/octet-stream" disabled={busy || Boolean(uncertain)} onChange={event => {
      const file = event.target.files?.[0]; event.target.value = '';
      if (file) { setError(''); setErrorDetails(''); setMessage(''); setFileAction({ kind: 'import', file }); }
    }} />
  {review && <section className="backup-inspection" aria-label={t("application_settings.backup_inspection")}><h4>{t("application_settings.backup_inspection")}</h4>
    <p>{review.metadata ? t("application_settings.ore_schema", { build: review.metadata.build, schema: review.metadata.schema, value: new Date(review.metadata.createdAt).toLocaleString(locale()) }) : t("application_settings.ore_database_no_backup_creation_metadata")}</p>
    <p>{t("application_settings.inspection_changes_no_application_content_this_private", { value: new Date(review.expiresAt).toLocaleTimeString(locale()) })}</p>
    <BackupTree key={review.stageId} stageId={review.stageId} />
    <h4>{t("application_settings.import_review")}</h4><p>{t("application_settings.additions_overlapping_identities_names_do_not_determine", { additions: review.additions, overlaps: review.overlaps })}</p>
    <p>{t("application_settings.overlapping_chats_are_replaced_completely_removing_their")}</p>
    <ul>{review.units.map(unit => <li key={`${unit.kind}:${unit.id}`}><strong>{unit.name}</strong> · {unit.kind} · {unit.overlap ? t("application_settings.overwrite") : t("application_settings.add")} <code>{unit.id}</code>{unit.children > 0 ? t("application_settings.current_dependent_records_in_the_replaced_chat", { children: unit.children }) : ''}</li>)}</ul>
    <div className="actions"><button className="secondary" disabled={busy || loading || offset === 0} onClick={() => void refresh(Math.max(0,offset-backupLimits.page))}>{t("application_settings.previous_review_page")}</button><span>{t("application_settings.of", { value: offset+1, value2: Math.min(offset+backupLimits.page,review.totalUnits), totalUnits: review.totalUnits })}</span><button className="secondary" disabled={busy || loading || offset+backupLimits.page >= Math.max(review.totalUnits,review.totalEffects)} onClick={() => void refresh(offset+backupLimits.page)}>{t("application_settings.next_review_page")}</button></div>
    {review.totalEffects > 0 && <><h5>{t("application_settings.retained_chats_using_incoming_shared_records", { totalEffects: review.totalEffects })}</h5><ul>{review.effects.map(effect => <li key={effect.id}><strong>{effect.title}</strong>: {effect.reason}</li>)}</ul></>}
    {review.blockers.map((blocker,index) => <p role="alert" key={index}>{blocker}</p>)}
    <p>{t("application_settings.to_preserve_another_copy_cancel_and_use")}<a href="#" onClick={event => { event.preventDefault(); openLibraries(); }}>{t("app.libraries")}</a>{t("application_settings.or_save_backup_first_library_copies_may")}</p>
    <div className="actions"><button disabled={busy || loading || Boolean(uncertain)} className="secondary" onClick={() => void refresh()}>{t("application_settings.refresh_import_review")}</button><button disabled={busy || loading || Boolean(uncertain)} className="secondary" onClick={() => void run(async () => { await api(`/data/stages/${review.stageId}`,'DELETE',{}); stage.current = null; setReview(null); })}>{t("application_settings.cancel_inspection")}</button>
    <button disabled={busy || loading || Boolean(uncertain) || review.blockers.length > 0} onClick={() => confirm({ title: review.overlaps ? t("application_settings.overwrite_overlapping_records") : t("application_settings.import_backup_2"),message: t("application_settings.additions_and_overwrites_overlapping_chats_lose_all", { additions: review.additions, overlaps: review.overlaps }),actionLabel: review.overlaps ? t("application_settings.overwrite_and_import") : t("application_settings.import_backup"),onConfirm: () => void run(() => execute({ path: `/data/stages/${review.stageId}/import`,body: { requestId: newId(),digest: review.digest,token: review.token,overwrite: review.overlaps > 0 } })) })}>{t("application_settings.import_entire_backup")}</button></div>
  </section>}
  </section></section>
  <section className="settings-section" aria-labelledby="wipe-data-heading"><h2 id="wipe-data-heading" tabIndex={-1}>{t("application_settings.wipe_application_data")}</h2><p>{t("application_settings.delete_all_chats_memory_libraries_api_keys")}</p>
    <p>{t("application_settings.save_backup_above_before_continuing")}</p>
    {feedbackArea === 'wipe' && feedback}
    <button className="danger" disabled={busy || Boolean(uncertain)} onClick={() => void run(async () => {
      const preview = await api<{ token: string; digest: string }>('/data/wipe-preview');
      confirm({ title: t("application_settings.wipe_application_data_2"),message: t("application_settings.all_saved_story_content_libraries_api_keys"),actionLabel: t("application_settings.wipe_application_data"),onConfirm: () => void run(() => execute({ path: '/data/wipe',body: { ...preview,requestId: newId(),overwrite: true } }), 'wipe') });
    }, 'wipe')}>{t("application_settings.wipe_application_data")}</button>
  </section><About /></div>
  {fileAction && <BackupFileDialog action={fileAction} busy={busy} error={error} errorDetails={errorDetails}
    cancel={() => { if (!pending.current) { setFileAction(null); setError(''); setErrorDetails(''); } }}
    submit={(password, confirmation) => { if (fileAction.kind === 'save') void download(password, confirmation); else void select(fileAction.file, password); }} />}
  </main>;
}

function BackupTree({ stageId }: { stageId: string }) {
  useLocale();
  return <div className="backup-tree" aria-label={t("application_settings.saved_content_tree")}>{backupTables.map(table => <BackupBranch key={table} stageId={stageId} table={table} />)}</div>;
}
function BackupBranch({ stageId,table,chat }: { stageId: string; table: BackupTable; chat?: string }) {
  useLocale();
  const [open,setOpen] = useState(false), [page,setPage] = useState<BackupPage|null>(null), [offset,setOffset] = useState(0), [error,setError] = useTextState(''), [attempt,setAttempt] = useState(0);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController(); setError(''); setPage(null);
    api<BackupPage>(`/data/stages/${stageId}/records/${table}?offset=${offset}${chat ? `&chat=${encodeURIComponent(chat)}` : ''}`,'GET',undefined,controller.signal).then(setPage).catch(error => { if (!controller.signal.aborted) setError(errorText(error)); });
    return () => controller.abort();
  },[open,offset,attempt,stageId,table,chat]);
  return <details open={open} onToggle={event => setOpen(event.currentTarget.open)}><summary>{labels[table]}</summary>{open && <>
    {error ? <p role="alert">{error} <button onClick={() => setAttempt(value => value+1)}>{t("application_settings.retry_branch")}</button></p> : !page ? <p role="status">{t("application_settings.loading_records")}</p> : <>
      {page.total === 0 && <p>{t("application_settings.no_saved_records")}</p>}{page.items.map(item => <BackupRecord key={item.key} stageId={stageId} table={table} item={item} />)}
      <div className="actions"><button className="secondary" disabled={offset === 0} onClick={() => setOffset(value => Math.max(0,value-backupLimits.page))}>{t("application_settings.previous_records")}</button><span>{t("application_settings.records_page", { total: page.total, value: Math.floor(offset/backupLimits.page)+1 })}</span><button className="secondary" disabled={offset+backupLimits.page >= page.total} onClick={() => setOffset(value => value+backupLimits.page)}>{t("application_settings.next_records")}</button></div>
    </>}
  </>}</details>;
}
function BackupRecord({ stageId,table,item }: { stageId: string; table: BackupTable; item: BackupPage['items'][number] }) {
  useLocale();
  const [field,setField] = useState('');
  const [open,setOpen] = useState(false),[leaf,setLeaf] = useState<BackupLeaf|null>(null),[offset,setOffset] = useState(0),[error,setError] = useTextState(''),[attempt,setAttempt] = useState(0);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController(); setError(''); setLeaf(null);
    api<BackupLeaf>(`/data/stages/${stageId}/records/${table}/${item.key}?offset=${offset}${field ? `&field=${encodeURIComponent(field)}` : ''}`,'GET',undefined,controller.signal).then(setLeaf).catch(error => { if (!controller.signal.aborted) setError(errorText(error)); });
    return () => controller.abort();
  },[open,offset,attempt,stageId,table,item.key,field]);
  return <details className="backup-record" open={open} onToggle={event => setOpen(event.currentTarget.open)}><summary>{item.label}</summary>{open && <>
    {error ? <p role="alert">{error} <button onClick={() => setAttempt(value => value+1)}>{t("application_settings.retry_record")}</button></p> : !leaf ? <p role="status">{t("application_settings.loading_record")}</p> : <>
      {item.chatId && <div className="backup-chat-children">{(['turns','response_variants','generations','context_states','summaries','context_jobs','context_steps','lore_epochs','lore_states','lore_operations'] as const).map(child => <BackupBranch key={child} stageId={stageId} table={child} chat={item.chatId} />)}</div>}
      {leaf.imageUrl && <img src={leaf.imageUrl} alt={t("application_settings.saved_picture")} loading="lazy" />}
      <dl>{leaf.fields.map(field => <div key={field.name}><dt>{field.name}</dt><dd>{field.value}</dd></div>)}</dl>
      {leaf.textFields && leaf.textFields.length > 0 && <label>{t("application_settings.record_text_field")}<Dropdown aria-label={t("application_settings.record_text_field")} value={leaf.field ?? ''} onChange={value => { setOffset(0); setField(value); }} options={leaf.textFields.map(name => ({ value: name,label: name }))} /></label>}
      {leaf.text !== null && <pre>{leaf.text}</pre>}{leaf.total > 8192 && <div className="actions"><button disabled={offset === 0} onClick={() => setOffset(value => Math.max(0,value-8192))}>{t("application_settings.previous_text")}</button><span>{t("application_settings.of_characters", { value: offset+1, value2: Math.min(offset+8192,leaf.total), total: leaf.total })}</span><button disabled={offset+8192 >= leaf.total} onClick={() => setOffset(value => value+8192)}>{t("application_settings.next_text")}</button></div>}
    </>}
  </>}</details>;
}
