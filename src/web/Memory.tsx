import { lazy, Suspense, useEffect, useState } from 'react';
import type { ChatSnapshot } from '../shared/contracts';
import { hasPromptMarker, type LibrarySnapshot } from '../shared/library';
import { refKey, type ContextJob, type ContextPlan, type ContextStep, type SummaryNode } from '../shared/context';
import { staleSummaries } from '../core/context';
import { api } from './api';
import { Dropdown, NumberInput } from './Controls';
import { InputMeter } from './PromptPeek';
import { MemoryTimeline } from './MemoryTimeline';
const RepairReview = lazy(() => import('./RepairReview').then(module => ({ default: module.RepairReview })));

type Run = (action: () => Promise<unknown>) => Promise<boolean>;
type JobDetails = { job: ContextJob; steps: ContextStep[] };
export function Memory({ snapshot, library, busy, run }: { snapshot: ChatSnapshot; library: LibrarySnapshot; busy: boolean; run: Run }) {
  const [planError, setPlanError] = useState('');
  const [calculation, setCalculation] = useState<{ key: string; plan: ContextPlan | null; error: string }>({ key: '', plan: null, error: '' });
  const planKey = `${snapshot.id}:${snapshot.revision}:${snapshot.context.revision}`;
  useEffect(() => {
    let current = true;
    api<ContextPlan>(`/chats/${snapshot.id}/context/plan`)
      .then(plan => { if (current) setCalculation({ key: planKey, plan, error: '' }); })
      .catch(error => { if (current) setCalculation(previous => ({ ...previous, key: planKey, error: error.message })); });
    return () => { current = false; };
  }, [planKey]);
  const plan = calculation.plan;
  const planCurrent = calculation.key === planKey && !calculation.error;
  const calculationError = calculation.key === planKey ? calculation.error : plan ? '' : 'Counting current input…';
  const [presetId, setPresetId] = useState(snapshot.settings.contextPresetId ?? ''), [target, setTarget] = useState(snapshot.settings.targetInputTokens);
  const [historyId, setHistoryId] = useState(''), [details, setDetails] = useState<JobDetails | null>(null), [frame, setFrame] = useState(0);
  const [repairSession, setRepairSession] = useState('');
  const [zoom, setZoom] = useState(false), [inspected, setInspected] = useState<SummaryNode | null>(null);
  const [summaryEdit, setSummaryEdit] = useState<{ text: string; revision: number } | null>(null);
  const summariesEnabled = hasPromptMarker(snapshot.sources.prompt, 'summary');
  const active = snapshot.context.jobs.find(job => job.status === 'running');
  const awaiting = snapshot.context.jobs.find(job => job.status === 'awaiting_review');
  const locked = busy || Boolean(active) || snapshot.generations.some(generation => generation.status === 'running');
  useEffect(() => { setPresetId(snapshot.settings.contextPresetId ?? ''); setTarget(snapshot.settings.targetInputTokens); }, [snapshot.settings.contextPresetId, snapshot.settings.targetInputTokens]);
  useEffect(() => {
    let current = true;
    if (!historyId) { setDetails(null); return; }
    api<JobDetails>(`/context/jobs/${historyId}`).then(value => { if (current) { setDetails(value); setFrame(value.steps.length + Number(Boolean(value.job.refresh)) + Number(Boolean(value.job.finalRefresh))); } }).catch(error => { if (current) setPlanError(error.message); });
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
  const positions = new Map(viewTurnIds.map((id, i) => [id, i]));
  const viewTime = selectedFrame?.createdAt ?? details?.job.updatedAt;
  const allNodes = snapshot.context.summaries.filter(node => node.approved && (!historyId || node.createdAt <= (viewTime ?? '')) || selected.has(refKey(node)));
  const latest = new Map<string, SummaryNode>();
  for (const node of allNodes) if (!latest.has(node.id) || selected.has(refKey(node)) || !selected.has(refKey(latest.get(node.id)!)) && node.revision > latest.get(node.id)!.revision) latest.set(node.id, node);
  const nodes = [...latest.values()];
  const operation = !historyId ? plan?.next : frame === 0 || !selectedFrame?.after ? selectedFrame?.operation : null;
  const levels = Math.max(2, ...nodes.map(node => node.level), operation?.level ?? 0);
  const repairJob = snapshot.context.jobs.find(job => job.mode === 'repair' && (job.status === 'running' || job.status === 'awaiting_review' || job.id === repairSession && ['failed', 'interrupted'].includes(job.status)));
  const latestJob = snapshot.context.jobs[0];
  const start = (mode: Exclude<ContextJob['mode'], 'refresh'>) => run(async () => {
    const result = await api<{ jobId: string }>(`/chats/${snapshot.id}/context/prepare`, 'POST', { revision: snapshot.revision, requestId: crypto.randomUUID(), mode });
    if (mode === 'repair') setRepairSession(result.jobId);
    setHistoryId(''); setDetails(null); setInspected(null); setSummaryEdit(null); setPlanError('');
  });
  const prepared = latestJob?.sourceRevision === snapshot.revision && latestJob.status === 'succeeded' && latestJob.outcome ? latestJob : null;
  const selectionReport = prepared?.finalRefresh ?? prepared?.refresh;
  const unsavedSettings = presetId !== (snapshot.settings.contextPresetId ?? '') || target !== snapshot.settings.targetInputTokens;
  return <main className="document-panel memory-panel"><p className="eyebrow">CONTEXT & MEMORY</p><h1>Make room for the next chapter.</h1><p className="muted">Original turns stay saved. Memory changes which parts reach the roleplay model.</p>
    <form className="memory-selection" onSubmit={e => { e.preventDefault(); void run(() => api(`/chats/${snapshot.id}/selections`, 'PUT', { revision: snapshot.revision, settings: { title: snapshot.settings.title, targetInputTokens: target, connectionId: snapshot.settings.connectionId ?? null, promptId: snapshot.settings.promptId ?? 'default', characterId: snapshot.settings.characterId ?? null, personaId: snapshot.settings.personaId ?? null, contextPresetId: presetId || null } })); }}>
      <fieldset disabled={locked}><legend>Preparation settings</legend><div className="form-grid"><label>Context preset<Dropdown aria-label="Memory context preset" value={presetId} onChange={setPresetId} options={[{ value: '', label: 'No context preset' }, ...library.contexts.map(item => ({ value: item.id, label: item.name }))]} /></label><label>Input target<NumberInput required value={target} onChange={setTarget} /></label></div><p className="small muted">Edit the summarization Connection, batch sizes and prompts in Libraries → Context presets.</p><button className="secondary" disabled={presetId === (snapshot.settings.contextPresetId ?? '') && target === snapshot.settings.targetInputTokens}>Save memory settings</button></fieldset>
    </form>
    {!summariesEnabled && <p role="status"><strong>Summaries are disabled.</strong> Enable a Summary marker in the prompt to use memory, then Prepare chat. Saved summaries are kept.</p>}
    {snapshot.context.preset && summariesEnabled && <p className="small muted">Minimum tail {snapshot.context.preset.minTail} · Turn batch {snapshot.context.preset.batchSize} · Summary target {snapshot.context.preset.summaryTokens} · Promotion group {snapshot.context.preset.promotionGroup} · Retain per level {snapshot.context.preset.retainedPerLevel}</p>}
    {plan && <div className="budget"><strong>Estimated input: {plan.inputTokens.toLocaleString()} / {plan.effectiveLimit.toLocaleString()}</strong><InputMeter input={plan.inputTokens} limit={plan.effectiveLimit} /><span>{plan.verbatimTurnIds.length} verbatim turns{summariesEnabled ? ` · ${snapshot.context.selected.length} active summaries · ${snapshot.context.archivedTurnIds.length} archived turns` : ' · Recent history within the input limit'}</span><small>Current input includes the resolved prompt and saved pending text. The effective limit respects both your target and the roleplay Connection’s output reservation.</small><p role="status" data-testid="memory-status">{!summariesEnabled ? plan.blocked ?? 'Summaries are disabled. Recent whole turns are used within the input limit.' : active ? `Preparing memory · ${active.stepCount} steps started. Preparation continues if this browser disconnects.` : plan.blocked ?? (plan.ready ? 'Ready: the current assembled input fits. The next submitted turn will be checked again.' : plan.reusable ? `Next: reuse a saved level ${plan.next?.level} summary.` : `Next: ${plan.next?.repair ? 'repair' : plan.next?.level === 1 ? 'summarize oldest turns' : `promote to level ${plan.next?.level}`}.`)}</p></div>}
    {(planError || calculationError) && <p role="status">{planError || calculationError}</p>}
    {latestJob?.error && latestJob.sourceRevision === snapshot.revision && !plan?.ready && <p className="memory-failure" role="status">Last preparation stopped: {latestJob.error}</p>}
    <div className="actions memory-actions">
      <button disabled={!summariesEnabled || locked || !planCurrent || !snapshot.context.preset || !plan || Boolean(plan.stale.length) || Boolean(awaiting) || unsavedSettings} onClick={() => void start('prepare')}>Prepare chat</button>
      <button className="secondary" disabled={!summariesEnabled || locked || !planCurrent || !plan?.next || Boolean(plan.blocked) || Boolean(awaiting) || unsavedSettings} onClick={() => void start('step')}>Save next summary</button>
      <button className="secondary" disabled={!summariesEnabled || locked || !planCurrent || !plan?.stale.length || Boolean(awaiting)} onClick={() => void start('repair')}>Repair summaries</button>
      {active && <button className="secondary" disabled={busy} onClick={() => void run(() => active.generationId ? api(`/generations/${active.generationId}/cancel`, 'POST', {}) : api(`/context/jobs/${active.id}/cancel`, 'POST', {}))}>Stop preparation</button>}
    </div>
    {summariesEnabled && <p className="small muted">Prepare chat reconsiders memory for the saved budget, reuses valid summaries first, and generates missing summaries only if needed. Recent history regains detail first. Manual corrections remain represented, without pinning later turns. Save settings and review any affected memory first.</p>}
    {summariesEnabled && prepared && <p role="status" data-testid="memory-prepare-result">{prepared.mode === 'step' ? 'Summary step saved.' : 'Memory prepared.'} {prepared.reusedCount ?? 0} saved summaries reused; {prepared.generatedCount ?? 0} new summaries generated.{prepared.refresh ? <> Verbatim turns: {prepared.refresh.verbatimBefore} → {prepared.outcome!.verbatimTurns}. Estimated input: {prepared.refresh.inputBefore.toLocaleString()} → {prepared.outcome!.inputTokens.toLocaleString()}.{selectionReport?.protectedSummaries ? ` ${selectionReport.protectedSummaries} manually edited summaries remain represented.` : ''}{selectionReport?.limitation ? ` ${selectionReport.limitation}` : selectionReport?.limited && !prepared.stepCount ? ' No different fitting selection was available in saved memory.' : ''}</> : null}</p>}
    {latestJob?.mode === 'repair' && latestJob.status === 'succeeded' && latestJob.sourceRevision === snapshot.revision && <p role="status" data-testid="memory-repair-result">Repair complete. {latestJob.reviewedCount ?? 0} approved; {latestJob.unchangedCount ?? 0} unchanged after model check; {latestJob.revalidatedCount ?? 0} reused without a model request.</p>}
    {repairJob && <Suspense fallback={<p role="status">Opening repair review…</p>}><RepairReview key={repairJob.id} snapshot={snapshot} job={repairJob} busy={busy} run={run} dismissed={() => setRepairSession('')} /></Suspense>}
    <section className="memory-chart"><div className="memory-chart-heading"><div><h2>Summary layers</h2><p className="small muted">Select a summary to inspect its coverage.</p></div><label className="checkbox"><input type="checkbox" checked={zoom} onChange={e => setZoom(e.target.checked)} />Zoom timeline</label></div>
      <label>Inspect saved preparation<Dropdown aria-label="Saved preparation" value={historyId} onChange={id => { setHistoryId(id); setInspected(null); }} options={[{ value: '', label: 'Current committed selection' }, ...snapshot.context.jobs.map(job => ({ value: job.id, label: `${new Date(job.createdAt).toLocaleString()} · ${job.mode} · ${job.status}` }))]} /></label>
      {details && <label className="snapshot-slider">Saved step {frame} / {frameCount}<input type="range" aria-label="Saved preparation step" min={0} max={frameCount} value={frame} onChange={e => { setFrame(Number(e.target.value)); setInspected(null); }} /><small>History inspection only. Current chat memory is unchanged.</small></label>}
      <MemoryTimeline nodes={nodes} selected={selected} stale={stale} archived={archived} turnIds={viewTurnIds} operation={operation} levels={levels} zoom={zoom} inspect={node => { setInspected(node); setSummaryEdit(null); }} /><div className="memory-legend"><span className="active">● {summariesEnabled || historyId ? 'Active in input' : 'Saved selection (disabled)'}</span><span className="preparing">● Next batch</span><span className="retained">● Retained beneath parents</span><span className="stale">● Out of date</span><span className="manual">● Manually edited</span></div>
    </section>
    {inspected && <section className="summary-inspection"><h2>Level {inspected.level} summary · revision {inspected.revision}</h2><p className="small muted">{inspected.turns.length} source turns · {new TextEncoder().encode(inspected.text).length.toLocaleString()} UTF-8 bytes · {selected.has(refKey(inspected)) ? 'Selected in this view' : 'Retained for inspection'}{inspected.manual ? ' · Manually corrected' : ''}</p>{summaryEdit ? <form onSubmit={async e => { e.preventDefault(); if (await run(() => api(`/chats/${snapshot.id}/context/summaries/${inspected.id}`, 'PATCH', { revision: summaryEdit.revision, summaryRevision: inspected.revision, text: summaryEdit.text }))) { setSummaryEdit(null); setInspected(null); } }}><label>Summary text<textarea aria-label="Summary text" required maxLength={1_000_000} value={summaryEdit.text} onChange={e => setSummaryEdit({ ...summaryEdit, text: e.target.value })} /></label><p className="small muted">Source links remain unchanged. Dependent summaries will require repair; previous versions stay saved.</p><div className="actions"><button disabled={locked || summaryEdit.revision !== snapshot.revision || !summaryEdit.text.trim()}>Save summary edit</button><button type="button" className="quiet" onClick={() => setSummaryEdit(null)}>Cancel edit</button></div>{summaryEdit.revision !== snapshot.revision && <p role="status">The chat changed. Cancel and reopen the summary editor.</p>}</form> : <><div className="prose">{inspected.text}</div>{!historyId && <button type="button" className="quiet" disabled={locked} onClick={() => setSummaryEdit({ text: inspected.text, revision: snapshot.revision })}>Edit summary</button>}</>}<details><summary>Source turns and dependencies</summary><pre>{JSON.stringify({ turns: inspected.turns, children: inspected.children, earlierContext: inspected.prior }, null, 2)}</pre>{inspected.turns.slice(0, 30).map(source => { const turn = snapshot.turns.find(turn => turn.id === source.turnId); return <details key={source.turnId}><summary>Turn {turn ? positions.get(turn.id)! + 1 : 'deleted'} · current source text</summary><div className="prose">{turn ? `${turn.user.text}\n\n${turn.assistant.text}` : 'This source turn has been deleted.'}</div></details>; })}{inspected.turns.length > 30 && <p className="small muted">First 30 source texts shown. All source identities are listed above.</p>}</details></section>}
    {details && <details><summary>Summary requests and step outcomes</summary>{details.job.error && <p className="small muted">Saved outcome: {details.job.error}</p>}{refreshFrame && <p className="small muted">Saved-memory selection: {refreshFrame.verbatimBefore} → {refreshFrame.verbatimAfter} verbatim turns; estimated input {refreshFrame.inputBefore.toLocaleString()} → {refreshFrame.inputAfter.toLocaleString()}.</p>}{finalRefresh && <p className="small muted">Final saved-memory selection: {finalRefresh.verbatimBefore} → {finalRefresh.verbatimAfter} verbatim turns; estimated input {finalRefresh.inputBefore.toLocaleString()} → {finalRefresh.inputAfter.toLocaleString()}.</p>}{details.steps.map((step, i) => <details key={step.id}><summary>Step {i + 1} · L{step.operation.level} · {step.repairOutcome === 'model_unchanged' ? 'model checked · unchanged' : step.repairOutcome === 'inputs_unchanged' ? 'unchanged inputs · no model request' : step.reused ? 'reused saved summary' : step.status}</summary>{step.error && <p>{step.error}</p>}<pre>{JSON.stringify(step.request ?? { note: step.repairOutcome === 'inputs_unchanged' ? 'All consumed content was unchanged. Updated dependency records without a model request.' : step.reused ? 'Reused a saved summary. No model request.' : 'No model request: all covered source turns were deleted.' }, null, 2)}</pre></details>)}</details>}
    {snapshot.context.summaries.length > 0 || snapshot.context.jobs.length > 0 ? <details className="restore-memory"><summary>Clear memory</summary><p className="small muted">Delete every summary layer, previous summary version, repair candidate and preparation record for this chat. All original turns stay saved and become available for verbatim input within the selected prompt’s rules. Your context preset and saved roleplay requests stay unchanged. Long history may need preparation again.</p><button className="secondary" disabled={locked} onClick={() => { if (confirm('Clear all memory layers and preparation records for this chat? Original turns and saved roleplay requests will be kept.')) void run(async () => { await api(`/chats/${snapshot.id}/context/clear`, 'POST', { revision: snapshot.revision }); setHistoryId(''); setDetails(null); setInspected(null); setSummaryEdit(null); setPlanError(''); }); }}>Clear memory</button></details> : null}
  </main>;
}
