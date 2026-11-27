import type Database from 'better-sqlite3';
import { z } from 'zod';

// Used only on trusted disposable databases to reproduce the exact schema 20
// definition for backup validation and historical migration fixtures.
export function restoreLegacyGenerationSchema(db: Database.Database) {
  db.transaction(() => {
    db.exec('DROP TABLE composer_suggestion_sessions; DROP INDEX suggestion_history; ALTER TABLE generations DROP COLUMN suggestion_session');
    const definition = z.string().parse(db.prepare("SELECT sql FROM sqlite_master WHERE name='generations'").pluck().get())
      .replace('turn_id TEXT REFERENCES turns(id)', 'turn_id TEXT NOT NULL REFERENCES turns(id)');
    db.exec(`CREATE TEMP TABLE saved_generations AS SELECT rowid AS ordinal, * FROM generations;
      CREATE TEMP TABLE variant_links AS SELECT id, generation_id FROM response_variants WHERE generation_id IS NOT NULL;
      DROP TABLE generations`);
    db.exec(definition);
    const columns = z.array(z.string()).parse(db.prepare("SELECT name FROM pragma_table_info('generations')").pluck().all()).join(', ');
    db.exec(`INSERT INTO generations (rowid, ${columns}) SELECT ordinal, ${columns} FROM saved_generations;
      CREATE UNIQUE INDEX one_active_generation ON generations (chat_id) WHERE status = 'running';
      CREATE INDEX generation_chat ON generations (chat_id);
      UPDATE response_variants SET generation_id = variant_links.generation_id FROM variant_links WHERE variant_links.id = response_variants.id;
      DROP TABLE saved_generations; DROP TABLE variant_links`);
  })();
}
