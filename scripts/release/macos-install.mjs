import { spawn } from 'node:child_process';
import { closeSync, createReadStream, openSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyApplication } from './application-assets.mjs';
import { launcherMessage } from './launcher-messages.mjs';
import { releaseLostControllerLock } from './launcher-lock.mjs';

const [action, home, input, commit, report, language] = process.argv.slice(2);
if (action === 'verify') {
  const info = verifyApplication(input);
  if (info.kind !== 'release') throw new Error('Normal installation must select a release.');
  console.log(`Verified installed ${info.commit}; runtime ${info.node}; schema ${info.schema}`);
} else if (action === 'build') {
  await buildSnapshot();
} else throw new Error('Expected verify or build.');

async function buildSnapshot() {
  let fd;
  try {
    fd = openSync(report, 'a');
    writeSync(fd, `Build exact main ${commit}\n`);
  } catch { process.exit(74); }

  let cancelled = 0;
  let child;
  let forceStop;
  let logBroken = false;
  const parent = process.ppid;
  function record(value) {
    if (logBroken) return;
    try { writeSync(fd, value); }
    catch { logBroken = true; stop(74); }
  }
  function stop(code) {
    if (cancelled) return;
    cancelled = code;
    if (!child?.pid) return;
    function signalOwnedGroup(signal) {
      try { process.kill(-child.pid, signal); }
      catch (error) { if (error.code !== 'ESRCH') record(`${error.stack}\n`); }
    }
    signalOwnedGroup('SIGTERM');
    forceStop = setTimeout(() => signalOwnedGroup('SIGKILL'), 5000);
  }
  const monitor = setInterval(() => { if (process.ppid !== parent) stop(129); }, 500);
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129], ['SIGXFSZ', 74]]) {
    process.once(signal, () => stop(code));
  }
  let phase = 'buildingVersion';
  try {
    const digest = createHash('sha256');
    for await (const bytes of createReadStream(input)) digest.update(bytes);
    if (cancelled) return;
    const env = {
      ...process.env, ORE_LAUNCH_EVENTS: '1',
      ORE_SNAPSHOT_SOURCE: `https://github.com/olegpro171/Open-Roleplay-Engine/archive/${commit}.tar.gz`,
      ORE_SNAPSHOT_SHA256: digest.digest('hex'),
    };
    for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'BASH_ENV', 'ENV']) delete env[name];
    const builder = resolve(dirname(fileURLToPath(import.meta.url)), '../../build-portable.sh');
    child = spawn('/bin/bash', [builder, '--snapshot', commit, home, input], {
      detached: true, stdio: ['ignore', fd, fd, 'pipe'], env,
    });
    let events = '';
    child.stdio[3].setEncoding('utf8');
    child.stdio[3].on('data', bytes => {
      if (cancelled) return;
      events += bytes;
      if (events.length > 4096) { record('Oversized build status event.\n'); stop(1); return; }
      while (events.includes('\n')) {
        const end = events.indexOf('\n');
        const id = events.slice(0, end);
        events = events.slice(end + 1);
        const expected = phase === 'buildingVersion' ? 'checkingVersion' : phase === 'checkingVersion' ? 'activatingVersion' : null;
        if (id !== expected) { record('Unexpected build status transition.\n'); stop(1); return; }
        phase = id;
        record(`Phase ${id}\n`);
        if (!cancelled) console.log(launcherMessage(id, language));
      }
    });
    // close waits for the dedicated event pipe to drain as well as process exit.
    const status = await new Promise((accept, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => accept(code ?? (signal ? 143 : 1)));
    });
    record(`Build exit ${status}; phase ${phase}\n`);
    if (status === 0) process.exitCode = phase === 'activatingVersion' ? 0 : 1;
    else if ([75, 129, 130, 143].includes(status)) process.exitCode = status;
    else process.exitCode = phase === 'activatingVersion' ? 24 : status;
  } catch (error) {
    record(`${error.stack}\n`);
    process.exitCode = 1;
  } finally {
    clearInterval(monitor);
    clearTimeout(forceStop);
    try { releaseLostControllerLock(home, parent, process.env.ORE_LAUNCH_LOCK_TOKEN); }
    catch (error) {
      record(`Lock cleanup failed: ${error.stack}\n`);
      if (!process.exitCode) process.exitCode = 75;
    }
    process.exitCode = logBroken ? 74 : cancelled || process.exitCode;
    closeSync(fd);
  }
}
