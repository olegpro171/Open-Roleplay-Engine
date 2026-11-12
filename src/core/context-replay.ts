import type { EngineSnapshot } from '../shared/contracts.js';
import { refKey, type ContextOperation, type ContextPlan, type ContextState, type SummaryNode, type SummaryRef } from '../shared/context.js';
import { hasPromptMarker } from '../shared/library.js';
import { message, type LocalizedMessage } from '../shared/localization.js';
import { AppError } from './errors.js';
import { correctionDiagnostic, correctionProtection, latestApproved } from './context-corrections.js';
import { hasChronologicalLevels, rankedPromotions, repairQueue, staleSummaries } from './context.js';
import { operationKey, savedSummaries } from './context-reuse.js';
import { managedInputCosts, summarySeparator, summaryText } from './prompt.js';
import { refusalAffected } from './summary-refusals.js';
import { countText } from './tokens.js';
import { requiredVerbatimTail } from './continuation.js';

type ReplayDecision = {
  next: ContextOperation | null;
  blocked?: LocalizedMessage;
  saved?: SummaryNode;
  correctionConflicts?: SummaryRef[];
  /** Correction anchors are required saved coverage, not replacements. */
  anchor?: boolean;
};

export type ReplayFrame = ReplayDecision & { snapshot: EngineSnapshot; plan: ContextPlan; maySupersede: boolean };

const reference = ({ id, revision }: SummaryRef): SummaryRef => ({ id, revision });
const turnIds = (node: SummaryNode) => node.turns.map(turn => turn.turnId);
const asOperation = (node: SummaryNode): ContextOperation => ({ level: node.level, turnIds: turnIds(node), children: node.children });

/** A run follows one working prefix, independently of when it can be selected. */
export class PreparationReplay {
  private readonly base: EngineSnapshot;
  private active: SummaryNode[] = [];
  private cutoff = 0;
  private joined = 0;
  private readonly byStart = new Map<number, SummaryNode[]>();
  private readonly exact = new Map<string, SummaryNode[]>();
  private readonly alternatives = new Map<string, number>();
  private readonly positions: Map<string, number>;
  private readonly sizes = new Map<string, number>();
  private readonly finalSizes = new Map<string, number>();
  private readonly layout = new Set<string>();
  private readonly protection;
  private readonly costs;
  private readonly config;
  private readonly limit;
  private readonly lastCutoff;
  private readonly pinnedFloor;
  private readonly hasMessages;
  private readonly stale: SummaryRef[];
  private readonly obstruction?: LocalizedMessage;
  private anchors: SummaryNode[] = [];
  private readonly conflicts: SummaryRef[] = [];
  private anchorIndex = 0;

