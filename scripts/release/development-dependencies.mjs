// Local Windows development only. Release/Snapshot installs never use this cache.
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildPhase } from './build-timing.mjs';
import { publishRename } from './selection.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function assertCachePath(home, path) {
  const root = resolve(home);
  let cursor = resolve(path);
  if (!cursor.startsWith(root + '\\')) throw new Error('Development cache path escapes its installation.');
  while (cursor !== root) {
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error('Linked development cache paths are not supported.');
    cursor = dirname(cursor);
  }
}
function files(root, directory = root) {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Development dependencies must be real directories.');
  return readdirSync(directory).sort().flatMap(name => {
    const path = join(directory, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error('Linked entries are not supported in the development dependency cache.');
    if (stat.isDirectory()) return files(root, path);
    if (!stat.isFile()) throw new Error('Unsupported development dependency cache entry.');
    return [path.slice(root.length + 1).replaceAll('\\', '/')];
  });
}
function run(npm, args) {
  const result = spawnSync(process.execPath, [npm, ...args], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Dependency preparation failed (exit ${result.status}).`);
}
export async function prepareDevelopmentDependencies(npm, home, runtime, runtimeChecksum) {
  if (process.platform !== 'win32') throw new Error('Development dependency reuse targets Windows only.');
  const work = process.cwd();
  const key = digest(JSON.stringify([
    'development-dependencies-v1;ci;include=dev,optional;ignore-scripts', runtime, runtimeChecksum,
    digest(readFileSync('package.json')), digest(readFileSync('package-lock.json')),
    digest(readFileSync(fileURLToPath(import.meta.url))),
  ]));
  const cache = join(resolve(home), 'cache/development-dependencies');
  assertCachePath(home, cache);
  mkdirSync(cache, { recursive: true });
  const pointer = join(cache, `${key}.json`);
  assertCachePath(home, pointer);
  let selected;
  if (existsSync(pointer)) {
    selected = JSON.parse(readFileSync(pointer, 'utf8'));
    if (selected.key !== key || typeof selected.directory !== 'string' || !new RegExp(`^${key}-[a-f0-9-]{36}$`).test(selected.directory)) {
      throw new Error('Invalid development dependency cache identity.');
    }
  }
  const modules = join(work, 'node_modules');
  if (selected) assertCachePath(home, join(cache, selected.directory, 'node_modules'));
  if (!selected || !existsSync(join(cache, selected.directory, 'node_modules'))) {
    console.log('[Build] Installing locked build dependencies...');
    await buildPhase('install-locked-dependencies', () => run(npm, ['ci', '--include=dev', '--include=optional', '--ignore-scripts']));
    run(join(work, 'scripts/release/native-smoke.mjs'), []);
    await buildPhase('cache-development-dependencies', () => {
      const directory = `${key}-${randomUUID()}`;
      const target = join(cache, directory);
      mkdirSync(target);
      const names = files(modules);
      // Windows read-only attributes protect files shared by retained snapshots.
      // The native Vite config loader keeps build temporaries out of this tree.
      const expected = names.map(name => ({ path: name, sha256: digest(readFileSync(join(modules, name))) }));
      for (const name of names) chmodSync(join(modules, name), 0o444);
      publishRename(modules, join(target, 'node_modules'));
      selected = { key, directory, files: expected };
      const temporary = join(cache, `${key}-${randomUUID()}.tmp`);
      writeFileSync(temporary, JSON.stringify(selected), { flag: 'wx' });
      publishRename(temporary, pointer);
    });
  } else console.log('[Build] Reusing locked build dependencies...');
  await buildPhase('link-development-dependencies', () => {
    const source = join(cache, selected.directory, 'node_modules');
    symlinkSync(source, modules, 'junction');
    // Staging compares its complete dependency inventory with this ready cache
    // before activation. Files are hashed once, rather than at both boundaries.
    writeFileSync(join(work, '.development-dependencies.json'), JSON.stringify({ ...selected, modules: source }));
  });
  try { run(join(work, 'scripts/release/native-smoke.mjs'), []); }
  catch (error) {
    // Retain dependency generations used by older snapshots. Only retire this
    // cache index so an explicit retry installs a new generation.
    unlinkSync(pointer);
    throw error;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareDevelopmentDependencies(...process.argv.slice(2));
}
