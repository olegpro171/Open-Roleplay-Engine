import { refKey, type ContextState, type SummaryNode, type SummaryRef, type TurnSource } from '../shared/context.js';
import { message, type MessageKey } from '../shared/localization.js';
import type { SummaryFile } from '../shared/summary-file.js';
import { hasChronologicalLevels, staleSummarySources } from './context.js';
import { correctionProtection, summaryDependencies } from './context-corrections.js';
import { AppError } from './errors.js';
import { checkSummaryRefusal } from './summary-refusals.js';

type FileSummary = SummaryFile['summaries'][number];

export function exportSummaryFile(branchId: string, branchCreatedAt: string | null, state: ContextState): SummaryFile {
  const reference = ({ id, revision }: SummaryRef): SummaryRef => ({ id, revision });
  const summaries = state.summaries.filter(node => node.approved).map(node => ({
    id: node.id, revision: node.revision, level: node.level, text: node.text, manual: node.manual,
    turns: node.turns.map(({ turnId, userRevision, assistantRevision, complete }) => ({ turnId, userRevision, assistantRevision, complete })),
    children: node.children.map(reference), prior: node.prior.map(reference),
    corrections: node.corrections?.map(reference), basedOn: node.basedOn && reference(node.basedOn),
  }));
  return { format: 'ore-summaries', version: 1, branchId, branchCreatedAt,
    selected: state.selected.map(reference), archivedTurnIds: state.archivedTurnIds, summaries };
}

function invalid(key: MessageKey = 'summary_file.invalid_graph'): never {
  throw new AppError(422, 'invalid_summary_file', message(key));
}

function dependenciesFirst(nodes: Map<string, SummaryNode>): SummaryNode[] {
  const consumers = new Map<string, string[]>();
  const pending = new Map<string, number>();
  const ready: string[] = [];
  for (const [key, node] of nodes) {
    const refs = summaryDependencies(node);
    if (node.basedOn) refs.push(node.basedOn);
    pending.set(key, refs.length);
    if (!refs.length) ready.push(key);
    for (const ref of refs) {
      const target = refKey(ref);
      if (!nodes.has(target)) invalid();
      const uses = consumers.get(target) ?? [];
      uses.push(key);
      consumers.set(target, uses);
    }
  }
  const ordered: SummaryNode[] = [];
  for (const key of ready) {
    const node = nodes.get(key);
    if (!node) invalid();
    ordered.push(node);
    for (const consumer of consumers.get(key) ?? []) {
      const remaining = (pending.get(consumer) ?? 0) - 1;
      pending.set(consumer, remaining);
      if (!remaining) ready.push(consumer);
    }
  }
  if (ordered.length !== nodes.size) invalid();
  return ordered;
}

/** The file is one approved editorial snapshot. Current versions consume the
 * other current versions, while older versions keep their historical links. */
export function importSummaryState(file: SummaryFile, sources: TurnSource[], createdAt: string): Omit<ContextState, 'revision'> {
  const original = new Map<string, FileSummary>();
  const latest = new Map<string, FileSummary>();
  for (const node of file.summaries) {
    const key = refKey(node);
    if (original.has(key) || node.turns.length && !node.text.trim()) invalid('summary_file.invalid_version');
    if (new Set(node.turns.map(turn => turn.turnId)).size !== node.turns.length) invalid('summary_file.invalid_coverage');
    original.set(key, node);
    if ((latest.get(node.id)?.revision ?? -1) < node.revision) latest.set(node.id, node);
  }
  const currentSources = new Map(sources.map(turn => [turn.turnId, turn]));
  const nodes = new Map<string, SummaryNode>();
  for (const [key, node] of original) {
    const current = latest.get(node.id) === node;
    const resolve = (ref: SummaryRef): SummaryRef => {
      if (!original.has(refKey(ref))) invalid();
      return { id: ref.id, revision: current ? latest.get(ref.id)?.revision ?? ref.revision : ref.revision };
    };
    if (node.basedOn && (node.basedOn.id !== node.id || node.basedOn.revision >= node.revision)) invalid();
    const refusal = checkSummaryRefusal(node.text);
    nodes.set(key, {
      ...node, approved: true, createdAt,
      turns: current ? node.turns.map(turn => currentSources.get(turn.turnId) ?? turn) : node.turns,
      children: node.children.map(resolve), prior: node.prior.map(resolve), corrections: node.corrections?.map(resolve),
      refusalCheck: refusal.result === 'suspected' ? { ...refusal, decision: 'keep' } : refusal,
    });
  }
  // The graph walk validates both historical and rebound links. Put producers
  // before consumers for subsequent freshness checks, even in reordered files.
  const summaries = dependenciesFirst(nodes);
  for (const node of summaries) {
    let offset = 0;
    if (node.level > 1 && node.turns.length && !node.children.length) invalid('summary_file.invalid_coverage');
    for (const ref of node.children) {
      const child = nodes.get(refKey(ref));
      if (!child || child.level >= node.level) invalid();
      for (const turn of child.turns) {
        if (node.turns[offset++]?.turnId !== turn.turnId) invalid('summary_file.invalid_coverage');
      }
    }
    if (node.children.length && offset !== node.turns.length) invalid('summary_file.invalid_coverage');
  }
  const selectedNodes = file.selected.map(ref => {
    const node = nodes.get(refKey(ref));
    if (!node?.turns.length || latest.get(ref.id)?.revision !== ref.revision) invalid('summary_file.invalid_selection');
    return node;
  });
  let offset = 0;
  for (const node of selectedNodes) {
    for (const turn of node.turns) {
      if (file.archivedTurnIds[offset] !== turn.turnId || sources[offset]?.turnId !== turn.turnId || !sources[offset].complete) {
        invalid('summary_file.invalid_selection');
      }
      offset++;
    }
  }
  if (offset !== file.archivedTurnIds.length || !hasChronologicalLevels(selectedNodes)) invalid('summary_file.invalid_selection');
  const state = { revision: 0, selected: file.selected, archivedTurnIds: file.archivedTurnIds, summaries };
  const stale = staleSummarySources(sources, state);
  // Retain historical records about deleted turns. Current selected memory and
  // surviving manual corrections must be usable as a complete replacement.
  if (state.selected.some(ref => stale.has(refKey(ref)))) invalid('summary_file.invalid_selection');
  const protection = correctionProtection(sources.map(source => ({ id: source.turnId })), state);
  if (protection.unresolved.length || protection.corrections.some(node => stale.has(refKey(node)))) {
    invalid('summary_file.invalid_corrections');
  }
  return state;
}
