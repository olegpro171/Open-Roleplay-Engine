import { message, MessageError } from '../shared/localization.js';
import { validationMessage } from '../shared/localization-validation.js';
import { importedTurnsSchema, transcriptEntryLimit, transcriptPartLimit, transcriptTextLimit, type ImportedTurn } from '../shared/library.js';

const lineLimit = 8_000_000;

// Iterate chunks rather than reading an entire export (which can contain large foreign memory snapshots).
export async function importChat(chunks: AsyncIterable<string>) {
  const turns: ImportedTurn[] = [];
  let buffer = '', lineNumber = 0, messages = 0, extraTurns = 0, total = 0, metadata = 0;
  function line(raw: string) {
    lineNumber++;
    if (raw.length > lineLimit) throw new MessageError(message("importErrors.line_export_line_exceeds_8_million_characters", { lineNumber: String(lineNumber) }));
    if (!raw.trim()) return;
    let value: unknown;
    try { value = JSON.parse(raw.replace(/^\uFEFF/, '')); } catch { throw new MessageError(message("importErrors.line_invalid_json", { lineNumber: String(lineNumber) })); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MessageError(message("importErrors.line_expected_a_json_object", { lineNumber: String(lineNumber) }));
    const entry = value as Record<string, unknown>;
    if (entry.is_group === true || typeof entry.group_id === 'string' || typeof entry.group_id === 'number' ||
        Array.isArray(entry.members) || (entry.is_user === false && typeof entry.original_avatar === 'string' && entry.original_avatar !== '')) {
      throw new MessageError(message('importErrors.line_group_chat', { lineNumber: String(lineNumber) }));
    }
    if (entry.is_system === true || entry.role === 'system') throw new MessageError(message("importErrors.line_system_messages_cannot_be_represented_as_roleplay", { lineNumber: String(lineNumber) }));
    if (!('mes' in entry)) {
      if (messages === 0 && metadata === 0 && ('chat_metadata' in entry || 'character_name' in entry || 'user_name' in entry)) { metadata++; return; }
      throw new MessageError(message("importErrors.line_missing_message_text_mes", { lineNumber: String(lineNumber) }));
    }
    if (typeof entry.mes !== 'string' || typeof entry.is_user !== 'boolean') throw new MessageError(message("importErrors.line_mes_must_be_text_and_is_user", { lineNumber: String(lineNumber) }));
    if (entry.mes.length > transcriptPartLimit) throw new MessageError(message("importErrors.line_message_exceeds_100_000_characters", { lineNumber: String(lineNumber) }));
    total += entry.mes.length; messages++;
    if (total > transcriptTextLimit || messages > transcriptEntryLimit) throw new MessageError(message("importErrors.the_active_transcript_is_too_large_to_import"));
    const last = turns.at(-1);
    if (entry.is_user) {
      if (last && !last.complete) { last.complete = true; extraTurns++; }
      turns.push({ user: entry.mes, assistant: '', complete: false });
    } else if (last && !last.complete) { last.assistant = entry.mes; last.complete = true; }
    else { turns.push({ user: '', assistant: entry.mes, complete: true }); if (messages > 1) extraTurns++; }
  }
  for await (const chunk of chunks) {
    buffer += chunk;
    let offset = 0, end: number;
    while ((end = buffer.indexOf('\n', offset)) !== -1) { line(buffer.slice(offset, end)); offset = end + 1; }
    buffer = buffer.slice(offset);
    if (buffer.length > lineLimit) throw new MessageError(message("importErrors.an_export_line_exceeds_the_8_million_character"));
  }
  if (buffer.trim()) line(buffer);
  if (!turns.length) throw new MessageError(message('importErrors.empty_transcript'));
  const parsed = importedTurnsSchema.safeParse(turns);
  const issue = parsed.error?.issues[0];
  if (issue) throw new MessageError(validationMessage(issue));
  return { turns, messages, extraTurns, metadata, characters: total };
}
