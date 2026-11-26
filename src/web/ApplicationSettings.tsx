import { LocalizedError, useTextState, errorText, t, message as msg, useLocale } from './localization';
import { LibraryImport } from './LibraryImport';
import { LanguageSettings } from './LanguageSettings';
import type { MessageKey } from '../shared/localization';
import { newId } from './uuid';
import { About } from './About';
import { BackupFileDialog, BackupRestoreDialog, type BackupFileAction } from './BackupFileDialog';
import { BackupInspection } from './BackupInspection';
import type { BackupFileInfo } from './BackupFileSummary';
import { BackupUploadError, uploadBackup } from './backup-upload';
import { Icon } from './Icon';
import { startDownload } from './downloads';
import { LanSettings } from './LanSettings';
import { ChatAppearanceSettings } from './ChatAppearanceSettings';
import { ChatBehaviorSettings } from './ChatBehaviorSettings';
import type { ChatBehaviorStatus } from '../shared/chat-behavior';
import type { Appearance, AppearanceStatus } from '../shared/appearance';
import type { SettingsAutosave } from './settings-autosave';
import type { LanSettings as LanConfiguration, LanStatus } from '../shared/lan';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { backupReviewSchema, dataCommandSchema, type BackupReview, type DataOutcome } from '../shared/backups';
import { api, ApiError } from './api';
import { z } from 'zod';
import { useConfirmation } from './Confirmation';

const commandSchema = z.object({ path: z.string().regex(/^\/data\/(wipe|stages\/[0-9a-f-]+\/import)$/), body: dataCommandSchema });
type Command = z.infer<typeof commandSchema>;
const commandKey = 'ore-data-management-command';
const settingsCategories = [
  { id: 'language-heading', label: 'language.heading' },
  { id: 'chat-appearance-heading', label: 'application_settings.chat_appearance' },
  { id: 'chat-behavior-heading', label: 'chat_behavior.heading' },
  { id: 'lan-heading', label: 'application_settings.phone_lan_access' },
  { id: 'data-backup-heading', label: 'application_settings.data_backup' },
  { id: 'wipe-data-heading', label: 'application_settings.wipe_application_data' },
  { id: 'about-heading', label: 'about.about_ore' },
] as const satisfies readonly { id: string; label: MessageKey }[];
type SettingsCategory = (typeof settingsCategories)[number]['id'];

function settingsScrollInset(panel: HTMLElement) {
  return Number.parseFloat(getComputedStyle(panel).scrollPaddingTop) || 0;
}

