import type { Message, Turn } from '../shared/contracts.js';
import { defaultPrompt, type PromptSources, type Saved } from '../shared/library.js';
import type { Lorebook, LoreDestination, LoreDiagnostic, LoreEntry, LoreEntryState, LoreOutcome, LorePlacement, LoreResolution, LoreScanMessage, LoreState } from '../shared/lorebook.js';
import { AppError } from './errors.js';
import { parseLoreDirectives, type LoreDirectives } from './lorebook-directives.js';
import { characterParts } from './character-prompt.js';
import { replaceNameMacros } from './names.js';
import { countInput } from './tokens.js';

export type LoreInput = {
  book: Saved<Lorebook>;
  turns: Turn[];
  sources: PromptSources;
  state: LoreState;
  pressure?: boolean;
};
export type RegexMatcher = (patterns: string[], texts: string[], caseSensitive: boolean) => Promise<{ matched: boolean; invalid?: string }>;

const MAX_RECURSION_ROUNDS = 32;
const MAX_SCAN_CHARACTERS = 20_000_000;
const MAX_REGEX_CHARACTER_CHECKS = 20_000_000;
const MAX_LITERAL_CHARACTER_CHECKS = 200_000_000;
const MAX_REGEX_TASKS = 4096;
const emptyMessageTokens = countInput([]).inputTokens;

/** Original nonblank parts only, in chronological role order, with a bounded backwards scan. */
export function loreScanMessages(turns: Turn[], depth: number): LoreScanMessage[] {
  const messages: LoreScanMessage[] = [];
  const limit = Math.min(1000, Math.max(0, Math.floor(depth)));
  for (let index = turns.length - 1; index >= 0 && messages.length < limit; index--) {
    const turn = turns[index];
    if (turn.complete && turn.assistant.text.trim() !== '') messages.push({ turnId: turn.id, partId: turn.assistant.id, revision: turn.assistant.revision, role: 'assistant', text: turn.assistant.text });
    if (messages.length < limit && turn.user.text.trim() !== '') messages.push({ turnId: turn.id, partId: turn.user.id, revision: turn.user.revision, role: 'user', text: turn.user.text });
  }
  return messages.reverse();
}

