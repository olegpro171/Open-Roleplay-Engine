import type { MessageText } from './localization';
import { formatMessage } from './localization';
import { useTextState, errorText, t, useLocale, locale } from './localization';
import { newId } from './uuid';
import { useConfirmation } from './Confirmation';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatSnapshot } from '../shared/contracts';
import { hasPromptMarker, type LibrarySnapshot } from '../shared/library';
import { refKey, type ContextJob, type ContextPlan, type ContextStep, type SummaryNode } from '../shared/context';
import { summaryDeletion } from '../core/context-delete';
import { staleSummaries } from '../core/context';
import { api } from './api';
import { Dropdown, NumberInput } from './Controls';
import { Icon } from './Icon';
import { InputMeter } from './PromptPeek';
import { SummaryInspection } from './SummaryInspection';
import { MemoryTimeline } from './MemoryTimeline';
import { RefusalReview } from './RefusalReview';
const RepairReview = lazy(() => import('./RepairReview').then(module => ({ default: module.RepairReview })));

type Run = (action: () => Promise<unknown>) => Promise<boolean>;
type JobDetails = { job: ContextJob; steps: ContextStep[] };
export function Memory({ snapshot, library, busy, run, editPreset }: { snapshot: ChatSnapshot; library: LibrarySnapshot; busy: boolean; run: Run; editPreset: (id: string) => void }) {
  useLocale();
  const confirmAction = useConfirmation(snapshot.id);
  const retryControls = useRef<HTMLFieldSetElement>(null);
  const [autoRetry, setAutoRetry] = useState(true);
  const [maxRetries, setMaxRetries] = useState(10);
  const [planError, setPlanError] = useTextState('');
  const [calculation, setCalculation] = useState<{ key: string; plan: ContextPlan | null; error: MessageText }>({ key: '', plan: null, error: '' });
  const planKey = `${snapshot.id}:${snapshot.revision}:${snapshot.context.revision}`;
  useEffect(() => {
    let current = true;
    api<ContextPlan>(`/chats/${snapshot.id}/context/plan`)
      .then(plan => { if (current) setCalculation({ key: planKey, plan, error: '' }); })
      .catch(error => { if (current) setCalculation(previous => ({ ...previous, key: planKey, error: errorText(error) })); });
    return () => { current = false; };
  }, [planKey]);
  const plan = calculation.plan;
  const planCurrent = calculation.key === planKey && !calculation.error;
  const calculationError = calculation.key === planKey ? formatMessage(calculation.error) : plan ? '' : t("app.counting_current_input");
  const [presetId, setPresetId] = useState(snapshot.settings.contextPresetId ?? ''), [target, setTarget] = useState(snapshot.settings.targetInputTokens);
  const [historyId, setHistoryId] = useState(''), [details, setDetails] = useState<JobDetails | null>(null), [frame, setFrame] = useState(0);
  const [repairSession, setRepairSession] = useState('');
  const [zoom, setZoom] = useState(false), [inspected, setInspected] = useState<SummaryNode | null>(null);
  const [deletionTarget, setDeletionTarget] = useState<{ node: SummaryNode; revision: number } | null>(null);
  const deletionHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (deletionTarget) deletionHeading.current?.focus(); }, [deletionTarget]);
  const deletion = useMemo(() => deletionTarget && deletionTarget.revision === snapshot.revision && !historyId
    ? summaryDeletion(snapshot.context, deletionTarget.node) : null, [deletionTarget, snapshot.context, snapshot.revision, historyId]);
  const restoring = new Set(deletion?.restoredTurnIds ?? []);
  const inspectSummary = (node: SummaryNode | null) => {
    setInspected(node);
    setDeletionTarget(null);
  };
  const summariesEnabled = hasPromptMarker(snapshot.sources.prompt, 'summary');
  const active = snapshot.context.jobs.find(job => job.status === 'running');
  const awaiting = snapshot.context.jobs.find(job => job.status === 'awaiting_review');
  const locked = busy || Boolean(active) || snapshot.generations.some(generation => generation.status === 'running');
  useEffect(() => { setPresetId(snapshot.settings.contextPresetId ?? ''); setTarget(snapshot.settings.targetInputTokens); }, [snapshot.settings.contextPresetId, snapshot.settings.targetInputTokens]);
  useEffect(() => {
    let current = true;
    if (!historyId) { setDetails(null); return; }
    api<JobDetails>(`/context/jobs/${historyId}`).then(value => { if (current) { setDetails(value); setFrame(value.steps.length + Number(Boolean(value.job.refresh)) + Number(Boolean(value.job.finalRefresh))); } }).catch(error => { if (current) setPlanError(errorText(error)); });
    return () => { current = false; };
  }, [historyId, snapshot.revision]);
  const refreshFrame = details?.job.refresh;
  const finalRefresh = details?.job.finalRefresh;
  const historyFrames = details ? [
    ...(refreshFrame ? [{ before: refreshFrame.before, after: refreshFrame.after, operation: null, createdAt: details.job.createdAt }] : []),
    ...details.steps,
    ...(finalRefresh ? [{ before: finalRefresh.before, after: finalRefresh.after, operation: null, createdAt: details.job.updatedAt }] : []),
  ] : [];
  const frameCount = historyFrames.length;
  const selectedFrame = historyFrames[Math.max(0, frame - 1)];
  const view = historyId && selectedFrame ? frame === 0 ? selectedFrame.before : selectedFrame.after ?? selectedFrame.before : snapshot.context;
  const selected = new Set(view.selected.map(refKey)), archived = new Set(view.archivedTurnIds), stale = staleSummaries(snapshot.turns, snapshot.context);
  const viewTurnIds = historyId && details ? details.job.historyTurnIds : snapshot.turns.map(turn => turn.id);
  const viewTime = selectedFrame?.createdAt ?? details?.job.updatedAt;
  const allNodes = snapshot.context.summaries.filter(node => node.approved && (!historyId || node.createdAt <= (viewTime ?? '')) || selected.has(refKey(node)));
  const latest = new Map<string, SummaryNode>();
  for (const node of allNodes) if (!latest.has(node.id) || selected.has(refKey(node)) || !selected.has(refKey(latest.get(node.id)!)) && node.revision > latest.get(node.id)!.revision) latest.set(node.id, node);
  const nodes = [...latest.values()];
  const viewPositions = new Map(viewTurnIds.map((id, index) => [id, index + 1]));
  const summaryOptions = nodes.map(node => {
    const surviving = node.turns.flatMap(source => {
      const position = viewPositions.get(source.turnId);
      return position === undefined ? [] : [position];
    });
    const range = surviving.length ? t("memory.turns", { value: surviving[0], value2: surviving.at(-1) ?? '' }) : t("memory.deleted_coverage");
    return { value: node.id, label: t("memory.l", { level: node.level, range: range, value: selected.has(refKey(node)) ? t("interface.selected") : t("labels.state.retained"), value2: stale.has(refKey(node)) ? t("memory_timeline.stale") : t("memory_timeline.fresh"), value3: node.manual ? t("interface.manually_corrected") : '', id: node.id }) };
  });
  const currentPlan = planCurrent ? plan : null;
  const operation = !historyId ? currentPlan?.next : frame === 0 || !selectedFrame?.after ? selectedFrame?.operation : null;
  const reusable = !historyId ? currentPlan?.reusable
    : selectedFrame && 'reused' in selectedFrame && selectedFrame.reused ? selectedFrame.result : null;
  const levels = Math.max(2, ...nodes.map(node => node.level), operation?.level ?? 0);
  const repairJob = snapshot.context.jobs.find(job => job.mode === 'repair' && (job.status === 'running' || job.status === 'awaiting_review' || job.id === repairSession && ['failed', 'interrupted'].includes(job.status)));
  const latestJob = snapshot.context.jobs[0];
  const start = (mode: Exclude<ContextJob['mode'], 'refresh'>) => run(async () => {
    if (autoRetry && mode !== 'repair' && !retryControls.current?.querySelector<HTMLInputElement>('input[required]')?.reportValidity()) return;
    const result = await api<{ jobId: string }>(`/chats/${snapshot.id}/context/prepare`, 'POST', { revision: snapshot.revision, requestId: newId(), mode, ...(autoRetry && mode !== 'repair' ? { retry: { maxRetries } } : {}) });
    if (mode === 'repair') setRepairSession(result.jobId);
    setHistoryId(''); setDetails(null); setInspected(null); setPlanError('');
  });
  const prepared = latestJob?.sourceRevision === snapshot.revision && latestJob.status === 'succeeded' && latestJob.outcome ? latestJob : null;
  const selectionReport = prepared?.finalRefresh ?? prepared?.refresh;
  const unsavedSettings = presetId !== (snapshot.settings.contextPresetId ?? '') || target !== snapshot.settings.targetInputTokens;
  return <section className="document-panel memory-panel chat-panel" aria-label={t("memory.memory")}><p className="eyebrow">{t("memory.context_memory")}</p><h1>{t("memory.make_room_for_the_next_chapter")}</h1><p className="muted">{t("memory.original_turns_stay_saved_memory_changes_which")}</p>
    <form className="memory-selection" onSubmit={e => { e.preventDefault(); void run(() => api(`/chats/${snapshot.id}/selections`, 'PUT', { revision: snapshot.revision, settings: { title: snapshot.settings.title, targetInputTokens: target, connectionId: snapshot.settings.connectionId ?? null, promptId: snapshot.settings.promptId ?? 'default', characterId: snapshot.settings.characterId ?? null, personaId: snapshot.settings.personaId ?? null, contextPresetId: presetId || null } })); }}>
      <fieldset disabled={locked}><legend>{t("memory.preparation_settings")}</legend><div className="form-grid"><label>{t("libraries.context_preset")}<Dropdown aria-label={t("memory.memory_context_preset")} value={presetId} onChange={setPresetId} options={[{ value: '', label: t("memory.no_context_preset") }, ...library.contexts.map(item => ({ value: item.id, label: item.name }))]} /></label><label>{t("app.input_target")}<NumberInput required value={target} onChange={setTarget} /></label></div><p className="small muted">{t("memory.edit_the_summarization_connection_batch_sizes_and")}</p><button className="secondary" disabled={presetId === (snapshot.settings.contextPresetId ?? '') && target === snapshot.settings.targetInputTokens}>{t("memory.save_memory_settings")}</button></fieldset>
    </form>
    {!summariesEnabled && <p role="status"><strong>{t("memory.summaries_are_disabled")}</strong> {t("memory.enable_a_summary_marker_in_the_prompt")}</p>}
    <RefusalReview snapshot={snapshot} locked={locked || Boolean(awaiting)} run={run} />
    {snapshot.context.preset && summariesEnabled && <p className="small muted">{t("memory.minimum_tail_turn_batch_summary_target_promotion", { minTail: snapshot.context.preset.minTail, batchSize: snapshot.context.preset.batchSize, summaryTokens: snapshot.context.preset.summaryTokens, promotionGroup: snapshot.context.preset.promotionGroup, retainedPerLevel: snapshot.context.preset.retainedPerLevel })} <span aria-hidden="true">·</span> <button type="button" className="quiet text-link" disabled={locked || unsavedSettings} onClick={() => { if (snapshot.settings.contextPresetId) editPreset(snapshot.settings.contextPresetId); }}><Icon name="EditOutline" />{t("memory.edit_context_preset")}</button></p>}
    {plan && <div className="budget"><strong>{t("app.estimated_input_2", { value: plan.inputTokens.toLocaleString(locale()), value2: plan.effectiveLimit.toLocaleString(locale()) })}</strong><InputMeter input={plan.inputTokens} limit={plan.effectiveLimit} /><span>{t("memory.verbatim_turns", { length: plan.verbatimTurnIds.length, value: summariesEnabled ? ` · ${snapshot.context.selected.length} active summaries · ${snapshot.context.archivedTurnIds.length} archived turns` : t("interface.recent_history_within_the_input_limit") })}</span><small>{t("memory.current_input_includes_the_resolved_prompt_and")}</small><p role="status" data-testid="memory-status">{!summariesEnabled ? (plan.blockedMessage ? formatMessage(plan.blockedMessage) : plan.blocked) ?? t("memory.summaries_are_disabled_recent_whole_turns_are") : active ? t("memory.preparing_memory_steps_started_preparation_continues_if", { stepCount: active.stepCount }) : (plan.blockedMessage ? formatMessage(plan.blockedMessage) : plan.blocked) ?? (plan.ready ? t("memory.ready_the_current_assembled_input_fits_the") : plan.reusable ? t("memory.next_reuse_a_saved_level_summary", { level: plan.next?.level ?? '' }) : t("memory.next", { value: plan.next?.repair ? t("labels.state.repair") : plan.next?.level === 1 ? t("interface.summarize_oldest_turns") : t("interface.promote_to_level", { level: String(plan.next?.level) }) }))}</p></div>}
    {(planError || calculationError) && <p role="status">{planError || calculationError}</p>}
    {latestJob?.error && latestJob.sourceRevision === snapshot.revision && !plan?.ready && <p className="memory-failure" role="status">{t("memory.last_preparation_stopped", { error: formatMessage(latestJob.errorMessage ?? latestJob.error) })}</p>}
    <div className="actions memory-actions">
      <button disabled={!summariesEnabled || locked || !planCurrent || !snapshot.context.preset || !plan || Boolean(plan.stale.length) || Boolean(awaiting) || unsavedSettings} onClick={() => void start('prepare')}>{t("memory.prepare_chat")}</button>
      <button className="secondary" disabled={!summariesEnabled || locked || !planCurrent || !plan?.next || Boolean(plan.blocked) || Boolean(awaiting) || unsavedSettings} onClick={() => void start('step')}>{t("memory.save_next_summary")}</button>
      <button className="secondary" disabled={!summariesEnabled || locked || !planCurrent || !plan?.repairCount || Boolean(awaiting)} onClick={() => void start('repair')}>{t("memory.repair_summaries")}</button>
      {active && <button className="secondary" disabled={busy} onClick={() => void run(() => active.generationId ? api(`/generations/${active.generationId}/cancel`, 'POST', {}) : api(`/context/jobs/${active.id}/cancel`, 'POST', {}))}>{t("memory.stop_preparation")}</button>}
    </div>
    {summariesEnabled && <fieldset ref={retryControls} disabled={locked} className="summary-retry-controls"><legend className="sr-only">{t("memory.preparation_retries")}</legend>
      <label className="checkbox"><input type="checkbox" checked={autoRetry} onChange={event => setAutoRetry(event.target.checked)} />{t("memory.auto_retry_failed_or_refused_requests")}</label>
      {autoRetry && <label>{t("memory.maximum_retries")}<NumberInput required aria-label={t("memory.maximum_retries")} min={0} max={Number.MAX_SAFE_INTEGER} value={maxRetries} onChange={setMaxRetries} /><small>{t("memory.retries_after_the_initial_attempt_per_request")}</small></label>}
    </fieldset>}
    {summariesEnabled && <p className="small muted">{t("memory.prepare_chat_reconsiders_memory_for_the_saved")}</p>}
    {summariesEnabled && prepared && <p role="status" data-testid="memory-prepare-result">{t("memory.saved_summaries_reused_new_summaries_generated", { value: prepared.mode === 'step' ? t("interface.summary_step_saved") : t("interface.memory_prepared"), value2: prepared.reusedCount ?? 0, value3: prepared.generatedCount ?? 0 })}{prepared.refresh ? <> {t("memory.verbatim_turns_estimated_input", { verbatimBefore: prepared.refresh.verbatimBefore, verbatimTurns: prepared.outcome!.verbatimTurns, value: prepared.refresh.inputBefore.toLocaleString(locale()), value2: prepared.outcome!.inputTokens.toLocaleString(locale()), value3: selectionReport?.protectedSummaries ? ` ${selectionReport.protectedSummaries} manually edited summaries remain represented.` : '', value4: selectionReport?.limitation ? ` ${formatMessage(selectionReport.limitationMessage ?? selectionReport.limitation)}` : selectionReport?.limited && !prepared.stepCount ? t("interface.no_different_fitting_selection_was_available_in_saved") : '' })}</> : null}</p>}
    {latestJob?.mode === 'repair' && latestJob.status === 'succeeded' && latestJob.sourceRevision === snapshot.revision && <p role="status" data-testid="memory-repair-result">{t("memory.repair_complete_approved_unchanged_after_model_check", { value: latestJob.reviewedCount ?? 0, value2: latestJob.unchangedCount ?? 0, value3: latestJob.revalidatedCount ?? 0 })}</p>}
    {repairJob && <Suspense fallback={<p role="status">{t("memory.opening_repair_review")}</p>}><RepairReview key={repairJob.id} snapshot={snapshot} job={repairJob} busy={busy} run={run} dismissed={() => setRepairSession('')} /></Suspense>}
    <section className="memory-chart"><div className="memory-chart-heading"><div><h2>{t("memory.summary_layers")}</h2><p className="small muted">{t("memory.select_a_summary_to_inspect_its_coverage")}</p></div><label className="checkbox"><input type="checkbox" checked={zoom} onChange={e => setZoom(e.target.checked)} />{t("memory.zoom_timeline")}</label></div>
      <label>{t("memory.inspect_saved_preparation")}<Dropdown aria-label={t("memory.saved_preparation")} value={historyId} onChange={id => { setHistoryId(id); setInspected(null); }} options={[{ value: '', label: t("memory.current_committed_selection") }, ...snapshot.context.jobs.map(job => ({ value: job.id, label: `${new Date(job.createdAt).toLocaleString(locale())} · ${job.mode} · ${job.status}` }))]} /></label>
      {details && <label className="snapshot-slider">{t("memory.saved_step", { frame: frame, frameCount: frameCount })}<input type="range" aria-label={t("memory.saved_preparation_step")} min={0} max={frameCount} value={frame} onChange={e => { setFrame(Number(e.target.value)); setInspected(null); }} /><small>{t("memory.history_inspection_only_current_chat_memory_is")}</small></label>}
      <MemoryTimeline nodes={nodes} selected={selected} stale={stale} archived={archived} turnIds={viewTurnIds} operation={operation} reusable={reusable} levels={levels} zoom={zoom} inspectedId={inspected?.id ?? null} deleting={deletion?.deletedIds} restoring={restoring} inspect={inspectSummary} /><div className="memory-legend"><span className="active">● {summariesEnabled || historyId ? t("memory.active_in_input") : t("memory.saved_selection_disabled")}</span><span className="preparing">{t("memory.next_batch")}</span><span className="retained">{t("memory.retained_alternatives")}</span><span className="stale">{t("memory.out_of_date")}</span><span className="manual">{t("memory.manually_edited")}</span></div>
      {deletionTarget && <section className="summary-deletion" aria-label={t("memory.summary_deletion_preview")}>
        <h3 ref={deletionHeading} tabIndex={-1}>{t("memory.delete_summary_and_dependents")}</h3>
        {deletion ? <>
          <p role="status">{t("memory.summaries_saved_versions_will_be_deleted_including", { size: deletion.deletedIds.size, length: deletion.deleted.length })}</p>
          <p>{t("memory.archived_turns_return_to_verbatim_from_the", { length: deletion.restoredTurnIds.length })}</p>
          {deletion.deleted.some(node => node.manual) && <p><strong>{t("memory.this_includes_manually_corrected_summaries")}</strong></p>}
          <p>{t("memory.all_versions_of_these_summaries_are_removed")}</p>
          {awaiting && <p role="status">{t("memory.close_the_repair_review_before_deleting_summaries")}</p>}
          <ul>{nodes.filter(node => deletion.deletedIds.has(node.id)).map(node => <li key={node.id}>{summaryOptions.find(option => option.value === node.id)?.label}</li>)}</ul>
          <button type="button" disabled={locked || Boolean(awaiting)} onClick={() => void run(async () => {
            await api(`/chats/${snapshot.id}/context/summaries/${deletionTarget.node.id}`, 'DELETE', { revision: deletionTarget.revision, summaryRevision: deletionTarget.node.revision });
            setDeletionTarget(null); setInspected(null); setPlanError('');
          })}>{t("memory.delete_summaries", { size: deletion.deletedIds.size })}</button>
        </> : <p role="status">{t("memory.the_chat_or_view_changed_cancel_this")}</p>}
        <button type="button" className="quiet" disabled={busy} onClick={() => setDeletionTarget(null)}>{t("memory.cancel_deletion")}</button>
      </section>}
    </section>
    {nodes.length > 0 && <label>{t("memory.inspect_saved_summary")}<Dropdown aria-label={t("memory.inspect_saved_summary")} value={inspected?.id ?? ''} onChange={id => inspectSummary(nodes.find(node => node.id === id) ?? null)} options={[{ value: '', label: t("memory.choose_an_identity_and_range") }, ...summaryOptions]} /></label>}
    {inspected && <SummaryInspection key={refKey(inspected)} snapshot={snapshot} node={inspected} historical={Boolean(historyId)} selected={selected} locked={locked} inspect={inspectSummary} saved={() => setInspected(null)} run={run} previewDelete={node => setDeletionTarget({ node, revision: snapshot.revision })} />}
    {details && <details><summary>{t("memory.summary_requests_and_step_outcomes")}</summary>{details.job.error && <p className="small muted">{t("memory.saved_outcome", { error: formatMessage(details.job.errorMessage ?? details.job.error) })}</p>}{refreshFrame && <p className="small muted">{t("memory.saved_memory_selection_verbatim_turns_estimated_input", { verbatimBefore: refreshFrame.verbatimBefore, verbatimAfter: refreshFrame.verbatimAfter, value: refreshFrame.inputBefore.toLocaleString(locale()), value2: refreshFrame.inputAfter.toLocaleString(locale()) })}</p>}{finalRefresh && <p className="small muted">{t("memory.final_saved_memory_selection_verbatim_turns_estimated", { verbatimBefore: finalRefresh.verbatimBefore, verbatimAfter: finalRefresh.verbatimAfter, value: finalRefresh.inputBefore.toLocaleString(locale()), value2: finalRefresh.inputAfter.toLocaleString(locale()) })}</p>}{details.steps.map((step, i) => <details key={step.id}><summary>{t("memory.step_l", { value: i + 1, level: step.operation.level, value2: step.repairOutcome === 'model_unchanged' ? t("interface.model_checked_unchanged") : step.repairOutcome === 'inputs_unchanged' ? t("interface.unchanged_inputs_no_model_request") : step.reused ? t("interface.reused_saved_summary") : step.status })}</summary>{step.resultDeleted && <p>{t("memory.the_saved_result_summary_was_deleted_this")}</p>}{step.error && <p>{formatMessage(step.errorMessage ?? step.error)}</p>}<pre>{JSON.stringify(step.request ?? { note: step.repairOutcome === 'inputs_unchanged' ? t("memory.all_consumed_content_was_unchanged_updated_dependency") : step.reused ? t("memory.reused_a_saved_summary_no_model_request") : t("memory.no_model_request_all_covered_source_turns") }, null, 2)}</pre></details>)}</details>}
    {snapshot.context.summaries.length > 0 || snapshot.context.jobs.length > 0 ? <details className="restore-memory"><summary>{t("memory.clear_memory")}</summary><p className="small muted">{t("memory.delete_every_summary_layer_previous_summary_version")}</p><button className="secondary" disabled={locked} onClick={() => { confirmAction({ title: t("memory.clear_memory_2"), message: t("memory.clear_all_memory_layers_and_preparation_records"), actionLabel: t("memory.clear_memory"), onConfirm: () => { void run(async () => { await api(`/chats/${snapshot.id}/context/clear`, 'POST', { revision: snapshot.revision }); setHistoryId(''); setDetails(null); setInspected(null); setPlanError(''); }); } }); }}>{t("memory.clear_memory")}</button></details> : null}
  </section>;
}