  constructor(snapshot: EngineSnapshot, savedLayout: ContextState = snapshot.context) {
    this.base = { ...snapshot };
    const { connection, context, settings, sources, turns } = snapshot;
    if (!hasPromptMarker(sources.prompt, 'summary')) throw new AppError(422, 'summaries_disabled', message('errors.summaries_are_disabled_enable_a_summary_marker_in'));
    if (!connection) throw new AppError(422, 'connection_required', message('errors.select_a_roleplay_connection_to_measure_the_complete'));
    if (!context.preset) throw new AppError(422, 'context_required', message('errors.select_a_context_preset_first'));
    this.config = context.preset;
    this.hasMessages = hasPromptMarker(sources.prompt, 'messages');
    this.limit = Math.min(settings.targetInputTokens, connection.contextWindow - connection.maxOutputTokens);
    this.positions = new Map(turns.map((turn, index) => [turn.id, index + 1]));
    this.costs = managedInputCosts(connection, settings, turns, sources, snapshot.loreResolution, snapshot.continuationTurnId);
    const minimum = requiredVerbatimTail(this.config.minTail, snapshot.continuationTurnId);
    this.lastCutoff = this.hasMessages ? Math.max(0, turns.filter(turn => turn.complete).length - minimum) : context.archivedTurnIds.length;
    this.protection = correctionProtection(turns, context);

    const nodes = new Map(context.summaries.map(node => [refKey(node), node]));
    const layoutNodes = savedLayout === context ? nodes : new Map(savedLayout.summaries.map(node => [refKey(node), node]));
    // An older batch size remains eligible on the established coverage layout.
    // Prior-context references do not establish coverage boundaries.
    const rememberLayout = (ref: SummaryRef) => {
      if (this.layout.has(refKey(ref))) return;
      this.layout.add(refKey(ref));
      layoutNodes.get(refKey(ref))?.children.forEach(rememberLayout);
    };
    savedLayout.selected.forEach(rememberLayout);
    const stale = staleSummaries(turns, context), refused = refusalAffected(context);
    this.stale = context.selected.filter(ref => stale.has(refKey(ref)));
    const selected = context.selected.flatMap(ref => {
      const node = nodes.get(refKey(ref));
      return node?.approved ? [node] : [];
    });
    const coverage = selected.flatMap(turnIds);
    if (context.selected.some(ref => refused.has(refKey(ref)))) this.obstruction = message('refusals.resolve_before_using_memory');
    else if (this.stale.length || selected.length !== context.selected.length || coverage.length !== context.archivedTurnIds.length
      || coverage.some((id, i) => id !== turns[i]?.id || id !== context.archivedTurnIds[i])) {
      this.obstruction = message('diagnostics.selected_memory_is_out_of_date_generate_a');
    }
    if (!this.hasMessages) {
      this.active = selected;
      this.cutoff = this.lastCutoff;
      this.joined = selected.reduce((total, node) => total + this.size(node), 0);
    }

    for (const node of latestApproved(context)) {
      for (const source of node.turns) {
        const key = this.alternativeKey(node.level, source.turnId);
        this.alternatives.set(key, (this.alternatives.get(key) ?? 0) + 1);
      }
    }
    const available = savedSummaries(turns, context).filter(node => this.end(node) <= this.lastCutoff
      && !this.protection.missingFor(node).length);
    for (const node of available) {
      const start = this.start(node);
      const byStart = this.byStart.get(start) ?? [];
      byStart.push(node);
      this.byStart.set(start, byStart);
      const key = operationKey(asOperation(node));
      const exact = this.exact.get(key) ?? [];
      exact.push(node);
      this.exact.set(key, exact);
    }

    if (!this.hasMessages) {
      this.conflicts = this.protection.unresolved;
    } else {
      this.findCorrectionAnchors(available, selected);
    }
    const variableBatches = this.anchors.length || available.some(node => node.level === 1 && this.layout.has(refKey(node)) && node.turns.length !== this.config.batchSize);
    const residual = this.hasMessages && !variableBatches ? this.lastCutoff % this.config.batchSize : 0;
    this.pinnedFloor = this.costs.tailInput[this.lastCutoff - residual];
  }

  private findCorrectionAnchors(available: SummaryNode[], selected: SummaryNode[]) {
    const corrections = [...this.protection.corrections].sort((a, b) => this.start(a) - this.start(b));
    if (!corrections.length) return;
    const byKey = new Map(corrections.map(node => [refKey(node), node]));
    const starts = new Set(corrections.map(node => node.turns[0]?.turnId));
    const containers = new Map<string, SummaryNode[]>();
    for (const node of available) {
      for (const source of node.turns) {
        if (!starts.has(source.turnId)) continue;
        const group = containers.get(source.turnId) ?? [];
        group.push(node);
        containers.set(source.turnId, group);
      }
    }
    const covered = new Set<string>();
    for (const correction of corrections) {
      const key = refKey(correction);
      if (covered.has(key)) continue;
      const previous = this.anchors.at(-1);
      const anchor = containers.get(correction.turns[0]?.turnId)?.filter(node => this.end(node) >= this.end(correction)
        && (!previous || this.end(previous) <= this.start(node)) && this.protection.represented(node).has(key))
        .sort((a, b) => this.start(b) - this.start(a) || this.end(a) - this.end(b) || a.level - b.level)[0];
      if (!anchor) {
        this.conflicts.push(correction);
        continue;
      }
      this.anchors.push(anchor);
      for (const represented of this.protection.represented(anchor)) {
        const linked = byKey.get(represented);
        if (linked && this.start(anchor) <= this.start(linked) && this.end(anchor) >= this.end(linked)) covered.add(represented);
      }
    }
    if (!this.conflicts.length || this.protection.unresolved.length || !hasChronologicalLevels(selected)) return;
    // Reviewed links can represent a correction across multiple saved spans.
    // Keep those exact spans if the committed representation still fits the tail rule.
    const eligible = new Set(available.map(refKey));
    const required = selected.filter(node => [...this.protection.represented(node)].some(key => {
      const correction = byKey.get(key);
      return correction && this.protection.overlaps(node, correction);
    }));
    if (required.every(node => eligible.has(refKey(node)))) {
      this.anchors = required;
      this.conflicts.length = 0;
    }
  }

  private start(node: SummaryNode) { return (this.positions.get(node.turns[0]?.turnId) ?? 0) - 1; }
  private end(node: SummaryNode) { return this.start(node) + node.turns.length; }
  private alternativeKey(level: number, turnId: string) { return `${level}:${turnId}`; }

