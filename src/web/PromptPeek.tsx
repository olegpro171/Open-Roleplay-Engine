import { openModal } from './dialog-focus';
import { formatMessage } from './localization';
import { t, useLocale, locale } from './localization';
import { placementLabel, stateLabel } from './localization-labels';
import { Icon } from './Icon';
import { useEffect, useRef, useState } from 'react';
import type { PromptEntry, RequestPreview } from '../shared/contracts';
import { LoreDiagnostics } from './LorebookEditor';

const loreDisclosureKey = 'ore-prompt-peek-lore-open';

function savedLoreDisclosure(): boolean {
  try { return localStorage.getItem(loreDisclosureKey) === 'true'; }
  catch { return false; }
}

const categories = (): { kind: PromptEntry['kind'] | 'overhead'; label: string }[] => [
  { kind: 'prompt', label: t("prompt_peek.prompt") }, { kind: 'character', label: t("app.character") },
  { kind: 'persona', label: t("libraries.persona") }, { kind: 'lore', label: t("prompt_peek.lore") }, { kind: 'memory', label: t("memory.memory") },
  { kind: 'history', label: t("app.active_turns") }, { kind: 'draft', label: t("prompt_peek.unsent_input") },
  { kind: 'overhead', label: t("prompt_peek.message_framing") },
];

export function InputMeter({ input, limit }: { input: number; limit: number }) {
  useLocale();
  const status = input > limit ? 'overflow' : input > limit * .9 ? 'near' : 'fits';
  return <div className={`input-meter ${status}`} role="meter" aria-label={t("prompt_peek.input_budget")} aria-valuemin={0} aria-valuemax={Math.max(1, limit)} aria-valuenow={Math.min(input, Math.max(1, limit))} aria-valuetext={t("prompt_peek.of_estimated_tokens", { value: input.toLocaleString(locale()), value2: limit.toLocaleString(locale()), value3: input > limit ? t("interface.over_limit") : '' })}>
    <div style={{ width: `${Math.min(100, input / Math.max(1, limit) * 100)}%` }} />
  </div>;
}

export function BudgetBreakdown({ request }: { request: RequestPreview }) {
  useLocale();
  const parts = request.layout ?? [];
  const content = parts.reduce((sum, part) => sum + part.tokens, 0);
  const buckets = categories().map(category => ({ ...category, tokens: category.kind === 'overhead' ? request.budget.inputTokens - content : parts.filter(part => part.kind === category.kind).reduce((sum, part) => sum + part.tokens, 0) })).filter(bucket => bucket.tokens > 0);
  return <div className="context-breakdown">
    <div className="allocation-bar" role="img" aria-label={buckets.map(bucket => t("prompt_peek.estimated_tokens", { label: bucket.label, value: bucket.tokens.toLocaleString(locale()) })).join(', ')}>{buckets.map(bucket => <span key={bucket.kind} className={`allocation ${bucket.kind}`} style={{ width: `${bucket.tokens / request.budget.inputTokens * 100}%` }} title={`${bucket.label}: ${bucket.tokens.toLocaleString(locale())}`} />)}</div>
    <ul className="allocation-legend">{buckets.map(bucket => <li key={bucket.kind}><span><i className={`allocation ${bucket.kind}`} />{bucket.label}</span><span>{bucket.tokens.toLocaleString(locale())} <small>({(bucket.tokens / request.budget.inputTokens * 100).toFixed(1)}%)</small></span></li>)}</ul>
  </div>;
}

