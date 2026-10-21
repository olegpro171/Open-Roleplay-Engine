import { removeSortingSchema } from './support/legacy-sorting.js';
import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync, fork } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store } from '../src/persistence/store.js';
import { startupPaths, applicationRoot, buildInfo, migrationsDirectory, validateInstalledAssets } from '../src/server/installation.js';
import { createApp } from '../src/server/app.js';

const directories: string[] = [];
const temporary = () => { const directory = mkdtempSync(join(tmpdir(), 'ORE space-история-')); directories.push(directory); return directory; };
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

it('anchors default installation paths independently of the invoking working directory', () => {
  const directory = temporary();
  const code = `import {Store} from ${JSON.stringify(pathToFileURL(resolve('src/persistence/store.ts')).href)}; import {createApp} from ${JSON.stringify(pathToFileURL(resolve('src/server/app.ts')).href)}; const {app}=await createApp({database: ${JSON.stringify(join(directory, 'saved.sqlite'))}}); await app.close();`;
  execFileSync(process.execPath, ['--import', pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href, '--input-type=module', '-e', code], { cwd: directory });
  const db = new Database(join(directory, 'saved.sqlite'), { readonly: true });
  try { expect(db.pragma('user_version', { simple: true })).toBe(15); } finally { db.close(); }
  expect(() => startupPaths({ ROLEPLAY_DATABASE: '' })).toThrow(/must name a database file/);
  expect(() => validateInstalledAssets({ ...startupPaths({}), staticDirectory: directory })).toThrow(/installation is incomplete/);
  expect(startupPaths({}).database).toBe(resolve(applicationRoot, 'data/roleplay.sqlite'));
  expect(startupPaths({ ORE_HOME: directory }).database).toBe(join(directory, 'data/roleplay.sqlite'));
  expect(startupPaths({ ORE_HOME: directory, ROLEPLAY_DATABASE: join(directory, 'explicit.sqlite') }).database).toBe(join(directory, 'explicit.sqlite'));
});

it('keeps source development independent of a compiled image worker and validates bad ports before opening data', () => {
  const directory = temporary();
  const result = execFileSync(process.execPath, ['--import', pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href, '--input-type=module', '-e', `try { await import(${JSON.stringify(pathToFileURL(resolve('src/server/main.ts')).href)}); } catch(error) { console.log(error.message); }`], { cwd: directory, env: { ...process.env, ROLEPLAY_PORT: 'invalid', ROLEPLAY_DATABASE: join(directory, 'unused.sqlite') }, encoding: 'utf8' });
  expect(result).toContain('ROLEPLAY_PORT must be an integer');
  expect(readdirSync(directory)).toEqual([]);
});

