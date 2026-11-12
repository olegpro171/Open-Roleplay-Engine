import type Database from 'better-sqlite3';
import { removeContinuationSchema } from './schema-18.js';

/** Reconstruct the shipped schema before turn pins for populated upgrade fixtures. */
export function removePinSchema(db: Database.Database) {
  removeContinuationSchema(db);
  db.exec('DROP INDEX turns_pinned; ALTER TABLE turns DROP COLUMN pinned');
}
