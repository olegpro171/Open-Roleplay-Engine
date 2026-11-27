import { useEffect, useState, type ReactNode } from 'react';
import { backupLimits, backupTables, type BackupTable, type BackupReview, type BackupPage, type BackupLeaf } from '../shared/backups';
import type { MessageKey } from '../shared/localization';
import { BackupFileSummary, type BackupFileInfo } from './BackupFileSummary';
import { errorText, locale, t, useLocale, useTextState } from './localization';
import { Dropdown } from './Controls';
import { Icon } from './Icon';
import { api } from './api';

const labels = {
  chat_groups: 'branches.shared_settings',
  connections: 'labels.library.connections',
  tags: 'character_editor.tags',
  library: 'backup.table.library',
  chats: 'backup.table.chats',
  turns: 'backup.table.turns',
  response_variants: 'backup.table.response_variants',
  generations: 'backup.table.generations',
  context_states: 'backup.table.context_states',
  summaries: 'backup.table.summaries',
  context_jobs: 'backup.table.context_jobs',
  context_steps: 'backup.table.context_steps',
  lore_epochs: 'backup.table.lore_epochs',
  lore_states: 'backup.table.lore_states',
  lore_operations: 'backup.table.lore_operations',
  character_tags: 'backup.table.character_tags',
  picture_assets: 'backup.table.picture_assets',
  character_pictures: 'backup.table.character_pictures',
  credentials: 'backup.table.credentials',
} as const satisfies Record<BackupTable, MessageKey>;

const unitKinds = {
  chats: 'labels.library.chats', connections: 'labels.library.connections',
  library: 'backup.library_items', tags: 'character_editor.tags',
} as const;

