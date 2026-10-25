import { message } from '../shared/localization.js';
import { diagnosticMessage } from '../shared/localization.js';
import { defaultPrompt, hasPromptMarker, type PromptSources } from '../shared/library.js';
import { cardInstructionFields, cardInstructionLabels, readCardInstruction, readCharacterDepthPrompt } from '../shared/card-instructions.js';
import type { PromptDiagnostic } from '../shared/prompt-diagnostics.js';
import { loreDestinationResolver, loreEntryLayout } from './lorebook.js';
import type { AuthorNote } from '../shared/author-note.js';

/** Structural availability only: no keyword scanning, model calls or activation changes. */
export function promptDiagnostics(sources: PromptSources, authorNote?: AuthorNote): PromptDiagnostic[] {
  const diagnostics: PromptDiagnostic[] = [];
  const preset = sources.prompt ?? defaultPrompt;
  const promptId = sources.prompt?.id ?? 'default';
  const card = sources.character;
  if (authorNote?.prompt.trim() && !hasPromptMarker(preset, 'messages')) {
    diagnostics.push({ code: 'author_note_messages_missing', target: 'prompts', itemId: promptId,
      ...diagnosticMessage(message('author_note.messages_missing')) });
  }
  if (card) {
    for (const field of cardInstructionFields) {
      const value = readCardInstruction(card, field);
      if (!value.success) diagnostics.push({ code: `invalid_${field}`, target: 'characters', itemId: card.id, ...diagnosticMessage(message("interface.is_invalid_edit_the_character_to_clear_or", { value: String(cardInstructionLabels[field]) })) });
      if ((!value.success || value.data.trim()) && !hasPromptMarker(preset, field === 'system_prompt' ? 'card_system_prompt' : 'card_post_history_instructions')) {
        diagnostics.push({ code: `disabled_${field}`, target: 'prompts', itemId: promptId, ...diagnosticMessage(message("interface.this_character_s_will_not_be_sent_enable", { value: String(field === 'system_prompt' ? 'system prompt' : 'post-history instructions'), value2: String(cardInstructionLabels[field]) })) });
      }
    }
    const note = readCharacterDepthPrompt(card);
    if (!note.success) diagnostics.push({ code: 'invalid_depth_prompt', target: 'characters', itemId: card.id, ...diagnosticMessage(message("interface.this_character_s_depth_note_has_invalid_settings")) });
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
      ...diagnosticMessage(message("interface.lorebook_be_inserted_because_the_required_character_field", { length: String(unavailable.length), value: String(unavailable.length === 1 ? 'entry cannot' : 'entries cannot'), value2: String(unavailable.slice(0, 3).map(entry => entry.name || 'Unnamed entry').join(', ')), value3: String(unavailable.length > 3 ? ', …' : '') })),
    });
  }
  return diagnostics;
}
