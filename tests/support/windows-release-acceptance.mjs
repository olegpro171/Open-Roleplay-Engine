// Exercise the production Release guards and package pipeline before merging.
// Only the disposable fixture has a main branch; its tree must equal the clean
// candidate exactly. Its synthetic commit is never published or pushed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

assert.equal(process.platform, 'win32');
const repository = resolve('.');
function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${executable} exited ${result.status}`);
  return result.stdout?.trim();
}
function git(args, cwd = repository) {
  return run('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' });
}
assert.equal(git(['status', '--porcelain', '--untracked-files=all']), '', 'Candidate sources must be committed and clean.');
const candidate = git(['rev-parse', 'HEAD']);
const tree = git(['rev-parse', 'HEAD^{tree}']);
const base = resolve(process.env.RUNNER_TEMP ?? tmpdir());
const root = mkdtempSync(join(base, 'ORE-ci-'));
const source = join(root, 'source');
const home = join(root, 'Chosen space-漢-&()', 'installation');
const output = join(root, 'release');
const ps = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
let succeeded = false;
console.log(`Candidate ${candidate}; isolated release fixture: ${root}`);
try {
  // A Git checkout preserves executable modes and avoids archive conversion
  // through the developer's core.autocrlf setting. No working files/data copy.
  git(['clone', '--no-checkout', '--no-hardlinks', '-c', 'core.autocrlf=false', repository, source]);
  git(['checkout', '-B', 'main', candidate], source);
  git(['config', 'user.name', 'ORE release acceptance'], source);
  git(['config', 'user.email', 'release-acceptance@example.invalid'], source);
  git(['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', `Isolated acceptance fixture for ${candidate}`], source);
  assert.equal(git(['rev-parse', 'HEAD^{tree}'], source), tree, 'Release fixture must contain the exact candidate tree.');
  const commit = git(['rev-parse', 'HEAD'], source);
  run(ps, ['-NoProfile', '-ExecutionPolicy', 'RemoteSigned', '-File', join(source, 'build-portable.ps1'), '-Mode', 'Release', '-Commit', commit, '-Destination', home]);
  run(process.execPath, [join(repository, 'scripts/release/ci-package-windows.mjs'), home, output, commit]);
  run(process.execPath, ['--import', 'tsx', join(repository, 'tests/support/windows-package-acceptance.ts'), output, commit]);
  console.log(`PASS: exact candidate tree ${tree}, production Release build/package checks and package-installer acceptance (isolated fixture commit ${commit}; no publication).`);
  succeeded = true;
} finally {
  assert.equal(dirname(root), base);
  if (succeeded) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  else console.error(`Retained failed release fixture for inspection: ${root}`);
}
