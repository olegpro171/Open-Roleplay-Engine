import type { Turn } from '../shared/contracts.js';
import { refKey, type SummaryNode, type SummaryRef } from '../shared/context.js';
import { summaryPressure } from './context.js';
import { summarySeparator, summaryText } from './prompt.js';
import { countText } from './tokens.js';

type Span = { node: SummaryNode; start: number; end: number; joinedTokens: number; finalTokens: number };

function savedSpans(turns: Turn[], available: SummaryNode[], lastCutoff: number): Span[] {
  const positions = new Map(turns.map((turn, index) => [turn.id, index + 1]));
  return available.flatMap(node => {
    const first = positions.get(node.turns[0]?.turnId);
    const end = positions.get(node.turns.at(-1)?.turnId ?? '');
    if (first === undefined || end === undefined || end > lastCutoff) return [];
    const text = summaryText(node, positions);
    // The o200k pre-tokenizer splits before the next "[Memory" header.
    // The separator may merge with the preceding summary.
    return [{ node, start: first - 1, end, joinedTokens: countText(text + summarySeparator), finalTokens: countText(text) }];
  });
}

/** Rebuild from fine saved coverage and promote the most pressured eligible level. */
export function replaySavedPressure(
  turns: Turn[], available: SummaryNode[], baseline: SummaryNode[],
  lastCutoff: number, tailInput: number[], summaryFrame: number, limit: number,
): SummaryNode[] | null {
  const spans = savedSpans(turns, available, lastCutoff);
  const byRef = new Map(spans.map(span => [refKey(span.node), span]));
  const byStart = new Map<number, Span[]>();
  for (const span of spans) {
    const group = byStart.get(span.start) ?? [];
    group.push(span);
    byStart.set(span.start, group);
  }
  // Replay must make the same choices after its intermediate summaries become
  // inactive, even if a saved alternative shares their exact range.
  for (const group of byStart.values()) {
    group.sort((a, b) => a.end - b.end);
  }
  const active: Span[] = [];
  for (const node of baseline) {
    const span = byRef.get(refKey(node));
    if (!span) return null;
    active.push(span);
  }
  const measure = (cutoff: number, joined: number, last: Span | undefined) =>
    tailInput[cutoff] + (last ? summaryFrame + joined - last.joinedTokens + last.finalTokens : 0);
  let joined = active.reduce((total, span) => total + span.joinedTokens, 0);
  let cutoff = active.at(-1)?.end ?? 0;
  let input = measure(cutoff, joined, active.at(-1));
  while (input > limit) {
    const leaf = byStart.get(cutoff)?.find(span => span.node.level === 1
      && measure(span.end, joined + span.joinedTokens, span) < input);
    if (leaf) {
      active.push(leaf);
      joined += leaf.joinedTokens;
      cutoff = leaf.end;
      input = measure(cutoff, joined, leaf);
      continue;
    }

    const layers = new Map<number, { first: number; last: number; tokens: number }>();
    const ends = new Map<number, number>();
    const cumulative = [0];
    for (const [index, span] of active.entries()) {
      const level = span.node.level;
      const layer = layers.get(level) ?? { first: index, last: index, tokens: 0 };
      layer.last = index;
      layer.tokens += span.joinedTokens;
      layers.set(level, layer);
      ends.set(span.end, index);
      cumulative.push(cumulative[index] + span.joinedTokens);
    }
    const ranked = [...layers].sort(([a, x], [b, y]) => summaryPressure(b, y.tokens) - summaryPressure(a, x.tokens) || b - a);
    let promoted = false;
    for (const [level, layer] of ranked) {
      // A saved parent can replace a different tiling of its span, provided
      // the whole oldest range at this source level is replaced.
      for (const parent of byStart.get(active[layer.first].start) ?? []) {
        if (parent.node.level !== level + 1) continue;
        const last = ends.get(parent.end);
        if (last === undefined || last > layer.last) continue;
        const replacementTokens = joined - (cumulative[last + 1] - cumulative[layer.first]) + parent.joinedTokens;
        const replacementInput = measure(cutoff, replacementTokens, last === active.length - 1 ? parent : active.at(-1));
        if (replacementInput >= input) continue;
        active.splice(layer.first, last - layer.first + 1, parent);
        joined = replacementTokens;
        input = replacementInput;
        promoted = true;
        break;
      }
      if (promoted) break;
    }
    if (!promoted) break;
  }
  return active.map(span => span.node);
}