/** Versioned 64-bit noncryptographic identity over explicit semantic data, bounded by schema limits. */
export function semanticFingerprint(book: Lorebook, entry: LoreEntry): string {
  const directives = parseLoreDirectives(entry.content, entry.id, () => true).values;
  const serialized = JSON.stringify([
    'ore-lore-semantics-v1',
    entry.activationRevision ?? 0,
    directives.scanDepth ?? entry.scanDepth ?? book.scanDepth, book.tokenBudget, book.recursiveScanning,
    entry.keys, entry.secondaryKeys, entry.content, entry.enabled, entry.constant, entry.selective,
    entry.useRegex, entry.caseSensitive, entry.insertionOrder, entry.priority, entry.placement,
    entry.role, entry.depth,
  ]);
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < serialized.length; index++) {
    const code = serialized.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x5bd1e995);
    second ^= second >>> 13;
  }
  return `ore-lore-semantics-v1:${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}
export const loreEntryFingerprint = semanticFingerprint;

function normalizeLiteral(text: string, caseSensitive: boolean): string {
  const normalized = text.normalize('NFC');
  return caseSensitive ? normalized : normalized.toLowerCase();
}

function literalMatch(keys: string[], normalizedTexts: string[], caseSensitive: boolean): boolean {
  return keys.some(key => key.trim() !== '' && normalizedTexts.some(text => text.includes(normalizeLiteral(key, caseSensitive))));
}

type DestinationResolver = (placement: LorePlacement, depth?: number, role?: Message['role'] | null) => LoreDestination | null;
export function loreDestinationResolver(sources: PromptSources): DestinationResolver {
  const blocks = (sources.prompt ?? defaultPrompt).blocks.filter(block => block.enabled);
  const characterBlocks = blocks.flatMap(block => {
    const parts = characterParts(block, sources.character);
    return parts.length ? [{ block, parts }] : [];
  });
  const messages = blocks.find(block => block.kind === 'marker' && block.marker === 'messages');
  return (placement, depth = 0, role) => {
    if (placement === 'history') {
      return messages ? { anchorId: messages.id, placement, role: role ?? 'system', depth } : null;
    }
    const field = placement === 'before_desc' || placement === 'after_desc' ? 'description' : placement;
    let anchor;
    if (placement === 'before_char') anchor = characterBlocks[0];
    else if (placement === 'after_char') anchor = characterBlocks.at(-1);
    else anchor = characterBlocks.find(value => value.parts.some(part => part.field === field));
    return anchor ? { anchorId: anchor.block.id, placement, role: role ?? 'system', depth } : null;
  };
}

export function loreEntryLayout(entry: LoreEntry, destination: DestinationResolver) {
  const parsed = parseLoreDirectives(entry.content, entry.id, (placement, depth) => destination(placement, depth, entry.role) !== null);
  const directives = parsed.values;
  const placement = directives.position ?? (directives.depth !== undefined ? 'history' : entry.placement);
  const resolved = parsed.unavailablePlacement ? null : destination(placement, directives.depth ?? entry.depth, directives.role ?? entry.role);
  return { parsed, placement, destination: resolved };
}

type PreparedEntry = {
  entry: LoreEntry;
  sourceIndex: number;
  fingerprint: string;
  matches: number;
  text: string;
  directives: LoreDirectives;
  destination: LoreDestination | null;
  scanDepth: number;
  keys: string[];
  secondaryKeys: string[];
  additionalKeys: string[][];
  excludeKeys: string[];
  outcome: LoreOutcome;
  terminal: boolean;
};

function admissionOrder(left: PreparedEntry, right: PreparedEntry): number {
  const leftConstant = left.entry.constant && !left.entry.useRegex;
  const rightConstant = right.entry.constant && !right.entry.useRegex;
  return right.entry.priority - left.entry.priority || Number(rightConstant) - Number(leftConstant) || left.entry.insertionOrder - right.entry.insertionOrder || left.sourceIndex - right.sourceIndex;
}

function excludedReason(entry: PreparedEntry, assistantCount: number, pressure: boolean): string | null {
  if (!entry.entry.enabled) return 'disabled';
  if (entry.text.trim() === '') return 'empty_content';
  if (!entry.destination) return 'unavailable_destination';
  if (pressure && entry.directives.ignoreOnPressure) return 'pressure';
  if (entry.directives.dontAfterMatch && entry.matches >= 2) return 'dont_activate_after_match';
  if (entry.directives.activate) return null;
  if (entry.directives.dontActivate) return 'dont_activate';
  if (entry.directives.keepAfterMatch && entry.matches >= 2) return null;
  if (entry.directives.after !== undefined && assistantCount < entry.directives.after) return 'activate_only_after';
  if (entry.directives.every !== undefined && assistantCount % entry.directives.every !== 0) return 'activate_only_every';
  return null;
}

/** Pure request-local activation. Only the caller may commit its proposed admitted-entry delta. */
export async function resolveLore(input: LoreInput, matchRegex: RegexMatcher): Promise<LoreResolution> {
  const { book, sources, turns, state } = input;
  let assistantCount = 0;
  for (const turn of turns) {
    if (turn.complete && turn.assistant.text.trim() !== '') assistantCount++;
  }
  const destination = loreDestinationResolver(sources);
  const diagnostics: LoreDiagnostic[] = [];
  const resolveNames = (text: string) => replaceNameMacros(text, sources.persona?.name ?? 'You', sources.character?.name ?? 'Character');
  const prepared: PreparedEntry[] = book.entries.map((entry, sourceIndex) => {
    const layout = loreEntryLayout(entry, destination);
    const { parsed } = layout;
    diagnostics.push(...parsed.diagnostics);
    const directives = parsed.values;
    const fingerprint = semanticFingerprint(book, entry);
    const saved = Object.hasOwn(state.entries, entry.id) ? state.entries[entry.id] : undefined;
    const matches = saved?.fingerprint === fingerprint ? saved.matches : 0;
    const text = resolveNames(parsed.text);
    const keys = entry.keys.map(resolveNames);
    const secondaryKeys = entry.secondaryKeys.map(resolveNames);
    const additionalKeys = directives.additionalKeys.map(group => group.map(resolveNames));
    const excludeKeys = (directives.excludeKeys ?? []).map(resolveNames);
    const unknownMacros = new Set<string>();
    for (const value of [parsed.text, ...entry.keys, ...entry.secondaryKeys, ...directives.additionalKeys.flat(), ...(directives.excludeKeys ?? [])]) {
      for (const macro of value.matchAll(/{{([^{}]*)}}/g)) if (!/^\s*(char|user)\s*$/i.test(macro[1])) unknownMacros.add(macro[0]);
    }
    if (unknownMacros.size) diagnostics.push({ code: 'unsupported_macro', entryId: entry.id, message: `Only {{char}} and {{user}} resolve. ${unknownMacros.size} other macro${unknownMacros.size === 1 ? ' remains' : 's remain'} literal.` });
    const { placement, destination: resolvedDestination } = layout;
    if (!resolvedDestination) diagnostics.push({ code: 'unavailable_destination', entryId: entry.id, message: `Lore destination ${placement} requires its enabled, nonempty character field or Messages source. Unchecked Character fields are unavailable.` });
    if (directives.position && directives.depth !== undefined) diagnostics.push({ code: 'position_overrides_depth', entryId: entry.id, message: '@@position takes precedence over @@depth.' });
    const outcome: LoreOutcome = { id: entry.id, name: entry.name, status: 'excluded', reason: 'no_match', text, destination: resolvedDestination, tokens: 0, fingerprint };
    return { entry, sourceIndex, fingerprint, matches, text, directives, destination: resolvedDestination, scanDepth: directives.scanDepth ?? entry.scanDepth ?? book.scanDepth, keys, secondaryKeys, additionalKeys, excludeKeys, outcome, terminal: false };
  });
  const pressure = input.pressure === true;
  const admitted: PreparedEntry[] = [];
  let usedTokens = 0;
  const stateBefore: Record<string, LoreEntryState> = Object.fromEntries(Object.entries(state.entries).map(([id, value]) => [id, { ...value }]));
  const stateDelta = new Map<string, LoreEntryState>();
  for (const entry of prepared) {
    const reason = excludedReason(entry, assistantCount, pressure);
    if (reason) {
      entry.outcome.reason = reason;
      entry.terminal = true;
    }
  }
  const scanDepth = prepared.reduce((depth, entry) => {
    const forced = entry.directives.activate || entry.directives.keepAfterMatch && entry.matches >= 2;
    const needsScan = !entry.entry.constant || entry.entry.useRegex || entry.additionalKeys.length > 0 || entry.excludeKeys.length > 0;
    return entry.terminal || forced || !needsScan ? depth : Math.max(depth, entry.scanDepth);
  }, 0);
  const scan = loreScanMessages(turns, scanDepth);
  const scanTexts = scan.map(message => message.text);
  if (scanTexts.reduce((total, text) => total + text.length, 0) > MAX_SCAN_CHARACTERS) throw new AppError(422, 'lore_scan_limit', 'The lore scan exceeds the 20 million character safety limit. Lower the book or entry scan depth before retrying.');
  const normalizedScan = scanTexts.map(text => normalizeLiteral(text, true));
  const foldedScan = normalizedScan.map(text => text.toLowerCase());
  let literalCharacterChecks = 0;
  const matchesLiteral = (keys: string[], normalizedTexts: string[], caseSensitive: boolean): boolean => {
    literalCharacterChecks += keys.length * normalizedTexts.reduce((total, text) => total + text.length, 0);
    if (literalCharacterChecks > MAX_LITERAL_CHARACTER_CHECKS) throw new AppError(422, 'lore_match_work_limit', 'The lore keyword scan exceeds its bounded work limit. Reduce keys, scan depth or the recursive chain before retrying.');
    return literalMatch(keys, normalizedTexts, caseSensitive);
  };
  let regexCharacterChecks = 0;
  let regexTasks = 0;
  const matchesKeys = async (entry: PreparedEntry, keys: string[], texts: string[], normalizedTexts: string[]): Promise<boolean | null> => {
    if (!entry.entry.useRegex) return matchesLiteral(keys, normalizedTexts, entry.entry.caseSensitive);
    regexTasks++;
    regexCharacterChecks += keys.length * texts.reduce((total, text) => total + text.length, 0) + keys.reduce((total, key) => total + key.length, 0);
    if (regexTasks > MAX_REGEX_TASKS || regexCharacterChecks > MAX_REGEX_CHARACTER_CHECKS) throw new AppError(422, 'lore_regex_work_limit', 'The lore regex scan exceeds its bounded work limit. Reduce regex keys, scan depth or the recursive chain before retrying.');
    const result = await matchRegex(keys, texts, entry.entry.caseSensitive);
    if (result.invalid) {
      entry.outcome.reason = 'invalid_regex';
      entry.terminal = true;
      diagnostics.push({ code: 'invalid_regex', entryId: entry.entry.id, message: `An activation pattern is invalid: ${result.invalid}` });
      return null;
    }
    return result.matched;
  };
  for (let round = 0; ; round++) {
    const recursiveTexts = admitted.map(entry => entry.text);
    const normalizedRecursive = recursiveTexts.map(text => normalizeLiteral(text, true));
    const foldedRecursive = normalizedRecursive.map(text => text.toLowerCase());
    const candidates: PreparedEntry[] = [];
    for (const entry of prepared) {
      if (entry.terminal || entry.outcome.status === 'admitted') continue;
      const forced = entry.directives.activate || entry.directives.keepAfterMatch && entry.matches >= 2;
      let reason = forced ? entry.directives.activate ? 'activate' : 'keep_activate_after_match' : entry.entry.constant && !entry.entry.useRegex ? 'constant' : 'keyword';
      if (!forced) {
        const original = entry.scanDepth === 0 ? [] : scanTexts.slice(-entry.scanDepth);
        const originalNormalized = entry.scanDepth === 0 ? [] : (entry.entry.caseSensitive ? normalizedScan : foldedScan).slice(-entry.scanDepth);
        const texts = book.recursiveScanning ? [...original, ...recursiveTexts] : original;
        const normalizedTexts = book.recursiveScanning ? [...originalNormalized, ...(entry.entry.caseSensitive ? normalizedRecursive : foldedRecursive)] : originalNormalized;
        if (!entry.entry.constant || entry.entry.useRegex) {
          const primary = await matchesKeys(entry, entry.keys, texts, normalizedTexts);
          if (primary === null) continue;
          if (!primary) { entry.outcome.reason = 'no_match'; continue; }
          if (round > 0) reason = 'recursive_keyword';
          if (!entry.entry.useRegex && entry.entry.selective && !matchesLiteral(entry.secondaryKeys, normalizedTexts, entry.entry.caseSensitive)) { entry.outcome.reason = 'secondary_condition'; continue; }
        }
        let additionalMatch = true;
        for (const keys of entry.additionalKeys) {
          const matching = await matchesKeys(entry, keys, texts, normalizedTexts);
          if (matching === null || !matching) { additionalMatch = false; break; }
        }
        if (!additionalMatch) { if (!entry.terminal) entry.outcome.reason = 'additional_keys'; continue; }
        if (!entry.entry.useRegex && matchesLiteral(entry.excludeKeys, normalizedTexts, entry.entry.caseSensitive)) { entry.outcome.reason = 'exclude_keys'; continue; }
      }
      entry.outcome.reason = reason;
      if (!entry.destination) throw new AppError(500, 'lore_destination_invariant', 'An eligible lore entry lost its destination.');
      entry.outcome.tokens = countInput([{ role: entry.destination.role, content: entry.text }]).inputTokens - emptyMessageTokens;
      candidates.push(entry);
    }
    let added = 0;
    for (const entry of candidates.sort(admissionOrder)) {
      if (usedTokens + entry.outcome.tokens > book.tokenBudget) {
        entry.outcome.reason = 'cap';
        entry.terminal = true;
        continue;
      }
      if (round >= MAX_RECURSION_ROUNDS) throw new AppError(422, 'lore_recursion_limit', 'Lore activation exceeds the 32-round safety limit. Reduce the recursive chain or disable recursive scanning before retrying.');
      entry.outcome.status = 'admitted';
      usedTokens += entry.outcome.tokens;
      admitted.push(entry);
      stateDelta.set(entry.entry.id, { fingerprint: entry.fingerprint, matches: Math.min(Number.MAX_SAFE_INTEGER, entry.matches + 1) });
      added++;
    }
    if (!book.recursiveScanning || added === 0) break;
  }
  return {
    version: 'ore-lore-v1', book: { id: book.id, revision: book.revision, name: book.name }, epoch: state.epoch,
    settings: { scanDepth: book.scanDepth, tokenBudget: book.tokenBudget, recursiveScanning: book.recursiveScanning },
    scan: scan.map(({ text: _text, ...message }) => message), assistantCount,
    outcomes: prepared.sort((left, right) => left.entry.insertionOrder - right.entry.insertionOrder || left.sourceIndex - right.sourceIndex).map(entry => entry.outcome.status === 'admitted' ? entry.outcome : { ...entry.outcome, text: '' }),
    diagnostics, tokens: usedTokens, pressure, stateBefore, stateDelta: Object.fromEntries(stateDelta),
  };
}
