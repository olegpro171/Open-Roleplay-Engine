import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const roots: string[] = [];
const children = new Set<ChildProcess>();
afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(accept => child.once('exit', () => accept()));
      child.kill();
      await exited;
    }
  }
  children.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform !== 'win32')('Windows package ownership and legacy recovery', () => {
  const setup = `. $env:ORE_TEST_PATH_TOOLS
. $env:ORE_TEST_LOCK_TOOLS
$ErrorActionPreference='Stop'
function Get-OreWindowsBootTime { [DateTime]::Parse('2026-10-28T00:00:00Z').ToUniversalTime() }
`;
  function fixture() {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'ORE package ownership-история-'))); roots.push(home);
    mkdirSync(join(home, 'cache'));
    writeFileSync(join(home, '.env'), 'private synthetic setting');
    writeFileSync(join(home, 'database-location.json'), 'retained location');
    const env = {
      ...process.env, ORE_TEST_HOME: home,
      ORE_TEST_PATH_TOOLS: resolve('scripts/release/windows-snapshot.ps1'),
      ORE_TEST_LOCK_TOOLS: resolve('scripts/release/windows-package-lock.ps1'),
      ORE_TEST_COMMON_NATIVE: resolve('scripts/release/windows-common.ps1'),
      ORE_TEST_COMMON_TOOLS: resolve('scripts/release/windows-standalone-common.ps1'),
    };
    function run(code: string) {
      return spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'RemoteSigned', '-Command', setup + code], { encoding: 'utf8', env, timeout: 15000 });
    }
    function legacy(name: string, beforeBoot: boolean, contents?: string) {
      const path = join(home, 'cache', name); mkdirSync(path);
      if (contents !== undefined) writeFileSync(join(path, 'owner'), contents);
      const time = new Date(beforeBoot ? '2026-10-27T00:00:00Z' : '2026-10-29T00:00:00Z');
      utimesSync(path, time, time);
      return path;
    }
    return { home, env, run, legacy };
  }

  it('parses the generated package helper and every changed Windows controller with native PowerShell 5.1', () => {
    const f = fixture();
    const files = ['scripts/release/windows-package-launcher.ps1', 'scripts/release/windows-package-lock.ps1', 'scripts/release/windows-package.ps1', 'scripts/release/recover-windows.ps1', 'scripts/release/start-windows.ps1', 'scripts/release/update-and-start.ps1', 'build-portable.ps1'];
    for (const file of files) {
      const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', '$tokens=$null;$errors=$null;[Management.Automation.Language.Parser]::ParseFile($env:ORE_TEST_PARSE,[ref]$tokens,[ref]$errors)|Out-Null;if($errors.Count){$errors|Out-String|Write-Output;exit 1}'], { encoding: 'utf8', env: { ...f.env, ORE_TEST_PARSE: resolve(file) } });
      expect(result.status, file + '\n' + result.stdout + result.stderr).toBe(0);
    }
  });

  it('initializes every native helper with a Unicode private compilation directory', () => {
    const f = fixture();
    const result = f.run(`
. $env:ORE_TEST_COMMON_NATIVE
. $env:ORE_TEST_COMMON_TOOLS
$directory=Join-Path $env:ORE_TEST_HOME ('cache/compilation space-'+[char]0x6f22+'-&()')
[IO.Directory]::CreateDirectory($directory)|Out-Null
$env:TEMP=$directory;$env:TMP=$directory+'\\'
$workingDirectory=[Environment]::CurrentDirectory
Initialize-OreJob
Initialize-OreCancellation
Initialize-OreLongPaths
$lease=Acquire-OrePackageLease $env:ORE_TEST_HOME
$lease.Dispose()
if($env:TEMP -cne $directory -or $env:TMP -cne ($directory+'\\') -or [Environment]::CurrentDirectory -cne $workingDirectory){throw 'Compilation changed the caller environment.'}
if([IO.Directory]::EnumerateFileSystemEntries($directory).GetEnumerator().MoveNext()){throw 'Compilation left temporary files.'}
`);
    expect(result.status, result.stdout+result.stderr).toBe(0);
  });

  it('restores the compiler environment and removes scratch files after a compilation error', () => {
    const f = fixture();
    const result = f.run(`
$directory=Join-Path $env:ORE_TEST_HOME ('cache/failed compilation-'+[char]0x6f22)
[IO.Directory]::CreateDirectory($directory)|Out-Null
$env:TEMP=$directory;$env:TMP=$directory+'\\'
$workingDirectory=[Environment]::CurrentDirectory
$failed=$false
try { Add-OreType 'public class Invalid { this is invalid CSharp; }' }
catch { if($_.Exception.Message -notmatch 'CS[0-9]+'){throw};$failed=$true }
if(!$failed){throw 'Invalid CSharp unexpectedly compiled.'}
if($env:TEMP -cne $directory -or $env:TMP -cne ($directory+'\\') -or [Environment]::CurrentDirectory -cne $workingDirectory){throw 'Failed compilation changed the caller environment.'}
if([IO.Directory]::EnumerateFileSystemEntries($directory).GetEnumerator().MoveNext()){throw 'Failed compilation left temporary files.'}
Add-OreType 'public static class OreCompilerRecovery { public static int Value() { return 42; } }'
if([OreCompilerRecovery]::Value() -ne 42){throw 'Compilation did not recover.'}
`);
    expect(result.status, result.stdout+result.stderr).toBe(0);
  });

  it('selects retained recovery tooling when a selected dependency is missing or unreadable', async () => {
    const f = fixture(), runtime = 'node-v24.19.0-win32-x64';
    const selected = join(f.home, 'app/release-selected/scripts/release');
    const recovery = join(f.home, 'recovery/release-retained');
    cpSync(resolve('scripts/release'), selected, { recursive: true });
    cpSync(resolve('scripts/release'), recovery, { recursive: true });
    writeFileSync(join(f.home, 'current'), `release-selected\n${runtime}\n`);
    writeFileSync(join(f.home, 'recovery/current'), `release-retained\n${runtime}\n`);
    const env = { ...f.env, ORE_TEST_COMMON_TOOLS: resolve('scripts/release/windows-standalone-common.ps1'), ORE_TEST_PACKAGE_TOOLS: resolve('scripts/release/windows-package.ps1') };
    const select = () => spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'RemoteSigned', '-Command', setup + '. $env:ORE_TEST_COMMON_TOOLS\n. $env:ORE_TEST_PACKAGE_TOOLS\nGet-OrePackageHelper $env:ORE_TEST_HOME'], { encoding: 'utf8', env });
    const first = select(); expect(first.status, first.stdout + first.stderr).toBe(0);
    expect(realpathSync.native(first.stdout.trim())).toBe(realpathSync.native(join(selected, 'windows-package-launcher.ps1')));
    const dependency = join(selected, 'check-database.mjs'), original = readFileSync(dependency);
    rmSync(dependency);
    const missing = select(); expect(missing.status, missing.stdout + missing.stderr).toBe(0);
    expect(realpathSync.native(missing.stdout.trim())).toBe(realpathSync.native(join(recovery, 'windows-package-launcher.ps1')));
    writeFileSync(dependency, original);
    const marker = join(f.home, 'dependency-locked');
    const reader = spawn('powershell.exe', ['-NoProfile', '-Command', '$s=[IO.File]::Open($env:ORE_TEST_DEPENDENCY,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None);[IO.File]::WriteAllText($env:ORE_TEST_MARKER,"ready");try{Start-Sleep -Seconds 60}finally{$s.Dispose()}'], { env: { ...env, ORE_TEST_DEPENDENCY: dependency, ORE_TEST_MARKER: marker }, stdio: 'ignore' });
    children.add(reader);
    await expect.poll(() => existsSync(marker), { timeout: 10000 }).toBe(true);
    const unreadable = select(); expect(unreadable.status, unreadable.stdout + unreadable.stderr).toBe(0);
    expect(realpathSync.native(unreadable.stdout.trim())).toBe(realpathSync.native(join(recovery, 'windows-package-launcher.ps1')));
    const exited = new Promise<void>(accept => reader.once('exit', () => accept())); reader.kill(); await exited;
    const restored = select(); expect(restored.status, restored.stdout + restored.stderr).toBe(0);
    expect(realpathSync.native(restored.stdout.trim())).toBe(realpathSync.native(join(selected, 'windows-package-launcher.ps1')));
  }, 30000);

  it('rejects a simultaneous controller and releases ownership automatically after abrupt termination', async () => {
    const f = fixture(), marker = join(f.home, 'entered');
    const owner = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'RemoteSigned', '-Command', setup + `$lease=Acquire-OrePackageLease $env:ORE_TEST_HOME
[IO.File]::WriteAllText((Join-Path $env:ORE_TEST_HOME 'entered'),'ready')
Start-Sleep -Seconds 60`], { env: f.env, stdio: 'ignore' });
    children.add(owner);
    await expect.poll(() => existsSync(marker), { timeout: 10000 }).toBe(true);
    const blocked = f.run('$lease=Acquire-OrePackageLease $env:ORE_TEST_HOME;exit 0');
    expect(blocked.status).not.toBe(0);
    const exited = new Promise<void>(accept => owner.once('exit', () => accept()));
    owner.kill(); await exited;
    const relaunched = f.run('$lease=Acquire-OrePackageLease $env:ORE_TEST_HOME;Assert-OreLegacyQuiescent $env:ORE_TEST_HOME;$lease.Dispose();exit 0');
    expect(relaunched.status, relaunched.stdout + relaunched.stderr).toBe(0);
    expect(existsSync(join(f.home, 'cache/update.lock'))).toBe(false);
    expect(existsSync(join(f.home, 'cache/build.lock'))).toBe(false);
  });

  it('fences surviving workers even after their controller has released its file lease', async () => {
    const f = fixture(), marker = join(f.home, 'worker.pid'), ready = join(f.home, 'lease-released');
    const workerScript = join(f.home, 'worker.mjs');
    writeFileSync(workerScript, `import {writeFileSync} from 'node:fs';writeFileSync(process.argv[2],String(process.pid));setInterval(()=>{},1000);`);
    const env = { ...f.env, ORE_TEST_NODE: process.execPath, ORE_TEST_SCRIPT: workerScript };
    const owner = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'RemoteSigned', '-Command', setup + `$lease=Acquire-OrePackageLease $env:ORE_TEST_HOME
$start=New-Object Diagnostics.ProcessStartInfo
$start.FileName=$env:ORE_TEST_NODE
$start.UseShellExecute=$false
$start.Arguments='"'+$env:ORE_TEST_SCRIPT+'" "'+(Join-Path $env:ORE_TEST_HOME 'worker.pid')+'"'
$worker=[Diagnostics.Process]::Start($start)
$lease.Dispose()
[IO.File]::WriteAllText((Join-Path $env:ORE_TEST_HOME 'lease-released'),'ready')
Start-Sleep -Seconds 60`], { env, stdio: 'ignore' });
    children.add(owner);
    await expect.poll(() => existsSync(marker) && existsSync(ready), { timeout: 10000 }).toBe(true);
    const worker = Number(readFileSync(marker, 'utf8'));
    const blocked = f.run('$lease=Acquire-OrePackageLease $env:ORE_TEST_HOME;[IO.File]::WriteAllText((Join-Path $env:ORE_TEST_HOME "late-write"),"unsafe")');
    expect(blocked.status).not.toBe(0); expect(blocked.stderr).toContain('Previous package workers are still stopping');
    expect(existsSync(join(f.home, 'late-write'))).toBe(false);
    const exited = new Promise<void>(accept => owner.once('exit', () => accept()));
    owner.kill(); await exited;
    const relaunched = f.run('$lease=Acquire-OrePackageLease $env:ORE_TEST_HOME;$lease.Dispose();exit 0');
    expect(relaunched.status, relaunched.stdout + relaunched.stderr).toBe(0);
    await expect.poll(() => { try { process.kill(worker, 0); return true; } catch { return false; } }).toBe(false);
  }, 30000);

  it('retires recognized pre-reboot legacy markers while preserving saved state', () => {
    const f = fixture();
    const locks = [
      f.legacy('update.lock', true, '12345\n12345678-abcd-1234-abcd-123456789012\n'),
      f.legacy('build.lock', true), f.legacy('database-location.lock', true),
    ];
    const result = f.run('$lease=Acquire-OrePackageLease $env:ORE_TEST_HOME;try{Assert-OreLegacyQuiescent $env:ORE_TEST_HOME}finally{$lease.Dispose()}');
    expect(result.status, result.stdout + result.stderr).toBe(0);
    for (const lock of locks) expect(existsSync(lock)).toBe(false);
    expect(readFileSync(join(f.home, '.env'), 'utf8')).toBe('private synthetic setting');
    expect(readFileSync(join(f.home, 'database-location.json'), 'utf8')).toBe('retained location');
  });

  it('preserves every marker when any legacy owner could have run during this boot', () => {
    const f = fixture();
    const old = f.legacy('update.lock', true);
    const current = f.legacy('build.lock', false);
    const result = f.run('try{Assert-OreLegacyQuiescent $env:ORE_TEST_HOME}catch{[Console]::WriteLine($script:OreFailure);throw}');
    expect(result.status).not.toBe(0); expect(result.stdout).toContain('legacyRestart');
    expect(existsSync(old)).toBe(true); expect(existsSync(current)).toBe(true);
  });

  it.each(['update.lock', 'build.lock', 'database-location.lock'])('preserves unknown contents in an old %s', name => {
    const f = fixture();
    const path = f.legacy(name, true, 'unrecognized user content');
    const result = f.run('Assert-OreLegacyQuiescent $env:ORE_TEST_HOME');
    expect(result.status).not.toBe(0);
    expect(readFileSync(join(path, 'owner'), 'utf8')).toBe('unrecognized user content');
  });

  it('serializes real database metadata writes through the outer lease without persistent lock directories', () => {
    const f = fixture();
    rmSync(join(f.home, 'database-location.json'));
    const nodeScript = join(f.home, 'resolve.mjs');
    writeFileSync(nodeScript, `import { resolveDatabase, recordDatabaseReady } from ${JSON.stringify(pathToFileURL(resolve('scripts/release/database-location.mjs')).href)};
const home=process.argv[2];
const selection=resolveDatabase(home);
recordDatabaseReady(home,selection);
console.log(JSON.stringify(selection.state));`);
    const script = `$lease=Acquire-OrePackageLease $env:ORE_TEST_HOME
try {
 $env:ORE_PACKAGE_LEASE_HOME=$env:ORE_TEST_HOME
 & $env:ORE_TEST_NODE $env:ORE_TEST_SCRIPT $env:ORE_TEST_HOME
 if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}
}finally{$lease.Dispose()}`;
    const env = { ...f.env, ORE_TEST_NODE: process.execPath, ORE_TEST_SCRIPT: nodeScript };
    const run = () => spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'RemoteSigned', '-Command', setup + script], { encoding: 'utf8', env, timeout: 15000 });
    const first = run(); expect(first.status, first.stdout + first.stderr).toBe(0);
    expect(existsSync(join(f.home, 'cache/database-location.lock'))).toBe(false);
    // An established, missing database remains an error on the next launch.
    const second = run(); expect(second.status).not.toBe(0); expect(second.stderr).toContain('Established database is missing');
    expect(existsSync(join(f.home, 'data/roleplay.sqlite'))).toBe(false);
    expect(existsSync(join(f.home, 'cache/database-location.lock'))).toBe(false);
  });

  it('does not let a lease for another installation bypass database metadata ownership', () => {
    const f = fixture();
    const lock = join(f.home, 'cache/database-location.lock'); mkdirSync(lock);
    const before = readFileSync(join(f.home, 'database-location.json'));
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import { resolveDatabase } from ${JSON.stringify(pathToFileURL(resolve('scripts/release/database-location.mjs')).href)};resolveDatabase(process.argv[1]);`, f.home], {
      encoding: 'utf8', env: { ...process.env, ORE_PACKAGE_LEASE_HOME: join(f.home, 'another-installation') },
    });
    expect(result.status).not.toBe(0); expect(result.stderr).toContain('Another launcher owns database-location.lock');
    expect(existsSync(lock)).toBe(true);
    expect(readFileSync(join(f.home, 'database-location.json'))).toEqual(before);
  });

  it('rejects reserved package recovery configuration and clears Node injection before invoking recovery', () => {
    const f = fixture();
    for (const name of ['recover-windows.ps1', 'windows-common.ps1', 'windows-snapshot.ps1', 'windows-package-lock.ps1', 'windows-standalone-common.ps1']) cpSync(resolve('scripts/release', name), join(f.home, name));
    writeFileSync(join(f.home, '.ore-installation'), 'ORE-installation:1\n');
    writeFileSync(join(f.home, '.env'), 'ORE_PACKAGE_LEASE_HOME=forged-private-value\n');
    const run = () => spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'RemoteSigned', '-File', join(f.home, 'recover-windows.ps1'), '--list'], { encoding: 'utf8', env: f.env, timeout: 15000 });
    const invalid = run(); expect(invalid.status).not.toBe(0); expect(invalid.stderr).toContain('invalidEnv');
    expect(invalid.stderr).not.toContain('forged-private-value');
    const runtime = `node-v${process.versions.node}-win32-x64`;
    mkdirSync(join(f.home, 'runtime', runtime), { recursive: true });
    cpSync(process.execPath, join(f.home, 'runtime', runtime, 'node.exe'));
    const tools = join(f.home, 'recovery/release-retained'); mkdirSync(tools, { recursive: true });
    writeFileSync(join(f.home, 'recovery/current'), `release-retained\n${runtime}\n`);
    const invoked = join(f.home, 'recovery-invoked'), injected = join(f.home, 'injection-executed'), injection = join(f.home, 'injection.mjs');
    writeFileSync(injection, `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(injected)},'unsafe');`);
    writeFileSync(join(tools, 'recover.mjs'), `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(invoked)},JSON.stringify({nodeOptions:process.env.NODE_OPTIONS??null,leasedHome:process.env.ORE_PACKAGE_LEASE_HOME}));`);
    const configuration = `NODE_OPTIONS=--import=${pathToFileURL(injection).href}\n`;
    writeFileSync(join(f.home, '.env'), configuration);
    const result = run(); expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(invoked, 'utf8'))).toEqual({ nodeOptions: null, leasedHome: f.home });
    expect(existsSync(injected)).toBe(false);
    expect(readFileSync(join(f.home, '.env'), 'utf8')).toBe(configuration);
    expect(readFileSync(join(f.home, 'database-location.json'), 'utf8')).toBe('retained location');
  }, 30000);
});
