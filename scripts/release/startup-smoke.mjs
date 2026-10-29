import { fork } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

export async function verifyStartup(application, executable, cache, launcher = join(application, 'scripts/release/portable-launch.mjs'), { timeoutMs = 60000 } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error('Startup timeout must be between 1 and 120000 milliseconds.');
  mkdirSync(cache, { recursive: true });
  const home = mkdtempSync(join(cache, 'startup-check-'));
  const reservation = createServer();
  let child;
  let exited = false;
  let exitCode;
  let output = '';
  let lastProgress = 'starting-launcher';
  let probeResult = 'Owned server has not reported readiness.';
  const started = performance.now();
  try {
    await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
    const address = reservation.address();
    if (!address || typeof address === 'string') throw new Error('Missing startup-check port.');
    await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
    const url = `http://127.0.0.1:${address.port}`;
    const env = { ...process.env, ORE_OPEN_BROWSER: '0', ORE_SKIP_UPDATE: '1', ORE_DATABASE_DEFAULT: 'installation', ROLEPLAY_DATABASE: join(home, 'data/roleplay.sqlite'), ROLEPLAY_HOST: '127.0.0.1', ROLEPLAY_PORT: String(address.port) };
    for (const key of ['ROLEPLAY_TLS_CERT', 'ROLEPLAY_TLS_KEY', 'ORE_DATABASE_MUST_EXIST', 'NODE_OPTIONS', 'NODE_PATH', 'ORE_LAUNCH_REPORT', 'ORE_LAUNCH_LOCK_TOKEN', 'ORE_LAUNCH_EVENTS', 'ORE_WINDOWS_BUILD_EVENTS']) delete env[key];
    child = fork(launcher, [home, application], { execPath: executable, execArgv: [], cwd: home, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    child.stdout.on('data', bytes => { output = (output+bytes).slice(-16000); });
    child.stderr.on('data', bytes => { output = (output+bytes).slice(-16000); });
    let ownedReady = false;
    child.on('message', value => {
      if (value?.type === 'ready' && value.url === url) ownedReady = true;
      if (value?.type === 'startup-progress' && typeof value.stage === 'string' && /^[a-z-]{1,80}$/u.test(value.stage)) lastProgress = value.stage;
    });
    child.once('error', error => { output += error.message; exited = true; exitCode = null; });
    child.once('exit', code => { exited = true; exitCode = code; });
    const deadline = performance.now() + timeoutMs;
    let ready = false;
    while (performance.now()<deadline && !exited) {
      // Requiring this owned child's ready IPC also protects against a port
      // reservation race accidentally probing an unrelated listening process.
      if (ownedReady) {
        try {
          const session = await fetch(`${url}/api/session`, { signal: AbortSignal.timeout(1000) });
          const body = await session.json();
          const page = await fetch(url, { signal: AbortSignal.timeout(1000) });
          const interfaceLoaded = (await page.text()).includes('<title>ORE</title>');
          probeResult = `Session HTTP ${session.status}; setupRequired=${body.setupRequired === true}; interface HTTP ${page.status}; interface title present=${interfaceLoaded}.`;
          if (session.ok && body.setupRequired === true && page.ok && interfaceLoaded) { ready = true; break; }
        } catch (error) { probeResult = `HTTP probe failed: ${error.message}`; }
      }
      await delay(25);
    }
    if (!ready) {
      const logs = join(home, 'logs');
      const details = existsSync(logs) ? readdirSync(logs).map(name => readFileSync(join(logs, name), 'utf8').slice(-16000)).join('\n') : '';
      throw new Error(`Application startup check failed${exited ? ` (exit ${exitCode})` : ' (timeout)'}. Previous selection retained.\nElapsed ${Math.round(performance.now() - started)} ms; last startup phase: ${lastProgress}; owned ready: ${ownedReady}. ${probeResult}\n${output}\n${details}`);
    }
    child.disconnect();
    const stopped = Date.now()+5000;
    while (!exited && Date.now()<stopped) await delay(20);
    if (!exited || exitCode !== 0) throw new Error(`Application startup check did not stop cleanly. Previous selection retained.\n${output}`);
  } finally {
    if (reservation.listening) await new Promise(resolve => reservation.close(resolve));
    if (child && !exited) {
      // Allow controller loss to cascade through application-start to the
      // server before forcing the controller to exit.
      if (child.connected) child.disconnect();
      const stopped = performance.now() + 5000;
      while (!exited && performance.now() < stopped) await delay(20);
    }
    if (child && !exited) {
      child.kill('SIGKILL');
      await new Promise(resolve => child.once('exit', resolve));
    }
    rmSync(home, { recursive: true, force: true });
  }
}
