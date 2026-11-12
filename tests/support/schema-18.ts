import type Database from 'better-sqlite3';

export function removeContinuationSchema(db: Database.Database) {
  if (db.prepare("SELECT 1 FROM pragma_table_info('generations') WHERE name = 'continuation_variant_id'").get()) {
    db.exec('ALTER TABLE generations DROP COLUMN continuation_variant_id');
  }
}
