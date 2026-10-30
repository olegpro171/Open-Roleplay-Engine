import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ORE-dev-'));
  roots.push(root);
  const source = join(root, "local edits & ' папка");
  const scripts = join(source, 'scripts/release');
  mkdirSync(scripts, { recursive: true });
  for (const file of ['start-dev-windows.ps1', 'windows-common.ps1']) {
    cpSync(join('scripts/release', file), join(scripts, file));
  }
  cpSync('start-dev.bat', join(source, 'start-dev.bat'));
  writeFileSync(join(source, 'build-portable.ps1'), `
param([string]$Mode, [string]$Destination)
if ($Mode -ne 'Development' -or $Destination -ne (Join-Path $PSScriptRoot 'ore-development')) { exit 41 }
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'built'), 'local edits')
if ($env:ORE_TEST_FAIL_BUILD -eq '1') { exit 42 }
exit 0
`);
  writeFileSync(join(scripts, 'update-and-start.ps1'), `
param([string]$Installation, [string]$SourceHint)
if ($env:ORE_SKIP_UPDATE -ne '1' -or $env:ORE_DATABASE_DEFAULT -ne 'repository') { exit 43 }
if ($Installation -ne (Join-Path $SourceHint 'ore-development')) { exit 44 }
if (![IO.File]::Exists((Join-Path $SourceHint 'built'))) { exit 45 }
[IO.File]::WriteAllText((Join-Path $SourceHint 'started'), $env:ROLEPLAY_DATABASE)
exit 0
`);
  const run = (extra: NodeJS.ProcessEnv = {}, args = '') => spawnSync('cmd.exe',
    ['/d', '/s', '/c', `""%ORE_TEST_ENTRY%"${args}"`], {
      windowsVerbatimArguments: true, cwd: root, encoding: 'utf8', timeout: 30000,
      env: { ...process.env, ORE_TEST_ENTRY: join(source, 'start-dev.bat'), ORE_NO_PAUSE: '1',
        ROLEPLAY_DATABASE: undefined, ORE_SKIP_UPDATE: '0', ...extra },
    });
  return { source, root, run };
}

describe.skipIf(process.platform !== 'win32')('Windows working-tree startup', () => {
  it('builds before starting, forces skip-update and resolves source .env relative to the caller', () => {
    const f = fixture();
    writeFileSync(join(f.source, '.env'), 'ROLEPLAY_DATABASE=synthetic.sqlite\n');
    const result = f.run();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(readFileSync(join(f.source, 'started'), 'utf8')).toBe(join(f.root, 'synthetic.sqlite'));
  });

  it('does not launch a retained installation after build failure', () => {
    const f = fixture();
    mkdirSync(join(f.source, 'ore-development'));
    writeFileSync(join(f.source, 'ore-development/current'), 'retained selection');
    const result = f.run({ ORE_TEST_FAIL_BUILD: '1' });
    expect(result.status, result.stdout + result.stderr).not.toBe(0);
    expect(existsSync(join(f.source, 'built'))).toBe(true);
    expect(existsSync(join(f.source, 'started'))).toBe(false);
    expect(readFileSync(join(f.source, 'ore-development/current'), 'utf8')).toBe('retained selection');
  });

  it('rejects arguments before building or starting', () => {
    const f = fixture();
    const result = f.run({}, ' unexpected');
    expect(result.status, result.stdout + result.stderr).not.toBe(0);
    expect(existsSync(join(f.source, 'built'))).toBe(false);
    expect(existsSync(join(f.source, 'started'))).toBe(false);
  });
});
