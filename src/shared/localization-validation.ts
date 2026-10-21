import { message, type LocalizedMessage, type MessageKey } from './localization.js';
import type { z } from 'zod';

const authored = new Map<string, MessageKey>(Object.entries({
  "Use a six-digit hex color.": "validation.use_a_six_digit_hex_color",
  "Use an HTTP(S) API base URL without credentials, query parameters, or a fragment.": "validation.use_an_http_s_api_base_url_without",
  "Reserved output must be smaller than the context window.": "validation.reserved_output_must_be_smaller_than_the_context",
  "Use a single line.": "validation.use_a_single_line",
  "Only Character supports a field selection.": "validation.only_character_supports_a_field_selection",
  "Character fields must be unique.": "validation.character_fields_must_be_unique",
  "Only card instruction markers support fallback text.": "validation.only_card_instruction_markers_support_fallback_text",
  "Only Messages permits character depth injection.": "validation.only_messages_permits_character_depth_injection",
  "Block identities must be unique.": "validation.block_identities_must_be_unique",
  "Use at most one enabled Messages marker.": "validation.use_at_most_one_enabled_messages_marker",
  "Use at most one enabled Summary marker.": "validation.use_at_most_one_enabled_summary_marker",
  "Only the final turn may await an assistant response.": "validation.only_the_final_turn_may_await_an_assistant",
  "The active transcript exceeds the 20 million character import limit.": "validation.the_active_transcript_exceeds_the_20_million_character",
  "Entry identities must be unique.": "validation.entry_identities_must_be_unique",
  "The normalized book exceeds its storage limit.": "validation.the_normalized_book_exceeds_its_storage_limit",
  "Invalid base64 file data.": "validation.invalid_base64_file_data",
  "Invalid base64 file length.": "validation.invalid_base64_file_length",
  "Moving a transcript window requires an anchor and revision.": "validation.moving_a_transcript_window_requires_an_anchor_and"
}));

export function validationMessage(issue: z.core.$ZodIssue): LocalizedMessage {
  const custom = authored.get(issue.message);
  if (custom) return message(custom);
  switch (issue.code) {
    case 'too_small': return message('validation.small', { minimum: String(issue.minimum) });
    case 'too_big': return message('validation.big', { maximum: String(issue.maximum) });
    case 'invalid_type': return message('validation.type', { expected: issue.expected });
    case 'invalid_format': return message('validation.format');
    case 'invalid_value': return message('validation.value');
    default: return message('validation.unknown');
  }
}
