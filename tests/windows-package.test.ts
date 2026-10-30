import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, cpSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { inventory } from '../scripts/release/stage.mjs';
import { installWindowsPackage, verifyWindowsPackage } from '../scripts/release/windows-package-install.mjs';

const roots: string[] = [];
const commit = 'a'.repeat(40), nextCommit = 'b'.repeat(40);
const runtime = 'node-v24.19.0-win32-x64';
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
 const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ORE-package-publication-'))); roots.push(root);
 const home = join(root, 'home'); mkdirSync(home);
 for (const directory of ['data', 'languages']) { mkdirSync(join(home, directory)); writeFileSync(join(home, directory, 'retained'), 'synthetic private content'); }
 for (const file of ['.env', 'database-location.json', 'updates-paused']) writeFileSync(join(home, file), 'retained '+file);
 function packageFor(sha = commit) {
  const payload = join(root, 'payload-'+sha), id = 'release-'+sha;
  for (const directory of ['data', 'languages', 'cache', 'logs', `app/${id}/scripts/release`, `runtime/${runtime}`, `recovery/${id}`]) mkdirSync(join(payload, directory), { recursive: true });
  const selection = `${id}\n${runtime}\n`;
  writeFileSync(join(payload, 'current'), selection); writeFileSync(join(payload, 'recovery/current'), selection);
  for (const file of ['start.command', 'recover.command', 'start-app.bat', 'recover-app.bat', 'start-windows.ps1', 'recover-windows.ps1', 'windows-common.ps1', 'windows-snapshot.ps1', 'windows-package-lock.ps1', 'windows-package.ps1', 'windows-standalone-common.ps1', 'README.md', 'LICENSE']) writeFileSync(join(payload, file), 'synthetic '+file);
  writeFileSync(join(payload, 'app', id, 'build-info.json'), JSON.stringify({ commit: sha, platform: 'win32', arch: 'x64', kind: 'release' }));
  writeFileSync(join(payload, 'runtime', runtime, 'node.exe'), 'synthetic runtime');
  for (const tools of [join(payload, 'app', id, 'scripts/release'), join(payload, 'recovery', id)]) {
   writeFileSync(join(tools, 'windows-package-protocol'), '2\n'); writeFileSync(join(tools, 'windows-package-launcher.ps1'), 'synthetic helper');
  }
  const seal = () => writeFileSync(join(payload, 'checksums.json'), JSON.stringify(inventory(payload).filter(file => file.path !== 'checksums.json')));
  seal(); return { payload, id, selection, seal };
 }
 return { root, home, packageFor };
}

