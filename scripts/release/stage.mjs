import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyStartup } from './startup-smoke.mjs';
import { readSelection, writeSelection } from './selection.mjs';

const recoveryFiles = ['recover.mjs', 'database-location.mjs', 'selection.mjs', 'startup-smoke.mjs', 'check-database.mjs', 'portable-launch.mjs', 'update-and-start.sh', 'launcher-protocol'];

const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
export function inventory(root, directory = root) {
  return readdirSync(directory).sort().flatMap(name => {
    const path = join(directory, name), stat = lstatSync(path), entry = relative(root, path).split('\\').join('/');
    if (stat.isSymbolicLink()) {
      const link = readlinkSync(path), target = relative(root, resolve(dirname(path), link));
      if (isAbsolute(link) || target === '..' || target.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error(`External symlink forbidden: ${entry}`);
      return [{ path: entry, link }];
    }
    if (stat.isDirectory()) return inventory(root, path);
    if (!stat.isFile()) throw new Error(`Unsupported packaged file: ${entry}`);
    return [{ path: entry, sha256: hash(path), bytes: stat.size }];
  });
}
function packages(directory) {
  const result = [];
  for (const name of readdirSync(directory).sort()) {
    if (name.startsWith('.')) continue;
    const path = join(directory, name);
    if (name.startsWith('@')) { result.push(...packages(path)); continue; }
    if (!existsSync(join(path, 'package.json'))) continue;
    const pkg = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));
    result.push({ path, pkg });
    if (existsSync(join(path, 'node_modules'))) result.push(...packages(join(path, 'node_modules')));
  }
  return result;
}
function notices(work, output) {
  mkdirSync(output, { recursive: true });
  cpSync(join(work, 'scripts/release/third-party'), join(output, 'native-sources'), { recursive: true });
  const entries = packages(join(work, 'node_modules'));
  const listing = entries.map(({ pkg }) => ({ name: pkg.name, version: pkg.version, license: pkg.license ?? 'See package notices', repository: pkg.repository ?? null }));
  writeFileSync(join(output, 'packages.json'), JSON.stringify(listing, null, 2));
  for (const { path, pkg } of entries) {
    const directory = join(output, `${pkg.name.replaceAll('/', '__')}@${pkg.version}`);
    mkdirSync(directory, { recursive: true });
    // Some binary packages put their combined notices in README instead of LICENSE.
    for (const name of readdirSync(path).filter(name => /^(licen[cs]e|copying|notice|authors|readme)/i.test(name))) {
      if (lstatSync(join(path, name)).isFile()) cpSync(join(path, name), join(directory, name));
    }
    if (existsSync(join(path, 'versions.json'))) cpSync(join(path, 'versions.json'), join(directory, 'versions.json'));
  }
  writeFileSync(join(output, 'README.txt'), `ORE third-party inventory\n\npackages.json includes build-time UI packages as well as server packages. Their supplied license/notice/readme files accompany it. Node's full license and bundled component notices are in runtime/<version>/LICENSE.\n\nsharp/libvips native component versions and upstream combined notices are retained with the @img packages. Rebuilding/replacing those dynamic libraries is permitted by their licenses; ORE does not embed them into its executable. Source/build recipes: https://github.com/lovell/sharp-libvips/tree/v1.3.4 and the pinned versions.json. Full GPL/LGPL texts, exact native component source/patch URLs and the pinned build recipe are in native-sources/. No publication/signing is performed by these scripts.\n`);
}
async function install(work, home, mode, commit, runtime, runtimeChecksum, noticeDirectory) {
  const { databaseSchemaVersion } = await import(pathToFileURL(join(work, 'dist/server/shared/build-info.js')).href);
  const pkg = JSON.parse(readFileSync(join(work, 'package.json'), 'utf8'));
  const id = `${mode === '--release' ? 'release' : 'dev'}-${commit.slice(0, 12)}-${randomUUID()}`;
  const staging = join(home, 'cache', `payload-${id}`), application = join(home, 'app', id);
  mkdirSync(staging);
  try {
    for (const input of ['dist', 'migrations', 'package.json', 'package-lock.json', 'node_modules']) cpSync(join(work, input), join(staging, input), { recursive: true, verbatimSymlinks: true });
    mkdirSync(join(staging, 'scripts/release'), { recursive: true });
    for (const name of ['native-smoke.mjs', 'package-portable.mjs', 'stage.mjs', ...recoveryFiles]) cpSync(join(work, 'scripts/release', name), join(staging, 'scripts/release', name));
    cpSync(noticeDirectory, join(staging, 'notices'), { recursive: true, verbatimSymlinks: true });
    cpSync(join(work, 'docs/RELEASES.md'), join(staging, 'README.md'));
    for (const name of ['RELEASES.md', 'RELEASE_IMPLEMENTATION_BRIEF.md', 'RELEASE_VERIFICATION.md', 'WINDOWS_RELEASE_HANDOFF.md', 'TEST_RELEASE.md']) cpSync(join(work, 'docs', name), join(staging, name));
    const metadata = { kind: mode === '--release' ? 'release' : 'development', version: pkg.version, commit, schema: databaseSchemaVersion, node: process.versions.node, platform: process.platform, arch: process.arch };
    writeFileSync(join(staging, 'build-info.json'), JSON.stringify(metadata, null, 2));
    const smoke = spawnSync(process.execPath, [join(staging, 'scripts/release/native-smoke.mjs')], { cwd: home, stdio: 'inherit' });
    if (smoke.status !== 0) throw new Error('Production dependency smoke failed; previous application remains selected.');
    const manifest = { ...metadata, runtime, runtimeArchiveSha256: runtimeChecksum, lockfileSha256: hash(join(staging, 'package-lock.json')), files: inventory(staging) };
    writeFileSync(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2));
    await verifyStartup(staging, process.execPath, join(home, 'cache'));
    let previous = readSelection(home, 'working');
    if (previous && !existsSync(join(home, 'app', previous.id, 'scripts/release/portable-launch.mjs'))) previous = null;
    if (!previous) {
      const current = readSelection(home);
      if (current) {
        try {
          await verifyStartup(join(home, 'app', current.id), join(home, 'runtime', current.runtime, 'bin/node'), join(home, 'cache'), join(staging, 'scripts/release/portable-launch.mjs'));
          previous = current;
        } catch (error) { console.warn(`Previous selected application could not be verified; it was not marked working: ${error.message}`); }
      }
    }
    renameSync(staging, application);
    const toolkit = join(home, 'recovery', id);
    mkdirSync(toolkit, { recursive: true });
    for (const name of recoveryFiles) cpSync(join(application, 'scripts/release', name), join(toolkit, name));
    writeSelection(join(home, 'recovery'), 'current', { id, runtime });
    const recoveryLauncher = join(home, `recover-${randomUUID()}.tmp`);
    cpSync(join(work, 'scripts/release/recover.command'), recoveryLauncher);
    renameSync(recoveryLauncher, join(home, 'recover.command'));
    // Root launcher contract is stable; all evolving logic belongs to the versioned app.
    const launcher = join(home, `start-${randomUUID()}.tmp`);
    cpSync(join(work, 'scripts/release/start.command'), launcher);
    renameSync(launcher, join(home, 'start.command'));
    if (previous) writeSelection(home, 'previous', previous);
    writeSelection(home, 'current', { id, runtime });
    console.log(`Activated ${metadata.kind} ${commit}; schema ${metadata.schema}; manifest ${join(application, 'manifest.json')}`);
  } finally { rmSync(staging, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action, ...args] = process.argv.slice(2);
  if (action === 'notices') notices(...args);
  else if (action === 'install') await install(...args);
  else throw new Error('Expected notices or install.');
}
