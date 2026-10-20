import { Icon } from './Icon';
import { useEffect, useRef, useState } from 'react';
import type { PromptEntry, RequestPreview } from '../shared/contracts';
import { LoreDiagnostics, lorePlacementLabels } from './LorebookEditor';

const categories: { kind: PromptEntry['kind'] | 'overhead'; label: string }[] = [
  { kind: 'prompt', label: 'Prompt' }, { kind: 'character', label: 'Character' },
  { kind: 'persona', label: 'Persona' }, { kind: 'lore', label: 'Lore' }, { kind: 'memory', label: 'Memory' },
  { kind: 'history', label: 'Active turns' }, { kind: 'draft', label: 'Unsent input' },
  { kind: 'overhead', label: 'Message framing' },
];

export function InputMeter({ input, limit }: { input: number; limit: number }) {
  const status = input > limit ? 'overflow' : input > limit * .9 ? 'near' : 'fits';
  return <div className={`input-meter ${status}`} role="meter" aria-label="Input budget" aria-valuemin={0} aria-valuemax={Math.max(1, limit)} aria-valuenow={Math.min(input, Math.max(1, limit))} aria-valuetext={`${input.toLocaleString()} of ${limit.toLocaleString()} estimated tokens${input > limit ? ', over limit' : ''}`}>
    <div style={{ width: `${Math.min(100, input / Math.max(1, limit) * 100)}%` }} />
  </div>;
}

export function BudgetBreakdown({ request }: { request: RequestPreview }) {
  const parts = request.layout ?? [];
  const content = parts.reduce((sum, part) => sum + part.tokens, 0);
  const buckets = categories.map(category => ({ ...category, tokens: category.kind === 'overhead' ? request.budget.inputTokens - content : parts.filter(part => part.kind === category.kind).reduce((sum, part) => sum + part.tokens, 0) })).filter(bucket => bucket.tokens > 0);
  return <div className="context-breakdown">
    <div className="allocation-bar" role="img" aria-label={buckets.map(bucket => `${bucket.label}: ${bucket.tokens.toLocaleString()} estimated tokens`).join(', ')}>{buckets.map(bucket => <span key={bucket.kind} className={`allocation ${bucket.kind}`} style={{ width: `${bucket.tokens / request.budget.inputTokens * 100}%` }} title={`${bucket.label}: ${bucket.tokens.toLocaleString()}`} />)}</div>
    <ul className="allocation-legend">{buckets.map(bucket => <li key={bucket.kind}><span><i className={`allocation ${bucket.kind}`} />{bucket.label}</span><span>{bucket.tokens.toLocaleString()} <small>({(bucket.tokens / request.budget.inputTokens * 100).toFixed(1)}%)</small></span></li>)}</ul>
  </div>;
}

