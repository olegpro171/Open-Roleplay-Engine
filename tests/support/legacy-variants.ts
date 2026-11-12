import { removeSortingSchema } from './legacy-sorting.js';
import type Database from 'better-sqlite3';

/** Build an actual pre-variant schema for the older migration fixtures. */
export function removeVariantSchema(db: Database.Database) {
  removeSortingSchema(db);
  db.exec('ALTER TABLE generations DROP COLUMN reasoning_text; DROP TABLE response_variants; ALTER TABLE turns DROP COLUMN selected_variant_id; ALTER TABLE generations DROP COLUMN kind; ALTER TABLE generations DROP COLUMN context_selection');
}

/** Compare every column that existed before migration 11. New fields have their own upgrade tests. */
export function legacyRows(db: Database.Database, table: string) {
  if (table === 'chats' && db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'chat_groups'").get()) {
    return db.prepare(`SELECT chats.id, chats.revision, json_patch(chat_groups.settings, chats.settings) AS settings
      FROM chats JOIN chat_groups ON chat_groups.id = chats.group_id ORDER BY chats.rowid`).all();
  }
  const added = table === 'summaries' ? ['fork_source_request'] : table === 'turns' ? ['selected_variant_id', 'message_at', 'pinned'] : table === 'generations' ? ['kind', 'context_selection', 'reasoning_text', 'error_message', 'continuation_variant_id'] : ['library', 'connections', 'chats'].includes(table) ? ['created_at', 'updated_at'] : [];
  const columns = db.prepare(`PRAGMA table_info("${table}")`).all();
  const names = columns.map(column => {
    if (typeof column !== 'object' || column === null || !('name' in column) || typeof column.name !== 'string') throw new Error('Missing fixture column');
    return column.name;
  }).filter(name => !added.includes(name));
  return db.prepare(`SELECT ${names.map(name => `"${name}"`).join(', ')} FROM "${table}" ORDER BY rowid`).all();
}