/** Find chronological tilings without enumerating combinations of overlapping alternatives. */
export function planSavedSelection(
  turns: Turn[], available: SummaryNode[], selected: SummaryRef[],
  firstCutoff: number, lastCutoff: number, tailInput: number[], summaryFrame: number, limit: number, preferredCutoff = firstCutoff,
): SummaryNode[] | null {
  if (preferredCutoff === 0 && firstCutoff === 0 && tailInput[0] <= limit) return [];
  const committed = new Set(selected.map(refKey));
  const byEnd = new Map<number, Span[]>();
  for (const span of savedSpans(turns, available, lastCutoff)) {
    const group = byEnd.get(span.end) ?? [];
    group.push(span);
    byEnd.set(span.end, group);
  }
  const prefixCosts = new Map<number, Map<number, number>>();
  const prefixCost = (end: number, level: number) => {
    if (end === 0) return 0;
    let best = Infinity;
    for (const [previousLevel, cost] of prefixCosts.get(end) ?? []) {
      if (previousLevel >= level) best = Math.min(best, cost);
    }
    return best;
  };
  let lowestInput = firstCutoff === 0 ? { cutoff: 0, input: tailInput[0] } : null;
  let fit = lowestInput && lowestInput.input <= limit ? lowestInput : null;
  for (const cutoff of [...byEnd.keys()].sort((a, b) => a - b)) {
    const group = byEnd.get(cutoff) ?? [];
    const byLevel = new Map<number, number>();
    let finalTokens = Infinity;
    for (const span of group) {
      const prefix = prefixCost(span.start, span.node.level);
      if (!Number.isFinite(prefix)) continue;
      byLevel.set(span.node.level, Math.min(byLevel.get(span.node.level) ?? Infinity, prefix + span.joinedTokens));
      finalTokens = Math.min(finalTokens, prefix + span.finalTokens);
    }
    prefixCosts.set(cutoff, byLevel);
    if (cutoff < firstCutoff || !Number.isFinite(finalTokens)) continue;
    const input = tailInput[cutoff] + summaryFrame + finalTokens;
    if (!lowestInput || input < lowestInput.input) lowestInput = { cutoff, input };
    if (input <= limit) {
      if (!fit || Math.abs(cutoff - preferredCutoff) < Math.abs(fit.cutoff - preferredCutoff)) fit = { cutoff, input };
      if (cutoff >= preferredCutoff) break;
    }
  }
  const best = fit ?? lowestInput;
  if (!best) return null;
  if (!best.cutoff) return [];

  // At the chosen cutoff, prefer finer saved detail from newest to oldest.
  // Keep a committed identity on equivalent spans.
  const fixed = tailInput[best.cutoff] + summaryFrame;
  let remaining = Math.max(best.input, limit) - fixed;
  let cutoff = best.cutoff, level = 0;
  const nodes: SummaryNode[] = [];
  while (cutoff > 0) {
    const choices = [...(byEnd.get(cutoff) ?? [])].sort((a, b) => a.node.level - b.node.level
      || b.start - a.start || Number(committed.has(refKey(b.node))) - Number(committed.has(refKey(a.node))));
    const tokens = (span: Span) => nodes.length ? span.joinedTokens : span.finalTokens;
    const span = choices.find(choice => {
      if (choice.node.level < level) return false;
      const prefix = prefixCost(choice.start, choice.node.level);
      return Number.isFinite(prefix) && prefix + tokens(choice) <= remaining;
    });
    if (!span) return null;
    remaining -= tokens(span);
    nodes.push(span.node);
    cutoff = span.start;
    level = span.node.level;
  }
  return nodes.reverse();
}
