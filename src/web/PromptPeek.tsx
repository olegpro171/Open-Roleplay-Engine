import { useEffect, useRef } from 'react';
import type { PromptEntry, RequestPreview } from '../shared/contracts';

const categories: { kind: PromptEntry['kind'] | 'overhead'; label: string }[] = [
  { kind: 'prompt', label: 'Prompt' }, { kind: 'character', label: 'Character' },
  { kind: 'persona', label: 'Persona' }, { kind: 'memory', label: 'Memory' },
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
    <p className="small muted">Conservative input estimates. Output reservation: {request.budget.reservedOutputTokens.toLocaleString()} tokens, separate from input.</p>
  </div>;
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
    <div className="peek-content"><div className="peek-heading"><div><p className="eyebrow">CURRENT INPUT</p><h2 id="prompt-peek-title">Prompt peek</h2></div><button className="secondary" onClick={close} autoFocus>Close peek</button></div>
      <p className="small muted">Resolved messages in model order, including unsent input. Preparation may change memory before the next response.</p>
      <p className="small over-limit" hidden={!stale}>Memory is out of date. Repair and review it before sending.</p>
      <strong>Estimated input: {request.budget.inputTokens.toLocaleString()} / {limit.toLocaleString()}</strong><InputMeter input={request.budget.inputTokens} limit={limit} />
      <BudgetBreakdown request={request} />
      {request.warnings?.map(warning => <p className="small" key={warning}>{warning}</p>)}
      <div className="prompt-message-list">{request.body.messages.map((message, i) => {
        const part = entries.get(i);
        return <details className={`prompt-message ${part?.kind ?? 'prompt'}`} key={i} open={i === 0}><summary><span className="message-order">{i + 1}</span><span>{part?.label ?? 'Message'}<small>{message.role}</small></span><span className="message-size">{part?.tokens.toLocaleString() ?? '—'} est.</span></summary><div className="prose">{message.content}</div></details>;
      })}</div>
      <details><summary>Effective request parameters</summary><pre>{JSON.stringify({ ...request.body, messages: undefined }, null, 2)}</pre></details>
    </div>
  </dialog>;
}
