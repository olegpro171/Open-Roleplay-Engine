import { restoreLegacyGenerationSchema } from '../../src/persistence/legacy-generation-schema.js';
import type Database from 'better-sqlite3';

export function removeComposerDraftSchema(db: Database.Database) {
  if (db.prepare("SELECT 1 FROM pragma_table_info('generations') WHERE name = 'suggestion_session'").get()) restoreLegacyGenerationSchema(db);
  db.exec('DROP TABLE IF EXISTS composer_drafts');
}
