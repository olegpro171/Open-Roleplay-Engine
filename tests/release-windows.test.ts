import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
describe.skipIf(process.platform !== 'win32')('Windows PowerShell public startup', () => {
  function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'ORE space-история-&()-')); directories.push(root);
    const source = join(root, 'repository'), home = join(root, 'installation');
    mkdirSync(source); mkdirSync(home);
    cpSync(resolve('scripts/release'), join(source, 'scripts/release'), { recursive: true });
    const runtime = `node-v${process.versions.node}-win32-x64`;
    mkdirSync(join(home, 'runtime', runtime), { recursive: true });
    linkSync(process.execPath, join(home, 'runtime', runtime, 'node.exe'));
    const git = (...args: string[]) => {
      const result = spawnSync('git', ['-C', source, ...args], { encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0); return result.stdout.trim();
    };
    git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Synthetic'); git('config', 'user.email', 'synthetic@example.invalid');
    // Test orchestration with a controlled builder; real staging/native/server
    // behavior is exercised separately against the actual exported package.
    writeFileSync(join(source, 'build-portable.ps1'), `param($Mode,$Commit,$Destination)
$ErrorActionPreference='Stop'
if ($env:ORE_TEST_BUILD_MODE -eq 'fail') { throw 'Synthetic build failure' }
if ($env:ORE_TEST_BUILD_MODE -eq 'hold') {
    [IO.File]::WriteAllText((Join-Path $Destination 'build-entered'),[string]$PID)
    Start-Sleep -Seconds 60
}
$app=Join-Path $Destination ('app/release-'+$Commit)
[IO.Directory]::CreateDirectory((Join-Path $app 'scripts/release')) | Out-Null
[IO.File]::WriteAllText((Join-Path $app 'build-info.json'),('{"kind":"release","commit":"'+$Commit+'"}'))
[IO.File]::WriteAllText((Join-Path $app 'scripts/release/portable-launch.mjs'),'console.log("SYNTHETIC LAUNCH");')
[IO.File]::WriteAllText((Join-Path $app 'scripts/release/launcher-protocol'),'2')
[IO.File]::AppendAllText((Join-Path $Destination 'build-count'),'build\n')
[IO.File]::WriteAllText((Join-Path $Destination 'current'),('release-'+$Commit+"\n${runtime}\n"),(New-Object Text.UTF8Encoding $false))
`);
    git('add', '.'); git('commit', '-qm', 'Synthetic initial'); git('remote', 'add', 'origin', source);
    function run(extra: NodeJS.ProcessEnv = {}) {
      return spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'RemoteSigned', '-File', join(source, 'scripts/release/update-and-start.ps1'), '-Installation', home, '-SourceHint', source], { cwd: root, env: { ...process.env, ORE_SKIP_UPDATE: '0', ...extra }, encoding: 'utf8', timeout: 30000 });
    }
    return { root, source, home, git, run };
  }
  it('installs committed main, skips unchanged builds, updates by fast forward and preserves dirty managed work', () => {
    const f = fixture();
    let result = f.run(); expect(result.status, result.stdout + result.stderr).toBe(0); expect(result.stdout).toContain('SYNTHETIC LAUNCH');
    const pointer = readFileSync(join(f.home, 'current')); expect(pointer[0]).not.toBe(0xef); expect(pointer.includes(0)).toBe(false);
    result = f.run(); expect(result.status, result.stdout + result.stderr).toBe(0); expect(result.stdout).toContain('No build needed');
    expect(readFileSync(join(f.home, 'build-count'), 'utf8').trim().split('\n')).toHaveLength(1);
    writeFileSync(join(f.source, 'new.txt'), 'committed update'); f.git('add', '.'); f.git('commit', '-qm', 'Synthetic update');
    result = f.run(); expect(result.status, result.stdout + result.stderr).toBe(0);
    const current = readFileSync(join(f.home, 'current'), 'utf8'); expect(current).toContain(f.git('rev-parse', 'HEAD'));
    const dirty = join(f.home, 'cache/update-source/user-edit.txt'); writeFileSync(dirty, 'preserve me');
    result = f.run(); expect(result.status, result.stdout + result.stderr).toBe(0); expect(result.stdout).toContain('local changes');
    expect(readFileSync(dirty, 'utf8')).toBe('preserve me'); expect(readFileSync(join(f.home, 'current'), 'utf8')).toBe(current);
    mkdirSync(join(f.home, 'cache/update.lock'));
    result = f.run(); expect(result.status).not.toBe(0); expect(result.stderr).toContain('Another startup'); expect(result.stdout).not.toContain('SYNTHETIC LAUNCH');
  }, 120000);
  it('fails first install offline, visibly falls back offline, and supports explicit no-check startup', () => {
    const f = fixture();
    const missingGit = f.run({ PATH: `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0` });
    expect(missingGit.status).not.toBe(0); expect(missingGit.stderr).toContain('Git is required');
    f.git('remote', 'set-url', 'origin', join(f.root, 'absent.git'));
    let result = f.run(); expect(result.status).not.toBe(0); expect(result.stderr).toContain('No usable installed version');
    f.git('remote', 'set-url', 'origin', f.source);
    // The previous failed attempt retained its source; switching requires the
    // documented explicit move, never a reset by the updater.
    rmSync(join(f.home, 'cache/update-source'), { recursive: true });
    result = f.run(); expect(result.status, result.stdout + result.stderr).toBe(0);
    f.git('remote', 'set-url', 'origin', join(f.root, 'absent.git'));
    result = f.run(); expect(result.status, result.stdout + result.stderr).toBe(0); expect(result.stdout).toContain('Starting last installed version');
    result = f.run({ ORE_SKIP_UPDATE: '1' }); expect(result.status).toBe(0); expect(result.stdout).toContain('check skipped');
    expect(f.run({ ORE_SKIP_UPDATE: 'invalid' }).status).not.toBe(0);
  }, 120000);
  it('kills inherited workers when its PowerShell owner is abruptly terminated', async () => {
    const f = fixture(), marker = join(f.home, 'worker.pid');
    const script = join(f.root, 'owner.ps1');
    const workerScript = join(f.root, 'worker.cjs');
    writeFileSync(workerScript, 'require("node:fs").writeFileSync(process.argv[2],String(process.pid));setInterval(()=>{},1000)');
    writeFileSync(script, '. $env:ORE_TEST_TOOLS\nInitialize-OreJob\n& $env:ORE_TEST_NODE $env:ORE_TEST_WORKER $env:ORE_TEST_MARKER');
    const owner = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'RemoteSigned', '-File', script], { stdio: 'ignore', env: { ...process.env, ORE_TEST_TOOLS: join(f.source, 'scripts/release/windows-common.ps1'), ORE_TEST_NODE: process.execPath, ORE_TEST_WORKER: workerScript, ORE_TEST_MARKER: marker } });
    const exited = new Promise(resolve => owner.once('exit', resolve));
    let worker: number | undefined;
    try {
      const deadline = Date.now() + 15000;
      while (!existsSync(marker) && Date.now() < deadline) await delay(25);
      expect(existsSync(marker)).toBe(true); worker = Number(readFileSync(marker, 'utf8'));
      owner.kill(); await exited;
      const stopped = Date.now() + 5000;
      const alive = () => { try { process.kill(worker ?? 0, 0); return true; } catch { return false; } };
      while (alive() && Date.now() < stopped) await delay(25);
      expect(alive()).toBe(false);
    } finally { owner.kill(); if (worker) { try { process.kill(worker); } catch { /* Already exited. */ } } }
  }, 30000);
  it('retains the installed selection after a failed build and cannot activate after cancellation', async () => {
    const f = fixture();
    expect(f.run({ ORE_TEST_BUILD_MODE: 'fail' }).status).not.toBe(0); expect(existsSync(join(f.home, 'current'))).toBe(false);
    expect(f.run().status).toBe(0);
    const before = readFileSync(join(f.home, 'current'), 'utf8');
    writeFileSync(join(f.source, 'next.txt'), 'next release'); f.git('add', '.'); f.git('commit', '-qm', 'Next candidate');
    const failed = f.run({ ORE_TEST_BUILD_MODE: 'fail' }); expect(failed.status, failed.stdout + failed.stderr).toBe(0); expect(failed.stdout).toContain('Starting last installed version');
    expect(readFileSync(join(f.home, 'current'), 'utf8')).toBe(before);
    const owner = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'RemoteSigned', '-File', join(f.source, 'scripts/release/update-and-start.ps1'), '-Installation', f.home, '-SourceHint', f.source], { env: { ...process.env, ORE_SKIP_UPDATE: '0', ORE_TEST_BUILD_MODE: 'hold' }, stdio: 'ignore' });
    const exited = new Promise(resolve => owner.once('exit', resolve));
    try {
      const marker = join(f.home, 'build-entered'), deadline = Date.now() + 15000;
      while (!existsSync(marker) && Date.now() < deadline) await delay(25);
      expect(existsSync(marker)).toBe(true);
      const builder = Number(readFileSync(marker, 'utf8'));
      owner.kill(); await exited;
      await expect.poll(() => { try { process.kill(builder, 0); return true; } catch { return false; } }).toBe(false);
      expect(readFileSync(join(f.home, 'current'), 'utf8')).toBe(before);
      const blocked = f.run(); expect(blocked.status).not.toBe(0); expect(blocked.stderr).toContain('stale lock');
    } finally { owner.kill(); }
  }, 60000);
  it('rejects a corrupted cached official-runtime archive before activation or dependency installation', () => {
    const f = fixture(), builder = join(f.source, 'build-portable.ps1');
    cpSync(resolve('build-portable.ps1'), builder);
    mkdirSync(join(f.home, 'cache'), { recursive: true });
    writeFileSync(join(f.home, 'cache/node-v24.19.0-win-x64.zip'), 'synthetic broken download');
    const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'RemoteSigned', '-File', builder, '-Mode', 'Development', '-Destination', f.home], { encoding: 'utf8', timeout: 15000 });
    expect(result.status).not.toBe(0); expect(result.stderr).toContain('checksum mismatch');
    expect(existsSync(join(f.home, 'current'))).toBe(false); expect(existsSync(join(f.home, 'cache/build.lock'))).toBe(false); expect(existsSync(join(f.home, 'cache/npm'))).toBe(false);
  });
});
