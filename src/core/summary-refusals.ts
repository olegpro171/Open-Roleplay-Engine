import { AppError } from './errors.js';
import { latestApproved, summaryDependencies } from './context-corrections.js';
import { containsSummaryRefusal, summaryRefusalFilterVersion } from './summary-validation.js';
import { refKey, type ContextState, type SummaryNode, type SummaryRefusalCheck } from '../shared/context.js';
import { message } from '../shared/localization.js';

export function checkSummaryRefusal(text: string): SummaryRefusalCheck {
  return { version: summaryRefusalFilterVersion, result: containsSummaryRefusal(text) ? 'suspected' : 'passed' };
}

export function summaryRefusalCheck(node: SummaryNode): SummaryRefusalCheck {
  return node.refusalCheck?.version === summaryRefusalFilterVersion ? node.refusalCheck : checkSummaryRefusal(node.text);
}

export function unresolvedRefusal(node: SummaryNode): boolean {
  const check = summaryRefusalCheck(node);
  return node.regeneration === 'refusal' || check.result === 'suspected' && check.decision !== 'keep';
}

export function refusalFindings(state: ContextState): SummaryNode[] {
  return latestApproved(state).filter(unresolvedRefusal);
}

/** Include all actual source, earlier-memory and editorial consumers. */
export function refusalAffected(state: ContextState): Set<string> {
  const consumers = new Map<string, string[]>();
  const affected = new Set<string>();
  const queue: string[] = [];
  for (const node of state.summaries) {
    const key = refKey(node);
    if (unresolvedRefusal(node)) { affected.add(key); queue.push(key); }
    for (const ref of summaryDependencies(node)) {
      const dependency = refKey(ref);
      const list = consumers.get(dependency) ?? [];
      list.push(key);
      consumers.set(dependency, list);
    }
  }
  for (let index = 0; index < queue.length; index++) {
    for (const key of consumers.get(queue[index]) ?? []) {
      if (!affected.has(key)) { affected.add(key); queue.push(key); }
    }
  }
  return affected;
}

export function assertRefusalSelection(state: ContextState): void {
  const affected = refusalAffected(state);
  if (state.selected.some(ref => affected.has(refKey(ref)))) {
    throw new AppError(422, 'summary_refusal_review', message('refusals.resolve_before_using_memory'));
  }
}

export function assertCleanSummaryInput(node: SummaryNode): void {
  if (unresolvedRefusal(node)) throw new AppError(422, 'summary_refusal_source', message('refusals.resolve_source_first'));
}
