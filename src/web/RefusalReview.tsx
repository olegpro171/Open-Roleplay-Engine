import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChatToolsSnapshot } from '../shared/contracts';
import { refKey, type SummaryRef } from '../shared/context';
import { refusalFindings } from '../core/summary-refusals';
import { summaryDependencies } from '../core/context-corrections';
import { summarySuffixDeletion } from '../core/context-delete';
import { summaryRefusalFilterVersion } from '../core/summary-validation';
import { api } from './api';
import { t, useLocale } from './localization';

export function RefusalReview({ snapshot, locked, run }: {
  snapshot: ChatToolsSnapshot; locked: boolean; run: (action: () => Promise<unknown>) => Promise<boolean>;
}) {
  useLocale();
  const findings = useMemo(() => refusalFindings(snapshot.context), [snapshot.context]);
  const needed = useMemo(() => {
    const nodes = new Map(snapshot.context.summaries.map(node => [refKey(node), node]));
    const keys = new Set<string>();
    const queue = [...snapshot.context.selected];
    for (let index = 0; index < queue.length; index++) {
      const key = refKey(queue[index]);
      if (keys.has(key)) continue;
      keys.add(key);
      const node = nodes.get(key);
      if (node) queue.push(...summaryDependencies(node));
    }
    return keys;
  }, [snapshot.context]);
  const [opened, setOpened] = useState('');
  const [preview, setPreview] = useState<{ revision: number; refs: SummaryRef[] } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (preview) heading.current?.focus(); }, [preview]);
  const deletion = useMemo(() => preview && preview.revision === snapshot.revision
    ? summarySuffixDeletion(snapshot.context, snapshot.turns.map(turn => turn.id), preview.refs) : null, [preview, snapshot]);
  const positions = useMemo(() => new Map(snapshot.turns.map((turn, index) => [turn.id, index + 1])), [snapshot.turns]);
  const resolve = (refs: SummaryRef[], action: 'keep' | 'regenerate' | 'delete', revision = snapshot.revision) => run(async () => {
    await api(`/chats/${snapshot.id}/context/refusals`, 'POST', { revision, filterVersion: summaryRefusalFilterVersion, summaries: refs.map(({ id, revision }) => ({ id, revision })), action });
    setPreview(null);
  });
  if (!findings.length) return null;
  const pending = findings.filter(node => node.regeneration !== 'refusal');
  return <section className="summary-inspection" aria-label={t('refusals.heading')}>
    <h2>{t('refusals.heading')}</h2>
    <p role="status">{t('refusals.notice', { count: findings.length })}</p>
    <p className="small muted">{t('refusals.help')}</p>
    {pending.length > 1 && <div className="actions">
      <button type="button" className="secondary" disabled={locked} onClick={() => void resolve(pending, 'keep')}>{t('refusals.keep_all')}</button>
      <button type="button" className="secondary" disabled={locked} onClick={() => void resolve(pending, 'regenerate')}>{t('refusals.regenerate_all')}</button>
      <button type="button" className="quiet" disabled={locked} onClick={() => setPreview({ revision: snapshot.revision, refs: pending.map(({ id, revision }) => ({ id, revision })) })}>{t('refusals.delete_all')}</button>
    </div>}
    {findings.map(node => {
      const range = node.turns.flatMap(source => positions.get(source.turnId) ?? []);
      const current = needed.has(refKey(node));
      return <details key={refKey(node)} open={opened === refKey(node)} onToggle={event => { if (event.currentTarget.open) setOpened(refKey(node)); else setOpened(previous => previous === refKey(node) ? '' : previous); }}>
        <summary>{t('refusals.range', { level: node.level, first: range[0] ?? '—', last: range.at(-1) ?? '—', state: current ? t('refusals.selected') : t('refusals.retained') })}</summary>
        {opened === refKey(node) && <><div className="prose">{node.text}</div>
          {node.regeneration === 'refusal' && <p role="status">{t('refusals.repair_pending')}</p>}
          <div className="actions">
            <button type="button" className="secondary" disabled={locked} onClick={() => void resolve([node], 'keep')}>{t('refusals.keep')}</button>
            <button type="button" className="secondary" disabled={locked || node.regeneration === 'refusal'} onClick={() => void resolve([node], 'regenerate')}>{t('refusals.regenerate')}</button>
            <button type="button" className="quiet" disabled={locked} onClick={() => setPreview({ revision: snapshot.revision, refs: [{ id: node.id, revision: node.revision }] })}>{t('refusals.delete')}</button>
          </div>
        </>}
      </details>;
    })}
    {findings.some(node => node.regeneration === 'refusal') && <p role="status">{t('refusals.repair_pending')}</p>}
    {preview && <section className="summary-deletion" aria-label={t('refusals.delete_title')}>
      <h3 ref={heading} tabIndex={-1}>{t('refusals.delete_title')}</h3>
      {deletion ? <>
        <p>{t('refusals.delete_help', { first: deletion.boundary + 1 })}</p>
        <p>{t('refusals.delete_summaries', { count: deletion.deletedIds.size })}</p>
        <p>{t('refusals.delete_versions', { count: deletion.deleted.length })}</p>
        <p>{t('refusals.restore_turns', { count: deletion.restoredTurnIds.length })}</p>
        {deletion.deleted.some(node => node.manual) && <p><strong>{t('memory.this_includes_manually_corrected_summaries')}</strong></p>}
        <ul>{[...new Map(deletion.deleted.map(node => [node.id, node])).values()].map(node => <li key={node.id}>{t('refusals.range', { level: node.level, first: positions.get(node.turns[0]?.turnId) ?? '—', last: positions.get(node.turns.at(-1)?.turnId ?? '') ?? '—', state: node.manual ? t('interface.manually_corrected') : t('labels.state.retained') })}</li>)}</ul>
        <button type="button" disabled={locked} onClick={() => void resolve(preview.refs, 'delete', preview.revision)}>{t('refusals.delete_confirm')}</button>
      </> : <p role="status">{t('refusals.obsolete')}</p>}
      <button type="button" className="quiet" disabled={locked} onClick={() => setPreview(null)}>{t('refusals.cancel')}</button>
    </section>}
  </section>;
}