function recoveredCommand(): Command | null {
  try { const saved = localStorage.getItem(commandKey); return saved ? commandSchema.parse(JSON.parse(saved)) : null; }
  catch { return null; }
}
export function ApplicationSettings({ openLibraries, appearance, chatBehavior, lan }: {
  openLibraries: () => void;
  appearance: SettingsAutosave<Appearance, AppearanceStatus>;
  chatBehavior: SettingsAutosave<ChatBehaviorStatus['settings'], ChatBehaviorStatus>;
  lan: SettingsAutosave<LanConfiguration, LanStatus>;
}) {
  useLocale();
  const [review,setReview] = useState<(BackupReview & { file: BackupFileInfo }) | null>(null);
  const [offset,setOffset] = useState(0);
  const [busy,setBusy] = useState(false), [error,setError] = useTextState(''), [message,setMessage] = useTextState('');
  const [errorDetails,setErrorDetails] = useTextState('');
  const [uncertain,setUncertain] = useState<Command|null>(recoveredCommand);
  const [progressId, setProgressId] = useState<string>();
  const [uploaded, setUploaded] = useState<number | null>(null);
  const [loading,setLoading] = useState(false);
  const [feedbackArea, setFeedbackArea] = useState<'backup' | 'wipe'>('backup');
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [fileAction, setFileAction] = useState<BackupFileAction | null>(null);
  const mounted = useRef(true), pending = useRef(false), stage = useRef<string|null>(null);
  const confirm = useConfirmation();
  const scrollPanel = useRef<HTMLDivElement>(null);
  const settingsContent = useRef<HTMLDivElement>(null);
  const categoryNav = useRef<HTMLElement>(null);
  const jumpPosition = useRef<number | null>(null);
  const [currentCategory, setCurrentCategory] = useState<SettingsCategory>(settingsCategories[0].id);

  const syncCurrentCategory = useCallback(() => {
    const panel = scrollPanel.current;
    if (!panel || panel.scrollTop === jumpPosition.current) return;
    jumpPosition.current = null;
    const visibleTop = panel.getBoundingClientRect().top + settingsScrollInset(panel) + 1;
    const atEnd = panel.scrollTop > 0 && panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 1;
    let current: SettingsCategory = settingsCategories[0].id;
    for (const { id } of settingsCategories) {
      const heading = panel.querySelector<HTMLElement>(`#${id}`);
      if (heading && (atEnd || heading.getBoundingClientRect().top <= visibleTop)) current = id;
    }
    setCurrentCategory(current);
  }, []);

  useEffect(() => {
    const panel = scrollPanel.current;
    const content = settingsContent.current;
    if (!panel || !content) return;
    const observer = new ResizeObserver(syncCurrentCategory);
    observer.observe(panel);
    observer.observe(content);
    return () => observer.disconnect();
  }, [syncCurrentCategory]);

  useEffect(() => {
    const nav = categoryNav.current;
    const sidebar = nav?.parentElement;
    const button = nav?.querySelector('[aria-current="location"]');
    if (!nav || !sidebar || !button) return;
    const revealCurrent = () => {
      const active = button.getBoundingClientRect();
      if (nav.scrollWidth > nav.clientWidth) {
        const rail = nav.getBoundingClientRect();
        if (active.left < rail.left) nav.scrollLeft += active.left - rail.left;
        else if (active.right > rail.right) nav.scrollLeft += active.right - rail.right;
      }
      if (sidebar.scrollHeight > sidebar.clientHeight) {
        const bounds = sidebar.getBoundingClientRect();
        if (active.top < bounds.top) sidebar.scrollTop += active.top - bounds.top;
        else if (active.bottom > bounds.bottom) sidebar.scrollTop += active.bottom - bounds.bottom;
      }
    };
    revealCurrent();
    const observer = new ResizeObserver(revealCurrent);
    observer.observe(nav);
    observer.observe(sidebar);
    observer.observe(button);
    return () => observer.disconnect();
  }, [currentCategory]);

  function scrollToCategory(category: SettingsCategory, headingId: string = category) {
    const panel = scrollPanel.current;
    const heading = panel?.querySelector<HTMLElement>(`#${headingId}`);
    if (!panel || !heading) return;
    heading.focus({ preventScroll: true });
    const target = panel.scrollTop + heading.getBoundingClientRect().top - panel.getBoundingClientRect().top - settingsScrollInset(panel);
    panel.scrollTop = target;
    // A short final section may share the same clamped scroll position as its neighbor.
    jumpPosition.current = Math.abs(panel.scrollTop - target) > 1 ? panel.scrollTop : null;
    setCurrentCategory(category);
  }
  const reviewId = review?.stageId;
  useLayoutEffect(() => {
    if (reviewId) scrollToCategory('data-backup-heading', 'backup-review-heading');
  }, [reviewId]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const stageId = stage.current;
      if (!stageId || pending.current) return;
      // The server can still need this file when an unacknowledged command is retried.
      if (recoveredCommand()?.path === `/data/stages/${stageId}/import`) return;
      void api(`/data/stages/${stageId}`, 'DELETE', {}).catch(() => {});
    };
  }, []);
  async function run(action: () => Promise<void>, area: 'backup' | 'wipe' = 'backup') {
    if (pending.current) return;
    pending.current = true; setFeedbackArea(area); setBusy(true); setError(''); setErrorDetails(''); setMessage('');
    try { await action(); } catch (error) {
      if (mounted.current) {
        setError(errorText(error, msg("application_settings.data_management_failed_try_again")));
        setErrorDetails(error instanceof BackupUploadError ? error.details ?? '' : '');
      }
    }
    finally { pending.current = false; if (mounted.current) { setProgressId(undefined); setBusy(false); } }
  }
  async function download(exportPassword: string, confirmedPassword: string) {
    await run(async () => {
      if (exportPassword !== confirmedPassword) throw new LocalizedError(msg('application_settings.backup_password_mismatch'));
      const id = newId(); setProgressId(id);
      const prepared = await api<unknown>('/data/backup', 'POST', { password: exportPassword, progressId: id });
      if (!mounted.current) return;
      startDownload(prepared);
      setFileAction(null);
      setMessage(msg("application_settings.backup_created_your_browser_handles_the_download"));
    });
  }
  async function select(file: File, importPassword: string) {
    await run(async () => {
      setUploaded(0);
      if (stage.current) await discardStage();
      const id = newId(); setProgressId(id);
      const value = await uploadBackup(file, importPassword, id, sent => { if (mounted.current) setUploaded(sent); });
      if (!mounted.current) { await api(`/data/stages/${value.stageId}`,'DELETE',{}); return; }
      stage.current = value.stageId; setOffset(0); setReview({ ...value, file: { name: file.name, size: file.size } }); setUncertain(null); setFileAction(null);
    });
  }
  async function discardStage() {
    try { await api(`/data/stages/${stage.current}`, 'DELETE', {}); }
    catch (error) { if (!(error instanceof ApiError && error.code === 'backup_expired')) throw error; }
    stage.current = null;
    setReview(null);
  }
  async function refresh(next?: number) {
    if (!review) return;
    setFeedbackArea('backup'); setLoading(true); setError(''); setErrorDetails('');
    try {
      const query = next === undefined ? '' : `?view=captured&offset=${next}`;
      const value = backupReviewSchema.parse(await api<unknown>(`/data/stages/${review.stageId}${query}`));
      if (mounted.current && stage.current === review.stageId) { setOffset(next ?? 0); setReview({ ...value, file: review.file }); }
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
  function restore(command: Command) {
    if (pending.current) return;
    setRestoreOpen(true);
    void run(() => execute(command));
  }
  const feedback = <>
    {busy && <p role="status">{t("application_settings.working_upload_validation_and_snapshot_work_must")}</p>}
    {message && <p role="status">{message}</p>}{error && <div role="alert"><p>{error}</p>{errorDetails && <details className="backup-error-details"><summary>{t("application_settings.details")}</summary><pre>{errorDetails}</pre></details>}</div>}
  </>;
  const recoverInReview = review && uncertain?.path === `/data/stages/${review.stageId}/import`;
  const recovery = uncertain && <div className="recovery"><p>{t("application_settings.the_command_may_have_committed_retry_this")}</p><button disabled={busy} onClick={() => {
      if (uncertain.path === '/data/wipe') void run(() => execute(uncertain), 'wipe');
      else restore(uncertain);
    }}>{t("application_settings.retry_data_command")}</button></div>;
  return <main className="library-layout application-settings">
    <aside className="library-sidebar">
      <p className="eyebrow" id="application-settings-heading">{t("application_settings.application_settings")}</p>
      <nav className="library-tabs" ref={categoryNav} aria-label={t("application_settings.settings_categories")}>
        {settingsCategories.map(({ id, label }) => <button key={id} type="button"
          aria-current={id === currentCategory ? 'location' : undefined} onClick={() => scrollToCategory(id)}>{t(label)}</button>)}
      </nav>
    </aside>
    <div className="document-panel library-panel settings-panel" ref={scrollPanel} onScroll={syncCurrentCategory} aria-labelledby="application-settings-heading">
    <div className="settings-content" ref={settingsContent}>
    {!recoverInReview && recovery}
    <LanguageSettings /><ChatAppearanceSettings autosave={appearance} />
    <ChatBehaviorSettings autosave={chatBehavior} />
    <LanSettings autosave={lan} />
    <section className="settings-section" aria-labelledby="data-backup-heading">
    <h2 id="data-backup-heading" tabIndex={-1}>{t("application_settings.data_backup")}</h2>
    {!review && !fileAction && !restoreOpen && feedbackArea === 'backup' && feedback}
    <div className="backup-entry">
      <section aria-labelledby="save-backup-heading"><div><h3 id="save-backup-heading">{t('application_settings.save_backup')}</h3>
        <p>{t('application_settings.backup_contents')}</p></div>
        <button className="secondary" type="button" disabled={busy || loading} aria-haspopup="dialog" onClick={event => {
          event.currentTarget.focus({ preventScroll: true });
          setError(''); setErrorDetails(''); setMessage(''); setFileAction({ kind: 'save' });
        }}><Icon name="SaveOutline" />{t('application_settings.open_save_backup')}</button>
      </section>
      <section aria-labelledby="import-backup-heading"><div><h3 id="import-backup-heading" tabIndex={-1}>{t('application_settings.import_backup')}</h3>
        <p>{t('backup.import_help')}</p></div>
        <LibraryImport label={t('application_settings.select_backup_file')} dialogTitle={t('application_settings.import_backup')}
          description={t('library_import.backup_description')} accept=".orebackup,.sqlite,.db,application/octet-stream"
          disabled={busy || loading || Boolean(uncertain)} onChange={event => {
            const file = event.target.files?.[0]; event.target.value = '';
            if (file) { setError(''); setErrorDetails(''); setMessage(''); setFileAction({ kind: 'import', file }); }
          }} />
      </section>
    </div>
    {review && <BackupInspection key={review.stageId} review={review} file={review.file} offset={offset} loading={loading}
      disabled={busy || loading || Boolean(uncertain)} feedback={!fileAction && !restoreOpen && <>
        {feedbackArea === 'backup' && feedback}{recoverInReview && recovery}
      </>}
      refresh={next => void refresh(next)} openLibraries={openLibraries}
      cancel={() => void run(async () => {
        await discardStage();
        if (mounted.current) scrollToCategory('data-backup-heading', 'import-backup-heading');
      })}
      commit={() => confirm({
        title: msg(review.overlaps ? 'application_settings.overwrite_overlapping_records' : 'application_settings.import_backup_2'),
        message: msg('application_settings.additions_and_overwrites_overlapping_chats_lose_all', { additions: review.additions, overlaps: review.overlaps }),
        actionLabel: msg(review.overlaps ? 'application_settings.overwrite_and_import' : 'application_settings.import_backup'),
        onConfirm: () => restore({ path: `/data/stages/${review.stageId}/import`, body: { requestId: newId(), digest: review.digest, token: review.token, overwrite: review.overlaps > 0 } }),
      })} />}
    </section>
  <section className="settings-section" aria-labelledby="wipe-data-heading"><h2 id="wipe-data-heading" tabIndex={-1}>{t("application_settings.wipe_application_data")}</h2><p>{t("application_settings.delete_all_chats_memory_libraries_api_keys")}</p>
    <p>{t("application_settings.save_backup_above_before_continuing")}</p>
    {feedbackArea === 'wipe' && feedback}
    <button className="danger" disabled={busy || Boolean(uncertain)} onClick={() => void run(async () => {
      const preview = await api<{ token: string; digest: string }>('/data/wipe-preview');
      confirm({ title: t("application_settings.wipe_application_data_2"),message: t("application_settings.all_saved_story_content_libraries_api_keys"),actionLabel: t("application_settings.wipe_application_data"),onConfirm: () => void run(() => execute({ path: '/data/wipe',body: { ...preview,requestId: newId(),overwrite: true } }), 'wipe') });
    }, 'wipe')}>{t("application_settings.wipe_application_data")}</button>
  </section><About /></div></div>
  {restoreOpen && <BackupRestoreDialog busy={busy} error={error} close={() => setRestoreOpen(false)} />}
  {fileAction && <BackupFileDialog action={fileAction} progressId={progressId} uploaded={uploaded} busy={busy} error={error} errorDetails={errorDetails}
    cancel={() => { if (!pending.current) { setFileAction(null); setError(''); setErrorDetails(''); } }}
    submit={(password, confirmation) => { if (fileAction.kind === 'save') void download(password, confirmation); else void select(fileAction.file, password); }} />}
  </main>;
}
