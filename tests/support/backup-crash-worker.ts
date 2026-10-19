import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { Store } from '../../src/persistence/store.js';
import { BackupStore } from '../../src/persistence/backup-store.js';

const database = process.argv[2], input = process.argv[3];
if (!database || !input) throw new Error('Missing synthetic crash fixture paths.');
const store = new Store(database), incoming = new Database(input,{ readonly: true });
store.sqlite.function('synthetic_crash',() => {
  process.stdout.write('crash-before-data-receipt\n');
  process.kill(process.pid,'SIGKILL');
});
store.sqlite.exec('CREATE TRIGGER synthetic_crash BEFORE INSERT ON data_commands BEGIN SELECT synthetic_crash(); END');
const backups = new BackupStore(store);
backups.commit({ requestId: randomUUID(),digest: '1'.repeat(64),token: backups.token,overwrite: true },incoming);
throw new Error('Crash injection did not run.');