it('exits cleanly if its launcher disconnects before startup completes', async () => {
  const directory = temporary(), database = join(directory, 'startup.sqlite');
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
  const address = reservation.address();
  if (!address || typeof address === 'string') throw new Error('Missing isolated startup port.');
  const port = address.port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const child = fork(resolve('src/server/main.ts'), [], { cwd: directory, execArgv: ['--import', pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href], env: { ...process.env, ORE_PARENT_IPC: '1', ROLEPLAY_DATABASE: database, ROLEPLAY_HOST: '127.0.0.1', ROLEPLAY_PORT: String(port), ROLEPLAY_TLS_CERT: '', ROLEPLAY_TLS_KEY: '' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let output = ''; child.stderr?.on('data', bytes => { output += String(bytes); });
  const exit = new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Disconnected startup left a server running.')); }, 5000);
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
  });
  child.disconnect();
  expect(await exit, output).toBe(0);
  if (existsSync(database)) {
    const saved = new Database(database, { readonly: true });
    try { expect(saved.prepare('SELECT * FROM runtime_owner').all()).toEqual([]); } finally { saved.close(); }
  }
});

it('rejects a future schema without modifying its contents, ownership or journal mode', () => {
  const path = join(temporary(), 'future.sqlite');
  const db = new Database(path);
  db.exec("CREATE TABLE sentinel (text TEXT); INSERT INTO sentinel VALUES ('keep me'); PRAGMA user_version=999;"); db.close();
  const before = readFileSync(path);
  expect(() => new Store(path)).toThrow(/Unsupported database schema 999/);
  expect(readFileSync(path)).toEqual(before);
  expect(readdirSync(resolve(path, '..'))).toEqual(['future.sqlite']);
});

function oldDatabase(path: string) {
  const seed = new Store(path);
  seed.replaceHistory(seed.snapshot().revision, 'main', [{ user: 'Synthetic original input', assistant: 'Saved response', complete: true }]);
  const snapshot = seed.snapshot();
  seed.close();
  const legacy = new Database(path);
  legacy.pragma('journal_mode=WAL');
  legacy.pragma('wal_autocheckpoint=0');
  removeSortingSchema(legacy);
  legacy.exec('DROP TABLE data_commands; DROP TABLE dataset_state; PRAGMA user_version=12;');
  return { legacy, snapshot };
}

it('snapshots populated WAL data before upgrade and restores to a new filename', () => {
  const directory = temporary(), path = join(directory, 'chat.sqlite');
  const { legacy, snapshot } = oldDatabase(path);
  try {
    const upgraded = new Store(path);
    expect(upgraded.snapshot()).toEqual(snapshot);
    upgraded.close();
    const backups = readdirSync(directory).filter(name => name.startsWith('chat.sqlite.pre-schema-12-'));
    expect(backups).toHaveLength(1);
    const backupPath = join(directory, backups[0]);
    // Windows privacy is established by the enclosing user-owned directory ACL,
    // checked in native release acceptance; chmod does not establish that ACL.
    if (process.platform !== 'win32') expect(statSync(backupPath).mode & 0o777).toBe(0o600);
    const backup = new Database(backupPath, { readonly: true });
    expect(backup.pragma('user_version', { simple: true })).toBe(12);
    expect(backup.prepare('SELECT user_text, assistant_text FROM turns').get()).toEqual({ user_text: 'Synthetic original input', assistant_text: 'Saved response' });
    expect(backup.prepare("SELECT name FROM sqlite_master WHERE name='dataset_state'").get()).toBeUndefined();
    backup.close();
    const restoredPath = join(directory, 'restored.sqlite');
    cpSync(backupPath, restoredPath);
    const restored = new Store(restoredPath);
    expect(restored.snapshot()).toEqual(snapshot);
    restored.close();
  } finally { legacy.close(); }
});

it('keeps data and releases ownership after a migration fails, retaining its pre-upgrade snapshot', () => {
  const directory = temporary(), path = join(directory, 'broken.sqlite');
  const { legacy, snapshot } = oldDatabase(path); legacy.close();
  const migrations = join(directory, 'migrations'); cpSync(migrationsDirectory, migrations, { recursive: true });
  writeFileSync(join(migrations, '0013_data_management.sql'), 'INVALID SQL;');
  expect(() => new Store(path, migrations)).toThrow();
  const db = new Database(path);
  expect(db.pragma('user_version', { simple: true })).toBe(12);
  expect(db.prepare('SELECT * FROM runtime_owner').all()).toEqual([]);
  db.close();
  expect(readdirSync(directory).filter(name => name.includes('.pre-schema-12-'))).toHaveLength(1);
  const recovered = new Store(path);
  expect(recovered.snapshot()).toEqual(snapshot);
  recovered.close();
});

it('publishes safe authenticated build identity and labels source builds honestly', async () => {
  const { app } = await createApp({ database: join(temporary(), 'about.sqlite') });
  try {
    expect((await app.inject({ method: 'GET', url: '/api/about' })).statusCode).toBe(401);
    const setup = await app.inject({ method: 'POST', url: '/api/setup', headers: { origin: 'http://localhost', host: 'localhost' }, payload: { password: 'synthetic-release-password' } });
    const cookie = setup.cookies.map(value => `${value.name}=${value.value}`).join('; ');
    const about = await app.inject({ method: 'GET', url: '/api/about', headers: { host: 'localhost', cookie } });
    expect(about.statusCode).toBe(200);
    expect(about.json()).toEqual(buildInfo());
    expect(about.json()).toMatchObject({ kind: 'development', schema: 15, commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() });
    expect(Object.keys(about.json()).sort()).toEqual(['arch', 'commit', 'kind', 'node', 'platform', 'schema']);
  } finally { await app.close(); }
});

it('reads commit-only installed metadata and tolerates the retired version on retained installations', () => {
  const root = temporary();
  const info = { kind: 'release', commit: 'a'.repeat(40), schema: 15, node: process.versions.node, platform: process.platform, arch: process.arch };
  writeFileSync(join(root, 'build-info.json'), JSON.stringify(info));
  expect(buildInfo(root)).toEqual(info);
  writeFileSync(join(root, 'build-info.json'), JSON.stringify({ ...info, version: 'retired-label' }));
  expect(buildInfo(root)).toEqual(info);
  writeFileSync(join(root, 'build-info.json'), JSON.stringify({ ...info, commit: 'invalid' }));
  expect(() => buildInfo(root)).toThrow();
});

it('does not borrow a parent repository commit for an exported source folder', () => {
  const root = temporary();
  execFileSync('git', ['init', '-b', 'main', root]);
  writeFileSync(join(root, 'tracked.txt'), 'Synthetic source');
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '-m', 'Synthetic commit']);
  const commit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  expect(buildInfo(root).commit).toBe(commit);
  const exported = join(root, 'exported');
  mkdirSync(exported);
  expect(buildInfo(exported).commit).toBeNull();
  expect(buildInfo(temporary()).commit).toBeNull();
});
