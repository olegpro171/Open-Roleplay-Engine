import type Database from 'better-sqlite3';

/** Build an actual pre-variant schema for the older migration fixtures. */
export function removeVariantSchema(db: Database.Database) {
  db.exec('ALTER TABLE generations DROP COLUMN reasoning_text; DROP TABLE response_variants; ALTER TABLE turns DROP COLUMN selected_variant_id; ALTER TABLE generations DROP COLUMN kind; ALTER TABLE generations DROP COLUMN context_selection');
}

/** Compare every column that existed before migration 11. New fields have their own upgrade tests. */
export function legacyRows(db: Database.Database, table: string) {
  const added = table === 'turns' ? ['selected_variant_id'] : table === 'generations' ? ['kind', 'context_selection', 'reasoning_text'] : [];
  const columns = db.prepare(`PRAGMA table_info("${table}")`).all();
  const names = columns.map(column => {
    if (typeof column !== 'object' || column === null || !('name' in column) || typeof column.name !== 'string') throw new Error('Missing fixture column');
    return column.name;
  }).filter(name => !added.includes(name));
  return db.prepare(`SELECT ${names.map(name => `"${name}"`).join(', ')} FROM "${table}" ORDER BY rowid`).all();
}
