import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) { chmodSync(directory, 0o700); rmSync(directory, { recursive: true, force: true }); } });
function fixture(developmentLauncher = false) {
  const root = mkdtempSync(join(tmpdir(), 'ORE bootstrap-история-')); directories.push(root);
  const source = join(root, 'source'), home = developmentLauncher ? join(source, 'ore-development') : join(root, 'installed'), bin = join(root, 'tools');
  mkdirSync(source); mkdirSync(home); mkdirSync(bin);
  cpSync(resolve('build-portable.sh'), join(source, 'build-portable.sh'));
  cpSync(resolve('start-dev.command'), join(source, 'start-dev.command'));
  cpSync(resolve('scripts/release'), join(source, 'scripts/release'), { recursive: true });
  for (const directory of ['src', 'public', 'migrations', 'docs']) mkdirSync(join(source, directory));
  for (const file of ['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.server.json', 'vite.config.ts', 'vitest.config.ts', 'playwright.config.ts', 'index.html', 'LICENSE', 'docs/RELEASES.md']) writeFileSync(join(source, file), '{}');
  const git = (args: string[]) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '-b', 'main']); git(['add', '.']); git(['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '-m', 'Synthetic release fixture']);
  const runtime = `node-v24.19.0-${process.platform}-${process.arch}`;
  writeFileSync(join(home, 'current'), 'previous-app\nprevious-runtime\n');
  mkdirSync(join(home, 'data')); writeFileSync(join(home, 'data/sentinel'), 'saved user data');
  mkdirSync(join(home, 'languages')); writeFileSync(join(home, 'languages/sentinel'), 'saved language pack');
  const run = (args = ['--development', home]) => spawnSync('/bin/bash', [join(source, 'build-portable.sh'), ...args], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin` }, timeout: 15000 });
  const unchanged = () => {
    expect(readFileSync(join(home, 'current'), 'utf8')).toBe('previous-app\nprevious-runtime\n');
    expect(readFileSync(join(home, 'data/sentinel'), 'utf8')).toBe('saved user data');
    expect(readFileSync(join(home, 'languages/sentinel'), 'utf8')).toBe('saved language pack');
    expect(existsSync(join(home, 'cache/build.lock'))).toBe(false);
  };
  return { root, source, home, bin, git, runtime, run, unchanged };
}

function controlledBuild(f: ReturnType<typeof fixture>, buildStatus = 0) {
  const runtime = join(f.home, 'runtime', f.runtime);
  mkdirSync(join(runtime, 'bin'), { recursive: true });
  mkdirSync(join(runtime, 'lib/node_modules/npm/bin'), { recursive: true });
  writeFileSync(join(runtime, 'bin/node'), `#!/bin/bash\nif [ "$1" = --version ]; then echo v24.19.0; else exec '${process.execPath.replaceAll("'", "'\\''")}' "$@"; fi\n`, { mode: 0o755 });
  writeFileSync(join(runtime, 'lib/node_modules/npm/bin/npm-cli.js'), `process.exit(process.argv.includes('build') ? ${buildStatus} : 0);`);
  writeFileSync(join(f.source, 'scripts/release/native-smoke.mjs'), '');
  // Only build/activation are synthetic; the builder's EXIT trap and development
  // launcher's decision to start after the build are exercised unchanged.
  writeFileSync(join(f.source, 'scripts/release/stage.mjs'), `
    import { writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    if (process.argv[2] === 'install') {
      const home = process.argv[4];
      writeFileSync(join(home, 'current'), 'new-app\\nprivate-runtime\\n');
      writeFileSync(join(home, 'start.command'), '#!/bin/bash\\nprintf started >> "$(dirname -- "$0")/started"\\n');
    }
  `);
}

function failTemporaryCleanup(f: ReturnType<typeof fixture>, failures: number | 'always') {
  // Reproduce an external writer keeping the temporary directory nonempty,
  // without relying on Finder timing or touching any real application data.
  writeFileSync(join(f.bin, 'rm'), `#!/bin/bash
stage="\${@: -1}"
count=0
[ ! -f "$stage/cleanup-attempts" ] || read -r count < "$stage/cleanup-attempts"
count=$((count + 1))
printf '%s\\n' "$count" > "$stage/cleanup-attempts"
${failures === 'always' ? '' : `if [ "$count" -gt ${failures} ]; then exec /bin/rm "$@"; fi`}
echo "rm: $stage: Directory not empty" >&2
exit 1
`, { mode: 0o755 });
}

describe.skipIf(process.platform === 'win32')('Bash staging failure recovery', () => {
  it('starts the activated development app despite persistent temporary cleanup failure and permits another launch', () => {
    const f = fixture(true);
    controlledBuild(f);
    failTemporaryCleanup(f, 'always');
    const launch = () => spawnSync('/bin/bash', [join(f.source, 'start-dev.command')], {
      encoding: 'utf8', timeout: 15000,
      env: { ...process.env, PATH: `${f.bin}:/usr/bin:/bin:/usr/sbin:/sbin` },
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = launch();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stderr).toContain('Directory not empty');
      expect(existsSync(join(f.home, 'cache/build.lock'))).toBe(false);
    }
    expect(readFileSync(join(f.home, 'started'), 'utf8')).toBe('startedstarted');
    expect(readFileSync(join(f.home, 'current'), 'utf8')).toBe('new-app\nprivate-runtime\n');
    expect(readFileSync(join(f.home, 'data/sentinel'), 'utf8')).toBe('saved user data');
    expect(readFileSync(join(f.home, 'languages/sentinel'), 'utf8')).toBe('saved language pack');
  });
  it('retries transient temporary cleanup failures', () => {
    const f = fixture();
    controlledBuild(f);
    failTemporaryCleanup(f, 1);
    const result = f.run();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(readdirSync(join(f.home, 'cache'))).toEqual([]);
  });
  it('preserves a build failure and releases its lock even when temporary cleanup also fails', () => {
    const f = fixture();
    controlledBuild(f, 42);
    failTemporaryCleanup(f, 'always');
    const result = f.run();
    expect(result.status).toBe(42);
    expect(result.stderr).toContain('Directory not empty');
    expect(existsSync(join(f.home, 'started'))).toBe(false);
    f.unchanged();
  });
  it('does not start the development app when its build lock cannot be released', () => {
    const f = fixture(true);
    controlledBuild(f);
    writeFileSync(join(f.bin, 'rmdir'), '#!/bin/bash\necho "rmdir: Permission denied" >&2\nexit 1\n', { mode: 0o755 });
    const result = spawnSync('/bin/bash', [join(f.source, 'start-dev.command')], {
      encoding: 'utf8', timeout: 15000,
      env: { ...process.env, PATH: `${f.bin}:/usr/bin:/bin:/usr/sbin:/sbin` },
    });
    expect(result.status).toBe(75);
    expect(result.stderr).toContain('Permission denied');
    expect(existsSync(join(f.home, 'started'))).toBe(false);
    expect(existsSync(join(f.home, 'cache/build.lock'))).toBe(true);
    expect(readFileSync(join(f.home, 'current'), 'utf8')).toBe('new-app\nprivate-runtime\n');
  });
  it('rejects dirty release inputs before creating output or fetching a runtime', () => {
    const f = fixture(); writeFileSync(join(f.source, 'private.env'), 'synthetic-only');
    const result = f.run(['--release', f.git(['rev-parse', 'HEAD']), join(f.root, 'new output')]);
    expect(result.status).not.toBe(0); expect(result.stderr).toContain('Release source must be clean');
    expect(existsSync(join(f.root, 'new output'))).toBe(false);
  });
  it('rejects commits outside main and abbreviated commit identities', () => {
    const f = fixture(); f.git(['checkout', '-b', 'candidate']); writeFileSync(join(f.source, 'candidate'), 'future'); f.git(['add', '.']); f.git(['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '-m', 'Candidate']);
    expect(f.run(['--release', f.git(['rev-parse', 'HEAD']), f.home]).stderr).toContain('reachable on local main');
    expect(f.run(['--release', f.git(['rev-parse', '--short', 'HEAD']), f.home]).stderr).toContain('exact full checked-out commit');
  });
  it('explains an unsupported old Linux libc before downloading or changing the installation', () => {
    const f = fixture();
    writeFileSync(join(f.bin, 'uname'), '#!/bin/bash\nif [ "$1" = -s ]; then echo Linux; else echo x86_64; fi\n', { mode: 0o755 });
    writeFileSync(join(f.bin, 'getconf'), '#!/bin/bash\necho "glibc 2.17"\n', { mode: 0o755 });
    const result = f.run(); expect(result.status).not.toBe(0); expect(result.stderr).toContain('require glibc 2.28 or newer; detected glibc 2.17');
    expect(readFileSync(join(f.home, 'current'), 'utf8')).toBe('previous-app\nprevious-runtime\n');
    expect(existsSync(join(f.home, 'cache'))).toBe(false);
  });
  it('rejects an incomplete runtime download and removes temporary work without switching data/app', () => {
    const f = fixture();
    writeFileSync(join(f.bin, 'curl'), '#!/bin/bash\nwhile [ "$#" -gt 0 ]; do if [ "$1" = -o ]; then shift; printf partial > "$1"; break; fi; shift; done\nexit 18\n', { mode: 0o755 });
    const result = f.run();
    expect(result.status).not.toBe(0); expect(result.stderr).toContain('Runtime download failed');
    expect(existsSync(join(f.home, 'cache', `${f.runtime}.tar.gz`))).toBe(false); f.unchanged();
  });
  it('rejects a mismatched cached checksum before executing a runtime', () => {
    const f = fixture(); mkdirSync(join(f.home, 'cache')); writeFileSync(join(f.home, 'cache', `${f.runtime}.tar.gz`), 'incorrect archive');
    const result = f.run(); expect(result.status).not.toBe(0); expect(result.stderr).toContain('Cached runtime checksum mismatch'); f.unchanged();
  });
  it('preserves the installed pointer/data/languages after a staged build command fails', () => {
    const f = fixture();
    controlledBuild(f, 42);
    const result = f.run(); expect(result.status).toBe(42); f.unchanged();
  });
  it('fails an unwritable installation without selecting an alternate database', () => {
    const f = fixture(); chmodSync(f.home, 0o500);
    try { const result = f.run(); expect(result.status).not.toBe(0); expect(result.stderr).toContain('Installation is not writable'); expect(existsSync(join(f.home, 'data/roleplay.sqlite'))).toBe(false); }
    finally { chmodSync(f.home, 0o700); }
  });
});
