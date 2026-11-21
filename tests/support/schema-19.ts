import type Database from 'better-sqlite3';

export function removeComposerDraftSchema(db: Database.Database) {
  db.exec('DROP TABLE IF EXISTS composer_drafts');
}
