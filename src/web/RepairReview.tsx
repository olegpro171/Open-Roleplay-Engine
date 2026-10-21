import { newId } from './uuid';
import { Icon } from './Icon';
import { useEffect, useRef, useState } from 'react';
import type { ChatSnapshot } from '../shared/contracts';
import { refKey, type ContextJob, type ContextJobDetails, type RepairAction } from '../shared/context';
import { api } from './api';
import { TextComparison } from './TextComparison';

export function RepairReview({ snapshot, job, busy, run, dismissed }: {
  snapshot: ChatSnapshot; job: ContextJob; busy: boolean; run: (action: () => Promise<unknown>) => Promise<boolean>; dismissed: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const pending = useRef(false);
  const retry = useRef<{ key: string; requestId: string } | null>(null);
  const [details, setDetails] = useState<ContextJobDetails | null>(null);
  const [error, setError] = useState('');
  const [sourcesOpen, setSourcesOpen] = useState(false), [priorOpen, setPriorOpen] = useState(false);
  const [draft, setDraft] = useState<{ key: string; text: string }>({ key: '', text: '' });
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    let current = true;
    api<ContextJobDetails>(`/context/jobs/${job.id}`).then(value => { if (current) { setDetails(value); setError(''); } }).catch(error => { if (current) setError(error.message); });
    return () => { current = false; };
  }, [job.id, snapshot.revision]);
  const step = details?.steps.slice().reverse().find(step => step.status === 'candidate');
  const candidate = snapshot.context.summaries.find(node => step?.result && refKey(node) === refKey(step.result));
  const previous = snapshot.context.summaries.find(node => step?.operation.repair && refKey(node) === refKey(step.operation.repair));
  const key = candidate ? refKey(candidate) : '';
  useEffect(() => { setSourcesOpen(false); setPriorOpen(false); }, [key]);
  const text = draft.key === key ? draft.text : candidate?.text ?? '';
  const running = job.status === 'running', locked = busy || running;
  const current = details?.job.sourceRevision === job.sourceRevision;
  const obsolete = Boolean(candidate && job.sourceRevision !== snapshot.revision);
  const remaining = current ? details?.repair?.remaining : undefined;
  const positions = candidate?.turns.map(source => snapshot.turns.findIndex(turn => turn.id === source.turnId) + 1).filter(Boolean) ?? [];
  async function act(action: RepairAction) {
    if (pending.current) return;
    pending.current = true; setError('');
    const body = { revision: snapshot.revision, action, ...(action === 'approve' && text !== candidate?.text ? { text } : {}) };
    const commandKey = JSON.stringify(body);
    if (retry.current?.key !== commandKey) retry.current = { key: commandKey, requestId: newId() };
    await run(async () => {
      try {
        await api(`/context/jobs/${job.id}/repair`, 'POST', { ...body, requestId: retry.current!.requestId });
        retry.current = null;
        if (action === 'close') dismissed();
      } catch (error) { setError(error instanceof Error ? error.message : 'Repair could not continue.'); throw error; }
    });
    pending.current = false;
  }
  return <dialog ref={dialog} className="repair-dialog" aria-labelledby="repair-title" onCancel={e => { e.preventDefault(); if (!busy) void act('close'); }}>
    <div className="repair-heading"><div><p className="eyebrow">REPAIR REVIEW</p><h2 id="repair-title">Review the proposed replacement</h2><p className="small muted" role="status">{job.reviewedCount ?? 0} approved · {job.unchangedCount ?? 0} unchanged after model check · {job.revalidatedCount ?? 0} reused without a request{remaining !== undefined ? ` · ${remaining} remaining` : ''}{running ? ' · Checking affected memory…' : ''}</p></div></div>
    <div className="repair-body">
      {candidate && previous && <><p className="small muted">Level {candidate.level} · {positions.length ? `Turns ${Math.min(...positions)}–${Math.max(...positions)}` : 'All covered turns deleted'}{previous.manual ? ' · Previous summary includes manual corrections' : ''}. Approve this replacement before its dependents are repaired.</p>
        {!snapshot.context.selected.some(ref => ref.id === candidate.id) && <p className="small muted">This summary is retained. Approval saves the repair; use Prepare chat afterward to select compatible corrected memory.</p>}
        {Boolean(step?.operation.reconcile?.length) && <p className="small muted">This proposal reconciles overlapping manual corrections. Compare their full texts under “Why this needs repair” before approving how they are represented.</p>}
        {!candidate.turns.length && <p>All source turns were deleted. Approval removes this summary’s coverage.</p>}
        <TextComparison key={key} original={previous.text} value={text} onChange={value => setDraft({ key, text: value })} disabled={locked || !candidate.turns.length} />
        {details?.repair && <details className="repair-sources" open={sourcesOpen} onToggle={e => setSourcesOpen(e.currentTarget.open)}><summary>Why this needs repair · compare sources</summary><p className="small muted">Compare the sources used previously with those supplied for this candidate. Earlier memory used for interpretation is also a dependency.</p>
          {details.repair.previousSources === null && <p>Previous source text is unavailable in the saved request.</p>}
          {sourcesOpen && <TextComparison original={details.repair.previousSources ?? ''} value={details.repair.currentSources} originalLabel="Previous sources" modifiedLabel="Current sources" />}
          {(details.repair.previousPrior || details.repair.currentPrior) && <details open={priorOpen} onToggle={e => { e.stopPropagation(); setPriorOpen(e.currentTarget.open); }}><summary>Earlier memory used for interpretation</summary>{sourcesOpen && priorOpen && <TextComparison original={details.repair.previousPrior} value={details.repair.currentPrior} originalLabel="Previous earlier memory" modifiedLabel="Current earlier memory" />}</details>}
        </details>}
      </>}
      {!candidate && <p role="status">{running ? 'Generating a repair candidate. Approved repairs are already saved.' : 'No candidate is ready. Regenerate to continue from the saved repairs.'}</p>}
      {(error || job.error) && <p className="repair-error" role="alert">{error || job.error}</p>}
      {obsolete && !running && <p role="status">The chat or settings changed. Regenerate this candidate before approving.</p>}
    </div>
    <div className="repair-footer"><div className="actions"><button disabled={locked || !current || obsolete || !candidate || Boolean(candidate.turns.length && !text.trim())} onClick={() => void act('approve')}>{remaining === 1 ? 'Approve & Finish' : 'Approve & Next'}</button><button className="secondary" disabled={locked} onClick={() => void act('regenerate')}>Regenerate</button><button className="secondary" disabled={busy} title="Close" onClick={() => void act('close')}><Icon name="Close" /><span className="sr-only">Close</span></button></div><small className="muted">Close discards this candidate and your unapproved edits. Approved repairs stay saved.</small></div>
  </dialog>;
}
