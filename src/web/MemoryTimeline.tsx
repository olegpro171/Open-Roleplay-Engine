import { t, useLocale } from './localization';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { refKey, type ContextOperation, type SummaryNode } from '../shared/context';

type Props = {
  nodes: SummaryNode[]; selected: Set<string>; stale: Set<string>; archived: Set<string>;
  turnIds: string[]; operation: ContextOperation | null | undefined; levels: number; zoom: boolean;
  inspectedId: string | null;
  deleting?: Set<string>; restoring?: Set<string>;
  inspect: (node: SummaryNode) => void;
};

export function MemoryTimeline({ nodes, selected, stale, archived, turnIds, operation, levels, zoom, inspectedId, inspect, deleting, restoring }: Props) {
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
    if (operation?.level === level) {
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
  const compact = plotWidth / count < 5;
  const bands: { start: number; end: number; archived: boolean; restoring: boolean }[] = [];
  for (const [i, id] of turnIds.entries()) {
    const last = bands.at(-1), isArchived = archived.has(id);
    if (last && last.archived === isArchived && last.restoring === Boolean(restoring?.has(id))) last.end = i;
    else bands.push({ start: i, end: i, archived: isArchived, restoring: Boolean(restoring?.has(id)) });
  }
  return <div className="timeline-layout">
    <div className="timeline-labels" aria-hidden="true">{Array.from({ length: levels }, (_, i) => <span key={i} style={{ bottom: rowBottom.get(i + 1) }}>{t("memory_timeline.l", { value: i + 1 })}</span>)}<span className="turn-layer-label">{t("memory_timeline.turns")}</span></div>
    <div className="timeline-scroll" tabIndex={0} aria-label={t("memory_timeline.layered_memory_timeline")} onScroll={() => setHint(null)}><div ref={plot} className="timeline" style={{ width: zoom ? Math.max(720, Math.min(count * 40, 200_000)) : '100%', height }}>
      {Array.from({ length: levels }, (_, i) => <div className="timeline-row" key={i} style={{ bottom: rowBottom.get(i + 1) }} />)}
      {nodes.map(node => {
        const range = sourceSpan(node.turns.map(source => source.turnId));
        if (!range) return null;
        const status = selected.has(refKey(node)) ? 'active' : 'retained';
        const freshness = stale.has(refKey(node)) ? t("memory_timeline.stale") : t("memory_timeline.fresh");
        const label = `${range.start + 1}–${range.end + 1}`, text = t("memory_timeline.l_turns_revision", { level: node.level, label: label, status: status, freshness: freshness, value: node.manual ? t("interface.manually_edited") : '', revision: node.revision });
        const fits = (range.end - range.start + 1) / count * plotWidth >= label.length * 6 + 14;
        return <button key={refKey(node)} data-summary-id={node.id} className={`summary-span ${status}${stale.has(refKey(node)) ? ' stale' : ''}${node.manual ? ' manual' : ''}${inspectedId === node.id ? ' inspected' : ''}${deleting?.has(node.id) ? ' deleting' : ''}`} style={{ ...span(range.start, range.end), bottom: bottom(node.level, refKey(node)) }} aria-pressed={inspectedId === node.id} aria-label={t("memory_timeline.level_summary_turns_to_revision", { level: node.level, value: range.start + 1, value2: range.end + 1, status: status, value3: deleting?.has(node.id) ? t("interface.will_be_deleted") : '', value4: node.manual ? t("interface.manually_edited_2") : '', freshness: freshness, revision: node.revision })} aria-describedby={hint?.text === text ? tooltipId : undefined} onPointerEnter={e => showHint(e.currentTarget, text)} onPointerLeave={() => setHint(null)} onFocus={e => showHint(e.currentTarget, text)} onBlur={() => setHint(null)} onClick={() => { setHint(null); inspect(node); }}>{fits ? label : ''}</button>;
      })}
      {operation && (() => { const range = sourceSpan(operation.turnIds); return range && <div className="summary-span preparing" style={{ ...span(range.start, range.end), bottom: bottom(operation.level, 'next') }} aria-label={t("memory_timeline.next_source_batch_no_replacement_is_active")}>{(range.end - range.start + 1) / count * plotWidth >= 40 ? 'next' : ''}</div>; })()}
      {compact ? bands.map(band => {
        const text = t("memory_timeline.turns_2", { value: band.start + 1, value2: band.end + 1, value3: band.archived ? t("interface.archived_2") : t("interface.verbatim"), value4: band.restoring ? t("interface.returns_to_verbatim") : '' });
        return <div key={band.start} className={`turn-tick turn-band ${band.archived ? 'retained' : 'active'}${band.restoring ? ' restoring' : ''}`} role="img" aria-label={text} style={span(band.start, band.end)} onPointerEnter={e => showHint(e.currentTarget, text)} onPointerLeave={() => setHint(null)} />;
      }) : turnIds.map((id, i) => <div key={id} title={t("memory_timeline.turn", { value: i + 1, value2: archived.has(id) ? t("interface.archived_2") : t("interface.verbatim"), value3: restoring?.has(id) ? t("interface.returns_to_verbatim") : '' })} className={`turn-tick ${archived.has(id) ? 'retained' : 'active'}${restoring?.has(id) ? ' restoring' : ''}`} style={span(i, i)}>{zoom && plotWidth / count >= String(i + 1).length * 6 + 4 ? i + 1 : ''}</div>)}
    </div></div>
    {hint && createPortal(<div id={tooltipId} role="tooltip" className="timeline-tooltip" style={{ left: hint.left, top: hint.top }}>{hint.text}</div>, document.body)}
  </div>;
}
