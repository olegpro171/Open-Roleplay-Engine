import { t, useLocale } from './localization';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { refKey, type ContextOperation, type SummaryNode, type SummaryRef } from '../shared/context';

type Props = {
  nodes: SummaryNode[]; selected: Set<string>; stale: Set<string>; archived: Set<string>;
  reusable?: SummaryRef | null;
  turnIds: string[]; operation: ContextOperation | null | undefined; levels: number; zoom: boolean;
  inspectedId: string | null;
  deleting?: Set<string>; restoring?: Set<string>;
  inspect: (node: SummaryNode) => void;
};

const compactSpanWidth = 5;

export function MemoryTimeline({ nodes, selected, stale, archived, turnIds, operation, reusable, levels, zoom, inspectedId, inspect, deleting, restoring }: Props) {
  useLocale();
  const plot = useRef<HTMLDivElement>(null);
  const [plotWidth, setPlotWidth] = useState(0);
  const [hint, setHint] = useState<{ text: string; left: number; top: number } | null>(null);
  const tooltipId = useId();
  useEffect(() => {
    const node = plot.current;
    if (!node) return;
    const observer = new ResizeObserver(() => { setPlotWidth(node.clientWidth); setHint(null); });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const count = Math.max(turnIds.length, 1);
  const positions = new Map(turnIds.map((id, i) => [id, i]));
  const span = (start: number, end: number) => ({ left: `${start / count * 100}%`, width: `${(end - start + 1) / count * 100}%` });
  const sourceSpan = (ids: string[]) => {
    const indices = ids.flatMap(id => positions.has(id) ? [positions.get(id)!] : []);
    return indices.length ? { start: Math.min(...indices), end: Math.max(...indices) } : null;
  };
  const replacement = operation && reusable ? nodes.find(node => refKey(node) === refKey(reusable)) : undefined;
  // Alternate identities can have identical or partially overlapping coverage.
  // Give each overlap its own keyboard-accessible lane instead of painting one
  // button over another. Revisions remain in the inspection selector.
  const lanes = new Map<string, number>(), rowBottom = new Map<number, number>();
  let height = 64;
  for (let level = 1; level <= levels; level++) {
    const ends: number[] = [];
    const items = nodes.filter(node => node.level === level).flatMap(node => {
      const range = sourceSpan(node.turns.map(source => source.turnId));
      return range ? [{ key: refKey(node), ...range }] : [];
    }).sort((a, b) => a.start - b.start || a.end - b.end || a.key.localeCompare(b.key));
    // Reuse surrounds the saved result in its existing lane. Only a new
    // replacement needs another lane alongside retained alternatives.
    if (operation?.level === level && !replacement) {
      const range = sourceSpan(operation.turnIds);
      if (range) items.push({ key: 'next', ...range });
    }
    for (const item of items) {
      let lane = ends.findIndex(end => end < item.start);
      if (lane < 0) lane = ends.length;
      ends[lane] = item.end;
      lanes.set(item.key, lane);
    }
    rowBottom.set(level, height + 16);
    height += 56 + Math.max(0, ends.length - 1) * 36;
  }
  const bottom = (level: number, key: string) => (rowBottom.get(level) ?? 80) + (lanes.get(key) ?? 0) * 36;
  const showHint = (node: HTMLElement, text: string) => {
    const rect = node.getBoundingClientRect();
    setHint({ text, left: Math.max(140, Math.min(window.innerWidth - 140, rect.left + rect.width / 2)), top: Math.max(8, rect.top - 48) });
  };
  const turnWidth = plotWidth / count;
  const compactTurns = turnWidth < compactSpanWidth;
  const bands: { start: number; end: number; archived: boolean; restoring: boolean }[] = [];
  for (const [i, id] of turnIds.entries()) {
    const last = bands.at(-1), isArchived = archived.has(id);
    if (last && last.archived === isArchived && last.restoring === Boolean(restoring?.has(id))) last.end = i;
    else bands.push({ start: i, end: i, archived: isArchived, restoring: Boolean(restoring?.has(id)) });
  }
  const spans = nodes.flatMap(node => {
    const range = sourceSpan(node.turns.map(source => source.turnId));
    if (!range) return [];
    const key = refKey(node);
    const status = selected.has(key) ? 'active' : 'retained';
    const row = bottom(node.level, key);
    const width = (range.end - range.start + 1) * turnWidth;
    const banded = width < compactSpanWidth && !node.manual && !stale.has(key) && !deleting?.has(node.id);
    return [{ node, ...range, status, row, width, banded }];
  });
  const summaryBands: { start: number; end: number; row: number; status: string }[] = [];
  for (const item of spans.filter(item => item.banded).sort((a, b) => a.row - b.row || a.start - b.start)) {
    const previous = summaryBands.at(-1);
    if (previous && previous.row === item.row && previous.status === item.status && previous.end + 1 === item.start) {
      previous.end = item.end;
    } else {
      summaryBands.push({ start: item.start, end: item.end, row: item.row, status: item.status });
    }
  }
  return <div className="timeline-layout">
    <div className="timeline-labels" aria-hidden="true">{Array.from({ length: levels }, (_, i) => <span key={i} style={{ bottom: rowBottom.get(i + 1) }}>{t("memory_timeline.l", { value: i + 1 })}</span>)}<span className="turn-layer-label">{t("memory_timeline.turns")}</span></div>
    <div className="timeline-scroll" tabIndex={0} aria-label={t("memory_timeline.layered_memory_timeline")} onScroll={() => setHint(null)}><div ref={plot} className="timeline" style={{ width: zoom ? Math.max(720, Math.min(count * 40, 200_000)) : '100%', height }}>
      {Array.from({ length: levels }, (_, i) => <div className="timeline-row" key={i} style={{ bottom: rowBottom.get(i + 1) }} />)}
      {summaryBands.map(band => <div key={`${band.row}:${band.start}`} className={`summary-band ${band.status}`}
        style={{ ...span(band.start, band.end), bottom: band.row }} aria-hidden="true" />)}
      {spans.map(({ node, start, end, status, row, width, banded }) => {
        const freshness = stale.has(refKey(node)) ? t("memory_timeline.stale") : t("memory_timeline.fresh");
        const label = `${start + 1}–${end + 1}`, text = t("memory_timeline.l_turns_revision", { level: node.level, label: label, status: status, freshness: freshness, value: node.manual ? t("interface.manually_edited") : '', revision: node.revision });
        const fits = width >= label.length * 6 + 14;
        return <button key={refKey(node)} data-summary-id={node.id} className={`summary-span ${status}${banded ? ' over-summary-band' : ''}${stale.has(refKey(node)) ? ' stale' : ''}${node.manual ? ' manual' : ''}${inspectedId === node.id ? ' inspected' : ''}${deleting?.has(node.id) ? ' deleting' : ''}`} style={{ ...span(start, end), bottom: row }} aria-pressed={inspectedId === node.id} aria-label={t("memory_timeline.level_summary_turns_to_revision", { level: node.level, value: start + 1, value2: end + 1, status: status, value3: deleting?.has(node.id) ? t("interface.will_be_deleted") : '', value4: node.manual ? t("interface.manually_edited_2") : '', freshness: freshness, revision: node.revision })} aria-describedby={hint?.text === text ? tooltipId : undefined} onPointerEnter={e => showHint(e.currentTarget, text)} onPointerLeave={() => setHint(null)} onFocus={e => showHint(e.currentTarget, text)} onBlur={() => setHint(null)} onClick={() => { setHint(null); inspect(node); }}>{fits && !banded ? label : ''}</button>;
      })}
      {operation && (() => { const range = sourceSpan(operation.turnIds); return range && <div className="summary-span preparing" style={{ ...span(range.start, range.end), bottom: bottom(operation.level, replacement ? refKey(replacement) : 'next') }} aria-label={t(replacement ? "memory_timeline.next_reuses_saved_summary" : "memory_timeline.next_source_batch_no_replacement_is_active")}>{(range.end - range.start + 1) / count * plotWidth >= 40 && !replacement ? t("memory_timeline.next") : ''}</div>; })()}
      {compactTurns ? bands.map(band => {
        const text = t("memory_timeline.turns_2", { value: band.start + 1, value2: band.end + 1, value3: band.archived ? t("interface.archived_2") : t("interface.verbatim"), value4: band.restoring ? t("interface.returns_to_verbatim") : '' });
        return <div key={band.start} className={`turn-tick turn-band ${band.archived ? 'retained' : 'active'}${band.restoring ? ' restoring' : ''}`} role="img" aria-label={text} style={span(band.start, band.end)} onPointerEnter={e => showHint(e.currentTarget, text)} onPointerLeave={() => setHint(null)} />;
      }) : turnIds.map((id, i) => {
        const text = t("memory_timeline.turn", { value: i + 1, value2: archived.has(id) ? t("interface.archived_2") : t("interface.verbatim"), value3: restoring?.has(id) ? t("interface.returns_to_verbatim") : '' });
        return <div key={id} role="img" aria-label={text} className={`turn-tick ${archived.has(id) ? 'retained' : 'active'}${restoring?.has(id) ? ' restoring' : ''}`} style={span(i, i)} onPointerEnter={e => showHint(e.currentTarget, text)} onPointerLeave={() => setHint(null)}>{zoom && plotWidth / count >= String(i + 1).length * 6 + 4 ? i + 1 : ''}</div>;
      })}
    </div></div>
    {hint && createPortal(<div id={tooltipId} role="tooltip" className="timeline-tooltip" style={{ left: hint.left, top: hint.top }}>{hint.text}</div>, document.body)}
  </div>;
}