describe('Windows package verification and atomic code publication', () => {
 it.skipIf(process.platform !== 'win32').each([1, 2])('validates a native inventory with %i files and rejects corruption and malformed inventories', count => {
  const f = fixture(), directory = join(f.root, 'inventory'); mkdirSync(directory);
  for (let index = 0; index < count; index++) writeFileSync(join(directory, `story-${index}.txt`), 'Synthetic saved story');
  const records = inventory(directory), checksumFile = join(directory, 'checksums.json');
  const save = (value: unknown) => writeFileSync(checksumFile, JSON.stringify(value));
  const run = () => spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'RemoteSigned', '-Command', "$ErrorActionPreference='Stop'; . $env:ORE_ZIP_TOOLS; . $env:ORE_PACKAGE_TOOLS; Test-OrePackageFiles $env:ORE_PACKAGE_DIRECTORY"], {
   encoding: 'utf8', timeout: 10000, env: { ...process.env, ORE_ZIP_TOOLS: resolve('scripts/release/windows-snapshot.ps1'), ORE_PACKAGE_TOOLS: resolve('scripts/release/windows-package.ps1'), ORE_PACKAGE_DIRECTORY: directory },
  });
  save(records);
  const valid = run(); expect(valid.status, valid.stdout+valid.stderr).toBe(0);
  writeFileSync(join(directory, 'story-0.txt'), 'Changed content');
  const changed = run(); expect(changed.status).not.toBe(0); expect(changed.stderr).toContain('Package file checksum mismatch');
  writeFileSync(join(directory, 'story-0.txt'), 'Synthetic saved story');
  writeFileSync(join(directory, 'unlisted.txt'), 'Unexpected content');
  const unlisted = run(); expect(unlisted.status).not.toBe(0); expect(unlisted.stderr).toContain('Unlisted package files');
  rmSync(join(directory, 'unlisted.txt'));
  for (const invalid of [records[0], [], [records], [...records, records[0]], records.map(record => ({ ...record, bytes: '21' }))]) {
   save(invalid);
   const rejected = run(); expect(rejected.status, JSON.stringify(invalid)+'\n'+rejected.stderr).not.toBe(0); expect(rejected.stderr).toMatch(/Invalid package file (inventory|record)/u);
  }
  expect(readFileSync(join(directory, 'story-0.txt'), 'utf8')).toBe('Synthetic saved story');
 }, 30000);
 it.skipIf(process.platform !== 'win32')('exports a ZIP that the strict native extractor accepts, preserving Unicode files and empty mutable directories', () => {
  const f = fixture(), p = f.packageFor(), app = join(p.payload, 'app', p.id);
  mkdirSync(join(app, 'nested'));
  writeFileSync(join(app, 'nested/story 漢.txt'), 'Synthetic Unicode story');
  writeFileSync(join(app, 'README.md'), 'Synthetic instructions'); writeFileSync(join(app, 'LICENSE'), 'Synthetic license');
  writeFileSync(join(app, 'manifest.json'), JSON.stringify({ commit, kind: 'release', platform: 'win32', arch: 'x64', files: inventory(app) }));
  writeFileSync(join(p.payload, 'data/saved.sqlite'), 'private synthetic data');
  writeFileSync(join(p.payload, '.env'), 'private synthetic configuration');
  const output = join(f.root, 'output');
  const packed = spawnSync(process.execPath, [resolve('scripts/release/package-portable.mjs'), p.payload, output], { encoding: 'utf8' });
  expect(packed.status, packed.stdout+packed.stderr).toBe(0);
  const name = `ORE-${commit.slice(0, 12)}-release-win32-x64`, extracted = join(f.root, 'extracted');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'RemoteSigned', '-Command', "$ErrorActionPreference='Stop'; . $env:ORE_ZIP_TOOLS; Expand-OreZip $env:ORE_ZIP_ARCHIVE $env:ORE_ZIP_ROOT $env:ORE_ZIP_DESTINATION -LongPaths"], {
   encoding: 'utf8', env: { ...process.env, ORE_ZIP_TOOLS: resolve('scripts/release/windows-snapshot.ps1'), ORE_ZIP_ARCHIVE: join(output, name+'.zip'), ORE_ZIP_ROOT: name, ORE_ZIP_DESTINATION: extracted },
  });
  expect(result.status, result.stdout+result.stderr).toBe(0);
  expect(readFileSync(join(extracted, 'app', p.id, 'nested/story 漢.txt'), 'utf8')).toBe('Synthetic Unicode story');
  expect(inventory(extracted).filter(file => file.path !== 'checksums.json')).toEqual(JSON.parse(readFileSync(join(extracted, 'checksums.json'), 'utf8')));
  for (const directory of ['data', 'cache', 'logs', 'languages']) expect(inventory(join(extracted, directory))).toEqual([]);
  expect(existsSync(join(extracted, '.env'))).toBe(false);
 });
 it('installs immutable code while preserving all mutable installation state', () => {
  const f = fixture(), p = f.packageFor();
  installWindowsPackage(p.payload, f.home, commit);
  expect(readFileSync(join(f.home, 'current'), 'utf8')).toBe(p.selection);
  for (const file of ['.env', 'database-location.json', 'updates-paused']) expect(readFileSync(join(f.home, file), 'utf8')).toBe('retained '+file);
  for (const directory of ['data', 'languages']) expect(readFileSync(join(f.home, directory, 'retained'), 'utf8')).toBe('synthetic private content');
  expect(readFileSync(join(f.home, 'recovery/current'), 'utf8')).toBe(p.selection);
 });
 it('retains the actually working selection across a forward update and reuses the identical runtime', () => {
  const f = fixture(), first = f.packageFor(); installWindowsPackage(first.payload, f.home, commit);
  writeFileSync(join(f.home, 'working'), first.selection);
  const next = f.packageFor(nextCommit); installWindowsPackage(next.payload, f.home, nextCommit);
  expect(readFileSync(join(f.home, 'previous'), 'utf8')).toBe(first.selection);
  expect(readFileSync(join(f.home, 'working'), 'utf8')).toBe(first.selection);
  expect(readFileSync(join(f.home, 'current'), 'utf8')).toBe(next.selection);
  expect(existsSync(join(f.home, 'app', first.id))).toBe(true);
 });
 it('retries an interrupted publication with complete immutable orphan directories', () => {
  const f = fixture(), p = f.packageFor();
  mkdirSync(join(f.home, 'app')); cpSync(join(p.payload, 'app', p.id), join(f.home, 'app', p.id), { recursive: true });
  installWindowsPackage(p.payload, f.home, commit);
  expect(readFileSync(join(f.home, 'current'), 'utf8')).toBe(p.selection);
 });
 it('preserves selection and differing existing runtime on failed publication', () => {
  const f = fixture(), p = f.packageFor(); writeFileSync(join(f.home, 'current'), 'release-retained\n'+runtime+'\n');
  mkdirSync(join(f.home, 'runtime', runtime), { recursive: true }); writeFileSync(join(f.home, 'runtime', runtime, 'node.exe'), 'different runtime');
  expect(() => installWindowsPackage(p.payload, f.home, commit)).toThrow('immutable payload differs');
  expect(readFileSync(join(f.home, 'current'), 'utf8')).toBe('release-retained\n'+runtime+'\n');
  expect(readFileSync(join(f.home, 'runtime', runtime, 'node.exe'), 'utf8')).toBe('different runtime');
 });
 it('rejects changed or unlisted files before publishing any payload', () => {
  const f = fixture(), p = f.packageFor(); writeFileSync(join(p.payload, 'runtime', runtime, 'node.exe'), 'changed');
  expect(() => installWindowsPackage(p.payload, f.home, commit)).toThrow('checksums'); expect(existsSync(join(f.home, 'app'))).toBe(false);
 });
 it.each(['data/story.sqlite', '.env'])('refuses user data even with a matching package inventory: %s', file => {
  const f = fixture(), p = f.packageFor(); writeFileSync(join(p.payload, file), 'private data'); p.seal();
  expect(() => verifyWindowsPackage(p.payload, commit)).toThrow(); expect(existsSync(join(f.home, 'current'))).toBe(false);
 });
 it('rejects another commit and unsupported helper protocol', () => {
  const f = fixture(), p = f.packageFor();
  expect(() => verifyWindowsPackage(p.payload, nextCommit)).toThrow('identity');
  writeFileSync(join(p.payload, 'recovery', p.id, 'windows-package-protocol'), '99'); p.seal();
  expect(() => verifyWindowsPackage(p.payload, commit)).toThrow('Unsupported');
 });
});
