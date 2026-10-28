import { fork, spawn } from 'node:child_process';
import { openSync, writeSync, closeSync, existsSync, mkdirSync, accessSync, constants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { finished } from 'node:stream/promises';
import { markWorking } from './selection.mjs';
import { verifyApplication } from './application-assets.mjs';
import { launcherMessage } from './launcher-messages.mjs';
import { releaseLostControllerLock } from './launcher-lock.mjs';

const application = resolve(process.argv[3] ?? resolve(dirname(fileURLToPath(import.meta.url)), '../..'));
const home = resolve(process.argv[2] ?? '');
const concise = typeof process.env.ORE_LAUNCH_REPORT === 'string';
const language = process.env.ORE_LAUNCH_LANGUAGE === 'ru' ? 'ru' : 'en';
let report;
let child;
let ready = false;
let stopping = false;
let failed = false;
let failureId = 'startupFailed';
let logBroken = false;
let browser;
const say = (id, params = {}) => console.log(launcherMessage(id, language, params));
function diagnostic(value) {
  if (logBroken) return false;
  try { writeSync(report, value); return true; }
  catch {
    logBroken = true; failed = true;
    say('logFailed');
    stop();
    return false;
  }
}
function assistance() {
  if (logBroken) return;
  say('assistance'); console.log(logPath);
}
function stop() {
  if (stopping) return;
  stopping = true;
  if (ready) say('stopping');
  if (child?.connected) child.disconnect();
  if (browser?.pid) browser.kill('SIGTERM');
}
const parent = process.ppid;
const monitor = setInterval(() => { if (process.ppid !== parent) stop(); }, 500);
monitor.unref();
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, stop);
if (process.platform !== 'win32') process.on('SIGXFSZ', () => {
  if (logBroken) return;
  logBroken = true; failed = true; say('logFailed'); stop();
});
if (typeof process.send === 'function') process.once('disconnect', stop);
const logPath = concise ? process.env.ORE_LAUNCH_REPORT : resolve(home, 'logs', `startup-${Date.now()}-${process.pid}.log`);
try {
  for (const directory of ['data', 'cache', 'logs', 'languages']) {
    mkdirSync(resolve(home, directory), { recursive: true, mode: 0o700 });
    accessSync(resolve(home, directory), constants.W_OK);
  }
  report = openSync(logPath, concise ? 'a' : 'wx', 0o600);
  writeSync(report, `Application startup ${application}; Node ${process.versions.node}\n`);
} catch {
  say('logFailed'); process.exit(74);
}
let legacyDatabase;
let recordLegacyReady = () => {};
try {
  const info = verifyApplication(application);
  if (!concise) console.log(`Starting ORE · commit ${info.commit}`);
  diagnostic(`Commit ${info.commit}; schema ${info.schema}; runtime ${info.node}\n`);
  // Retained old payloads lack application-start. This explicit compatibility
  // path preserves their recovery guards; new payloads own them at startup.
  if (!existsSync(resolve(application, 'scripts/release/application-start.mjs'))) {
    const { resolveDatabase, recordDatabaseReady } = await import('./database-location.mjs');
    const { inspectDatabase } = await import('./check-database.mjs');
    legacyDatabase = resolveDatabase(home);
    recordLegacyReady = () => recordDatabaseReady(home, legacyDatabase);
    if (existsSync(legacyDatabase.path)) inspectDatabase(application, legacyDatabase.path, info.schema);
  }
  if (logBroken) process.exit(74);
  say('starting');
  child = fork(resolve(application, legacyDatabase ? 'dist/server/server/main.js' : 'scripts/release/application-start.mjs'), legacyDatabase ? [] : [home, application], {
    execPath: process.execPath, execArgv: [], cwd: application,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, ORE_PARENT_IPC: '1', ORE_HOME: home, ...(legacyDatabase ? { ROLEPLAY_DATABASE: legacyDatabase.path, ORE_DATABASE_MUST_EXIST: legacyDatabase.mustExist ? '1' : '0' } : {}), TMPDIR: resolve(home, 'cache'), TMP: resolve(home, 'cache'), TEMP: resolve(home, 'cache') },
  });
  child.stdout.on('data', bytes => diagnostic(bytes));
  child.stderr.on('data', bytes => diagnostic(bytes));
  child.once('error', error => { failed = true; diagnostic(`${error.stack}\n`); });
  child.on('message', value => {
    if (stopping || !value || typeof value !== 'object') return;
    if (value.type === 'startup-error' && ['alreadyRunning', 'portConflict'].includes(value.id)) { failureId = value.id; return; }
    if (ready || value.type !== 'ready' || typeof value.url !== 'string') return;
    // Ready URLs are server-generated loopback/TLS endpoints. Reject control
    // characters instead of allowing a child to inject Terminal instructions.
    let url;
    try {
      url = new URL(value.url);
      if (!['http:', 'https:'].includes(url.protocol) || /[\x00-\x20\x7f]/u.test(value.url) || url.username || url.password) throw new Error('Invalid ready URL.');
      if (legacyDatabase) {
        recordLegacyReady();
      }
      markWorking(home, application);
      if (!diagnostic(`Ready ${value.url}\n`)) return;
      ready = true;
      process.send?.({ type: 'ready', url: value.url }, error => { if (error) stop(); });
    } catch (error) { failed = true; diagnostic(`${error.stack}\n`); stop(); return; }
    say('ready'); say('openUrl', { url: value.url }); console.log('');
    say('keepWindow'); say('stopHint');
    if (process.env.ORE_OPEN_BROWSER === '0') return;
    say('openingBrowser');
    const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    browser = spawn(command, process.platform === 'win32' ? ['url.dll,FileProtocolHandler', value.url] : [value.url], { stdio: 'ignore' });
    let reported = false;
    function browserFailed(cause) {
      if (reported || stopping) return;
      reported = true; diagnostic(`Browser open failed: ${cause}\n`);
      say('browserFailed'); say('openUrl', { url: value.url });
    }
    browser.once('error', error => browserFailed(error.message));
    browser.once('exit', (code, signal) => { if (code !== 0) browserFailed(`exit ${code}, signal ${signal}`); });
  });
  const status = await new Promise((accept, reject) => { child.once('error', reject); child.once('exit', (code, signal) => accept(code ?? (signal ? 1 : 0))); });
  // Fork's IPC teardown is independent of stream completion. Drain both pipes
  // explicitly before closing the report, including the final failure bytes.
  await Promise.all([finished(child.stdout, { cleanup: true }), finished(child.stderr, { cleanup: true })]);
  process.exitCode = logBroken ? 74 : failed || !ready ? 1 : status;
  if (stopping && !ready && !failed) say('cancelled');
  else if (!ready || failed || status !== 0) {
    diagnostic(`Startup/server failure; exit ${status}. No older code was launched. Use recover.command --list / --previous for explicit compatible recovery.\n`);
    if (!logBroken) { say(failureId); assistance(); }
  } else say('stopped');
} catch (error) {
  diagnostic(`${error.stack}\nNo alternative database was selected. Use recover.command --list / --previous for explicit compatible recovery.\n`);
  if (!logBroken) {
    if (!concise) console.error(error.message);
    say('startupFailed'); assistance();
  }
  process.exitCode = logBroken ? 74 : 1;
} finally {
  stopping = true;
  if (browser?.pid && browser.exitCode === null && browser.signalCode === null) browser.kill('SIGTERM');
  clearInterval(monitor);
  try { releaseLostControllerLock(home, parent, process.env.ORE_LAUNCH_LOCK_TOKEN); }
  catch (error) { diagnostic(`Lock cleanup failed: ${error.stack}\n`); if (!process.exitCode) process.exitCode = 75; }
  if (report !== undefined) closeSync(report);
  if (process.connected) process.disconnect();
}
