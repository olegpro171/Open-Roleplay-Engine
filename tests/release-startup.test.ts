import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

it('starts an incomplete selected app through retained startup tooling while preserving its established database identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'ORE retained startup-история-')); directories.push(root);
  const home = join(root, 'ORE'), app = join(home, 'app/release-selected'), tools = join(app, 'scripts/release');
  const recovery = join(home, 'recovery/release-retained');
  for (const directory of ['dist/client', 'dist/server/server', 'migrations']) mkdirSync(join(app, directory), { recursive: true });
  cpSync(resolve('scripts/release'), tools, { recursive: true });
  cpSync(resolve('scripts/release'), recovery, { recursive: true });
  symlinkSync(resolve('node_modules'), join(app, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  writeFileSync(join(app, 'package.json'), '{"type":"module"}');
  const info = { kind: 'release', commit: 'a'.repeat(40), schema: 13, node: process.versions.node, platform: process.platform, arch: process.arch };
  const runtime = `node-v${process.versions.node}-${process.platform}-${process.arch}`;
  writeFileSync(join(app, 'build-info.json'), JSON.stringify(info));
  const observed = join(root, 'database-observed.json');
  writeFileSync(join(app, 'dist/server/server/main.js'), `
import {createRequire} from 'node:module';import {writeFileSync} from 'node:fs';
const Database=createRequire(import.meta.url)('better-sqlite3');
const db=new Database(process.env.ROLEPLAY_DATABASE,{readonly:true,fileMustExist:true});
writeFileSync(${JSON.stringify(observed)},JSON.stringify({path:process.env.ROLEPLAY_DATABASE,mustExist:process.env.ORE_DATABASE_MUST_EXIST,story:db.prepare('SELECT text FROM sentinel').pluck().get()}));
db.close();
${releaseServer}`);
  writeFileSync(join(app, 'dist/server/server/picture-worker.js'), '');
  writeFileSync(join(app, 'dist/client/index.html'), '<title>ORE</title>');
  writeFileSync(join(app, 'migrations/0014_library_sorting.sql'), '');
  const files = ['dist/server/server/main.js', 'dist/server/server/picture-worker.js', 'dist/client/index.html', 'migrations/0014_library_sorting.sql'].map(path => ({ path, sha256: createHash('sha256').update(readFileSync(join(app, path))).digest('hex') }));
  writeFileSync(join(app, 'manifest.json'), JSON.stringify({ ...info, runtime, files }));
  writeFileSync(join(home, 'current'), `release-selected\n${runtime}\n`);
  const database = join(root, 'external-story.sqlite');
  const db = new Database(database); db.exec("CREATE TABLE sentinel(text TEXT); INSERT INTO sentinel VALUES ('retained story'); PRAGMA user_version=13;"); db.close();
  const state = { version: 1, default: { kind: 'external', path: database }, established: [{ kind: 'external', path: database }] };
  writeFileSync(join(home, 'database-location.json'), JSON.stringify(state));
  const before = readFileSync(database);
  rmSync(join(tools, 'check-database.mjs'));
  const run = (controller: string) => {
    const env: NodeJS.ProcessEnv = { ...process.env, ROLEPLAY_PORT: '0', ORE_OPEN_BROWSER: '0' };
    for (const key of ['ROLEPLAY_DATABASE', 'ORE_PACKAGE_LEASE_HOME', 'ORE_LAUNCH_REPORT', 'ORE_LAUNCH_LOCK_TOKEN', 'ORE_LAUNCH_EVENTS', 'ORE_WINDOWS_BUILD_EVENTS']) delete env[key];
    return spawnSync(process.execPath, ['--input-type=module', '-e', `
import {fork} from 'node:child_process';
const child=fork(process.argv[1],[process.argv[2],process.argv[3]],{execPath:process.execPath,execArgv:[],stdio:['ignore','inherit','inherit','ipc']});
let ready=false;
child.on('message',message=>{if(message?.type==='ready'){ready=true;child.disconnect();}});
child.once('error',error=>{console.error(error);process.exitCode=1;});
child.once('exit',code=>{process.exitCode=code===0&&ready?0:1;});
`, controller, home, app], { encoding: 'utf8', env, timeout: 15000 });
  };
  const incomplete = run(join(tools, 'portable-launch.mjs'));
  expect(incomplete.status).not.toBe(0); expect(existsSync(observed)).toBe(false);
  const recovered = run(join(recovery, 'portable-launch.mjs'));
  expect(recovered.status, recovered.stdout + recovered.stderr).toBe(0);
  expect(JSON.parse(readFileSync(observed, 'utf8'))).toEqual({ path: database, mustExist: '1', story: 'retained story' });
  expect(readFileSync(database)).toEqual(before);
  expect(JSON.parse(readFileSync(join(home, 'database-location.json'), 'utf8'))).toEqual(state);
  expect(existsSync(join(home, 'data/roleplay.sqlite'))).toBe(false);
  const upgraded = new Database(database); upgraded.pragma('user_version=14'); upgraded.close();
  const incompatible = run(join(recovery, 'portable-launch.mjs'));
  expect(incompatible.status).not.toBe(0);
  const reports = readdirSync(join(home, 'logs')).map(name => readFileSync(join(home, 'logs', name), 'utf8')).join('\n');
  expect(reports).toContain('Database schema 14 is not supported by this application (maximum 13)');
  expect(JSON.parse(readFileSync(join(home, 'database-location.json'), 'utf8'))).toEqual(state);
}, 30000);
