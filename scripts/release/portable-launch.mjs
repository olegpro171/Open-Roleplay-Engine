import { createHash } from 'node:crypto';
import { fork, spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, accessSync, constants, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const application = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const home = resolve(process.argv[2] ?? '');
try {
  if (process.env.ROLEPLAY_DATABASE !== undefined && !process.env.ROLEPLAY_DATABASE.trim()) throw new Error('ROLEPLAY_DATABASE must name a database file. Unset it to use the installation default.');
  for (const directory of ['data', 'cache', 'logs', 'languages']) {
    mkdirSync(resolve(home, directory), { recursive: true, mode: 0o700 });
    accessSync(resolve(home, directory), constants.W_OK);
  }
  for (const file of ['dist/server/server/main.js', 'dist/server/server/picture-worker.js', 'dist/client/index.html', 'migrations/0013_data_management.sql', 'build-info.json']) accessSync(resolve(application, file), constants.R_OK);
  const manifest = JSON.parse(readFileSync(resolve(application, 'manifest.json'), 'utf8'));
  if (!Array.isArray(manifest.files)) throw new Error('Installation manifest is missing its file list. Rebuild the application.');
  for (const file of manifest.files) {
    if (typeof file.path !== 'string' || (!file.path.startsWith('dist/') && !file.path.startsWith('migrations/'))) continue;
    if (file.path.split('/').some(part => part === '..' || part === '')) throw new Error('Invalid installation manifest path.');
    const actual = createHash('sha256').update(readFileSync(resolve(application, file.path))).digest('hex');
    if (actual !== file.sha256) throw new Error(`Application asset differs from its manifest: ${file.path}. Rebuild before starting.`);
  }
  const info = JSON.parse(readFileSync(resolve(application, 'build-info.json'), 'utf8'));
  if (info.node !== process.versions.node || info.platform !== process.platform || info.arch !== process.arch) throw new Error('Bundled runtime/OS/CPU does not match this application. Rebuild for this machine.');
} catch (error) {
  console.error(`ORE cannot start: ${error.message}\nUse a writable ORE directory or repair the installation. No alternative database was selected.`);
  process.exit(1);
}
const logPath = resolve(home, 'logs', `startup-${Date.now()}-${process.pid}.log`);
const log = createWriteStream(logPath, { flags: 'wx', mode: 0o600 });
console.log(`ORE log: ${logPath}`);
let failed = false;
log.on('error', error => { failed = true; console.error(`Cannot write ORE log: ${error.message}`); child?.kill('SIGTERM'); });
let child;
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  child?.kill('SIGTERM');
}
// These cover a terminal close as well as Ctrl+C. Never kill a foreign PID.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, stop);
child = fork(resolve(application, 'dist/server/server/main.js'), [], {
  execPath: process.execPath, execArgv: [], cwd: application,
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  env: { ...process.env, ORE_PARENT_IPC: '1', ORE_HOME: home, ROLEPLAY_DATABASE: process.env.ROLEPLAY_DATABASE ? resolve(process.env.ROLEPLAY_DATABASE) : resolve(home, 'data/roleplay.sqlite'), TMPDIR: resolve(home, 'cache'), TMP: resolve(home, 'cache'), TEMP: resolve(home, 'cache') },
});
child.stdout.on('data', bytes => { process.stdout.write(bytes); log.write(bytes); });
child.stderr.on('data', bytes => { process.stderr.write(bytes); log.write(bytes); });
child.once('error', error => { failed = true; console.error(`ORE could not launch: ${error.message}`); log.end(); process.exitCode = 1; });
child.on('message', message => {
  if (stopping || message?.type !== 'ready' || typeof message.url !== 'string') return;
  if (process.env.ORE_OPEN_BROWSER === '0') return;
  const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
  const browser = spawn(command, [message.url], { stdio: 'ignore' });
  browser.on('error', () => console.log(`Open ${message.url} in your browser.`));
  browser.unref();
});
child.once('exit', (code, signal) => {
  process.exitCode = failed ? 1 : code ?? (signal ? 1 : 0);
  log.end();
});
