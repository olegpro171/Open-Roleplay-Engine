import type Database from 'better-sqlite3';

/** Remove migrations 15 and 14 when reconstructing genuine historical schemas. */
export function removeSortingSchema(db: Database.Database) {
  db.exec('ALTER TABLE generations DROP COLUMN error_message');
  db.exec('DROP INDEX turn_message_date');
  for (const table of ['library', 'connections', 'chats']) {
    db.exec(`ALTER TABLE ${table} DROP COLUMN created_at; ALTER TABLE ${table} DROP COLUMN updated_at;`);
  }
  db.exec('ALTER TABLE turns DROP COLUMN message_at');
}
