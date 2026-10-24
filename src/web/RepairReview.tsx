import { openModal } from './dialog-focus';
import { formatMessage } from './localization';
import { useTextState, errorText, t, message as msg, useLocale } from './localization';
import { newId } from './uuid';
import { Icon } from './Icon';
import { useEffect, useRef, useState } from 'react';
import type { ChatSnapshot } from '../shared/contracts';
import { refKey, type ContextJob, type ContextJobDetails, type ContextJobProgress, type SummaryPhase, type RepairAction } from '../shared/context';
import { api } from './api';
import { TextComparison } from './TextComparison';
import { RejectedSummary } from './RejectedSummary';

export function RepairReview({ snapshot, job, busy, run, dismissed }: {
  snapshot: ChatSnapshot; job: ContextJob; busy: boolean; run: (action: () => Promise<unknown>) => Promise<boolean>; dismissed: () => void;
}) {
  useLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const pending = useRef(false);
  const retry = useRef<{ key: string; requestId: string } | null>(null);
  const [details, setDetails] = useState<ContextJobDetails | null>(null);
  const [phase, setPhase] = useState<SummaryPhase>('connecting');
  const [error, setError] = useTextState('');
  const [sourcesOpen, setSourcesOpen] = useState(false), [priorOpen, setPriorOpen] = useState(false);
  const [draft, setDraft] = useState<{ key: string; text: string }>({ key: '', text: '' });
  useEffect(() => { openModal(dialog.current); }, []);
  useEffect(() => {
    const controller = new AbortController();
    api<ContextJobDetails>(`/context/jobs/${job.id}`, 'GET', undefined, controller.signal)
      .then(value => { if (!controller.signal.aborted) { setDetails(value); setError(''); } })
      .catch(error => { if (!controller.signal.aborted) setError(errorText(error)); });
    return () => controller.abort();
  }, [job.id, job.status, snapshot.revision]);
  useEffect(() => {
    setPhase('connecting');
    if (job.status !== 'running') return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const progress = await api<ContextJobProgress>(`/context/jobs/${job.id}/progress`, 'GET', undefined, controller.signal);
        if (controller.signal.aborted || progress.status !== 'running') return;
        setPhase(progress.phase ?? 'connecting');
      } catch (error) { if (!controller.signal.aborted) setError(errorText(error)); }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 500);
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [job.id, job.status, snapshot.revision]);
  const rejected = details?.steps.at(-1);
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
      } catch (error) { setError(errorText(error, msg("repair_review.repair_could_not_continue"))); throw error; }
    });
    pending.current = false;
  }
  return <dialog ref={dialog} className="repair-dialog" aria-labelledby="repair-title" onCancel={e => { e.preventDefault(); if (!busy) void act('close'); }}>
    <div className="repair-heading"><div><p className="eyebrow">{t("repair_review.repair_review")}</p><h2 id="repair-title">{t("repair_review.review_the_proposed_replacement")}</h2><p className="small muted" role="status">{t("repair_review.approved_unchanged_after_model_check_reused_without", { value: job.reviewedCount ?? 0, value2: job.unchangedCount ?? 0, value3: job.revalidatedCount ?? 0, value4: remaining !== undefined ? t("repair_review.remaining", { count: remaining }) : '' })}</p></div></div>
    <div className="repair-body">
      {candidate && previous && <><p className="small muted">{t("repair_review.level_approve_this_replacement_before_its_dependents", { level: candidate.level, value: positions.length ? t("interface.turns", { value: String(Math.min(...positions)), value2: String(Math.max(...positions)) }) : t("interface.all_covered_turns_deleted"), value2: previous.manual ? t("interface.previous_summary_includes_manual_corrections") : '' })}</p>
        {!snapshot.context.selected.some(ref => ref.id === candidate.id) && <p className="small muted">{t("repair_review.this_summary_is_retained_approval_saves_the")}</p>}
        {Boolean(step?.operation.reconcile?.length) && <p className="small muted">{t("repair_review.this_proposal_reconciles_overlapping_manual_corrections_compare")}</p>}
        {!candidate.turns.length && <p>{t("repair_review.all_source_turns_were_deleted_approval_removes")}</p>}
        <TextComparison key={key} original={previous.text} value={text} onChange={value => setDraft({ key, text: value })} disabled={locked || !candidate.turns.length} />
        {details?.repair && <details className="repair-sources" open={sourcesOpen} onToggle={e => setSourcesOpen(e.currentTarget.open)}><summary>{t("repair_review.why_this_needs_repair_compare_sources")}</summary><p className="small muted">{t("repair_review.compare_the_sources_used_previously_with_those")}</p>
          {details.repair.previousSources === null && <p>{t("repair_review.previous_source_text_is_unavailable_in_the")}</p>}
          {sourcesOpen && <TextComparison original={details.repair.previousSources ?? ''} value={details.repair.currentSources} originalLabel={t("repair_review.previous_sources")} modifiedLabel={t("repair_review.current_sources")} />}
          {(details.repair.previousPrior || details.repair.currentPrior) && <details open={priorOpen} onToggle={e => { e.stopPropagation(); setPriorOpen(e.currentTarget.open); }}><summary>{t("repair_review.earlier_memory_used_for_interpretation")}</summary>{sourcesOpen && priorOpen && <TextComparison original={details.repair.previousPrior} value={details.repair.currentPrior} originalLabel={t("repair_review.previous_earlier_memory")} modifiedLabel={t("repair_review.current_earlier_memory")} />}</details>}
        </details>}
      </>}
      {running && <p role="status" data-testid="repair-phase">{t(`repair_review.phase_${phase}`)}</p>}
      {!candidate && !running && <p role="status">{t("repair_review.no_candidate_is_ready_regenerate_to_continue")}</p>}
      {current && !running && rejected?.status === 'failed' && rejected.rejectedText !== undefined && <RejectedSummary key={rejected.id} text={rejected.rejectedText} />}
      {(error || job.error) && <p className="repair-error" role="alert">{error || formatMessage(job.errorMessage ?? job.error)}</p>}
      {obsolete && !running && <p role="status">{t("repair_review.the_chat_or_settings_changed_regenerate_this")}</p>}
    </div>
    <div className="repair-footer"><div className="actions"><button disabled={locked || !current || obsolete || !candidate || Boolean(candidate.turns.length && !text.trim())} onClick={() => void act('approve')}>{remaining === 1 ? t("repair_review.approve_finish") : t("repair_review.approve_next")}</button><button className="secondary" disabled={locked} onClick={() => void act('regenerate')}>{t("repair_review.regenerate")}</button><button className="secondary" disabled={busy} title={t("reasoning.close")} onClick={() => void act('close')}><Icon name="Close" /><span className="sr-only">{t("reasoning.close")}</span></button></div><small className="muted">{t("repair_review.close_discards_this_candidate_and_your_unapproved")}</small></div>
  </dialog>;
}
