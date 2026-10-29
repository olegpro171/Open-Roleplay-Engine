import { expect } from 'vitest';
import { statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

export function expectPrivateFile(path: string) {
  if (process.platform !== 'win32') {
    expect(statSync(path).mode & 0o777).toBe(0o600);
    return;
  }
  // Windows reports synthetic Unix mode bits. Check the effective file DACL
  // instead: only this user, SYSTEM and local administrators may be allowed.
  const result = spawnSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-Command', `
$ErrorActionPreference='Stop'
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$allowed=@($sid,'S-1-5-18','S-1-5-32-544')
$rules=(Get-Acl -LiteralPath $env:ORE_TEST_PRIVATE_FILE).GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])
$unexpected=@($rules|Where-Object {$_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -notin $allowed})
if($unexpected.Count){throw 'Private file grants access beyond its owner, SYSTEM and administrators.'}
`], { encoding: 'utf8', env: { ...process.env, ORE_TEST_PRIVATE_FILE: path } });
  expect(result.status, result.stdout+result.stderr).toBe(0);
}
