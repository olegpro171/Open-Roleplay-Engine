import { characterFields, type PromptPreset } from '../shared/library.js';

// Compatibility for callers without a selected preset. Changing factory prose
// must not add instructions to legacy inline-settings requests.
export function inlineSettingsPrompt(instructions: string): PromptPreset {
  return {
    name: 'Inline settings',
    blocks: [
      { id: 'instructions', name: 'Card system prompt', enabled: true, kind: 'marker', role: 'system', marker: 'card_system_prompt', fallback: instructions },
      { id: 'character', name: 'Character', enabled: true, kind: 'marker', role: 'system', marker: 'character', fields: [...characterFields] },
      { id: 'persona', name: 'Persona', enabled: true, kind: 'marker', role: 'system', marker: 'persona' },
      { id: 'summary', name: 'Summary', enabled: true, kind: 'marker', role: 'system', marker: 'summary' },
      { id: 'messages', name: 'Messages', enabled: true, kind: 'marker', role: 'system', marker: 'messages', allowDepthPrompt: true },
      { id: 'post-history', name: 'Card post-history instructions', enabled: true, kind: 'marker', role: 'system', marker: 'card_post_history_instructions', fallback: '' },
    ],
  };
}
