import type { PromptPreset } from '../shared/library.js';

// Frozen factory value used only by the pre-v8 exact-default migrations.
export const legacyLorePrompt = {
  name: 'Default roleplay', blocks: [
    { id: 'instructions', name: 'Instructions', enabled: true, kind: 'text', role: 'system', text: 'Write the next response in this roleplay. Stay consistent with the established story.' },
    { id: 'lore-before', name: 'Lore before Character', enabled: true, kind: 'marker', role: 'system', marker: 'lore_before' },
    { id: 'character', name: 'Character', enabled: true, kind: 'marker', role: 'system', marker: 'character' },
    { id: 'lore-after', name: 'Lore after Character', enabled: true, kind: 'marker', role: 'system', marker: 'lore_after' },
    { id: 'persona', name: 'Persona', enabled: true, kind: 'marker', role: 'system', marker: 'persona' },
    { id: 'summary', name: 'Summary', enabled: true, kind: 'marker', role: 'system', marker: 'summary' },
    { id: 'lore-history', name: 'Lore in history', enabled: true, kind: 'marker', role: 'system', marker: 'lore_history' },
    { id: 'messages', name: 'Messages', enabled: true, kind: 'marker', role: 'system', marker: 'messages' },
  ],
};

/** Pre-card-instructions template: historical upgrades must never activate new sources. */
export const legacyRoleplayPrompt: PromptPreset = {
  name: 'Default roleplay', blocks: [
    { id: 'instructions', name: 'Instructions', enabled: true, kind: 'text', role: 'system', text: 'Write the next response in this roleplay. Stay consistent with the established story.' },
    { id: 'character', name: 'Character', enabled: true, kind: 'marker', role: 'system', marker: 'character', fields: ['name', 'description', 'personality', 'scenario', 'examples'] },
    { id: 'persona', name: 'Persona', enabled: true, kind: 'marker', role: 'system', marker: 'persona' },
    { id: 'summary', name: 'Summary', enabled: true, kind: 'marker', role: 'system', marker: 'summary' },
    { id: 'messages', name: 'Messages', enabled: true, kind: 'marker', role: 'system', marker: 'messages' },
  ],
};
