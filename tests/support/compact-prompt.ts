import { defaultInstructions, characterFields, type PromptPreset } from '../../src/shared/library.js';

// Keep synthetic budget and placement scenarios independent of shipped prompt prose.
export const compactPrompt: PromptPreset = {
  name: 'Default prompt', blocks: [
    { id: 'instructions', name: 'Card system prompt', enabled: true, kind: 'marker', role: 'system', marker: 'card_system_prompt', fallback: defaultInstructions },
    { id: 'character', name: 'Character', enabled: true, kind: 'marker', role: 'system', marker: 'character', fields: [...characterFields] },
    { id: 'persona', name: 'Persona', enabled: true, kind: 'marker', role: 'system', marker: 'persona' },
    { id: 'summary', name: 'Summary', enabled: true, kind: 'marker', role: 'system', marker: 'summary' },
    { id: 'messages', name: 'Messages', enabled: true, kind: 'marker', role: 'system', marker: 'messages', allowDepthPrompt: true },
    { id: 'post-history', name: 'Card post-history instructions', enabled: true, kind: 'marker', role: 'system', marker: 'card_post_history_instructions', fallback: '' },
  ],
};