  private size(node: SummaryNode): number {
    const key = refKey(node);
    const known = this.sizes.get(key);
    if (known !== undefined) return known;
    const text = summaryText(node, this.positions);
    // Each next "[Memory" header starts a new o200k pre-token after the
    // separator. Count the separator with the preceding summary.
    const joined = countText(text + summarySeparator);
    this.sizes.set(key, joined);
    this.finalSizes.set(key, countText(text));
    return joined;
  }

  private measure(cutoff: number, joined: number, last?: SummaryNode): number {
    const tail = this.costs.tailInput[cutoff];
    if (!last) return tail;
    const withoutLast = joined - this.size(last);
    return tail + this.costs.summaryFrame + withoutLast + (this.finalSizes.get(refKey(last)) ?? 0);
  }

  private promotionLocation(operation: ContextOperation): number {
    return this.active.findIndex(node => refKey(node) === refKey(operation.children[0]));
  }

  private replacementInput(operation: ContextOperation, node: SummaryNode): number {
    if (operation.level === 1) return this.measure(this.end(node), this.joined + this.size(node), node);
    const start = this.promotionLocation(operation);
    const end = start + operation.children.length;
    const replaced = this.active.slice(start, end).reduce((total, child) => total + this.size(child), 0);
    return this.measure(this.cutoff, this.joined - replaced + this.size(node), end === this.active.length ? node : this.active.at(-1));
  }

  private matchesChildren(parent: SummaryNode, start: number, level: number): boolean {
    const last = this.active[start + parent.children.length - 1];
    return parent.level === level + 1 && parent.children.length >= 2 && last !== undefined && this.end(last) === this.end(parent) && parent.children.every((ref, offset) => {
      const child = this.active[start + offset];
      return child?.level === level && refKey(child) === refKey(ref);
    });
  }

  private savedCorrectionPrefix(anchor: SummaryNode): SummaryNode | undefined {
    const index = this.active.findIndex(node => node.level < anchor.level);
    if (index === -1) return undefined;
    const first = this.active[index];
    // A direct parent correction can force an already saved chronological
    // prefix. Recover exact coverage even if the current floor prevents
    // creating a new parent at this boundary.
    return this.byStart.get(this.start(first))?.find(parent =>
      this.layout.has(refKey(parent)) && this.matchesChildren(parent, index, first.level));
  }

  private promotions(input: number) {
    const groupSizes = new Map<number, number>();
    for (const [index, first] of this.active.entries()) {
      if (index > 0 && this.active[index - 1].level === first.level) continue;
      for (const parent of this.byStart.get(this.start(first)) ?? []) {
        if (!this.layout.has(refKey(parent)) || !this.matchesChildren(parent, index, first.level)) continue;
        const retained = this.active.slice(index + parent.children.length, index + parent.children.length + this.config.retainedPerLevel);
        if (retained.length < this.config.retainedPerLevel || retained.some(node => node.level !== first.level)
          || this.replacementInput(asOperation(parent), parent) >= input) continue;
        groupSizes.set(first.level, parent.children.length);
        break;
      }
    }
    return rankedPromotions(this.active, this.config, this.sizes, groupSizes);
  }

  private maySupersede({ next, anchor, saved }: ReplayDecision): boolean {
    // Replaying an already accepted boundary is not a new supersession.
    return Boolean(next && !anchor && !(saved && this.layout.has(refKey(saved))) && next.turnIds.some(id =>
      (this.alternatives.get(this.alternativeKey(next.level, id)) ?? 0) > Number(Boolean(saved))));
  }

  next(): ReplayFrame {
    const decision = this.decide();
    const { next, blocked, saved } = decision;
    const { context, settings, turns } = this.base;
    const inputTokens = this.measure(this.cutoff, this.joined, this.active.at(-1));
    const plan: ContextPlan = {
      inputTokens, targetInputTokens: settings.targetInputTokens, effectiveLimit: this.limit,
      method: this.costs.budget.method, counting: this.costs.budget.counting,
      verbatimTurnIds: this.hasMessages ? turns.slice(this.cutoff).map(turn => turn.id) : [],
      next, ready: !blocked && !next, blocked: blocked?.fallback ?? null, blockedMessage: blocked, stale: this.stale,
      ...(saved ? { reusable: reference(saved) } : {}),
      ...(blocked ? { repairCount: repairQueue(turns, context).length } : {}),
    };
    const snapshot = { ...this.base, context: { ...context,
      selected: this.active.map(reference), archivedTurnIds: turns.slice(0, this.cutoff).map(turn => turn.id) } };
    return { ...decision, snapshot, plan, maySupersede: this.maySupersede(decision) };
  }

  advanceSaved(): boolean {
    const decision = this.decide();
    if (!decision.saved || this.maySupersede(decision)) return false;
    this.advance(decision, decision.saved);
    return true;
  }

