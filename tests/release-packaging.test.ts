import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { releaseServer } from './support/release-server.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ORE artifact-история-')); directories.push(root);
  const work = join(root, 'work'), home = join(root, 'home'), notices = join(root, 'notices');
  mkdirSync(home); mkdirSync(join(home, 'cache')); mkdirSync(join(home, 'app')); mkdirSync(notices); writeFileSync(join(notices, 'LICENSE'), 'Synthetic notice');
  for (const directory of ['dist/client/assets', 'dist/server/server', 'dist/server/shared', 'migrations', 'node_modules/.bin', 'node_modules/pkg', 'docs', 'scripts']) mkdirSync(join(work, directory), { recursive: true });
  cpSync(resolve('scripts/release'), join(work, 'scripts/release'), { recursive: true });
  writeFileSync(join(work, 'scripts/release/native-smoke.mjs'), '// Native loading is covered by the real packaged smoke; this isolates staging.');
  writeFileSync(join(work, 'package.json'), JSON.stringify({ type: 'module', version: '0.1.0' })); writeFileSync(join(work, 'package-lock.json'), '{}');
  writeFileSync(join(work, 'dist/server/shared/build-info.js'), 'export const databaseSchemaVersion = 13;');
  writeFileSync(join(work, 'dist/server/server/main.js'), releaseServer); writeFileSync(join(work, 'dist/server/server/picture-worker.js'), '');
  writeFileSync(join(work, 'dist/client/index.html'), '<title>ORE</title>'); writeFileSync(join(work, 'dist/client/assets/app.js'), 'Synthetic asset');
  writeFileSync(join(work, 'migrations/0013_data_management.sql'), '-- Synthetic migration');
  for (const file of ['RELEASES.md', 'RELEASE_IMPLEMENTATION_BRIEF.md', 'RELEASE_VERIFICATION.md', 'WINDOWS_RELEASE_HANDOFF.md', 'TEST_RELEASE.md']) writeFileSync(join(work, 'docs', file), 'Synthetic instructions');
  writeFileSync(join(work, 'node_modules/pkg/bin.js'), ''); symlinkSync('../pkg/bin.js', join(work, 'node_modules/.bin/example'));
  for (const directory of ['data', 'languages', 'tests']) { mkdirSync(join(work, directory)); writeFileSync(join(work, directory, 'PRIVATE'), 'synthetic private fixture'); }
  writeFileSync(join(work, '.env'), 'synthetic private environment');
  mkdirSync(join(home, 'data')); writeFileSync(join(home, 'data/PRIVATE'), 'synthetic installed private data');
  writeFileSync(join(home, 'database-path.txt'), '/synthetic/private/original-data.sqlite');
  writeFileSync(join(home, 'update-source.txt'), '/synthetic/private/source-checkout');
  const runtime = `node-v24.19.0-${process.platform}-${process.arch}`;
  mkdirSync(join(home, 'runtime', runtime), { recursive: true }); writeFileSync(join(home, 'runtime', runtime, 'LICENSE'), 'Synthetic runtime license');
  const install = (commit = 'a'.repeat(40)) => spawnSync(process.execPath, [resolve('scripts/release/stage.mjs'), 'install', work, home, '--development', commit, runtime, 'b'.repeat(64), notices], { encoding: 'utf8' });
  const installed = install(); expect(installed.status, installed.stderr).toBe(0);
  const id = readFileSync(join(home, 'current'), 'utf8').split('\n')[0];
  const application = join(home, 'app', id);
  return { root, work, home, application, install };
}