export function LoreInspection({ request, historical = false }: { request: RequestPreview; historical?: boolean }) {
  useLocale();
  const [page, setPage] = useState(0);
  const lore = request.lore;
  const signature = lore ? `${lore.book.id}:${lore.book.revision}:${lore.epoch}:${lore.outcomes.map(outcome => outcome.id + outcome.status).join(',')}` : '';
  useEffect(() => { setPage(0); }, [signature]);
  if (lore === null) return <p className="small muted">{t("prompt_peek.no_lorebook_was_selected_for_this_request")}</p>;
  if (!lore) return <p className="small muted">{historical ? t("prompt_peek.lore_metadata_is_unavailable_for_this_saved") : t("prompt_peek.no_lorebook_resolution_is_attached_to_this")}</p>;
  if (lore.detailsAvailable) return <section className="lore-inspection" aria-label={t("prompt_peek.resolved_lore")}><h3>{t("prompt_peek.lore_2", { name: lore.book.name })}</h3><p className="small" role="status">{t("prompt_peek.loading_saved_lore_details")}</p></section>;
  const admitted = lore.outcomes.filter(outcome => outcome.status === 'admitted').length;
  const last = Math.max(0, Math.ceil(lore.outcomes.length / 50) - 1), shown = Math.min(page, last);
  return <section className="lore-inspection" aria-label={t("prompt_peek.resolved_lore")}><h3>{t("prompt_peek.lore_2", { name: lore.book.name })}</h3><p className="small">{t("prompt_peek.book_revision_admitted_evaluated_estimated_tokens", { revision: lore.book.revision, admitted: admitted, length: lore.outcomes.length, value: lore.tokens.toLocaleString(locale()), value2: lore.pressure ? t("interface.pressure_exclusions_applied") : '' })}</p><p className="small muted">{historical ? t("prompt_peek.this_saved_resolution_retains_the_original_entry") : t("prompt_peek.resolved_against_original_recent_messages_including_unsent")}</p>
    <LoreDiagnostics diagnostics={lore.diagnostics} />
    {lore.outcomes.length === 0 && <p className="small muted">{t("prompt_peek.this_book_has_no_entries_to_evaluate")}</p>}
    {lore.outcomes.slice(shown * 50, (shown + 1) * 50).map(outcome => <details className={`lore-outcome ${outcome.status}`} key={outcome.id}><summary>{t("prompt_peek.est", { value: outcome.name || t("lorebook_editor.unnamed_entry"), status: outcome.status, value2: outcome.tokens.toLocaleString(locale()) })}</summary><p className="small">{outcome.reason}</p>{outcome.destination && <p className="small">{placementLabel(outcome.destination.placement)} · {stateLabel(outcome.destination.role)}{outcome.destination.placement === 'history' ? t("prompt_peek.depth", { depth: outcome.destination.depth }) : ''}</p>}{outcome.text ? <div className="prose">{outcome.text}</div> : <p className="small muted">{t("prompt_peek.no_resolved_prose")}</p>}</details>)}
    {last > 0 && <div className="actions lore-pagination"><button type="button" className="secondary" disabled={shown === 0} onClick={() => setPage(shown - 1)}>{t("prompt_peek.previous_lore_page")}</button><span>{t("lorebook_editor.page_of", { value: shown + 1, value2: last + 1 })}</span><button type="button" className="secondary" disabled={shown === last} onClick={() => setPage(shown + 1)}>{t("prompt_peek.next_lore_page")}</button></div>}
  </section>;
}

export function PromptPeek({ request, stale, close }: { request: RequestPreview; stale: boolean; close: () => void }) {
  useLocale();
  const [loreOpen, setLoreOpen] = useState(savedLoreDisclosure);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    const node = dialog.current;
    openModal(node);
    return () => { node?.close(); trigger?.focus(); };
  }, []);
  const entries = new Map(request.layout?.map(part => [part.messageIndex, part]));
  const limit = Math.min(request.budget.targetInputTokens, request.budget.contextWindow - request.budget.reservedOutputTokens);
  return <dialog ref={dialog} className="prompt-peek" aria-labelledby="prompt-peek-title" onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <div className="peek-content"><div className="peek-heading"><div><p className="eyebrow">{t("prompt_peek.current_input")}</p><h2 id="prompt-peek-title">{t("app.prompt_peek")}</h2></div><button className="secondary" onClick={close} title={t("prompt_peek.close_peek")}><Icon name="Close" /><span className="sr-only">{t("prompt_peek.close_peek")}</span></button></div>
      <p className="small muted">{t("prompt_peek.resolved_messages_in_model_order_including_unsent")}</p>
      <p className="small over-limit" hidden={!stale}>{t("prompt_peek.memory_is_out_of_date_repair_and")}</p>
      <strong>{t("app.estimated_input_2", { value: request.budget.inputTokens.toLocaleString(locale()), value2: limit.toLocaleString(locale()) })}</strong><InputMeter input={request.budget.inputTokens} limit={limit} />
      <BudgetBreakdown request={request} />
      <details className="peek-lore" open={loreOpen}>
        <summary onClick={event => {
          event.preventDefault();
          const open = !loreOpen;
          setLoreOpen(open);
          try { localStorage.setItem(loreDisclosureKey, String(open)); }
          catch { /* The disclosure remains usable when browser preferences cannot be saved. */ }
        }}>{t("prompt_peek.resolved_lore")}</summary>
        <LoreInspection request={request} />
      </details>
      {request.warnings?.map((warning, index) => <p className="small" key={warning}>{formatMessage(request.warningMessages?.[index] ?? warning)}</p>)}
      <h3 className="peek-prompt-heading">{t("prompt_peek.assembled_prompt")}</h3>
      <section className="prompt-message-list" aria-label={t("prompt_peek.assembled_prompt")}><PromptMessages request={request} entries={entries} /></section>
      <details><summary>{t("prompt_peek.effective_request_parameters")}</summary><pre>{JSON.stringify({ ...request.body, messages: undefined }, null, 2)}</pre></details>
    </div>
  </dialog>;
}

function PromptMessages({ request, entries }: { request: RequestPreview; entries: Map<number, PromptEntry> }) {
  useLocale();
  return request.body.messages.map((value, i) => {
    const part = entries.get(i);
    return <details className={`prompt-message ${part?.kind ?? 'prompt'}`} key={i}><summary><span className="message-order">{i + 1}</span><span>{formatMessage(part?.labelMessage ?? part?.label) || t("prompt_peek.message")}<small>{stateLabel(value.role)}</small></span><span className="message-size">{t("prompt_peek.est_2", { value: part?.tokens.toLocaleString(locale()) ?? '—' })}</span></summary><div className="prose">{value.content}</div></details>;
  });
}