export function BackupInspection({ review, file, offset, loading, disabled, feedback, refresh, openLibraries, cancel, commit }: {
  review: BackupReview; file: BackupFileInfo; offset: number; loading: boolean; disabled: boolean;
  feedback: ReactNode; refresh: (offset?: number) => void; openLibraries: () => void; cancel: () => void; commit: () => void;
}) {
  useLocale();
  const pages = Math.ceil(Math.max(review.totalUnits, review.totalEffects) / backupLimits.page);
  const page = Math.floor(offset / backupLimits.page) + 1;
  return <section className="backup-inspection" aria-labelledby="backup-review-heading">
    <header><h3 id="backup-review-heading" tabIndex={-1}>{t('application_settings.import_review')}</h3>
      <small>{t('application_settings.inspection_changes_no_application_content_this_private', {
        value: new Date(review.expiresAt).toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit' }),
      })}</small>
    </header>
    <BackupFileSummary file={file} />
    <dl className="backup-counts">
      <div><dt>{t('backup.additions')}</dt><dd>{review.additions.toLocaleString(locale())}</dd></div>
      <div><dt>{t('backup.overwrites')}</dt><dd>{review.overlaps.toLocaleString(locale())}</dd></div>
      {review.totalEffects > 0 && <div><dt>{t('backup.retained')}</dt><dd>{review.totalEffects.toLocaleString(locale())}</dd></div>}
    </dl>
    {review.overlaps > 0 && <div className="backup-overwrite-note"><Icon name="ErrorOutline" /><p>{t('application_settings.overlapping_chats_are_replaced_completely_removing_their')}</p></div>}
    {review.blockers.map((blocker, index) => <p role="alert" key={index}>{blocker}</p>)}
    {feedback}
    <div className="backup-review-actions actions">
      <button disabled={disabled || review.blockers.length > 0} onClick={commit}>{t('application_settings.import_entire_backup')}</button>
      <button className="secondary" disabled={disabled} onClick={cancel}>{t('application_settings.cancel_inspection')}</button>
      <button className="quiet" disabled={disabled} onClick={() => refresh()}><Icon name="Refresh" />{t('application_settings.refresh_import_review')}</button>
    </div>
    <details className="backup-disclosure">
      <summary>{t('backup.changes')}</summary>
      <p className="small muted">{t('backup.matching')}</p>
      {pages === 0 && <p>{t('backup.no_changes')}</p>}
      {pages > 1 && <div className="backup-pager">
        <button className="secondary" aria-label={t('application_settings.previous_review_page')} disabled={disabled || page <= 1}
          onClick={() => refresh(offset - backupLimits.page)}><Icon name="ArrowShortBack" /></button>
        <span role="status">{t('lorebook_editor.page_of', { value: page, value2: pages })}</span>
        <button className="secondary" aria-label={t('application_settings.next_review_page')} disabled={disabled || page >= pages}
          onClick={() => refresh(offset + backupLimits.page)}><Icon name="ArrowShortForward" /></button>
      </div>}
      <div className="backup-change-list" data-paged={pages > 1 || undefined} aria-busy={loading} tabIndex={0} role="region" aria-label={t('backup.changes')} key={offset}>
        {review.units.map(unit => <div className="backup-change" key={`${unit.kind}:${unit.id}`}>
          <div><strong>{unit.name}</strong><small>{t(unitKinds[unit.kind])} · <code>{unit.id}</code></small>
            {unit.children > 0 && <small>{t('application_settings.current_dependent_records_in_the_replaced_chat', { children: unit.children })}</small>}
          </div>
          <span className={unit.overlap ? 'backup-overwrite' : ''}>{t(unit.overlap ? 'application_settings.overwrite' : 'application_settings.add')}</span>
        </div>)}
        {review.effects.length > 0 && <section><h4>{t('application_settings.retained_chats_using_incoming_shared_records', { totalEffects: review.totalEffects })}</h4>
          <p className="small muted">{t('backup.retained_help')}</p><ul>{review.effects.map(effect => <li key={effect.id}>{effect.title}</li>)}</ul>
        </section>}
      </div>
      {review.overlaps > 0 && <p className="small muted">{t('application_settings.to_preserve_another_copy_cancel_and_use')}<a href="#" onClick={event => { event.preventDefault(); openLibraries(); }}>{t('app.libraries')}</a>{t('application_settings.or_save_backup_first_library_copies_may')}</p>}
    </details>
    <details className="backup-disclosure"><summary>{t('backup.browse')}</summary>
      <p className="small muted">{review.metadata ? t('application_settings.ore_schema', {
        build: review.metadata.build, schema: review.metadata.schema, value: new Date(review.metadata.createdAt).toLocaleString(locale()),
      }) : t('application_settings.ore_database_no_backup_creation_metadata')}</p>
      <BackupTree stageId={review.stageId} />
    </details>
  </section>;
}

function BackupTree({ stageId }: { stageId: string }) {
  useLocale();
  return <div className="backup-tree">{backupTables.map(table => <BackupBranch key={table} stageId={stageId} table={table} />)}</div>;
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
  return <details open={open} onToggle={event => setOpen(event.currentTarget.open)}><summary>{t(labels[table])}</summary>{open && <>
    {error ? <p role="alert">{error} <button onClick={() => setAttempt(value => value+1)}>{t("application_settings.retry_branch")}</button></p> : !page ? <p role="status">{t("application_settings.loading_records")}</p> : <>
      {page.total === 0 && <p>{t("application_settings.no_saved_records")}</p>}{page.items.map(item => <BackupRecord key={item.key} stageId={stageId} table={table} item={item} />)}
      {page.total > backupLimits.page && <div className="actions"><button className="secondary" disabled={offset === 0} onClick={() => setOffset(value => Math.max(0,value-backupLimits.page))}>{t("application_settings.previous_records")}</button><span>{t("application_settings.records_page", { total: page.total, value: Math.floor(offset/backupLimits.page)+1 })}</span><button className="secondary" disabled={offset+backupLimits.page >= page.total} onClick={() => setOffset(value => value+backupLimits.page)}>{t("application_settings.next_records")}</button></div>}
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
