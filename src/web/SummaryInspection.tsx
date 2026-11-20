import { errorText, formatMessage, t, useLocale, locale, type MessageText } from './localization';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChatToolsSnapshot } from '../shared/contracts';
import { refKey, type SummaryNode, type SummaryTokenCount } from '../shared/context';
import { selectionRepresents } from '../core/context-corrections';
import { staleSummaries } from '../core/context';
import { hasPromptMarker } from '../shared/library';
import { Dropdown } from './Controls';
import { api, datasetChanged } from './api';

type TokenCountResult = { path: string } & ({ tokens: number } | { error: MessageText });

export function SummaryInspection({ snapshot, node, historical, selected, locked, inspect, saved, run, previewDelete }: {
  snapshot: ChatToolsSnapshot; node: SummaryNode; historical: boolean; selected: Set<string>; locked: boolean;
  inspect: (node: SummaryNode) => void; saved: () => void; run: (action: () => Promise<unknown>) => Promise<boolean>;
  previewDelete: (node: SummaryNode) => void;
}) {
  useLocale();
  const [edit, setEdit] = useState<{ summary: string; text: string; revision: number } | null>(null);
  const summaryKey = refKey(node);
  if (edit && edit.summary !== summaryKey) setEdit(null);
  const summaryText = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { summaryText.current?.scrollTo(0, 0); }, [summaryKey]);
  const countPath = `/chats/${snapshot.id}/context/summaries/${node.id}/versions/${node.revision}/token-count`;
  const [countResult, setCountResult] = useState<TokenCountResult>();
  const [countAttempt, setCountAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    api<SummaryTokenCount>(countPath, 'GET', undefined, controller.signal)
      .then(({ tokens }) => {
        if (!controller.signal.aborted && !datasetChanged()) setCountResult({ path: countPath, tokens });
      })
      .catch(error => {
        if (!controller.signal.aborted && !datasetChanged()) setCountResult({ path: countPath, error: errorText(error) });
      });
    return () => controller.abort();
  }, [countPath, countAttempt]);
  const count = countResult?.path === countPath ? countResult : undefined;
  const versions = snapshot.context.summaries.filter(version => version.id === node.id && version.approved).sort((a, b) => b.revision - a.revision);
  const latest = versions[0]?.revision === node.revision;
  const stale = staleSummaries(snapshot.turns, snapshot.context).has(refKey(node));
  const represented = selectionRepresents(snapshot.context, node);
  const summariesEnabled = hasPromptMarker(snapshot.sources.prompt, 'summary');
  const directlySelected = snapshot.context.selected.some(ref => refKey(ref) === summaryKey);
  const status = !latest ? t("summary_inspection.historical_version_editing_uses_the_current_approved")
    : represented && stale && summariesEnabled ? t("summary_inspection.stale_selected_dependency")
    : represented ? t(summariesEnabled
      ? directlySelected ? "summary_inspection.represented_in_the_saved_model_input" : "summary_inspection.represented_in_input_through_higher_summary"
      : directlySelected ? "summary_inspection.represented_in_saved_memory_summaries_are_disabled" : "summary_inspection.represented_in_memory_through_higher_summary")
    : t("summary_inspection.retained_for_inspection_this_summary_is_not");
  return <section className="summary-inspection">
    <h2>{t("summary_inspection.level_summary_revision", { level: node.level, revision: node.revision })}</h2>
    <label>{t("summary_inspection.summary_version")}<Dropdown aria-label={t("summary_inspection.summary_version")} value={refKey(node)} onChange={key => {
      const version = versions.find(version => refKey(version) === key);
      if (version) { setEdit(null); inspect(version); }
    }} options={versions.map(version => ({ value: refKey(version), label: t("summary_inspection.revision", { revision: version.revision, value: version.revision === versions[0]?.revision ? t("interface.current_approved") : t("interface.historical"), value2: version.manual ? t("interface.manually_corrected") : '' }) }))} /></label>
    {!count ? <p className="small muted">{t('summary_inspection.counting_text_tokens')}</p>
      : 'error' in count ? <p className="small muted"><span role="alert">{formatMessage(count.error)}</span>{' '}
        <button type="button" className="quiet" onClick={() => {
          setCountResult(undefined);
          setCountAttempt(attempt => attempt + 1);
        }}>{t('app.retry_loading')}</button>
      </p>
      : <p className="small muted">{t("summary_inspection.source_turns_and_tokens", {
        count: node.turns.length,
        tokens: count.tokens.toLocaleString(locale()),
        selection: selected.has(summaryKey) ? t("interface.selected_in_this_view") : t("interface.retained_in_this_view"),
        freshness: stale ? t("interface.stale") : t("interface.fresh"),
        correction: node.manual ? t("interface.manually_corrected_2") : '',
      })}</p>}
    <p role="status" data-testid="summary-authority">{status}</p>
    {edit ? <form onSubmit={async event => {
      event.preventDefault();
      if (await run(() => api(`/chats/${snapshot.id}/context/summaries/${node.id}`, 'PATCH', { revision: edit.revision, summaryRevision: node.revision, text: edit.text }))) saved();
    }}>
      <label>{t("summary_inspection.summary_text")}<textarea className="summary-edit-text" aria-label={t("summary_inspection.summary_text")} required maxLength={1_000_000} value={edit.text} onChange={event => setEdit({ ...edit, text: event.target.value })} /></label>
      <p className="field-help small muted">{t("summary_inspection.an_unchanged_save_does_nothing_changed_text")}</p>
      <div className="actions"><button disabled={locked || edit.revision !== snapshot.revision || !edit.text.trim()}>{t("summary_inspection.save_summary_edit")}</button><button type="button" className="quiet" onClick={() => setEdit(null)}>{t("app.cancel_edit")}</button></div>
      {edit.revision !== snapshot.revision && <p role="status">{t("summary_inspection.the_chat_changed_cancel_and_reopen_the")}</p>}
    </form> : <><div ref={summaryText} className="prose summary-text" role="region" aria-label={t("summary_inspection.summary_text")} tabIndex={0}>{node.text}</div>{!historical && latest && <button type="button" className="quiet" disabled={locked} onClick={() => setEdit({ summary: summaryKey, text: node.text, revision: snapshot.revision })}>{t("summary_inspection.edit_summary")}</button>}</>}
    {!historical && latest && !edit && <button type="button" className="quiet" disabled={locked} onClick={() => previewDelete(node)}>{t("summary_inspection.delete_summary")}</button>}
    <details><summary>{t("summary_inspection.source_turns_and_dependencies")}</summary><pre>{JSON.stringify({ id: node.id, turns: node.turns, children: node.children, earlierContext: node.prior, reconciledCorrections: node.corrections ?? [] }, null, 2)}</pre>
      {node.turns.slice(0, 30).map(source => {
        const position = snapshot.turns.findIndex(turn => turn.id === source.turnId), turn = snapshot.turns[position];
        return <details key={source.turnId}><summary>{t("summary_inspection.turn_current_source_text", { value: turn ? position + 1 : 'deleted' })}</summary><div className="prose">{turn ? `${turn.user.text}\n\n${turn.assistant.text}` : t("summary_inspection.this_source_turn_has_been_deleted")}</div></details>;
      })}
      {node.turns.length > 30 && <p className="small muted">{t("summary_inspection.first_30_source_texts_shown_all_source")}</p>}
    </details>
  </section>;
}
