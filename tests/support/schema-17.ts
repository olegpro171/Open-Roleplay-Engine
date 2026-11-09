import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { defaultMigrationsDirectory } from '../../src/persistence/store.js';

// Call before adding pictures to the synthetic legacy database.
export function restoreLegacyPictureSchema(db: Database.Database, migrations = defaultMigrationsDirectory) {
  db.exec('DROP TABLE character_pictures; DROP TABLE picture_assets');
  db.exec(readFileSync(join(migrations, '0010_pictures.sql'), 'utf8'));
}
