import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ORE Unicode длинный путь-')); roots.push(root);
  const parent = join(root, ...Array.from({ length: 9 }, (_, index) => `Chosen long installation folder ${index}`));
  mkdirSync(parent, { recursive: true });
  const destination = join(parent, 'payload');
  const archive = join(root, 'package.zip');
  const run = (source: string) => spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'RemoteSigned', '-Command', `$ErrorActionPreference='Stop';[Console]::OutputEncoding=New-Object Text.UTF8Encoding $false;. $env:ORE_LONG_TOOLS\n${source}`], {
    encoding: 'utf8', timeout: 30000,
    env: { ...process.env, ORE_LONG_TOOLS: resolve('scripts/release/windows-snapshot.ps1'), ORE_LONG_ARCHIVE: archive, ORE_LONG_DESTINATION: destination, ORE_LONG_OUTSIDE: join(root, 'outside') },
  });
  return { root, parent, destination, archive, run };
}
describe.skipIf(process.platform !== 'win32')('Windows PowerShell 5.1 package Unicode path I/O', () => {
  it('extracts, inspects, hashes and removes a package beyond MAX_PATH without host or registry changes', () => {
    const f = fixture();
    const path = join(f.destination, 'app', 'nested', 'story.txt');
    expect(path.length).toBeGreaterThan(300);
    const source = `Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip=[IO.Compression.ZipFile]::Open($env:ORE_LONG_ARCHIVE,[IO.Compression.ZipArchiveMode]::Create)
try {
  $zip.CreateEntry('package/app/empty/')|Out-Null
  $entry=$zip.CreateEntry('package/app/nested/story.txt')
  $writer=New-Object IO.StreamWriter ($entry.Open()),(New-Object Text.UTF8Encoding $false)
  try{$writer.Write('Synthetic story')}finally{$writer.Dispose()}
} finally{$zip.Dispose()}
Expand-OreZip $env:ORE_LONG_ARCHIVE 'package' $env:ORE_LONG_DESTINATION -LongPaths
Assert-OreLongTree $env:ORE_LONG_DESTINATION
$files=@(Get-OreLongFiles $env:ORE_LONG_DESTINATION)
@{files=$files;length=(Get-OreLongLength $env:ORE_LONG_DESTINATION $files[0]);hash=(Get-OreLongHash $env:ORE_LONG_DESTINATION $files[0])}|ConvertTo-Json -Compress`;
    const result = f.run(source);
    expect(result.status, result.stdout+result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ files: [path], length: Buffer.byteLength('Synthetic story'), hash: createHash('sha256').update('Synthetic story').digest('hex') });
    expect(readFileSync(path, 'utf8')).toBe('Synthetic story');
    expect(existsSync(join(f.destination, 'app/empty'))).toBe(true);
    const removed = f.run('Remove-OreLongTree $env:ORE_LONG_DESTINATION');
    expect(removed.status, removed.stdout+removed.stderr).toBe(0);
    expect(existsSync(f.destination)).toBe(false);
  });
  it('rejects traversal and junctions before inspecting or deleting external content', () => {
    const f = fixture();
    mkdirSync(f.destination); mkdirSync(join(f.root, 'outside'));
    writeFileSync(join(f.root, 'outside/sentinel.txt'), 'preserve');
    const escaped = f.run("Assert-OreLongPath $env:ORE_LONG_DESTINATION ($env:ORE_LONG_DESTINATION+'\\..\\outside')");
    expect(escaped.status).not.toBe(0);
    expect(escaped.stderr).toContain('escapes installation');
    const linked = join(f.destination, 'external');
    symlinkSync(join(f.root, 'outside'), linked, 'junction');
    for (const action of ['Assert-OreLongTree', 'Remove-OreLongTree']) {
      const result = f.run(`${action} $env:ORE_LONG_DESTINATION`);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Reparse point');
    }
    expect(readFileSync(join(f.root, 'outside/sentinel.txt'), 'utf8')).toBe('preserve');
    rmSync(linked, { recursive: true, force: true });
  });
});
