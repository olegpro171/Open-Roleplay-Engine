import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) { chmodSync(directory, 0o700); rmSync(directory, { recursive: true, force: true }); } });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ORE bootstrap-история-')); directories.push(root);
  const source = join(root, 'source'), home = join(root, 'installed'), bin = join(root, 'tools');
  mkdirSync(source); mkdirSync(home); mkdirSync(bin);
  cpSync(resolve('build-portable.sh'), join(source, 'build-portable.sh'));
  cpSync(resolve('scripts/release'), join(source, 'scripts/release'), { recursive: true });
  for (const directory of ['src', 'public', 'migrations', 'docs']) mkdirSync(join(source, directory));
  for (const file of ['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.server.json', 'vite.config.ts', 'vitest.config.ts', 'playwright.config.ts', 'index.html', 'docs/RELEASES.md', 'docs/RELEASE_IMPLEMENTATION_BRIEF.md', 'docs/RELEASE_VERIFICATION.md', 'docs/WINDOWS_RELEASE_HANDOFF.md','docs/WINDOWS_RELEASE_VERIFICATION.md', 'docs/TEST_RELEASE.md']) writeFileSync(join(source, file), '{}');
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

describe.skipIf(process.platform === 'win32')('Bash staging failure recovery', () => {
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
    const f = fixture(), runtime = join(f.home, 'runtime', f.runtime);
    mkdirSync(join(runtime, 'bin'), { recursive: true }); mkdirSync(join(runtime, 'lib/node_modules/npm/bin'), { recursive: true });
    // Controlled runtime/transport fixture: real Node executes only synthetic JS.
    writeFileSync(join(runtime, 'bin/node'), `#!/bin/bash\nif [ "$1" = --version ]; then echo v24.19.0; else exec '${process.execPath.replaceAll("'", "'\\''")}' "$@"; fi\n`, { mode: 0o755 });
    writeFileSync(join(runtime, 'lib/node_modules/npm/bin/npm-cli.js'), 'process.exit(process.argv.includes("build") ? 42 : 0);');
    writeFileSync(join(f.source, 'scripts/release/native-smoke.mjs'), '');
    const result = f.run(); expect(result.status).toBe(42); f.unchanged();
  });
  it('fails an unwritable installation without selecting an alternate database', () => {
    const f = fixture(); chmodSync(f.home, 0o500);
    try { const result = f.run(); expect(result.status).not.toBe(0); expect(result.stderr).toContain('Installation is not writable'); expect(existsSync(join(f.home, 'data/roleplay.sqlite'))).toBe(false); }
    finally { chmodSync(f.home, 0o700); }
  });
});
