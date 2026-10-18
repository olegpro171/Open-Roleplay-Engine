import type { LoreDiagnostic, LorePlacement } from '../shared/lorebook.js';
import { AppError } from './errors.js';

export type LoreDirectives = {
  after?: number;
  every?: number;
  keepAfterMatch?: true;
  dontAfterMatch?: true;
  depth?: number;
  role?: 'system' | 'user' | 'assistant';
  scanDepth?: number;
  position?: LorePlacement;
  ignoreOnPressure?: true;
  additionalKeys: string[][];
  excludeKeys?: string[];
  dontActivate?: true;
  activate?: true;
};

type Directive = { name: string; value: string };
type ParsedValue = { apply: (value: LoreDirectives) => void; placement?: LorePlacement; depth?: number };
type PlacementCheck = (placement: LorePlacement, depth?: number) => boolean;
export type ParsedLoreDirectives = {
  text: string;
  values: LoreDirectives;
  diagnostics: LoreDiagnostic[];
  unavailablePlacement: boolean;
};

const flagNames = new Set(['keep_activate_after_match', 'dont_activate_after_match', 'ignore_on_max_context', 'dont_activate', 'activate']);
const unsupportedNames = new Set(['instruct_depth', 'reverse_depth', 'reverse_instruct_depth', 'instruct_scan_depth', 'is_greeting', 'is_user_icon', 'disable_ui_prompt']);
const supportedNames = new Set([...flagNames, 'activate_only_after', 'activate_only_every', 'depth', 'role', 'scan_depth', 'position', 'additional_keys', 'exclude_keys']);
const fieldPositions = new Set<LorePlacement>(['before_desc', 'after_desc', 'personality', 'scenario']);

function boundedInteger(text: string, minimum: number, maximum: number): number | null {
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : null;
}

function parsedValue(directive: Directive): ParsedValue | null {
  const { name, value } = directive;
  if (flagNames.has(name)) {
    if (value !== '') return null;
    switch (name) {
      case 'keep_activate_after_match': return { apply: result => { result.keepAfterMatch = true; } };
      case 'dont_activate_after_match': return { apply: result => { result.dontAfterMatch = true; } };
      case 'ignore_on_max_context': return { apply: result => { result.ignoreOnPressure = true; } };
      case 'dont_activate': return { apply: result => { result.dontActivate = true; } };
      case 'activate': return { apply: result => { result.activate = true; } };
    }
  }
  if (name === 'activate_only_after' || name === 'activate_only_every') {
    const count = boundedInteger(value, name === 'activate_only_every' ? 1 : 0, 1_000_000_000);
    if (count === null) return null;
    return { apply: result => { if (name === 'activate_only_after') result.after = count; else result.every = count; } };
  }
  if (name === 'depth' || name === 'scan_depth') {
    if (name === 'depth' && /^-\d+$/.test(value) && Number(value) >= -1000) return { placement: 'history', depth: 0, apply: result => { result.depth = 0; } };
    const depth = boundedInteger(value, 0, 1000);
    if (depth === null) return null;
    if (name === 'depth') return { placement: 'history', depth, apply: result => { result.depth = depth; } };
    return { apply: result => { result.scanDepth = depth; } };
  }
  if (name === 'role') {
    if (value !== 'system' && value !== 'user' && value !== 'assistant') return null;
    return { apply: result => { result.role = value; } };
  }
  if (name === 'position') {
    const position = [...fieldPositions].find(candidate => candidate === value);
    if (!position) return null;
    return { placement: position, apply: result => { result.position = position; } };
  }
  if (name === 'additional_keys' || name === 'exclude_keys') {
    const keys = value.split(',').map(key => key.trim());
    if (!value || keys.length > 64 || keys.some(key => !key || key.length > 2000)) return null;
    return { apply: result => { if (name === 'additional_keys') result.additionalKeys.push(keys); else result.excludeKeys = keys; } };
  }
  return null;
}

/** Parses only fixed directive syntax. Untrusted patterns are evaluated by the injected isolated matcher. */
export function parseLoreDirectives(content: string, entryId: string, placeable: PlacementCheck): ParsedLoreDirectives {
  const chains: Directive[][] = [];
  const prose: string[] = [];
  const orphanDiagnostics: LoreDiagnostic[] = [];
  let currentChain: Directive[] | null = null;
  let afterControl = false;
  let controlCount = 0;
  for (const line of content.split(/\r\n|\n|\r/)) {
    const control = /^\s*(@{2,})(.*)$/.exec(line);
    if (!control) {
      currentChain = null;
      if (afterControl && line.trim() === '') continue;
      afterControl = false;
      prose.push(line);
      continue;
    }
    if (++controlCount > 256) throw new AppError(422, 'lore_directive_limit', 'A lore entry exceeds the 256-directive safety limit. Reduce its control lines before sending.');
    while (prose.length && prose.at(-1)?.trim() === '') prose.pop();
    afterControl = true;
    const body = control[2].trim();
    const parsed = /^([a-zA-Z_]+)(?:\s+(.*))?$/.exec(body);
    const directive = { name: parsed?.[1] ?? body, value: parsed?.[2]?.trim() ?? '' };
    if (control[1] === '@@') {
      currentChain = [directive];
      chains.push(currentChain);
    } else if (control[1] === '@@@' && currentChain) currentChain.push(directive);
    else {
      // An orphan fallback remains control text and must never reach the model.
      orphanDiagnostics.push({ code: 'invalid_directive', entryId, message: 'An orphan fallback directive is inactive.' });
      currentChain = null;
    }
  }
  const values: LoreDirectives = { additionalKeys: [] };
  const diagnostics: LoreDiagnostic[] = [...orphanDiagnostics];
  const seen = new Set<string>();
  let unavailablePlacement = false;
  for (const chain of chains) {
    const seenBeforeChain = new Set(seen);
    let chainUnavailable = false;
    let selected = false;
    for (const directive of chain) {
      const { name } = directive;
      if (name !== 'additional_keys' && seenBeforeChain.has(name)) {
        diagnostics.push({ code: 'duplicate_directive', entryId, message: `Only the first @@${name} directive applies.` });
        continue;
      }
      seen.add(name);
      if (!supportedNames.has(name)) {
        diagnostics.push({ code: 'unsupported_directive', entryId, message: unsupportedNames.has(name) ? `@@${name} is unavailable in this chat environment; its fallback is considered.` : `Unknown @@${name} directive is inactive; its fallback is considered.` });
        continue;
      }
      const parsed = parsedValue(directive);
      if (!parsed) {
        diagnostics.push({ code: 'invalid_directive', entryId, message: `@@${name} has an invalid value; its fallback is considered.` });
        continue;
      }
      if (parsed.placement && !placeable(parsed.placement, parsed.depth)) {
        diagnostics.push({ code: 'unavailable_destination', entryId, message: `@@${name} has no enabled destination or active character field; its fallback is considered.` });
        chainUnavailable = true;
        continue;
      }
      parsed.apply(values);
      selected = true;
      break;
    }
    if (chainUnavailable && !selected) unavailablePlacement = true;
  }
  // Decorator-adjacent blank lines are removed; unrelated prose spacing is retained.

  const text = chains.length || orphanDiagnostics.length ? prose.join('\n').replace(/^\n+|\n+$/g, '') : content;
  return { text, values, diagnostics, unavailablePlacement: unavailablePlacement && values.position === undefined && values.depth === undefined };
}
