import { useEffect, useState } from 'react';
import type { ChatSnapshot } from '../shared/contracts';
import type { LibrarySnapshot } from '../shared/library';
import { refKey, type ContextJob, type ContextPlan, type ContextStep, type SummaryNode } from '../shared/context';
import { staleSummaries } from '../core/context';
import { api } from './api';
import { Dropdown, NumberInput } from './Controls';

type Run = (action: () => Promise<unknown>) => Promise<boolean>;
type JobDetails = { job: ContextJob; steps: ContextStep[] };
export function Memory({ snapshot, library, busy, run }: { snapshot: ChatSnapshot; library: LibrarySnapshot; busy: boolean; run: Run }) {
  const [plan, setPlan] = useState<ContextPlan | null>(null), [planError, setPlanError] = useState('');
  const [presetId, setPresetId] = useState(snapshot.settings.contextPresetId ?? ''), [target, setTarget] = useState(snapshot.settings.targetInputTokens);
  const [historyId, setHistoryId] = useState(''), [details, setDetails] = useState<JobDetails | null>(null), [frame, setFrame] = useState(0);
  const [review, setReview] = useState<JobDetails | null>(null), [candidateText, setCandidateText] = useState('');
  const [zoom, setZoom] = useState(false), [inspected, setInspected] = useState<SummaryNode | null>(null);
  const [summaryEdit, setSummaryEdit] = useState<{ text: string; revision: number } | null>(null);
  const active = snapshot.context.jobs.find(job => job.status === 'running');
  const awaiting = snapshot.context.jobs.find(job => job.status === 'awaiting_review');
  const locked = busy || Boolean(active) || snapshot.generations.some(generation => generation.status === 'running');
  useEffect(() => { setPresetId(snapshot.settings.contextPresetId ?? ''); setTarget(snapshot.settings.targetInputTokens); }, [snapshot.settings.contextPresetId, snapshot.settings.targetInputTokens]);
  useEffect(() => {
    let current = true;
    api<ContextPlan>(`/chats/${snapshot.id}/context/plan`).then(value => { if (current) { setPlan(value); setPlanError(''); } }).catch(error => { if (current) { setPlan(null); setPlanError(error.message); } });
    return () => { current = false; };
  }, [snapshot.id, snapshot.revision, active?.stepCount]);
  useEffect(() => {
    let current = true;
    if (!historyId) { setDetails(null); return; }
    api<JobDetails>(`/context/jobs/${historyId}`).then(value => { if (current) { setDetails(value); setFrame(value.steps.length); } }).catch(error => { if (current) setPlanError(error.message); });
    return () => { current = false; };
  }, [historyId, snapshot.revision]);
  useEffect(() => {
    let current = true;
    if (!awaiting) { setReview(null); return; }
    api<JobDetails>(`/context/jobs/${awaiting.id}`).then(value => {
      if (current) { setReview(value); const ref = value.steps.at(-1)?.result; setCandidateText(snapshot.context.summaries.find(node => ref && refKey(node) === refKey(ref))?.text ?? ''); }
    }).catch(error => { if (current) setPlanError(error.message); });
    return () => { current = false; };
  }, [awaiting?.id, snapshot.revision]);
  const selectedFrame = details?.steps[Math.max(0, frame - 1)];
  const view = historyId && selectedFrame ? frame === 0 ? selectedFrame.before : selectedFrame.after ?? selectedFrame.before : snapshot.context;
  const selected = new Set(view.selected.map(refKey)), archived = new Set(view.archivedTurnIds), stale = staleSummaries(snapshot.turns, snapshot.context);
  const viewTurnIds = historyId && details ? details.job.historyTurnIds : snapshot.turns.map(turn => turn.id);
  const positions = new Map(viewTurnIds.map((id, i) => [id, i]));
  const allNodes = snapshot.context.summaries.filter(node => node.approved && (!historyId || node.createdAt <= (selectedFrame?.createdAt ?? '')) || selected.has(refKey(node)));
  const latest = new Map<string, SummaryNode>();
  for (const node of allNodes) if (!latest.has(node.id) || selected.has(refKey(node)) || !selected.has(refKey(latest.get(node.id)!)) && node.revision > latest.get(node.id)!.revision) latest.set(node.id, node);
  const nodes = [...latest.values()];
  const operation = !historyId ? plan?.next : frame === 0 || !selectedFrame?.after ? selectedFrame?.operation : null;
  const levels = Math.max(2, ...nodes.map(node => node.level), operation?.level ?? 0);
  const count = Math.max(viewTurnIds.length, 1), tickSize = Math.max(1, Math.ceil(count / 1_000));
  const spans = (ids: string[]) => {
    const indices = ids.flatMap(id => positions.has(id) ? [positions.get(id)!] : []);
    if (!indices.length) return null;
    const start = Math.min(...indices), end = Math.max(...indices);
    return { left: `${start / count * 100}%`, width: `${(end - start + 1) / count * 100}%`, start: start + 1, end: end + 1 };
  };
  const repairStep = review?.steps.at(-1), repairCandidate = snapshot.context.summaries.find(node => repairStep?.result && refKey(node) === refKey(repairStep.result));
  const oldSummary = snapshot.context.summaries.find(node => repairStep?.operation.repair && refKey(node) === refKey(repairStep.operation.repair));
  const latestJob = snapshot.context.jobs[0];
  const start = (mode: ContextJob['mode']) => run(() => api(`/chats/${snapshot.id}/context/prepare`, 'POST', { revision: snapshot.revision, requestId: crypto.randomUUID(), mode }));
  return <main className="document-panel memory-panel"><p className="eyebrow">CONTEXT & MEMORY</p><h1>Make room for the next chapter.</h1><p className="muted">Original turns stay saved. Memory changes which parts reach the roleplay model.</p>
    <form className="memory-selection" onSubmit={e => { e.preventDefault(); void run(() => api(`/chats/${snapshot.id}/selections`, 'PUT', { revision: snapshot.revision, settings: { title: snapshot.settings.title, targetInputTokens: target, connectionId: snapshot.settings.connectionId ?? null, promptId: snapshot.settings.promptId ?? 'default', characterId: snapshot.settings.characterId ?? null, personaId: snapshot.settings.personaId ?? null, contextPresetId: presetId || null } })); }}>
      <fieldset disabled={locked}><legend>Preparation settings</legend><div className="form-grid"><label>Context preset<Dropdown aria-label="Memory context preset" value={presetId} onChange={setPresetId} options={[{ value: '', label: 'Full verbatim history' }, ...library.contexts.map(item => ({ value: item.id, label: item.name }))]} /></label><label>Input target<NumberInput required value={target} onChange={setTarget} /></label></div><p className="small muted">Edit the summarization Connection, batch sizes and prompts in Libraries → Context presets.</p><button className="secondary" disabled={presetId === (snapshot.settings.contextPresetId ?? '') && target === snapshot.settings.targetInputTokens}>Save memory settings</button></fieldset>
    </form>
    {snapshot.context.preset && <p className="small muted">Minimum tail {snapshot.context.preset.minTail} · Turn batch {snapshot.context.preset.batchSize} · Summary target {snapshot.context.preset.summaryTokens} · Promotion group {snapshot.context.preset.promotionGroup} · Retain per level {snapshot.context.preset.retainedPerLevel}</p>}
    {plan && <div className="budget"><strong>Estimated input: {plan.inputTokens.toLocaleString()} / {plan.effectiveLimit.toLocaleString()}</strong><meter aria-label="Input budget" min={0} max={Math.max(1, plan.effectiveLimit)} value={Math.min(plan.inputTokens, Math.max(1, plan.effectiveLimit))} /><span>{snapshot.context.archivedTurnIds.length} archived turns · {plan.verbatimTurnIds.length} verbatim turns · {snapshot.context.selected.length} active summaries</span><small>Current input, including the resolved prompt and pending text. Counts are conservative estimates, not verified provider tokens. The effective limit respects both your target and the roleplay Connection’s output reservation.</small><p role="status" data-testid="memory-status">{active ? `Preparing memory · ${active.stepCount} steps started. The Mac keeps working if this browser disconnects.` : plan.blocked ?? (plan.ready ? 'Ready: the current assembled input fits. The next submitted turn will be checked again.' : `Next: ${plan.next?.repair ? 'repair' : plan.next?.level === 1 ? 'summarize oldest turns' : `promote to level ${plan.next?.level}`}.`)}</p></div>}
    {planError && <p role="status">{planError}</p>}
    {latestJob?.error && <p className="memory-failure" role="status">{latestJob.error}</p>}
    <div className="actions memory-actions"><button disabled={locked || !snapshot.context.preset || !plan || plan.ready || Boolean(plan.blocked)} onClick={() => void start('prepare')}>Prepare chat</button><button className="secondary" disabled={locked || !plan?.next || Boolean(plan.blocked)} onClick={() => void start('step')}>Save next summary</button><button className="secondary" disabled={locked || !plan?.stale.length || Boolean(awaiting)} onClick={() => void start('repair')}>Repair next affected summary</button>{active && <button className="secondary" disabled={busy} onClick={() => void run(() => active.generationId ? api(`/generations/${active.generationId}/cancel`, 'POST', {}) : api(`/context/jobs/${active.id}/cancel`, 'POST', {}))}>Stop preparation</button>}</div>
    {review && repairCandidate && <section className="repair-review"><p className="eyebrow">REPAIR REVIEW</p><h2>Review the proposed replacement</h2><p className="small muted">Repair proceeds from changed children upward. Approve each candidate before its parent is repaired. Saved generations and earlier summary versions remain unchanged.</p><div className="repair-comparison"><div><h3>Previous summary</h3><div className="prose">{oldSummary?.text}</div></div><div><label>Proposed summary<textarea aria-label="Proposed summary" disabled={locked || !repairCandidate.turns.length} value={candidateText} onChange={e => setCandidateText(e.target.value)} maxLength={1_000_000} /></label>{!repairCandidate.turns.length && <p>All source turns were deleted. Approval removes this summary’s coverage.</p>}</div></div><div className="actions"><button disabled={locked || Boolean(repairCandidate.turns.length && !candidateText.trim())} onClick={() => void run(() => api(`/context/jobs/${review.job.id}/review`, 'POST', { revision: snapshot.revision, accept: true, ...(candidateText !== repairCandidate.text ? { text: candidateText } : {}) }))}>Approve replacement</button><button className="secondary" disabled={locked} onClick={() => void run(() => api(`/context/jobs/${review.job.id}/review`, 'POST', { revision: snapshot.revision, accept: false }))}>Discard candidate</button></div></section>}
    <section className="memory-chart"><div className="memory-chart-heading"><div><h2>How history becomes memory</h2><p className="small muted">Select a summary to inspect its coverage.</p></div><label className="checkbox"><input type="checkbox" checked={zoom} onChange={e => setZoom(e.target.checked)} />Zoom timeline</label></div>
      <label>Inspect saved preparation<Dropdown aria-label="Saved preparation" value={historyId} onChange={id => { setHistoryId(id); setInspected(null); }} options={[{ value: '', label: 'Current committed selection' }, ...snapshot.context.jobs.map(job => ({ value: job.id, label: `${new Date(job.createdAt).toLocaleString()} · ${job.mode} · ${job.status}` }))]} /></label>
      {details && <label className="snapshot-slider">Saved step {frame} / {details.steps.length}<input type="range" aria-label="Saved preparation step" min={0} max={details.steps.length} value={frame} onChange={e => { setFrame(Number(e.target.value)); setInspected(null); }} /><small>History inspection only. Current chat memory is unchanged.</small></label>}
      <div className="timeline-scroll" tabIndex={0} aria-label="Layered memory timeline"><div className="timeline" style={{ width: zoom ? Math.max(720, Math.min(count * 20, 100_000)) : '100%', minWidth: 320, height: levels * 56 + 64 }}>
        {Array.from({ length: levels }, (_, i) => <div className="timeline-row" key={i} style={{ bottom: (i + 1) * 56 + 24 }}>L{i + 1}</div>)}
        {nodes.map(node => { const span = spans(node.turns.map(source => source.turnId)); if (!span) return null; const status = stale.has(refKey(node)) ? 'stale' : selected.has(refKey(node)) ? 'active' : 'retained'; return <button key={refKey(node)} className={`summary-span ${status}`} style={{ left: span.left, width: span.width, bottom: node.level * 56 + 24 }} title={`L${node.level} · turns ${span.start}–${span.end} · ${status}`} aria-label={`Level ${node.level} summary, turns ${span.start} to ${span.end}, ${status}`} onClick={() => { setInspected(node); setSummaryEdit(null); }}>L{node.level} · {span.start}–{span.end}</button>; })}
        {operation && (() => { const span = spans(operation.turnIds); return span && <div className="summary-span preparing" style={{ left: span.left, width: span.width, bottom: operation.level * 56 + 24 }} title="Next source batch; no replacement is active">next</div>; })()}
        {viewTurnIds.filter((_, i) => i % tickSize === 0).map(id => { const index = positions.get(id)!, span = spans(viewTurnIds.slice(index, index + tickSize))!; return <div key={id} title={`Turns ${span.start}–${span.end} · ${archived.has(id) ? 'archived' : 'verbatim'}`} className={`turn-tick ${archived.has(id) ? 'retained' : 'active'}`} style={{ left: span.left, width: span.width }}>{zoom && tickSize === 1 ? span.start : ''}</div>; })}
      </div></div><div className="memory-legend"><span className="active">● Active in input</span><span className="preparing">● Next batch</span><span className="retained">● Retained beneath parents</span><span className="stale">● Out of date</span></div>
    </section>
    {inspected && <section className="summary-inspection"><h2>Level {inspected.level} summary · revision {inspected.revision}</h2><p className="small muted">{inspected.turns.length} source turns · {new TextEncoder().encode(inspected.text).length.toLocaleString()} UTF-8 bytes · {selected.has(refKey(inspected)) ? 'Selected in this view' : 'Retained for inspection'}{inspected.manual ? ' · Manually corrected' : ''}</p>{summaryEdit ? <form onSubmit={async e => { e.preventDefault(); if (await run(() => api(`/chats/${snapshot.id}/context/summaries/${inspected.id}`, 'PATCH', { revision: summaryEdit.revision, summaryRevision: inspected.revision, text: summaryEdit.text }))) { setSummaryEdit(null); setInspected(null); } }}><label>Summary text<textarea aria-label="Summary text" required maxLength={1_000_000} value={summaryEdit.text} onChange={e => setSummaryEdit({ ...summaryEdit, text: e.target.value })} /></label><p className="small muted">Source links remain unchanged. Dependent summaries will require repair; previous versions stay saved.</p><div className="actions"><button disabled={locked || summaryEdit.revision !== snapshot.revision || !summaryEdit.text.trim()}>Save summary edit</button><button type="button" className="quiet" onClick={() => setSummaryEdit(null)}>Cancel edit</button></div>{summaryEdit.revision !== snapshot.revision && <p role="status">The chat changed. Cancel and reopen the summary editor.</p>}</form> : <><div className="prose">{inspected.text}</div>{!historyId && <button type="button" className="quiet" disabled={locked} onClick={() => setSummaryEdit({ text: inspected.text, revision: snapshot.revision })}>Edit summary</button>}</>}<details><summary>Source turns and dependencies</summary><pre>{JSON.stringify({ turns: inspected.turns, children: inspected.children, earlierContext: inspected.prior }, null, 2)}</pre>{inspected.turns.slice(0, 30).map(source => { const turn = snapshot.turns.find(turn => turn.id === source.turnId); return <details key={source.turnId}><summary>Turn {turn ? positions.get(turn.id)! + 1 : 'deleted'} · current source text</summary><div className="prose">{turn ? `${turn.user.text}\n\n${turn.assistant.text}` : 'This source turn has been deleted.'}</div></details>; })}{inspected.turns.length > 30 && <p className="small muted">First 30 source texts shown. All source identities are listed above.</p>}</details></section>}
    {details && <details><summary>Summary requests and step outcomes</summary>{details.steps.map((step, i) => <details key={step.id}><summary>Step {i + 1} · L{step.operation.level} · {step.status}</summary>{step.error && <p>{step.error}</p>}<pre>{JSON.stringify(step.request ?? { note: 'No model request: all covered source turns were deleted.' }, null, 2)}</pre></details>)}</details>}
    {snapshot.context.archivedTurnIds.length > 0 && <details className="restore-memory"><summary>Restore original context</summary><p className="small muted">Return every saved turn to verbatim input. Summaries and preparation records remain available for inspection. Long history may need preparation again before a response can fit.</p><button className="secondary" disabled={locked} onClick={() => { if (confirm('Restore all saved turns to verbatim context? Saved summaries will remain available for inspection.')) void run(() => api(`/chats/${snapshot.id}/context/restore`, 'POST', { revision: snapshot.revision })); }}>Restore all turns to verbatim</button></details>}
  </main>;
}
