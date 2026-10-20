import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ORE update-история-'))); directories.push(root);
  const source = join(root, 'original checkout'), remote = join(root, 'remote.git'), home = join(root, 'installed ORE');
  mkdirSync(join(source, 'scripts/release'), { recursive: true });
  mkdirSync(join(home, 'data'), { recursive: true }); mkdirSync(join(home, 'languages'));
  writeFileSync(join(home, 'data/sentinel'), 'Saved synthetic story'); writeFileSync(join(home, 'languages/sentinel'), 'Saved language pack');
  for (const name of ['update-and-start.sh', 'start.command', 'database-location.mjs', 'launcher-protocol']) cpSync(resolve('scripts/release', name), join(source, 'scripts/release', name));
  cpSync(resolve('start-app.command'), join(source, 'start-app.command'));
  cpSync(resolve('start.sh'), join(source, 'start.sh'));
  writeFileSync(join(source, 'scripts/release/portable-launch.mjs'), `import {readFileSync,existsSync,mkdirSync,writeFileSync} from 'node:fs'; import {dirname} from 'node:path'; import {resolveDatabase,recordDatabaseReady} from './database-location.mjs'; const home=process.argv[2]; const database=resolveDatabase(home); if(!existsSync(database.path)){mkdirSync(dirname(database.path),{recursive:true});writeFileSync(database.path,'Synthetic test database');} recordDatabaseReady(home,database); console.log(JSON.stringify({launchedCommit:readFileSync(home+'/current','utf8').split('\\n')[0].slice(8),database:database.path}));`);

  // This fixture replaces only compilation. Git selection, updater, pointer
  // reload and installed launcher are real; native/staging paths have own suites.
  writeFileSync(join(source, 'build-portable.sh'), `#!/bin/bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
commit=$2
home=$3
printf '%s\\n' "$commit" >> "$home/build-calls"
[ ! -f FAIL_BUILD ] || exit 42
if [ -f WAIT_BUILD ]; then touch "$home/build-waiting"; sleep 30; fi
id="release-$commit"
mkdir -p "$home/app/$id/scripts/release" "$home/runtime/node-v24.19.0-darwin-arm64/bin"
ln -sf ${quote(process.execPath)} "$home/runtime/node-v24.19.0-darwin-arm64/bin/node"
printf '{"kind":"release","commit":"%s"}' "$commit" > "$home/app/$id/build-info.json"
cp scripts/release/update-and-start.sh scripts/release/database-location.mjs scripts/release/launcher-protocol scripts/release/portable-launch.mjs "$home/app/$id/scripts/release/"
cp scripts/release/start.command "$home/start.command"

printf '%s\\nnode-v24.19.0-darwin-arm64\\n' "$id" > "$home/current"
`);
  const git = (directory: string, args: string[]) => execFileSync('git', ['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', '-C', directory, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(source, ['init', '-b', 'main']); git(source, ['add', '.']); git(source, ['commit', '-m', 'Initial synthetic release']);
  const first = git(source, ['rev-parse', 'HEAD']);
  git(root, ['clone', '--bare', source, remote]); git(source, ['remote', 'add', 'origin', remote]);
  writeFileSync(join(home, 'update-source.txt'), remote+'\n');
  const run = (skip = false, installed = false) => {
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', ORE_SKIP_UPDATE: skip ? '1' : '0', GIT_CONFIG_NOSYSTEM: '1' };
    delete env.ROLEPLAY_DATABASE;
    return spawnSync('/bin/bash', installed ? [join(home, 'start.command')] : [join(source, 'scripts/release/update-and-start.sh'), home], { cwd: root, encoding: 'utf8', timeout: 15000, env });
  };
  const advance = (name = 'change') => { writeFileSync(join(source, name), name); git(source, ['add', '.']); git(source, ['commit', '-m', 'Next synthetic release']); git(source, ['push', 'origin', 'main']); return git(source, ['rev-parse', 'HEAD']); };
  const calls = () => existsSync(join(home, 'build-calls')) ? readFileSync(join(home, 'build-calls'), 'utf8').trim().split('\n') : [];
  const preserved = () => { expect(readFileSync(join(home, 'data/sentinel'), 'utf8')).toBe('Saved synthetic story'); expect(readFileSync(join(home, 'languages/sentinel'), 'utf8')).toBe('Saved language pack'); expect(existsSync(join(home, 'cache/update.lock'))).toBe(false); };
  return { root, source, remote, home, first, git, run, advance, calls, preserved, managed: join(home, 'cache/update-source') };
}

describe.skipIf(process.platform === 'win32')('startup updates using real local Git remotes', () => {
  it('installs on first launch and reuses the exact installed commit on repeat launch, without global Node', () => {
    const f = fixture();
    const first = f.run(); expect(first.status, first.stdout+first.stderr).toBe(0); expect(first.stdout).toContain(`"launchedCommit":"${f.first}"`);
    const repeat = f.run(false, true); expect(repeat.status, repeat.stdout+repeat.stderr).toBe(0); expect(repeat.stdout).toContain('No build needed');
    expect(f.calls()).toEqual([f.first]); f.preserved();
  });
  it('builds a newer main commit, reloads the new selection and leaves the original checkout untouched', () => {
    const f = fixture(); expect(f.run().status).toBe(0);
    const next = f.advance(); writeFileSync(join(f.source, 'local-draft'), 'Keep my edits');
    const result = f.run(false, true); expect(result.status, result.stdout+result.stderr).toBe(0); expect(result.stdout).toContain(`"launchedCommit":"${next}"`);
    expect(f.calls()).toEqual([f.first, next]); expect(readFileSync(join(f.source, 'local-draft'), 'utf8')).toBe('Keep my edits'); f.preserved();
  });
  it('retains the installed selection after a failed build, launches it and retries a later fixed commit', () => {
    const f = fixture(); expect(f.run().status).toBe(0); const failed = f.advance('FAIL_BUILD');
    const result = f.run(); expect(result.status, result.stdout+result.stderr).toBe(0); expect(result.stdout).toContain(`"launchedCommit":"${f.first}"`); expect(result.stderr).toContain('Starting the last installed version');
    rmSync(join(f.source, 'FAIL_BUILD')); const fixed = f.advance('fixed');
    const retry = f.run(); expect(retry.status, retry.stdout+retry.stderr).toBe(0); expect(retry.stdout).toContain(`"launchedCommit":"${fixed}"`); expect(f.calls()).toEqual([f.first, failed, fixed]); f.preserved();
  });
  it('launches the saved app offline and provides an explicit no-check mode', () => {
    const f = fixture(); expect(f.run().status).toBe(0); renameSync(f.remote, f.remote+'.offline');
    const offline = f.run(); expect(offline.status, offline.stdout+offline.stderr).toBe(0); expect(offline.stdout).toContain(`"launchedCommit":"${f.first}"`); expect(offline.stderr).toContain('Starting the last installed version');
    const skip = f.run(true, true); expect(skip.status).toBe(0); expect(skip.stdout).toContain('update check skipped'); expect(skip.stdout).not.toContain('Checking ORE main'); expect(f.calls()).toEqual([f.first]); f.preserved();
  });
  it('fails clearly without an installed app when the remote is unavailable, then succeeds on explicit retry', () => {
    const f = fixture(); renameSync(f.remote, f.remote+'.offline');
    const failed = f.run(); expect(failed.status).not.toBe(0); expect(failed.stderr).toContain('no usable installed version'); expect(existsSync(join(f.home, 'current'))).toBe(false);
    renameSync(f.remote+'.offline', f.remote); expect(f.run().status).toBe(0); f.preserved();
  });
  it('preserves edits in its managed checkout instead of resetting them', () => {
    const f = fixture(); expect(f.run().status).toBe(0); f.advance(); writeFileSync(join(f.managed, 'draft'), 'Preserve this too');
    const result = f.run(); expect(result.status).toBe(0); expect(result.stdout).toContain('has local changes'); expect(readFileSync(join(f.managed, 'draft'), 'utf8')).toBe('Preserve this too'); expect(f.calls()).toEqual([f.first]); f.preserved();
  });
  it('never lets a missing Git directory or linked checkout redirect updates into another repository', () => {
    for (const kind of ['incomplete', 'linked']) {
      const f = fixture(); expect(f.run().status).toBe(0);
      renameSync(f.managed, f.managed+'.preserved');
      if (kind === 'linked') symlinkSync(f.source, f.managed); else mkdirSync(f.managed);
      const result = f.run(); expect(result.status).toBe(0); expect(result.stdout).toContain('incomplete or linked elsewhere');
      expect(existsSync(join(f.source, '.git/FETCH_HEAD'))).toBe(false); expect(f.calls()).toEqual([f.first]); f.preserved();
    }
  });
  it('refuses rewritten main history rather than automatically downgrading/replacing the installed release', () => {
    const f = fixture(); expect(f.run().status).toBe(0);
    f.git(f.source, ['checkout', '--orphan', 'replacement']); f.git(f.source, ['commit', '-m', 'Unrelated synthetic history']); f.git(f.source, ['push', '--force', 'origin', 'HEAD:main']);
    const result = f.run(); expect(result.status).toBe(0); expect(result.stdout).toContain('Refusing an automatic downgrade'); expect(f.calls()).toEqual([f.first]); f.preserved();
  });
  it('does not launch another server when another startup holds the update lock', () => {
    const f = fixture(); expect(f.run().status).toBe(0); mkdirSync(join(f.home, 'cache/update.lock'));
    const result = f.run(); expect(result.status).toBe(75); expect(result.stdout).not.toContain('launchedCommit'); expect(existsSync(join(f.home, 'cache/update.lock'))).toBe(true);
  });
  it('keeps the previous launcher contract usable if activation stops before switching an older payload', () => {
    const f = fixture(); expect(f.run().status).toBe(0);
    const id = readFileSync(join(f.home, 'current'), 'utf8').split('\n')[0];
    rmSync(join(f.home, 'app', id, 'scripts/release/update-and-start.sh'));
    const result = f.run(false, true);
    expect(result.status, result.stdout+result.stderr).toBe(0); expect(result.stdout).toContain(`"launchedCommit":"${f.first}"`); expect(result.stderr).toContain('Launcher update was not activated'); f.preserved();
  });
  it('hands source startup to the installed updater so updater fixes take effect on later starts', () => {
    const f = fixture(); expect(f.run().status).toBe(0);
    const id = readFileSync(join(f.home, 'current'), 'utf8').split('\n')[0];
    writeFileSync(join(f.home, 'app', id, 'scripts/release/update-and-start.sh'), '#!/bin/bash\necho "Installed updater invoked"\n');
    const result = spawnSync('/bin/bash', [join(f.source, 'scripts/release/update-and-start.sh'), f.home, f.source], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0); expect(result.stdout).toContain('Installed updater invoked');
  });
  it('preserves the legacy source database through both startup entries without overriding an explicit database', () => {
    const f = fixture();
    const home = join(f.source, 'ore-portable');
    const run = (entry: string, explicit?: string) => {
      const env: NodeJS.ProcessEnv = { ...process.env, ORE_SKIP_UPDATE: entry.endsWith('/start.command') ? '1' : '0' };
      delete env.ROLEPLAY_DATABASE;
      return spawnSync('/bin/bash', [entry], { cwd: f.root, encoding: 'utf8', env: { ...env, ...(explicit ? { ROLEPLAY_DATABASE: explicit } : {}) } });
    };
    const initial = run(join(f.source, 'start-app.command')); expect(initial.status, initial.stdout+initial.stderr).toBe(0);
    const legacy = join(f.source, 'data/roleplay.sqlite');
    expect(initial.stdout).toContain(JSON.stringify(legacy));
    const repeat = run(join(f.source, 'start-app.command'));
    expect(repeat.status, repeat.stdout+repeat.stderr).toBe(0); expect(repeat.stdout).toContain('No build needed');
    const linux = run(join(f.source, 'start.sh'));
    expect(linux.status, linux.stdout+linux.stderr).toBe(0); expect(linux.stdout).toContain(JSON.stringify(legacy));
    expect(readFileSync(join(home, 'build-calls'), 'utf8').trim().split('\n')).toEqual([f.first]);
    expect(run(join(home, 'start.command')).stdout).toContain(JSON.stringify(legacy));
    const explicit = join(f.root, 'explicit.sqlite');
    expect(run(join(home, 'start.command'), explicit).stdout).toContain(JSON.stringify(explicit));
  });
  it('rejects installation arguments on both source entries before changing another installation', () => {
    const f = fixture();
    for (const name of ['start-app.command', 'start.sh']) {
      const result = spawnSync('/bin/bash', [join(f.source, name), f.home], { cwd: f.root, encoding: 'utf8' });
      expect(result.status).toBe(1); expect(result.stderr).toContain('no arguments');
    }
    expect(f.calls()).toEqual([]); expect(existsSync(join(f.source, 'ore-portable'))).toBe(false); f.preserved();
  });
  it('rejects a linked installation directory instead of building outside the repository', () => {
    const f = fixture(); symlinkSync(f.home, join(f.source, 'ore-portable'));
    const result = spawnSync('/bin/bash', [join(f.source, 'start-app.command')], { cwd: f.root, encoding: 'utf8' });
    expect(result.status).toBe(1); expect(result.stderr).toContain('not a symbolic link');
    expect(existsSync(join(f.home, 'database-path.txt'))).toBe(false); expect(f.calls()).toEqual([]); f.preserved();
  });
  it('rejects an invalid remembered database path instead of launching a different empty database', () => {
    const f = fixture(); expect(f.run().status).toBe(0);
    rmSync(join(f.home, 'database-location.json'));
    for (const path of ['', 'relative.sqlite']) {
      writeFileSync(join(f.home, 'database-path.txt'), path);
      const result = f.run(true, true); expect(result.status).not.toBe(0); expect(result.stderr).toContain('Invalid legacy database path'); expect(result.stdout).not.toContain('launchedCommit');
    }
    expect(f.calls()).toEqual([f.first]); f.preserved();
  });
  it('retains the committed app and releases the lock after a terminal signal interrupts a build', async () => {
    const f = fixture(); expect(f.run().status).toBe(0); f.advance('WAIT_BUILD');
    const before = readFileSync(join(f.home, 'current'), 'utf8');
    const child = spawn('/bin/bash', [join(f.source, 'scripts/release/update-and-start.sh'), f.home], { cwd: f.root, detached: true, stdio: 'ignore', env: { ...process.env, ORE_SKIP_UPDATE: '0' } });
    if (!child.pid) throw new Error('No test launcher process.');
    const pid = child.pid;
    const exited = new Promise<void>((resolve, reject) => { child.once('exit', () => resolve()); child.once('error', reject); });
    try {
      const deadline = Date.now()+5000;
      while (!existsSync(join(f.home, 'build-waiting')) && Date.now()<deadline) await delay(20);
      expect(existsSync(join(f.home, 'build-waiting'))).toBe(true);
      process.kill(-pid, 'SIGTERM');
      await exited;
      while (existsSync(join(f.home, 'cache/update.lock')) && Date.now()<deadline) await delay(20);
      expect(readFileSync(join(f.home, 'current'), 'utf8')).toBe(before); f.preserved();
    } finally {
      try { process.kill(-pid, 'SIGKILL'); } catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') throw error; }
      await exited;
    }
  });
});
