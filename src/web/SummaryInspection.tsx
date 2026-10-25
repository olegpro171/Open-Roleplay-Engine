import { t, useLocale, locale } from './localization';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChatToolsSnapshot } from '../shared/contracts';
import { refKey, type SummaryNode } from '../shared/context';
import { correctionProtection } from '../core/context-corrections';
import { staleSummaries } from '../core/context';
import { hasPromptMarker } from '../shared/library';
import { Dropdown } from './Controls';
import { api } from './api';
import { countText } from '../core/tokens';

export function SummaryInspection({ snapshot, node, historical, selected, locked, inspect, saved, run, previewDelete }: {
  snapshot: ChatToolsSnapshot; node: SummaryNode; historical: boolean; selected: Set<string>; locked: boolean;
  inspect: (node: SummaryNode) => void; saved: () => void; run: (action: () => Promise<unknown>) => Promise<boolean>;
  previewDelete: (node: SummaryNode) => void;
}) {
  useLocale();
  const [edit, setEdit] = useState<{ text: string; revision: number } | null>(null);
  const summaryText = useRef<HTMLDivElement>(null);
  useEffect(() => { summaryText.current?.scrollTo(0, 0); }, [node.id, node.revision]);
  const textTokens = useMemo(() => countText(node.text), [node.text]);
  const versions = snapshot.context.summaries.filter(version => version.id === node.id && version.approved).sort((a, b) => b.revision - a.revision);
  const latest = versions[0]?.revision === node.revision;
  const stale = staleSummaries(snapshot.turns, snapshot.context).has(refKey(node));
  const protection = correctionProtection(snapshot.turns, snapshot.context);
  const represented = snapshot.context.selected.some(ref => {
    const summary = snapshot.context.summaries.find(summary => refKey(summary) === refKey(ref));
    return summary && protection.represented(summary).has(refKey(node));
  });
  const summariesEnabled = hasPromptMarker(snapshot.sources.prompt, 'summary');
  const status = !latest ? t("summary_inspection.historical_version_editing_uses_the_current_approved")
    : node.manual && (!represented || stale) ? t("summary_inspection.correction_awaiting_reconciliation_use_repair_summaries_for")
    : represented ? `${summariesEnabled ? t("summary_inspection.represented_in_the_saved_model_input") : t("summary_inspection.represented_in_saved_memory_summaries_are_disabled")}${snapshot.context.selected.some(ref => refKey(ref) === refKey(node)) ? ' directly.' : t("summary_inspection.through_a_higher_summary")}`
    : t("summary_inspection.retained_for_inspection_this_summary_is_not");
  return <section className="summary-inspection">
    <h2>{t("summary_inspection.level_summary_revision", { level: node.level, revision: node.revision })}</h2>
    <label>{t("summary_inspection.summary_version")}<Dropdown aria-label={t("summary_inspection.summary_version")} value={refKey(node)} onChange={key => {
      const version = versions.find(version => refKey(version) === key);
      if (version) { setEdit(null); inspect(version); }
    }} options={versions.map(version => ({ value: refKey(version), label: t("summary_inspection.revision", { revision: version.revision, value: version.revision === versions[0]?.revision ? t("interface.current_approved") : t("interface.historical"), value2: version.manual ? t("interface.manually_corrected") : '' }) }))} /></label>
    <p className="small muted">{t("summary_inspection.identity_source_turns_estimated_text_tokens", { id: node.id, length: node.turns.length, value: textTokens.toLocaleString(locale()), value2: selected.has(refKey(node)) ? t("interface.selected_in_this_view") : t("interface.retained_in_this_view"), value3: stale ? t("interface.stale") : t("interface.fresh"), value4: node.manual ? t("interface.manually_corrected_2") : '' })}</p>
    <p role="status" data-testid="summary-authority">{status}</p>
    {edit ? <form onSubmit={async event => {
      event.preventDefault();
      if (await run(() => api(`/chats/${snapshot.id}/context/summaries/${node.id}`, 'PATCH', { revision: edit.revision, summaryRevision: node.revision, text: edit.text }))) saved();
    }}>
      <label>{t("summary_inspection.summary_text")}<textarea aria-label={t("summary_inspection.summary_text")} required maxLength={1_000_000} value={edit.text} onChange={event => setEdit({ ...edit, text: event.target.value })} /></label>
      <p className="small muted">{t("summary_inspection.an_unchanged_save_does_nothing_changed_text")}</p>
      <div className="actions"><button disabled={locked || edit.revision !== snapshot.revision || !edit.text.trim()}>{t("summary_inspection.save_summary_edit")}</button><button type="button" className="quiet" onClick={() => setEdit(null)}>{t("app.cancel_edit")}</button></div>
      {edit.revision !== snapshot.revision && <p role="status">{t("summary_inspection.the_chat_changed_cancel_and_reopen_the")}</p>}
    </form> : <><div ref={summaryText} className="prose summary-text" role="region" aria-label={t("summary_inspection.summary_text")} tabIndex={0}>{node.text}</div>{!historical && latest && <button type="button" className="quiet" disabled={locked} onClick={() => setEdit({ text: node.text, revision: snapshot.revision })}>{t("summary_inspection.edit_summary")}</button>}</>}
    {!historical && latest && !edit && <button type="button" className="quiet" disabled={locked} onClick={() => previewDelete(node)}>{t("summary_inspection.delete_summary")}</button>}
    <details><summary>{t("summary_inspection.source_turns_and_dependencies")}</summary><pre>{JSON.stringify({ turns: node.turns, children: node.children, earlierContext: node.prior, reconciledCorrections: node.corrections ?? [] }, null, 2)}</pre>
      {node.turns.slice(0, 30).map(source => {
        const position = snapshot.turns.findIndex(turn => turn.id === source.turnId), turn = snapshot.turns[position];
        return <details key={source.turnId}><summary>{t("summary_inspection.turn_current_source_text", { value: turn ? position + 1 : 'deleted' })}</summary><div className="prose">{turn ? `${turn.user.text}\n\n${turn.assistant.text}` : t("summary_inspection.this_source_turn_has_been_deleted")}</div></details>;
      })}
      {node.turns.length > 30 && <p className="small muted">{t("summary_inspection.first_30_source_texts_shown_all_source")}</p>}
    </details>
  </section>;
}
