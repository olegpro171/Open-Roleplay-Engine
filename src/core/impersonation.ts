import { AppError } from './errors.js';
import { modelText } from './model-text.js';
import { message } from '../shared/localization.js';
import { defaultImpersonateInstruction } from '../shared/default-prompt.js';
import { hasPromptMarker, type PromptBlock } from '../shared/library.js';
import type { EngineSnapshot } from '../shared/contracts.js';

// Project the request sources before preparation so every replay/measurement sees
// the same layout as the final provider request. Stored sources remain untouched.
export function impersonationView(snapshot: EngineSnapshot, draft: string): EngineSnapshot {
  const { prompt } = snapshot.sources;
  const markers = ['character', 'persona', 'summary', 'pinned_messages', 'messages'] as const;
  const blocks: PromptBlock[] = markers.filter(marker => marker !== 'summary' || hasPromptMarker(prompt, marker))
    .map(marker => ({ id: marker, name: marker, marker, role: 'system', enabled: true, kind: 'marker' }));
  return {
    ...snapshot,
    settings: { ...snapshot.settings, authorNote: undefined },
    sources: { ...snapshot.sources, lorebook: null, prompt: {
      id: prompt?.id ?? 'impersonate', revision: prompt?.revision ?? 0, name: 'Impersonate', blocks,
      impersonateInstruction: prompt?.impersonateInstruction,
    } },
    turnInstruction: { kind: 'impersonate', draft },
  };
}

export function impersonationInstruction(custom: string | undefined, draft: string, user: string, char: string) {
  const template = custom?.trim() ? custom : defaultImpersonateInstruction;
  const values: Record<string, string> = { draft, user, char };
  let length = template.length;
  const result = template.replace(/{{\s*(draft|user|char)\s*}}/gi, (match, key: string) => {
    const value = values[key.toLowerCase()];
    length += value.length - match.length;
    // Bound repeated insertions before allocating the expanded string.
    if (length > 4_000_000) throw new AppError(422, 'instruction_too_long', message('impersonate.instruction_length'));
    return value;
  });
  const content = modelText(result);
  if (!content.trim()) throw new AppError(422, 'empty_instruction', message('impersonate.empty_instruction'));
  return content;
}
