import { importedTurnSchema, replaceHistorySchema, type ImportedTurn } from '../shared/library.js';

// Iterate chunks rather than reading an entire export (which can contain large foreign memory snapshots).
export async function importChat(chunks: AsyncIterable<string>) {
  const turns: ImportedTurn[] = [];
  let buffer = '', lineNumber = 0, messages = 0, extraTurns = 0, total = 0, metadata = 0;
  function line(raw: string) {
    lineNumber++;
    if (raw.length > 8_000_000) throw new Error(`Line ${lineNumber}: export line exceeds 8 million characters.`);
    if (!raw.trim()) return;
    let value: unknown;
    try { value = JSON.parse(raw.replace(/^\uFEFF/, '')); } catch { throw new Error(`Line ${lineNumber}: invalid JSON. No messages have been replaced.`); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Line ${lineNumber}: expected a JSON object.`);
    const entry = value as Record<string, unknown>;
    if (!('mes' in entry)) {
      if (messages === 0 && metadata === 0 && ('chat_metadata' in entry || 'character_name' in entry || 'user_name' in entry)) { metadata++; return; }
      throw new Error(`Line ${lineNumber}: missing message text (mes).`);
    }
    if (entry.is_system === true || entry.role === 'system') throw new Error(`Line ${lineNumber}: system messages cannot be represented as roleplay turns.`);
    if (typeof entry.mes !== 'string' || typeof entry.is_user !== 'boolean') throw new Error(`Line ${lineNumber}: mes must be text and is_user must be a boolean.`);
    if (entry.mes.length > 100_000) throw new Error(`Line ${lineNumber}: message exceeds 100,000 characters.`);
    total += entry.mes.length; messages++;
    if (total > 20_000_000 || messages > 50_000) throw new Error('The active transcript is too large to import.');
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
    if (buffer.length > 8_000_000) throw new Error('An export line exceeds the 8 million character limit.');
  }
  if (buffer.trim()) line(buffer);
  replaceHistorySchema.parse({ revision: 0, turns });
  turns.forEach(t => importedTurnSchema.parse(t));
  return { turns, messages, extraTurns, metadata, characters: total };
}
