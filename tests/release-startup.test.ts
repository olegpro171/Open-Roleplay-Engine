import { afterEach, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { releaseServer } from './support/release-server.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture(code: string) {
  const root = mkdtempSync(join(tmpdir(), 'ORE startup probe-история-')); directories.push(root);
  const cache = join(root, 'cache'), launcher = join(root, 'launcher.mjs');
  mkdirSync(cache); writeFileSync(launcher, code);
  const run = (options = '{}', env: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { verifyStartup } from ${JSON.stringify(pathToFileURL(resolve('scripts/release/startup-smoke.mjs')).href)};
    await verifyStartup(process.argv[1], process.execPath, process.argv[2], process.argv[3], ${options});
  `, root, cache, launcher], { encoding: 'utf8', timeout: 25000, env: { ...process.env, ...env } });
  return { root, cache, run };
}

it('allows a cold startup beyond the former fifteen-second deadline', () => {
  const f = fixture(`import {setTimeout as delay} from 'node:timers/promises'; await delay(16000); ${releaseServer}`);
  const result = f.run();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(readdirSync(f.cache)).toEqual([]);
}, 25000);

it('reports the last startup milestone when readiness never arrives and cleans up the probe', () => {
  const f = fixture(`process.send({type:'startup-progress',stage:'initializing-services'}); setInterval(()=>{},1000); process.on('disconnect',()=>process.exit(0));`);
  const result = f.run('{ timeoutMs: 250 }');
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('initializing-services');
  expect(result.stderr).toContain('timeout');
  expect(readdirSync(f.cache)).toEqual([]);
});

it('requires an actual interface after owned readiness and reports an unexpected HTTP response', () => {
  const f = fixture(releaseServer.replace("'<title>ORE</title>'", "'<title>Unexpected page</title>'"));
  const result = f.run('{ timeoutMs: 500 }');
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('owned ready: true');
  expect(result.stderr).toContain('interface title present=false');
  expect(readdirSync(f.cache)).toEqual([]);
});

it('isolates temporary startup reports from an inherited live-launch report', () => {
  const f = fixture(`
    if (process.env.ORE_LAUNCH_REPORT || process.env.ORE_LAUNCH_LOCK_TOKEN) throw new Error('Inherited live startup authority');
    ${releaseServer}`);
  const result = f.run('{}', { ORE_LAUNCH_REPORT: join(f.root, 'live-report.txt'), ORE_LAUNCH_LOCK_TOKEN: 'synthetic-live-token' });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(readdirSync(f.cache)).toEqual([]);
});
