import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    return { root, source, home };
  }
  it('reads private literal configuration with process and source precedence and safe errors', () => {
    const f = fixture(), first = join(f.root, 'source.env'), second = join(f.root, 'installed.env');
    writeFileSync(first, '# comment\r\nORE_ENV_LITERAL="$(throw \'must not run\') $HOME"\r\nORE_ENV_KEEP=file\r\nORE_ENV_SOURCE=source\r\n');
    writeFileSync(second, 'ORE_ENV_SOURCE=installed\n');
    const script = join(f.root, 'env-check.ps1');
    writeFileSync(script, '. $env:ORE_TEST_TOOLS\nImport-OreEnvironment $env:ORE_TEST_FIRST\nImport-OreEnvironment $env:ORE_TEST_SECOND\n@{literal=$env:ORE_ENV_LITERAL;keep=$env:ORE_ENV_KEEP;source=$env:ORE_ENV_SOURCE} | ConvertTo-Json -Compress');
    const run = () => spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'RemoteSigned', '-File', script], { encoding: 'utf8', env: { ...process.env, ORE_TEST_TOOLS: resolve('scripts/release/windows-common.ps1'), ORE_TEST_FIRST: first, ORE_TEST_SECOND: second, ORE_ENV_KEEP: 'process' } });
    const result = run(); expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ literal: "$(throw 'must not run') $HOME", keep: 'process', source: 'source' });
    writeFileSync(first, '# comment\nprivate invalid contents\n');
    const invalid = run(); expect(invalid.status).not.toBe(0); expect(invalid.stderr).toContain('expected KEY=value'); expect(invalid.stderr).not.toContain('private invalid contents');
  });
  it('rejects an empty installed database override in startup and recovery', () => {
    const f = fixture(), tools = join(f.source, 'scripts/release');
    for (const name of ['start-windows.ps1', 'recover-windows.ps1', 'windows-common.ps1', 'windows-snapshot.ps1', 'windows-standalone-common.ps1', 'windows-package-lock.ps1']) cpSync(join(tools, name), join(f.home, name));
    writeFileSync(join(f.home, '.env'), 'ROLEPLAY_DATABASE=\n');
    for (const entry of ['start-windows.ps1', 'recover-windows.ps1']) {
      const env = { ...process.env }; delete env.ROLEPLAY_DATABASE;
      const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'RemoteSigned', '-File', join(f.home, entry)], { encoding: 'utf8', env });
      expect(result.status).not.toBe(0); expect(result.stderr).toContain('ROLEPLAY_DATABASE must name a database file');
      expect(existsSync(join(f.home, 'data/roleplay.sqlite'))).toBe(false);
    }
  });
  it('kills inherited workers when its PowerShell owner is abruptly terminated', async () => {
    const f = fixture(), marker = join(f.home, 'worker.pid');
    const script = join(f.root, 'owner.ps1');
    const workerScript = join(f.root, 'worker.cjs');
    writeFileSync(workerScript, 'require("node:fs").writeFileSync(process.argv[2],String(process.pid));setInterval(()=>{},1000)');
    writeFileSync(script, '. $env:ORE_TEST_TOOLS\n. (Join-Path ([IO.Path]::GetDirectoryName($env:ORE_TEST_TOOLS)) "windows-snapshot.ps1")\nInitialize-OreJob\n& $env:ORE_TEST_NODE $env:ORE_TEST_WORKER $env:ORE_TEST_MARKER');
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
  it('rejects a corrupted cached official-runtime archive before activation or dependency installation', () => {
    const f = fixture(), builder = join(f.source, 'scripts/release/build-portable.ps1');
    const init = spawnSync('git', ['-C', f.source, 'init', '-q', '-b', 'main']);
    expect(init.status).toBe(0);
    const commit = spawnSync('git', ['-C', f.source, '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '--allow-empty', '-qm', 'Synthetic build']);
    expect(commit.status).toBe(0);
    mkdirSync(join(f.home, 'cache'), { recursive: true });
    writeFileSync(join(f.home, 'cache/node-v24.19.0-win-x64.zip'), 'synthetic broken download');
    const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'RemoteSigned', '-File', builder, '-Mode', 'Development', '-Destination', f.home], { encoding: 'utf8', timeout: 15000 });
    expect(result.status).not.toBe(0); expect(result.stderr).toContain('checksum mismatch');
    expect(existsSync(join(f.home, 'current'))).toBe(false); expect(existsSync(join(f.home, 'cache/build.lock'))).toBe(false); expect(existsSync(join(f.home, 'cache/npm'))).toBe(false);
  });
});
