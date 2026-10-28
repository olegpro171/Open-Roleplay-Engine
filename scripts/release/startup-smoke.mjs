import { fork } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

export async function verifyStartup(application, executable, cache, launcher = join(application, 'scripts/release/portable-launch.mjs')) {
  mkdirSync(cache, { recursive: true });
  const home = mkdtempSync(join(cache, 'startup-check-'));
  const reservation = createServer();
  let child;
  let exited = false;
  let exitCode;
  let output = '';
  try {
    await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
    const address = reservation.address();
    if (!address || typeof address === 'string') throw new Error('Missing startup-check port.');
    await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
    const url = `http://127.0.0.1:${address.port}`;
    const env = { ...process.env, ORE_OPEN_BROWSER: '0', ORE_SKIP_UPDATE: '1', ORE_DATABASE_DEFAULT: 'installation', ROLEPLAY_DATABASE: join(home, 'data/roleplay.sqlite'), ROLEPLAY_HOST: '127.0.0.1', ROLEPLAY_PORT: String(address.port) };
    for (const key of ['ROLEPLAY_TLS_CERT', 'ROLEPLAY_TLS_KEY', 'ORE_DATABASE_MUST_EXIST', 'NODE_OPTIONS', 'NODE_PATH']) delete env[key];
    child = fork(launcher, [home, application], { execPath: executable, execArgv: [], cwd: home, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    child.stdout.on('data', bytes => { output = (output+bytes).slice(-16000); });
    child.stderr.on('data', bytes => { output = (output+bytes).slice(-16000); });
    let ownedReady = false;
    child.on('message', value => { if (value?.type === 'ready' && value.url === url) ownedReady = true; });
    child.once('error', error => { output += error.message; exited = true; exitCode = null; });
    child.once('exit', code => { exited = true; exitCode = code; });
    const deadline = Date.now()+15000;
    let ready = false;
    while (Date.now()<deadline && !exited) {
      // Requiring this owned child's ready IPC also protects against a port
      // reservation race accidentally probing an unrelated listening process.
      if (ownedReady) {
        try {
          const session = await fetch(`${url}/api/session`, { signal: AbortSignal.timeout(1000) });
          const body = await session.json();
          const page = await fetch(url, { signal: AbortSignal.timeout(1000) });
          if (session.ok && body.setupRequired === true && page.ok && (await page.text()).includes('<title>ORE</title>')) { ready = true; break; }
        } catch { /* The owned server may still be becoming ready; deadline bounds retries. */ }
      }
      await delay(25);
    }
    if (!ready) {
      const logs = join(home, 'logs');
      const details = existsSync(logs) ? readdirSync(logs).map(name => readFileSync(join(logs, name), 'utf8').slice(-16000)).join('\n') : '';
      throw new Error(`Application startup check failed${exited ? ` (exit ${exitCode})` : ' (timeout)'}. Previous selection retained.\n${output}\n${details}`);
    }
    child.disconnect();
    const stopped = Date.now()+5000;
    while (!exited && Date.now()<stopped) await delay(20);
    if (!exited || exitCode !== 0) throw new Error(`Application startup check did not stop cleanly. Previous selection retained.\n${output}`);
  } finally {
    if (reservation.listening) await new Promise(resolve => reservation.close(resolve));
    if (child && !exited) {
      child.kill('SIGKILL');
      await new Promise(resolve => child.once('exit', resolve));
    }
    rmSync(home, { recursive: true, force: true });
  }
}
