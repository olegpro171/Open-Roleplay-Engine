import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync, existsSync, cpSync, realpathSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { inventory, omitDependencyDeclarations } from '../scripts/release/stage.mjs';
import { activatePreparedWindowsPackage, installWindowsPackage, prepareWindowsPackage, verifyWindowsPackage } from '../scripts/release/windows-package-install.mjs';
import { launcherVersion } from '../scripts/release/windows-launcher-version.mjs';

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
 it.skipIf(process.platform !== 'win32').each([
  { name: 'a clean shutdown', status: 0, message: 'ORE stopped.' },
  { name: 'startup cancellation', status: 1, message: 'Cancelled. Run the launcher again to retry.' },
  { name: 'a shutdown failure', status: 42, message: 'Synthetic server shutdown failed.' },
 ])('preserves the foreground process result for $name when the helper observes Ctrl+C first', ({ status, message }) => {
  const f = fixture(), installed = f.packageFor();
  installWindowsPackage(installed.payload, f.home, commit);
  writeFileSync(join(f.home, '.ore-installation'), 'ORE-installation:1\n');
  writeFileSync(join(f.home, '.env'), '');
  const app = join(f.home, 'app', installed.id), tools = join(app, 'scripts/release');
  const helper = join(tools, 'windows-package-launcher.ps1');
  const interrupt = join(f.root, 'interrupt'), observed = join(f.root, 'observed');
  for (const name of ['windows-install-verify.mjs', 'application-assets.mjs']) cpSync(resolve('scripts/release', name), join(tools, name));
  cpSync(process.execPath, join(f.home, 'runtime', runtime, 'node.exe'));
  writeFileSync(join(app, 'build-info.json'), JSON.stringify({ kind: 'release', commit, schema: 1, node: process.versions.node, platform: process.platform, arch: process.arch }));
  for (const path of ['dist/server/server/main.js', 'dist/server/server/picture-worker.js', 'dist/client/index.html', 'migrations/0014_library_sorting.sql']) {
   mkdirSync(join(app, path, '..'), { recursive: true });
   writeFileSync(join(app, path), '');
  }
  writeFileSync(join(app, 'manifest.json'), JSON.stringify({ files: inventory(app) }));
  writeFileSync(join(tools, 'portable-launch.mjs'), `
import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
writeFileSync(${JSON.stringify(interrupt)}, '');
while (!existsSync(${JSON.stringify(observed)})) await delay(10);
console.log(${JSON.stringify(message)});
process.exitCode = ${status};
`);
  // Supply cancellation to the helper before letting the foreground process exit.
  const body = '# The installed helper owns the lease';
  const code = readFileSync(resolve('scripts/release/windows-package-launcher.ps1'), 'utf8');
  writeFileSync(helper, code.replace(body, `function Test-OreCancellation {
    if (![OreCancellation]::IsCancelled -and [IO.File]::Exists($env:ORE_TEST_WINDOW_INTERRUPT)) {
        [OreCancellation]::Cancel()
        [IO.File]::WriteAllText($env:ORE_TEST_WINDOW_OBSERVED,'')
    }
    return [OreCancellation]::IsCancelled
}\n${body}`));
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'RemoteSigned', '-File', helper, '-Installed', '-Installation', f.home, '-Invoking', f.root, '-Language', 'en'], {
   encoding: 'utf8', timeout: 20000,
   env: { ...process.env, ORE_NO_PAUSE: '1', ORE_TEST_WINDOW_INTERRUPT: interrupt, ORE_TEST_WINDOW_OBSERVED: observed },
  });
  const logs = join(f.home, 'logs');
  const report = existsSync(logs) ? readdirSync(logs).map(name => readFileSync(join(logs, name), 'utf8')).join('\n') : '';
  expect(existsSync(observed), result.stdout+result.stderr+report).toBe(true);
  expect(result.status, result.stdout+result.stderr).toBe(status);
  expect(result.stdout.trimEnd().split(/\r?\n/u).at(-1)).toBe(message);
  expect(result.stderr).toBe('');
  expect(readdirSync(logs)).toHaveLength(1);
  expect(report).not.toContain('OperationCanceledException');
 }, 25000);
 it.skipIf(process.platform !== 'win32')('an older batch declines a new installation before requesting package bytes', () => {
  const f = fixture(), entry = join(f.root, 'ORE-launcher.bat'), requests = join(f.root, 'requests.txt');
  const min = launcherVersion + 1;
  const tag = 'build-'+commit;
  const archive = 'ORE-windows-x64.zip';
  const assets = [archive, archive+'.sha256', 'ORE-windows-x64.json'].map(name => ({
   name, state: 'uploaded', browser_download_url: `https://github.com/olegpro171/Open-Roleplay-Engine/releases/download/${tag}/${name}`,
  }));
  writeFileSync(join(f.root,'latest.json'), JSON.stringify({ tag_name: tag, draft: false, prerelease: false, assets }));
  writeFileSync(join(f.root,'descriptor.json'), JSON.stringify({
   formatVersion: 2, platform: 'win32', arch: 'x64', launcherProtocol: 2, commit, archive,
   sha256: 'a'.repeat(64), bytes: 1, minimumLauncherVersion: min,
  }));
  const override = `function Get-OreHttps([string]$Url,[string]$Output,[int]$Seconds) {
    [IO.File]::AppendAllText($env:ORE_TEST_VERSION_REQUESTS,$Url+[Environment]::NewLine)
    $name = if ($Url.EndsWith('/releases/latest')) { 'latest.json' }
    elseif ($Url.EndsWith('/ORE-windows-x64.json')) { 'descriptor.json' }
    else { throw 'Unexpected download in the version gate test.' }
    [IO.File]::Copy((Join-Path $env:ORE_TEST_VERSION_ROOT $name),$Output)
}`;
  const batch = readFileSync(resolve('ORE-launcher.bat'), 'utf8');
  writeFileSync(entry, batch.replace('# Bootstrap contract 2.', override+'\n# Bootstrap contract 2.').replaceAll(/\r?\n/gu, '\r\n'));
  const result = spawnSync('cmd.exe', ['/d', '/s', '/c', '""%ORE_TEST_VERSION_BATCH%""'], {
   cwd: f.root, windowsVerbatimArguments: true, encoding: 'utf8', timeout: 20000,
   env: { ...process.env, ORE_TEST_VERSION_ROOT: f.root, ORE_TEST_VERSION_BATCH: entry, ORE_TEST_VERSION_REQUESTS: requests, ORE_NO_PAUSE: '1', ORE_SKIP_UPDATE: '0' },
  });
  expect(result.status, result.stdout+result.stderr).toBe(1);
  expect(result.stdout).toMatch(new RegExp(`(?:version|версии) ${min}\\b`, 'u'));
  expect(result.stdout).toContain('https://github.com/olegpro171/Open-Roleplay-Engine/releases/latest');
  expect(readFileSync(requests, 'utf8').trim().split(/\r?\n/u)).toEqual([
   'https://api.github.com/repos/olegpro171/Open-Roleplay-Engine/releases/latest',
   assets[2].browser_download_url,
  ]);
  expect(existsSync(join(f.root, 'ORE-internal/current'))).toBe(false);
 }, 25000);
 it('omits dependency declarations while retaining JavaScript, maps and notices', () => {
  const f = fixture(), modules = join(f.root, 'node_modules/package'), nested = join(modules,'lib');
  mkdirSync(nested, { recursive: true });
  for (const file of ['index.js', 'index.d.ts', 'LICENSE', 'lib/index.cjs', 'lib/index.cjs.map', 'lib/index.d.cts', 'lib/index.d.mts']) writeFileSync(join(modules, file), file);
  omitDependencyDeclarations(modules);
  expect(inventory(modules).map(file => file.path)).toEqual(['LICENSE', 'index.js', 'lib/index.cjs', 'lib/index.cjs.map']);
 });
 it.skipIf(process.platform !== 'win32')('walks long ordinary paths and rejects nested junctions without following them', () => {
  const f = fixture(), directory = join(f.root, 'tree'), nested = join(directory, 'nested'), outside = join(f.root, 'outside');
  const longPath = join(nested, 'a'.repeat(110), 'b'.repeat(110), 'story.txt');
  mkdirSync(join(longPath, '..'), { recursive: true });
  mkdirSync(outside); writeFileSync(longPath, 'Synthetic story');
  const run = () => spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'RemoteSigned', '-Command', "$ErrorActionPreference='Stop'; . $env:ORE_ZIP_TOOLS; Get-OreLongFiles $env:ORE_PACKAGE_DIRECTORY"], {
   encoding: 'utf8', timeout: 15000, env: { ...process.env, ORE_ZIP_TOOLS: resolve('scripts/release/windows-snapshot.ps1'), ORE_PACKAGE_DIRECTORY: directory },
  });
  const ordinary = run(); expect(ordinary.status, ordinary.stderr).toBe(0);
  expect(ordinary.stdout.trim()).toBe(longPath);
  const link = join(nested, 'junction');
  symlinkSync(outside, link, 'junction');
  try {
   const escaped = run(); expect(escaped.status).not.toBe(0);
   expect(escaped.stderr).toMatch(/Reparse point/u);
  } finally { rmSync(link, { force: true }); }
 });
 it.skipIf(process.platform !== 'win32').each([1, 2])('validates a native inventory with %i files and rejects corruption and malformed inventories', count => {
  const f = fixture(), directory = join(f.root, 'inventory'); mkdirSync(directory);
  for (let index = 0; index < count; index++) writeFileSync(join(directory, `story-${index}.txt`), 'Synthetic saved story');
  const records = inventory(directory), checksumFile = join(directory, 'checksums.json');
  const save = (value: unknown) => writeFileSync(checksumFile, JSON.stringify(value));
  const run = () => {
   const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'RemoteSigned', '-Command', "$ErrorActionPreference='Stop'; . $env:ORE_ZIP_TOOLS; . $env:ORE_PACKAGE_TOOLS; Test-OrePackageFiles $env:ORE_PACKAGE_DIRECTORY"], {
    encoding: 'utf8', timeout: 10000, env: { ...process.env, ORE_ZIP_TOOLS: resolve('scripts/release/windows-snapshot.ps1'), ORE_PACKAGE_TOOLS: resolve('scripts/release/windows-package.ps1'), ORE_PACKAGE_DIRECTORY: directory },
   });
   expect(result.error, result.stdout+result.stderr).toBeUndefined();
   return result;
  };
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
 it('prepares an update without changing any active pointers or root tools until activation', () => {
  const f = fixture(), first = f.packageFor(); installWindowsPackage(first.payload, f.home, commit);
  writeFileSync(join(f.home, 'working'), first.selection);
  const next = f.packageFor(nextCommit), tool = 'start-app.bat';
  writeFileSync(join(next.payload, tool), 'next tool'); next.seal();
  const prepared = prepareWindowsPackage(next.payload, f.home, nextCommit, 2);
  for (const ptr of ['current', 'recovery/current', 'working']) expect(readFileSync(join(f.home, ptr), 'utf8')).toBe(first.selection);
  expect(readFileSync(join(f.home, tool), 'utf8')).toBe('synthetic '+tool);
  expect(existsSync(join(f.home, 'previous'))).toBe(false);
  expect(existsSync(join(f.home, 'app', next.id))).toBe(true);
  expect(() => activatePreparedWindowsPackage(f.home, prepared, 1)).toThrow('requires a newer Windows launcher');
  for (const ptr of ['current', 'recovery/current', 'working']) expect(readFileSync(join(f.home, ptr), 'utf8')).toBe(first.selection);
  expect(readFileSync(join(f.home, tool), 'utf8')).toBe('synthetic '+tool);
  activatePreparedWindowsPackage(f.home, prepared, 2);
  for (const ptr of ['current', 'recovery/current']) expect(readFileSync(join(f.home, ptr), 'utf8')).toBe(next.selection);
  for (const ptr of ['working', 'previous']) expect(readFileSync(join(f.home, ptr), 'utf8')).toBe(first.selection);
  expect(readFileSync(join(f.home, tool), 'utf8')).toBe('next tool');
 });
 it.skipIf(process.platform !== 'win32')('keeps a prepared update for a compatible batch when launching offline with an older one', () => {
  const f = fixture(), first = f.packageFor(); installWindowsPackage(first.payload, f.home, commit);
  const next = f.packageFor(nextCommit);
  prepareWindowsPackage(next.payload, f.home, nextCommit, 2);
  const prepared = join(f.home, 'cache/prepared-update');
  const receipt = inventory(prepared);
  const check = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'RemoteSigned', '-Command', `
$ErrorActionPreference = 'Stop'
foreach ($script in @('windows-common.ps1','windows-snapshot.ps1','windows-standalone-common.ps1','windows-package.ps1','windows-package-session.ps1','windows-package-update.ps1')) {
 . (Join-Path $env:ORE_TEST_VERSION_TOOLS $script)
}
function Show-OreMessage($Id,$Parameters) { [Console]::WriteLine("$Id "+$Parameters.required) }
function Invoke-OreProcess { throw 'Old launcher reached activation.' }
$Installation = $env:ORE_TEST_VERSION_HOME
$script:OreReport = Join-Path $Installation 'version-test.log'
$result = Use-OrePreparedUpdate (Get-OreSelection $Installation) (Join-Path $Installation 'cache/prepared-update') 1
if ($result) { throw 'Old launcher activated a prepared update.' }
`], {
   encoding: 'utf8', timeout: 15000,
   env: { ...process.env, ORE_TEST_VERSION_HOME: f.home, ORE_TEST_VERSION_TOOLS: resolve('scripts/release') },
  });
  expect(check.status, check.stdout+check.stderr).toBe(0);
  expect(check.stdout.trim()).toBe('launcherUpdateRequired 2');
  expect(inventory(prepared)).toEqual(receipt);
  expect(readFileSync(join(f.home, 'current'), 'utf8')).toBe(first.selection);
  expect(readFileSync(join(f.home, 'recovery/current'), 'utf8')).toBe(first.selection);
 });
 it.each(['receipt corruption', 'requirement corruption', 'different base'])('leaves the selected version intact after %s', kind => {
  const f = fixture(), first = f.packageFor(); installWindowsPackage(first.payload, f.home, commit);
  const next = f.packageFor(nextCommit), prepared = prepareWindowsPackage(next.payload, f.home, nextCommit, 2);
  if (kind === 'receipt corruption') writeFileSync(join(f.home, 'cache/prepared-update/start-app.bat'), 'changed tool');
  else if (kind === 'requirement corruption') writeFileSync(join(f.home, 'cache/prepared-update/minimum-launcher-version'), '1');
  else writeFileSync(join(f.home, 'current'), 'release-other\n'+runtime+'\n');
  const selected = readFileSync(join(f.home, 'current'), 'utf8');
  expect(() => activatePreparedWindowsPackage(f.home, prepared, 2)).toThrow(/inventory|no longer matches/u);
  expect(readFileSync(join(f.home, 'current'), 'utf8')).toBe(selected);
  expect(readFileSync(join(f.home, 'recovery/current'), 'utf8')).toBe(first.selection);
  expect(readFileSync(join(f.home, 'start-app.bat'), 'utf8')).toBe('synthetic start-app.bat');
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
