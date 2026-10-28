// Application startup owns database resolution/compatibility and ready recording.
// The external updater and foreground controller never open saved SQLite data.
import { fork } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveDatabase, recordDatabaseReady } from './database-location.mjs';
import { inspectDatabase } from './check-database.mjs';

const [home, application] = process.argv.slice(2);
let child;
let stopping = !process.connected;
function stop() { stopping = true; if (child?.connected) child.disconnect(); }
function send(value) {
  if (!process.connected) { stop(); return; }
  process.send?.(value, error => { if (error) stop(); });
}
process.once('disconnect', stop);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, stop);
try {
  const database = resolveDatabase(home);
  const establishedEnvironment = { ...process.env };
  delete establishedEnvironment.ORE_LAUNCH_REPORT;
  delete establishedEnvironment.ORE_LAUNCH_EVENTS;
  delete establishedEnvironment.ORE_LAUNCH_LOCK_TOKEN;
  const info = JSON.parse(readFileSync(resolve(application, 'build-info.json'), 'utf8'));
  if (existsSync(database.path)) inspectDatabase(application, database.path, info.schema);
  if (!stopping) {
    child = fork(resolve(application, 'dist/server/server/main.js'), [], {
      execPath: process.execPath, execArgv: [], cwd: application,
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      env: { ...establishedEnvironment, ORE_PARENT_IPC: '1', ORE_HOME: home, ROLEPLAY_DATABASE: database.path, ORE_DATABASE_MUST_EXIST: database.mustExist ? '1' : '0' },
    });
    child.on('message', value => {
      if (stopping || !value || typeof value !== 'object') return;
      if (value.type === 'startup-error') { send(value); return; }
      if (value.type !== 'ready' || typeof value.url !== 'string') return;
      try { recordDatabaseReady(home, database); send(value); }
      catch (error) { console.error(error.stack); process.exitCode = 1; stop(); }
    });
    child.once('error', error => { console.error(error.stack); process.exitCode = 1; if (process.connected) process.disconnect(); });
    child.once('exit', (code, signal) => { process.exitCode ||= code ?? (signal ? 1 : 0); if (process.connected) process.disconnect(); });
  }
} catch (error) {
  console.error(`${error.stack}\nNo alternative database was selected. Use recover.command --list / --previous for explicit compatible recovery.`);
  process.exitCode = 1;
  if (process.connected) process.disconnect();
}