describe.skipIf(process.platform === 'win32')('portable artifact boundaries', () => {
  it('rejects server and launcher startup failures after a successful native smoke without activating or touching saved data', () => {
    const f = fixture(), previous = readFileSync(join(f.home, 'current'), 'utf8');
    writeFileSync(join(f.work, 'dist/server/server/main.js'), 'throw new Error("Synthetic server startup failure");');
    const server = f.install('c'.repeat(40));
    expect(server.status).not.toBe(0); expect(server.stderr).toContain('Application startup check failed');
    expect(readFileSync(join(f.home, 'current'), 'utf8')).toBe(previous);
    writeFileSync(join(f.work, 'dist/server/server/main.js'), releaseServer);
    writeFileSync(join(f.work, 'scripts/release/portable-launch.mjs'), 'process.exit(0);');
    const launcher = f.install('d'.repeat(40));
    expect(launcher.status).not.toBe(0); expect(launcher.stderr).toContain('Application startup check failed');
    expect(readFileSync(join(f.home, 'current'), 'utf8')).toBe(previous);
    expect(readdirSync(join(f.home, 'data'))).toEqual(['PRIVATE']);
    expect(readFileSync(join(f.home, 'data/PRIVATE'), 'utf8')).toBe('synthetic installed private data');
    expect(readdirSync(join(f.home, 'cache')).filter(name => name.startsWith('startup-check-'))).toEqual([]);
  });
  it('retains an explicit previous working selection when activating a startup-verified replacement', () => {
    const f = fixture(), previous = readFileSync(join(f.home, 'current'), 'utf8');
    writeFileSync(join(f.home, 'working'), previous);
    const next = f.install('c'.repeat(40)); expect(next.status, next.stderr).toBe(0);
    expect(readFileSync(join(f.home, 'previous'), 'utf8')).toBe(previous);
    expect(readFileSync(join(f.home, 'working'), 'utf8')).toBe(previous);
    expect(readFileSync(join(f.home, 'current'), 'utf8')).not.toBe(previous);
    expect(existsSync(join(f.home, 'recover.command'))).toBe(true);
  });
  it('preserves internal npm symlinks and ships only app/runtime files with empty mutable directories', () => {
    const f = fixture(), output = join(f.root, 'output');
    const packaged = spawnSync(process.execPath, [resolve('scripts/release/package-portable.mjs'), f.home, output], { encoding: 'utf8' }); expect(packaged.status, packaged.stderr).toBe(0);
    const archive = readdirSync(output).find(file => file.endsWith('.tar.gz')); expect(archive).toBeDefined();
    if (!archive) throw new Error('Missing test artifact');
    const listing = spawnSync('tar', ['-tzf', join(output, archive)], { encoding: 'utf8' }); expect(listing.status).toBe(0);
    expect(listing.stdout).not.toContain('PRIVATE'); expect(listing.stdout).not.toContain('.env'); expect(listing.stdout).not.toContain('/tests/');
    expect(listing.stdout).not.toContain('/database-path.txt'); expect(listing.stdout).not.toContain('/update-source.txt');
    expect(listing.stdout).toContain('/checksums.json'); expect(listing.stdout).toContain('/notices/LICENSE');
    const extracted = join(f.root, 'extracted'); mkdirSync(extracted);
    expect(spawnSync('tar', ['-xzf', join(output, archive), '-C', extracted]).status).toBe(0);
    const payload = join(extracted, readdirSync(extracted)[0]);
    for (const directory of ['data', 'cache', 'logs', 'languages']) {
      expect(readdirSync(join(payload, directory))).toEqual([]);
      expect(statSync(join(payload, directory)).mode & 0o777).toBe(0o700);
    }
    expect(readFileSync(join(f.application, 'node_modules/.bin/example'), 'utf8')).toBe('');
    expect(readFileSync(join(payload, 'app', readFileSync(join(f.home, 'current'), 'utf8').split('\n')[0], 'node_modules/.bin/example'), 'utf8')).toBe('');
  });
  it('refuses modified assets during startup and artifact export, before starting a database', () => {
    const f = fixture(); writeFileSync(join(f.application, 'dist/client/assets/app.js'), 'unexpected modification');
    const start = spawnSync(process.execPath, [join(f.application, 'scripts/release/portable-launch.mjs'), f.home], { encoding: 'utf8' });
    expect(start.status).toBe(1); expect(start.stderr).toContain('Application asset differs from its manifest');
    expect(readdirSync(join(f.home, 'data'))).toEqual(['PRIVATE']);
    const packaged = spawnSync(process.execPath, [resolve('scripts/release/package-portable.mjs'), f.home, join(f.root, 'output')], { encoding: 'utf8' });
    expect(packaged.status).not.toBe(0); expect(packaged.stderr).toContain('differs from its manifest');
  });
  it('rejects dependency symlinks pointing outside the staged application and preserves the selected version', () => {
    const f = fixture(), previous = readFileSync(join(f.home, 'current'), 'utf8');
    symlinkSync(f.root, join(f.work, 'node_modules/external'));
    const result = spawnSync(process.execPath, [resolve('scripts/release/stage.mjs'), 'install', f.work, f.home, '--development', 'c'.repeat(40), `node-v24.19.0-${process.platform}-${process.arch}`, 'b'.repeat(64), join(f.root, 'notices')], { encoding: 'utf8' });
    expect(result.status).not.toBe(0); expect(result.stderr).toContain('External symlink forbidden');
    expect(readFileSync(join(f.home, 'current'), 'utf8')).toBe(previous);
  });
});
