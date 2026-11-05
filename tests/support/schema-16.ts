import type Database from 'better-sqlite3';

/** Reconstruct the shipped schema before turn pins for populated upgrade fixtures. */
export function removePinSchema(db: Database.Database) {
  db.exec('DROP INDEX turns_pinned; ALTER TABLE turns DROP COLUMN pinned');
}
