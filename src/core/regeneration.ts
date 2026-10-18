import type { ChatSnapshot } from '../shared/contracts.js';
import { refKey } from '../shared/context.js';
import { hasPromptMarker } from '../shared/library.js';
import { AppError } from './errors.js';
import { summaryDependencies } from './context-corrections.js';

/** A request-local endpoint. The stored turn remains complete throughout. */
export function regenerationView(snapshot: ChatSnapshot): ChatSnapshot {
  const target = snapshot.turns.at(-1);
  if (!target?.complete) throw new AppError(409, 'no_completed_turn', 'Only the latest completed turn can be regenerated.');
  const turns = snapshot.turns.map(turn => turn.id === target.id
    ? { ...turn, complete: false, assistant: { ...turn.assistant, text: '' } } : turn);
  const earlier = new Set(turns.slice(0, -1).map(turn => turn.id));
  const nodes = new Map(snapshot.context.summaries.map(node => [refKey(node), node]));
  const checked = new Map<string, boolean>();
  const visiting = new Set<string>();
  const safe = (key: string): boolean => {
    const known = checked.get(key);
    if (known !== undefined) return known;
    const node = nodes.get(key);
    if (!node || visiting.has(key)) return false;
    visiting.add(key);
    const valid = node.turns.every(source => earlier.has(source.turnId)) && summaryDependencies(node).every(ref => safe(refKey(ref)));
    visiting.delete(key);
    checked.set(key, valid);
    return valid;
  };
  const summaries = snapshot.context.summaries.filter(node => safe(refKey(node)));
  if (hasPromptMarker(snapshot.sources.prompt, 'summary')) {
    const latest = new Map<string, typeof snapshot.context.summaries[number]>();
    for (const node of snapshot.context.summaries) if (node.approved && node.revision > (latest.get(node.id)?.revision ?? -1)) latest.set(node.id, node);
    if ([...latest.values()].some(node => node.manual && node.turns.some(source => source.turnId === target.id))) {
      throw new AppError(422, 'regeneration_correction_conflict', 'A manually corrected summary includes this response. Preserve that correction in the transcript and clear memory before regenerating this turn.');
    }
  }
  // Keep only the valid selected prefix. A parent crossing the endpoint cannot
  // be sliced; its retained children remain available for ordinary saved reuse.
  const selected = [];
  const archivedTurnIds: string[] = [];
  for (const ref of snapshot.context.selected) {
    const node = nodes.get(refKey(ref));
    if (!node || !safe(refKey(ref))) break;
    if (snapshot.context.preset && earlier.size - archivedTurnIds.length - node.turns.length < snapshot.context.preset.minTail) break;
    selected.push(ref);
    archivedTurnIds.push(...node.turns.map(source => source.turnId));
  }
  return { ...snapshot, turns, context: { ...snapshot.context, summaries, selected, archivedTurnIds },
    // Regeneration is a history replacement. Resolve matching from its input,
    // with fresh prior-match state, rather than counting the old response twice.
    loreState: { epoch: snapshot.loreState?.epoch ?? 0, entries: {} } };
}
