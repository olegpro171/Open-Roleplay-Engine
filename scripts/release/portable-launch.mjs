import { createHash } from 'node:crypto';
import { fork, spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, accessSync, constants, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDatabase, recordDatabaseReady } from './database-location.mjs';
import { markWorking } from './selection.mjs';
import { inspectDatabase } from './check-database.mjs';

const application = resolve(process.argv[3] ?? resolve(dirname(fileURLToPath(import.meta.url)), '../..'));
const home = resolve(process.argv[2] ?? '');
const recoveryCommand = process.platform === 'win32' ? 'recover-app.bat' : 'recover.command (recover-app.command from source)';
let database;
console.log('[Start] Checking application files, runtime compatibility and saved database compatibility...');
try {
  if (process.env.ROLEPLAY_DATABASE !== undefined && !process.env.ROLEPLAY_DATABASE.trim()) throw new Error('ROLEPLAY_DATABASE must name a database file. Unset it to use the installation default.');
  for (const directory of ['data', 'cache', 'logs', 'languages']) {
    mkdirSync(resolve(home, directory), { recursive: true, mode: 0o700 });
    accessSync(resolve(home, directory), constants.W_OK);
  }
  for (const file of ['dist/server/server/main.js', 'dist/server/server/picture-worker.js', 'dist/client/index.html', 'migrations/0014_library_sorting.sql', 'build-info.json']) accessSync(resolve(application, file), constants.R_OK);
  const manifest = JSON.parse(readFileSync(resolve(application, 'manifest.json'), 'utf8'));
  if (!Array.isArray(manifest.files)) throw new Error('Installation manifest is missing its file list. Rebuild the application.');
  for (const file of manifest.files) {
    if (typeof file.path !== 'string' || (!file.path.startsWith('dist/') && !file.path.startsWith('migrations/'))) continue;
    if (file.path.split('/').some(part => part === '..' || part === '')) throw new Error('Invalid installation manifest path.');
    const actual = createHash('sha256').update(readFileSync(resolve(application, file.path))).digest('hex');
    if (actual !== file.sha256) throw new Error(`Application asset differs from its manifest: ${file.path}. Rebuild before starting.`);
  }
  database = resolveDatabase(home);
  const info = JSON.parse(readFileSync(resolve(application, 'build-info.json'), 'utf8'));
  if (info.node !== process.versions.node || info.platform !== process.platform || info.arch !== process.arch) throw new Error('Bundled runtime/OS/CPU does not match this application. Rebuild for this machine.');
  if (typeof info.commit !== 'string' || !/^[0-9a-f]{40}$/.test(info.commit)) throw new Error('Invalid application commit metadata.');
  if (!Number.isInteger(info.schema) || info.schema < 1) throw new Error('Invalid application schema metadata.');
  if (existsSync(database.path)) inspectDatabase(application, database.path, info.schema);
  console.log(`Starting ORE · commit ${info.commit}`);
} catch (error) {
  console.error(`ORE cannot start: ${error.message}\nNo alternative database was selected. Use ${recoveryCommand} --list / --previous to inspect and recover retained versions safely.`);
  process.exit(1);
}
const logPath = resolve(home, 'logs', `startup-${Date.now()}-${process.pid}.log`);
const log = createWriteStream(logPath, { flags: 'wx', mode: 0o600 });
console.log(`ORE log: ${logPath}`);
let failed = false;
let ready = false;
log.on('error', error => { failed = true; console.error(`Cannot write ORE log: ${error.message}`); child?.kill('SIGTERM'); });
let child;
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  if (child?.connected) child.disconnect();
}
// These cover a terminal close as well as Ctrl+C. Never kill a foreign PID.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, stop);
if (typeof process.send === 'function') process.once('disconnect', stop);
child = fork(resolve(application, 'dist/server/server/main.js'), [], {
  execPath: process.execPath, execArgv: [], cwd: application,
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  env: { ...process.env, ORE_PARENT_IPC: '1', ORE_HOME: home, ROLEPLAY_DATABASE: database.path, ORE_DATABASE_MUST_EXIST: database.mustExist ? '1' : '0', TMPDIR: resolve(home, 'cache'), TMP: resolve(home, 'cache'), TEMP: resolve(home, 'cache') },
});
child.stdout.on('data', bytes => { process.stdout.write(bytes); log.write(bytes); });
child.stderr.on('data', bytes => { process.stderr.write(bytes); log.write(bytes); });
child.once('error', error => { failed = true; console.error(`ORE could not launch: ${error.message}`); log.end(); process.exitCode = 1; if (process.connected) process.disconnect(); });
child.on('message', message => {
  if (stopping || message?.type !== 'ready' || typeof message.url !== 'string') return;
  try {
    recordDatabaseReady(home, database);
    markWorking(home, application);
    ready = true;
    process.send?.({ type: 'ready', url: message.url }, error => { if (error) stop(); });
  } catch (error) { failed = true; console.error(`Could not record successful startup: ${error.message}`); stop(); return; }
  console.log(`ORE is ready. Open ${message.url} in your browser.`);
  console.log('Keep this terminal window open while using ORE. Press Ctrl+C here to stop the app.');
  if (process.env.ORE_OPEN_BROWSER === '0') return;
  console.log('Opening your browser...');
  // Avoid cmd.exe parsing of a provider-independent URL on Windows.
  const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const browser = spawn(command, process.platform === 'win32' ? ['url.dll,FileProtocolHandler', message.url] : [message.url], { stdio: 'ignore' });
  browser.on('error', () => console.log(`Open ${message.url} in your browser.`));
  browser.unref();
});
child.once('exit', (code, signal) => {
  process.exitCode = failed || !ready ? 1 : code ?? (signal ? 1 : 0);
  if (!ready) console.error(`ORE did not become ready. No older code was launched automatically. Use ${recoveryCommand} --list / --previous; recovery checks the saved database schema first.`);
  log.end();
  if (process.connected) process.disconnect();
});
