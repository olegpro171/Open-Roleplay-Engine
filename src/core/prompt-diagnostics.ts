import { defaultPrompt, hasPromptMarker, type PromptSources } from '../shared/library.js';
import { cardInstructionFields, cardInstructionLabels, readCardInstruction, readCharacterDepthPrompt } from '../shared/card-instructions.js';
import type { PromptDiagnostic } from '../shared/prompt-diagnostics.js';
import { loreDestinationResolver, loreEntryLayout } from './lorebook.js';

/** Structural availability only: no keyword scanning, model calls or activation changes. */
export function promptDiagnostics(sources: PromptSources): PromptDiagnostic[] {
  const diagnostics: PromptDiagnostic[] = [];
  const preset = sources.prompt ?? defaultPrompt;
  const promptId = sources.prompt?.id ?? 'default';
  const card = sources.character;
  if (card) {
    for (const field of cardInstructionFields) {
      const value = readCardInstruction(card, field);
      if (!value.success) diagnostics.push({ code: `invalid_${field}`, target: 'characters', itemId: card.id, message: `${cardInstructionLabels[field]} is invalid. Edit the character to clear or replace it.` });
      if ((!value.success || value.data.trim()) && !hasPromptMarker(preset, field === 'system_prompt' ? 'card_system_prompt' : 'card_post_history_instructions')) {
        diagnostics.push({ code: `disabled_${field}`, target: 'prompts', itemId: promptId, message: `This character’s ${field === 'system_prompt' ? 'system prompt' : 'post-history instructions'} will not be sent. Enable ${cardInstructionLabels[field]} in the selected preset.` });
      }
    }
    const note = readCharacterDepthPrompt(card);
    if (!note.success) diagnostics.push({ code: 'invalid_depth_prompt', target: 'characters', itemId: card.id, message: 'This character’s depth note has invalid settings. Edit the character to clear or replace it.' });
    const messages = preset.blocks.find(block => block.enabled && block.kind === 'marker' && block.marker === 'messages');
    if ((!note.success || note.data.prompt.trim()) && (messages?.kind !== 'marker' || !messages.allowDepthPrompt)) {
      diagnostics.push({ code: 'disabled_depth_prompt', target: 'prompts', itemId: promptId, message: messages
        ? 'This character’s depth note will not be sent. Allow character depth prompt injection under Messages.'
        : 'This character’s depth note will not be sent because Messages is absent or disabled.' });
    }
  }
  if (sources.lorebook) {
    const destination = loreDestinationResolver(sources);
    const unavailable = sources.lorebook.entries.filter(entry => {
      if (!entry.enabled) return false;
      const layout = loreEntryLayout(entry, destination);
      return Boolean(layout.parsed.text.trim()) && !layout.destination;
    });
    if (unavailable.length) diagnostics.push({ code: 'unavailable_lore_destinations', target: 'lorebooks', itemId: sources.lorebook.id,
      message: `${unavailable.length} lorebook ${unavailable.length === 1 ? 'entry cannot' : 'entries cannot'} be inserted because the required character field or Messages source is absent, disabled, unchecked, or empty. Affected: ${unavailable.slice(0, 3).map(entry => entry.name || 'Unnamed entry').join(', ')}${unavailable.length > 3 ? ', …' : ''}.`,
    });
  }
  return diagnostics;
}
