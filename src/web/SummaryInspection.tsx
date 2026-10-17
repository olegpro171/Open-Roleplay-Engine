import { useState } from 'react';
import type { ChatSnapshot } from '../shared/contracts';
import { refKey, type SummaryNode } from '../shared/context';
import { correctionProtection } from '../core/context-corrections';
import { staleSummaries } from '../core/context';
import { hasPromptMarker } from '../shared/library';
import { Dropdown } from './Controls';
import { api } from './api';

export function SummaryInspection({ snapshot, node, historical, selected, locked, inspect, saved, run }: {
  snapshot: ChatSnapshot; node: SummaryNode; historical: boolean; selected: Set<string>; locked: boolean;
  inspect: (node: SummaryNode) => void; saved: () => void; run: (action: () => Promise<unknown>) => Promise<boolean>;
}) {
  const [edit, setEdit] = useState<{ text: string; revision: number } | null>(null);
  const versions = snapshot.context.summaries.filter(version => version.id === node.id && version.approved).sort((a, b) => b.revision - a.revision);
  const latest = versions[0]?.revision === node.revision;
  const stale = staleSummaries(snapshot.turns, snapshot.context).has(refKey(node));
  const protection = correctionProtection(snapshot.turns, snapshot.context);
  const represented = snapshot.context.selected.some(ref => {
    const summary = snapshot.context.summaries.find(summary => refKey(summary) === refKey(ref));
    return summary && protection.represented(summary).has(refKey(node));
  });
  const summariesEnabled = hasPromptMarker(snapshot.sources.prompt, 'summary');
  const status = !latest ? 'Historical version. Editing uses the current approved version.'
    : node.manual && (!represented || stale) ? 'Correction awaiting reconciliation. Use Repair summaries for stale or conflicting memory, then Prepare chat. Saving does not insert it into model input.'
    : represented ? `${summariesEnabled ? 'Represented in the saved model input' : 'Represented in saved memory; summaries are disabled'}${snapshot.context.selected.some(ref => refKey(ref) === refKey(node)) ? ' directly.' : ' through a higher summary.'}`
    : 'Retained for inspection. This summary is not currently represented in model input.';
  return <section className="summary-inspection">
    <h2>Level {node.level} summary · revision {node.revision}</h2>
    <p className="small muted">Identity {node.id} · {node.turns.length} source turns · {selected.has(refKey(node)) ? 'Selected in this view' : 'Retained in this view'} · {stale ? 'Stale' : 'Fresh'}{node.manual ? ' · Manually corrected' : ''}</p>
    <p role="status" data-testid="summary-authority">{status}</p>
    <label>Summary version<Dropdown aria-label="Summary version" value={refKey(node)} onChange={key => {
      const version = versions.find(version => refKey(version) === key);
      if (version) { setEdit(null); inspect(version); }
    }} options={versions.map(version => ({ value: refKey(version), label: `Revision ${version.revision}${version.revision === versions[0]?.revision ? ' · current approved' : ' · historical'}${version.manual ? ' · manually corrected' : ''}` }))} /></label>
    {edit ? <form onSubmit={async event => {
      event.preventDefault();
      if (await run(() => api(`/chats/${snapshot.id}/context/summaries/${node.id}`, 'PATCH', { revision: edit.revision, summaryRevision: node.revision, text: edit.text }))) saved();
    }}>
      <label>Summary text<textarea aria-label="Summary text" required maxLength={1_000_000} value={edit.text} onChange={event => setEdit({ ...edit, text: event.target.value })} /></label>
      <p className="small muted">An unchanged save does nothing. Changed text keeps its source links and previous versions. Dependents may need repair. A retained correction awaits reconciliation; saving alone does not select it or make stale sources current.</p>
      <div className="actions"><button disabled={locked || edit.revision !== snapshot.revision || !edit.text.trim()}>Save summary edit</button><button type="button" className="quiet" onClick={() => setEdit(null)}>Cancel edit</button></div>
      {edit.revision !== snapshot.revision && <p role="status">The chat changed. Cancel and reopen the summary editor.</p>}
    </form> : <><div className="prose">{node.text}</div>{!historical && latest && <button type="button" className="quiet" disabled={locked} onClick={() => setEdit({ text: node.text, revision: snapshot.revision })}>Edit summary</button>}</>}
    <details><summary>Source turns and dependencies</summary><pre>{JSON.stringify({ turns: node.turns, children: node.children, earlierContext: node.prior, reconciledCorrections: node.corrections ?? [] }, null, 2)}</pre>
      {node.turns.slice(0, 30).map(source => {
        const position = snapshot.turns.findIndex(turn => turn.id === source.turnId), turn = snapshot.turns[position];
        return <details key={source.turnId}><summary>Turn {turn ? position + 1 : 'deleted'} · current source text</summary><div className="prose">{turn ? `${turn.user.text}\n\n${turn.assistant.text}` : 'This source turn has been deleted.'}</div></details>;
      })}
      {node.turns.length > 30 && <p className="small muted">First 30 source texts shown. All source identities are listed above.</p>}
    </details>
  </section>;
}
