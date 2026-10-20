import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { renameSync, rmSync, writeFileSync } from 'node:fs';

/** Ownership is held by the caller; migrations start only after this returns. */
export function savePreUpgradeSnapshot(sqlite: Database.Database, filename: string, version: number) {
  const destination = `${filename}.pre-schema-${version}-${Date.now()}-${randomUUID()}.sqlite`;
  const temporary = `${destination}.part`;
  // VACUUM INTO accepts an empty existing file, allowing private permissions
  // before SQLite writes any credentials. Only the completed snapshot is named.
  writeFileSync(temporary, '', { flag: 'wx', mode: 0o600 });
  try {
    sqlite.prepare('VACUUM INTO ?').run(temporary);
    const snapshot = new Database(temporary);
    try {
      // Process authority is not user data and must not block explicit restore.
      snapshot.prepare('DELETE FROM runtime_owner').run();
    } finally { snapshot.close(); }
    renameSync(temporary, destination);
  } finally { rmSync(temporary, { force: true }); }
}