  private decide(): ReplayDecision {
    if (this.obstruction) return { next: null, blocked: this.obstruction };
    if (this.conflicts.length) return { next: null, blocked: correctionDiagnostic, correctionConflicts: this.conflicts };
    const input = this.measure(this.cutoff, this.joined, this.active.at(-1));
    const anchor = this.anchors[this.anchorIndex];
    if (input <= this.limit && !anchor) return { next: null };
    const required = this.costs.tailInput[this.cutoff];
    const { config, lastCutoff, cutoff } = this;
    if (this.costs.hasPins && this.pinnedFloor >= this.limit) return { next: null, blocked: message('pins.required_budget') };

    const boundary = anchor ? this.start(anchor) : lastCutoff;
    if (anchor && cutoff === boundary && (this.active.at(-1)?.level ?? Infinity) >= anchor.level) {
      return { next: asOperation(anchor), saved: anchor, anchor: true };
    }
    if (this.hasMessages && cutoff < boundary) {
      const leaves = this.byStart.get(cutoff) ?? [];
      const eligible = (node: SummaryNode) => node.level === 1 && this.end(node) <= boundary
        && this.replacementInput(asOperation(node), node) < input;
      const saved = leaves.find(node => this.layout.has(refKey(node)) && eligible(node))
        ?? leaves.find(node => node.turns.length === config.batchSize && eligible(node));
      if (saved) return { next: asOperation(saved), saved };
      if (cutoff + config.batchSize <= boundary) {
        const batch = this.base.turns.slice(cutoff, cutoff + config.batchSize);
        return { next: { level: 1, turnIds: batch.map(turn => turn.id), children: [] } };
      }
    }
    if (anchor && cutoff < boundary) return this.blockedAnchor(anchor);
    if (anchor) {
      const saved = this.savedCorrectionPrefix(anchor);
      if (saved) return { next: asOperation(saved), saved };
    }
    if (!anchor && required >= this.limit) {
      if (this.costs.hasPins) return { next: null, blocked: message('pins.required_budget') };
      return { next: null, blocked: message(required > this.limit
        ? 'diagnostics.the_required_verbatim_tail_pending_input_and_prompt'
        : 'diagnostics.no_input_capacity_remains_for_summaries_covering_archived') };
    }
    const next = this.promotions(input)[0];
    if (!next) {
      if (anchor) return this.blockedAnchor(anchor);
      return { next: null, blocked: message(this.hasMessages ? 'diagnostics.no_complete_promotion_group_satisfies_the_retained_summary'
        : 'diagnostics.the_selected_summaries_and_prompt_cannot_fit_the') };
    }
    const parents = this.exact.get(operationKey(next)) ?? [];
    const shrinks = (node: SummaryNode) => this.replacementInput(next, node) < input;
    const saved = parents.find(node => this.layout.has(refKey(node)) && shrinks(node)) ?? parents.find(shrinks);
    return { next, saved };
  }

  private blockedAnchor(anchor: SummaryNode): ReplayDecision {
    const represented = this.protection.represented(anchor);
    return { next: null, blocked: correctionDiagnostic,
      correctionConflicts: this.protection.corrections.filter(correction => represented.has(refKey(correction))) };
  }

  advance(frame: ReplayDecision, node: SummaryNode) {
    const operation = frame.next;
    if (!operation) throw new Error('Cannot advance a finished memory replay');
    if (frame.anchor || operation.level === 1) {
      this.active.push(node);
      this.cutoff += node.turns.length;
      this.joined += this.size(node);
      if (frame.anchor) this.anchorIndex++;
    } else {
      const removed = this.active.splice(this.promotionLocation(operation), operation.children.length, node);
      this.joined += this.size(node) - removed.reduce((total, child) => total + this.size(child), 0);
    }
    if (!frame.saved) {
      this.base.context = { ...this.base.context, summaries: [...this.base.context.summaries, node] };
      for (const source of node.turns) {
        const key = this.alternativeKey(node.level, source.turnId);
        this.alternatives.set(key, (this.alternatives.get(key) ?? 0) + 1);
      }
    }
  }

  updateRevisions({ sourceRevision, selectionRevision }: { sourceRevision: number; selectionRevision: number }) {
    this.base.revision = sourceRevision;
    this.base.context = { ...this.base.context, revision: selectionRevision };
  }
}

/** Inspect through uninterrupted saved reuse, with no selection or job writes. */
export function inspectPreparation(snapshot: EngineSnapshot): ReplayFrame {
  const replay = new PreparationReplay(snapshot);
  while (replay.advanceSaved()) { /* Saved operations only move the working prefix forward. */ }
  return replay.next();
}
