// Load SQLite from the target application with its matching Node/native ABI.
// No WAL, migration, ownership or schema writes are allowed in this preflight.
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function inspectDatabase(application, path, maximum, checkOwner = false) {
  const Database = createRequire(resolve(application, 'package.json'))('better-sqlite3');
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const schema = db.pragma('user_version', { simple: true });
    if (!Number.isInteger(schema) || schema < 0 || schema > maximum) throw new Error(`Database schema ${schema} is not supported by this application (maximum ${maximum}). Restore a compatible pre-upgrade snapshot to a NEW filename, then explicitly select that copy. The database was not downgraded.`);
    const owners = checkOwner && db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='runtime_owner'").get();
    if (owners) {
      for (const row of db.prepare('SELECT process_id FROM runtime_owner').all()) {
        if (!Number.isInteger(row.process_id) || row.process_id < 1) throw new Error('Invalid database ownership record.');
        try { process.kill(row.process_id, 0); }
        catch (error) { if (error.code === 'ESRCH') continue; throw new Error('Cannot verify database ownership. Stop all ORE processes before recovery.'); }
        throw new Error('This database still has a live owner. Stop ORE before recovery.');
      }
    }
    return schema;
  } finally { db.close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [application, path, maximum] = process.argv.slice(2);
  try { console.log(`Database schema ${inspectDatabase(application, path, Number(maximum), true)} is compatible.`); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