export function LoreInspection({ request, historical = false }: { request: RequestPreview; historical?: boolean }) {
  const [page, setPage] = useState(0);
  const lore = request.lore;
  const signature = lore ? `${lore.book.id}:${lore.book.revision}:${lore.epoch}:${lore.outcomes.map(outcome => outcome.id + outcome.status).join(',')}` : '';
  useEffect(() => { setPage(0); }, [signature]);
  if (lore === null) return <p className="small muted">No lorebook was selected for this request.</p>;
  if (!lore) return <p className="small muted">{historical ? 'Lore metadata is unavailable for this saved request.' : 'No lorebook resolution is attached to this request.'}</p>;
  if (lore.detailsAvailable) return <section className="lore-inspection" aria-label="Resolved lore"><h3>Lore · {lore.book.name}</h3><p className="small" role="status">Loading saved lore details…</p></section>;
  const admitted = lore.outcomes.filter(outcome => outcome.status === 'admitted').length;
  const last = Math.max(0, Math.ceil(lore.outcomes.length / 50) - 1), shown = Math.min(page, last);
  return <section className="lore-inspection" aria-label="Resolved lore"><h3>Lore · {lore.book.name}</h3><p className="small">Book revision {lore.book.revision} · {admitted} admitted / {lore.outcomes.length} evaluated · {lore.tokens.toLocaleString()} estimated tokens{lore.pressure ? ' · Pressure exclusions applied' : ''}</p><p className="small muted">{historical ? 'This saved resolution retains the original entry text and placement.' : 'Resolved against original recent messages, including unsent input. Preview does not advance activation state.'}</p>
    <LoreDiagnostics diagnostics={lore.diagnostics} />
    {lore.outcomes.length === 0 && <p className="small muted">This book has no entries to evaluate.</p>}
    {lore.outcomes.slice(shown * 50, (shown + 1) * 50).map(outcome => <details className={`lore-outcome ${outcome.status}`} key={outcome.id}><summary>{outcome.name || 'Unnamed entry'} · {outcome.status} · {outcome.tokens.toLocaleString()} est.</summary><p className="small">{outcome.reason}</p>{outcome.destination && <p className="small">{lorePlacementLabels[outcome.destination.placement]} · {outcome.destination.role}{outcome.destination.placement === 'history' ? ` · Depth ${outcome.destination.depth}` : ''}</p>}{outcome.text ? <div className="prose">{outcome.text}</div> : <p className="small muted">No resolved prose.</p>}</details>)}
    {last > 0 && <div className="actions lore-pagination"><button type="button" className="secondary" disabled={shown === 0} onClick={() => setPage(shown - 1)}>Previous lore page</button><span>Page {shown + 1} of {last + 1}</span><button type="button" className="secondary" disabled={shown === last} onClick={() => setPage(shown + 1)}>Next lore page</button></div>}
  </section>;
}

export function PromptPeek({ request, stale, close }: { request: RequestPreview; stale: boolean; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    const node = dialog.current;
    node?.showModal();
    return () => { node?.close(); trigger?.focus(); };
  }, []);
  const entries = new Map(request.layout?.map(part => [part.messageIndex, part]));
  const limit = Math.min(request.budget.targetInputTokens, request.budget.contextWindow - request.budget.reservedOutputTokens);
  return <dialog ref={dialog} className="prompt-peek" aria-labelledby="prompt-peek-title" onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <div className="peek-content"><div className="peek-heading"><div><p className="eyebrow">CURRENT INPUT</p><h2 id="prompt-peek-title">Prompt peek</h2></div><button className="secondary" onClick={close} autoFocus title="Close peek"><Icon name="Close" /><span className="sr-only">Close peek</span></button></div>
      <p className="small muted">Resolved messages in model order, including unsent input. Preparation may change memory before the next response.</p>
      <p className="small over-limit" hidden={!stale}>Memory is out of date. Repair and review it before sending.</p>
      <strong>Estimated input: {request.budget.inputTokens.toLocaleString()} / {limit.toLocaleString()}</strong><InputMeter input={request.budget.inputTokens} limit={limit} />
      <BudgetBreakdown request={request} />
      <LoreInspection request={request} />
      {request.warnings?.map(warning => <p className="small" key={warning}>{warning}</p>)}
      <div className="prompt-message-list"><PromptMessages request={request} entries={entries} /></div>
      <details><summary>Effective request parameters</summary><pre>{JSON.stringify({ ...request.body, messages: undefined }, null, 2)}</pre></details>
    </div>
  </dialog>;
}

function PromptMessages({ request, entries }: { request: RequestPreview; entries: Map<number, PromptEntry> }) {
  const message = (i: number) => {
    const part = entries.get(i), value = request.body.messages[i];
    return <details className={`prompt-message ${part?.kind ?? 'prompt'}`} key={i}><summary><span className="message-order">{i + 1}</span><span>{part?.label ?? 'Message'}<small>{value.role}</small></span><span className="message-size">{part?.tokens.toLocaleString() ?? '—'} est.</span></summary><div className="prose">{value.content}</div></details>;
  };
  const result = [];
  for (let i = 0; i < request.body.messages.length;) {
    const group = entries.get(i)?.group;
    if (!group) { result.push(message(i)); i++; continue; }
    const start = i, children = [];
    while (i < request.body.messages.length && entries.get(i)?.group?.id === group.id) children.push(message(i++));
    result.push(<section className="prompt-message-group" aria-label={`${group.label} messages`} key={`group-${start}`}><h3>{group.label}</h3>{children}</section>);
  }
  return result;
}
