import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store } from '../src/persistence/store.js';
import { releaseServer } from './support/release-server.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function root() { const path = realpathSync(mkdtempSync(join(tmpdir(), 'ORE recovery-история-'))); roots.push(path); return path; }
const locationModule = JSON.stringify(pathToFileURL(resolve('scripts/release/database-location.mjs')).href);
function resolveLocation(home: string, database?: string, ready = false) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import {resolveDatabase,recordDatabaseReady} from ${locationModule}; const home=process.argv[1]; const env={ORE_DATABASE_DEFAULT:'repository',...(process.argv[2]?{ROLEPLAY_DATABASE:process.argv[2]}:{})}; const result=resolveDatabase(home,env); ${ready ? 'recordDatabaseReady(home,result);' : ''} console.log(JSON.stringify({path:result.path,mustExist:result.mustExist}));`, home, database ?? ''], { encoding: 'utf8' });
  return result;
}
function state(home: string) { return JSON.parse(readFileSync(join(home, 'database-location.json'), 'utf8')); }
function startupReports(home: string) { return readdirSync(join(home, 'logs')).map(name => readFileSync(join(home, 'logs', name), 'utf8')).join('\n'); }
function recoveryFixture() {
  const directory = root(), home = join(directory, 'ORE');
  mkdirSync(join(home, 'cache'), { recursive: true }); mkdirSync(join(home, 'data'));
  const runtime = `node-v${process.versions.node}-${process.platform}-${process.arch}`;
  mkdirSync(join(home, 'runtime', runtime, 'bin'), { recursive: true });
  if (process.platform === 'win32') linkSync(process.execPath, join(home, 'runtime', runtime, 'node.exe'));
  else symlinkSync(process.execPath, join(home, 'runtime', runtime, 'bin/node'));
  for (const id of ['release-current', 'release-previous']) {
    const app = join(home, 'app', id);
    for (const name of ['dist/client', 'dist/server/server', 'migrations', 'scripts']) mkdirSync(join(app, name), { recursive: true });
    cpSync(resolve('scripts/release'), join(app, 'scripts/release'), { recursive: true });
    // The target uses real native SQLite. Only its HTTP application is controlled.
    symlinkSync(resolve('node_modules'), join(app, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    writeFileSync(join(app, 'package.json'), '{"type":"module"}');
    const info = { kind: 'release', version: 'test', commit: 'a'.repeat(40), schema: 13, node: process.versions.node, platform: process.platform, arch: process.arch };
    writeFileSync(join(app, 'build-info.json'), JSON.stringify(info));
    writeFileSync(join(app, 'dist/client/index.html'), '<title>ORE</title>');
    writeFileSync(join(app, 'dist/server/server/main.js'), releaseServer);
    writeFileSync(join(app, 'dist/server/server/picture-worker.js'), '');
    writeFileSync(join(app, 'migrations/0014_library_sorting.sql'), '');
    const files = ['dist/client/index.html', 'dist/server/server/main.js', 'dist/server/server/picture-worker.js', 'migrations/0014_library_sorting.sql', 'build-info.json'].map(path => ({ path, sha256: createHash('sha256').update(readFileSync(join(app, path))).digest('hex') }));
    writeFileSync(join(app, 'manifest.json'), JSON.stringify({ ...info, runtime, files }));
  }
  const current = `release-current\n${runtime}\n`, previous = `release-previous\n${runtime}\n`;
  writeFileSync(join(home, 'current'), current); writeFileSync(join(home, 'previous'), previous);
  const path = join(home, 'data/roleplay.sqlite');
  const database = new Database(path); database.exec("CREATE TABLE sentinel (text TEXT); INSERT INTO sentinel VALUES ('preserve this story'); PRAGMA user_version=13;"); database.close();
  const run = (args: string[], env: NodeJS.ProcessEnv = {}) => {
    const environment = { ...process.env, ...env }; delete environment.ROLEPLAY_DATABASE;
    return spawnSync(process.execPath, [resolve('scripts/release/recover.mjs'), home, ...args], { encoding: 'utf8', env: { ...environment, ...env }, timeout: 20000 });
  };
  return { home, path, current, previous, run };
}

describe('database location identity and relocation', () => {
  it('resolves a repository default relative to its new folder and never recreates the old path', () => {
    const directory = root(), repository = join(directory, 'before'), home = join(repository, 'ore-portable');
    mkdirSync(home, { recursive: true }); mkdirSync(join(repository, 'data'));
    const path = join(repository, 'data/roleplay.sqlite'); writeFileSync(path, 'Synthetic existing story');
    expect(resolveLocation(home, undefined, true).status).toBe(0);
    const moved = join(directory, 'after'); renameSync(repository, moved);
    const result = resolveLocation(join(moved, 'ore-portable'));
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ path: join(moved, 'data/roleplay.sqlite'), mustExist: true });
    expect(existsSync(repository)).toBe(false); expect(readFileSync(join(moved, 'data/roleplay.sqlite'), 'utf8')).toBe('Synthetic existing story');
    expect(state(join(moved, 'ore-portable')).default).toEqual({ kind: 'repository' });
  });
  it('blocks a disappeared established external database but permits first-time explicit creation', () => {
    const directory = root(), home = join(directory, 'ORE'), external = join(directory, 'external.sqlite'); mkdirSync(home);
    const first = resolveLocation(home, external); expect(first.status).toBe(0); expect(JSON.parse(first.stdout).mustExist).toBe(false); expect(existsSync(external)).toBe(false);
    writeFileSync(external, 'Established synthetic data'); expect(resolveLocation(home, external, true).status).toBe(0);
    renameSync(external, external+'.retained');
    const missing = resolveLocation(home, external); expect(missing.status).not.toBe(0); expect(missing.stderr).toContain('Established database is missing');
    expect(existsSync(external)).toBe(false); expect(readFileSync(external+'.retained', 'utf8')).toBe('Established synthetic data');
  });
  it('stops ambiguous moved legacy metadata and supports explicit selection of the moved existing database', () => {
    const directory = root(), repository = join(directory, 'moved'), home = join(repository, 'ore-portable'); mkdirSync(home, { recursive: true }); mkdirSync(join(repository, 'data'));
    const missing = join(directory, 'original/data/roleplay.sqlite'); writeFileSync(join(home, 'database-path.txt'), missing+'\n');
    writeFileSync(join(repository, 'data/roleplay.sqlite'), 'Moved saved story');
    const before = resolveLocation(home); expect(before.status).not.toBe(0); expect(before.stderr).toContain('Legacy database path is ambiguous'); expect(existsSync(missing)).toBe(false);
    execFileSync(process.execPath, ['--input-type=module', '-e', `import {selectDatabase} from ${locationModule}; selectDatabase(process.argv[1],{kind:'repository'});`, home]);
    const after = resolveLocation(home); expect(after.status, after.stderr).toBe(0); expect(JSON.parse(after.stdout).path).toBe(join(repository, 'data/roleplay.sqlite'));
  });
  it('does not recreate a disappeared legacy default database', () => {
    const directory = root(), home = join(directory, 'ore-portable'); mkdirSync(home);
    const missing = join(directory, 'data/roleplay.sqlite');
    writeFileSync(join(home, 'database-path.txt'), missing+'\n');
    const result = resolveLocation(home);
    expect(result.status).not.toBe(0); expect(result.stderr).toContain('Established database is missing');
    expect(existsSync(missing)).toBe(false);
  });
  it('uses fileMustExist at the SQLite opening boundary even if an established file disappears after resolution', () => {
    const path = join(root(), 'missing-parent/saved.sqlite');
    expect(() => new Store(path, undefined, { mustExist: true })).toThrow();
    expect(existsSync(path)).toBe(false); expect(existsSync(join(path, '..'))).toBe(false);
  });
  it('rejects a concurrent database metadata writer without removing its lock or replacing known locations', () => {
    const home = root(); expect(resolveLocation(home).status).toBe(0);
    const before = readFileSync(join(home, 'database-location.json'));
    mkdirSync(join(home, 'cache/database-location.lock'));
    const blocked = resolveLocation(home, join(home, 'other.sqlite'));
    expect(blocked.status).not.toBe(0); expect(blocked.stderr).toContain('Another launcher owns database-location.lock');
    expect(readFileSync(join(home, 'database-location.json'))).toEqual(before); expect(existsSync(join(home, 'cache/database-location.lock'))).toBe(true);
  });
});

describe('explicit application recovery', () => {
  it('selects the previous startup-verified version without changing saved data and pauses automatic updates', () => {
    const f = recoveryFixture(), before = readFileSync(f.path);
    const result = f.run(['--previous']); expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(f.home, 'current'), 'utf8')).toBe(f.previous); expect(readFileSync(f.path)).toEqual(before);
    expect(existsSync(join(f.home, 'updates-paused'))).toBe(true);
    expect(f.run(['--resume-updates']).status).toBe(0); expect(existsSync(join(f.home, 'updates-paused'))).toBe(false);
  });
  it('refuses older code against a newer schema, but permits an explicitly chosen compatible restored copy', () => {
    const f = recoveryFixture(); const database = new Database(f.path); database.pragma('user_version=14'); database.close(); const before = readFileSync(f.path);
    const result = f.run(['--previous']); expect(result.status).not.toBe(0); expect(result.stderr).toContain('Database schema 14');
    expect(readFileSync(join(f.home, 'current'), 'utf8')).toBe(f.current); expect(readFileSync(f.path)).toEqual(before); expect(existsSync(join(f.home, 'updates-paused'))).toBe(false);
    const launch = spawnSync(process.execPath, [join(f.home, 'app/release-current/scripts/release/portable-launch.mjs'), f.home], { encoding: 'utf8', env: { ...process.env, ORE_DATABASE_DEFAULT: 'installation', ROLEPLAY_DATABASE: f.path, ORE_OPEN_BROWSER: '0' } });
    expect(launch.status).toBe(1); expect(startupReports(f.home)).toContain('Database schema 14'); expect(launch.stdout).not.toContain('Local:'); expect(readFileSync(f.path)).toEqual(before);
    const restored = join(f.home, 'data/restored-copy.sqlite');
    const copy = new Database(restored); copy.exec("CREATE TABLE sentinel (text TEXT); INSERT INTO sentinel VALUES ('older snapshot'); PRAGMA user_version=13;"); copy.close();
    const recovered = f.run(['--previous'], { ROLEPLAY_DATABASE: restored }); expect(recovered.status, recovered.stderr).toBe(0);
    expect(readFileSync(f.path)).toEqual(before); expect(readFileSync(join(f.home, 'current'), 'utf8')).toBe(f.previous);
  });
  it('keeps current schema guards after selecting an older payload without the new launcher protocol', () => {
    const f = recoveryFixture();
    const previousApp = join(f.home, 'app/release-previous');
    rmSync(join(previousApp, 'scripts/release/launcher-protocol'));
    writeFileSync(join(previousApp, 'scripts/release/portable-launch.mjs'), 'process.exit(42);');
    const toolkit = join(f.home, 'recovery/release-current');
    cpSync(resolve('scripts/release'), toolkit, { recursive: true });
    writeFileSync(join(f.home, 'recovery/current'), f.current);
    cpSync(resolve('scripts/release/start.command'), join(f.home, 'start.command'));
    if (process.platform === 'win32') {
      for (const name of ['start-windows.ps1', 'windows-common.ps1']) cpSync(resolve('scripts/release', name), join(f.home, name));
    }
    const recovered = f.run(['--previous']); expect(recovered.status, recovered.stderr).toBe(0);
    const database = new Database(f.path); database.pragma('user_version=14'); database.close();
    const launched = spawnSync(process.platform === 'win32' ? 'powershell.exe' : '/bin/bash', process.platform === 'win32' ? ['-NoProfile', '-ExecutionPolicy', 'RemoteSigned', '-File', join(f.home, 'start-windows.ps1')] : [join(f.home, 'start.command')], { encoding: 'utf8', env: { ...process.env, ORE_SKIP_UPDATE: '1', ORE_OPEN_BROWSER: '0', ROLEPLAY_DATABASE: f.path }, timeout: 20000 });
    expect(launched.status).toBe(1); expect(startupReports(f.home)).toContain('Database schema 14');
    expect(launched.stdout).not.toContain('Local:'); expect(readFileSync(join(f.home, 'current'), 'utf8')).toBe(f.previous);
  });
  it('rejects an active database owner and a retained app whose launcher fails without changing selection', () => {
    const f = recoveryFixture(), db = new Database(f.path);
    db.exec(`CREATE TABLE runtime_owner (process_id INTEGER); INSERT INTO runtime_owner VALUES (${process.pid});`); db.close();
    const owned = f.run(['--previous']); expect(owned.status).not.toBe(0); expect(owned.stderr).toContain('live owner'); expect(readFileSync(join(f.home, 'current'), 'utf8')).toBe(f.current);
    const stopped = new Database(f.path); stopped.exec('DELETE FROM runtime_owner'); stopped.close();
    writeFileSync(join(f.home, 'app/release-previous/scripts/release/portable-launch.mjs'), 'process.exit(0);');
    const broken = f.run(['--previous']); expect(broken.status).not.toBe(0); expect(broken.stderr).toContain('Application startup check failed'); expect(readFileSync(join(f.home, 'current'), 'utf8')).toBe(f.current);
    expect(existsSync(join(f.home, 'cache/update.lock'))).toBe(false); expect(existsSync(join(f.home, 'cache/build.lock'))).toBe(false);
  });
});
