import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { releaseServer } from './support/release-server.js';

const roots: string[] = [];
// These are real Bash/Node/archive/SQLite process workflows. Keep the runner's
// total budget above the per-readiness bounds even under concurrent builds.
vi.setConfig({ testTimeout: 20_000, hookTimeout: 10_000 });
const children = new Set<ChildProcess>();
afterEach(async () => {
  for (const child of children) { child.kill('SIGTERM'); await new Promise<void>(accept => child.exitCode !== null ? accept() : child.once('exit', () => accept())); }
  children.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const commitA = 'a'.repeat(40), commitB = 'b'.repeat(40);
function command(path: string, source: string) { writeFileSync(path, `#!/bin/bash\nset -euo pipefail\n${source}\n`, { mode: 0o755 }); }
function fixture(language: string | null = 'en-US') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ORE standalone-история-$%-'))); roots.push(root);
  const parent = join(root, 'chosen folder $(literal); %s'), home = join(parent, 'ORE-internal'), tools = join(root, 'tools');
  mkdirSync(parent); mkdirSync(tools); writeFileSync(join(parent, 'unrelated.txt'), 'preserve parent');
  const shimPath = `${tools}:/usr/bin:/bin:/usr/sbin:/sbin`;
  const instrument = (text: string) => text.replaceAll('export PATH=/usr/bin:/bin:/usr/sbin:/sbin', `export PATH=${quote(shimPath)}`);
  writeFileSync(join(parent, 'ORE-launcher.command'), instrument(readFileSync('ORE-launcher.command', 'utf8')), { mode: 0o755 });
  const writeLanguage = (locale: string | null) => writeFileSync(join(root, 'preferences'), JSON.stringify(locale === null ? {} : { AppleLanguages: [locale] }));
  writeLanguage(language);
  command(join(tools, 'defaults'), `cat ${quote(join(root, 'preferences'))}`);
  // Instrument every forbidden tool, including tools supplied by developer Macs.
  for (const name of ['git', 'node', 'npm', 'python', 'python3', 'jq', 'brew', 'cc', 'clang', 'make', 'xcodebuild', 'xcrun']) command(join(tools, name), `printf '%s\\n' ${quote(name)} >> ${quote(join(root, 'forbidden'))}; exit 99`);
  writeFileSync(join(root, 'main.json'), JSON.stringify({ sha: commitA }));
  writeFileSync(join(root, 'compare.json'), JSON.stringify({ status: 'ahead', base_commit: { sha: commitA }, merge_base_commit: { sha: commitA } }));
  command(join(tools, 'curl'), `
url=''; output=''
while [ "$#" -gt 0 ]; do
  case "$1" in https://*) url=$1;; -o) shift; output=$1;; esac
  shift
done
printf '%s\\n' "$url" >> ${quote(join(root, 'calls'))}
mode=$(cat ${quote(join(root, 'mode'))} 2>/dev/null || true)
case "$mode" in offline) exit 6;; delay) exec /bin/sleep 30;; esac
case "$url" in
  */commits/main) cp ${quote(join(root, 'main.json'))} "$output";;
  */compare/*) cp ${quote(join(root, 'compare.json'))} "$output";;
  *nodejs.org*) cp ${quote(join(root, 'toolkit.tar.gz'))} "$output";;
  */archive/*.tar.gz) cp ${quote(join(root, 'source.tar.gz'))} "$output";;
  *) exit 90;;
esac
`);
  const runtimeId = `node-v24.19.0-darwin-${process.arch}`;
  const toolkit = join(root, 'toolkit', runtimeId);
  mkdirSync(join(toolkit, 'bin'), { recursive: true }); mkdirSync(join(toolkit, 'lib/node_modules/npm/bin'), { recursive: true });
  command(join(toolkit, 'bin/node'), `if [ "$1" = --version ]; then echo v24.19.0; else exec ${quote(process.execPath)} "$@"; fi`);
  const server = `import {createRequire} from 'node:module';\nconst Database=createRequire(import.meta.url)('better-sqlite3');\nimport {mkdirSync,existsSync,appendFileSync} from 'node:fs';\nimport {dirname} from 'node:path';\nmkdirSync(dirname(process.env.ROLEPLAY_DATABASE),{recursive:true});\nconst db=new Database(process.env.ROLEPLAY_DATABASE); db.exec('CREATE TABLE IF NOT EXISTS sentinel(text TEXT)'); db.close();\nappendFileSync(${JSON.stringify(join(root,'server-calls'))},process.env.ROLEPLAY_PORT+'\\n');\nif(existsSync(${JSON.stringify(join(root,'fail-probe'))}) || (process.env.ROLEPLAY_PORT==='0' && existsSync(${JSON.stringify(join(root,'fail-live'))}))) throw Error('SYNTHETIC STARTUP FAILURE');\nconsole.log('SYNTHETIC SERVER WARNING');\n${releaseServer}`;
  const stub = `import {mkdirSync,writeFileSync,appendFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
appendFileSync(${JSON.stringify(join(root, 'build-calls'))},process.argv.slice(2).join(' ')+'\\n');
console.error('SYNTHETIC DEPENDENCY WARNING');
if (process.argv.includes('build')) {
  if(existsSync(${JSON.stringify(join(root,'fail-build'))})) process.exit(42);
  if(existsSync(${JSON.stringify(join(root,'delay-build'))})) await new Promise(accept=>setTimeout(accept,30000));
  ${['dist/client', 'dist/server/server', 'dist/server/shared', 'node_modules/better-sqlite3'].map(path => `mkdirSync(${JSON.stringify(path)},{recursive:true});`).join('\n')}
  writeFileSync('dist/server/server/main.js',${JSON.stringify(server)});
  writeFileSync('dist/server/server/picture-worker.js','');
  writeFileSync('dist/server/shared/build-info.js','export const databaseSchemaVersion=15;');
  writeFileSync('dist/client/index.html','<title>ORE</title>');
  writeFileSync('node_modules/better-sqlite3/package.json','{"name":"better-sqlite3","version":"fixture","main":"index.cjs"}');
  writeFileSync('node_modules/better-sqlite3/index.cjs',${JSON.stringify(`module.exports=require(${JSON.stringify(resolve('node_modules/better-sqlite3'))});`)});
}
`;
  writeFileSync(join(toolkit, 'lib/node_modules/npm/bin/npm-cli.js'), stub);
  expect(spawnSync('/usr/bin/tar', ['-czf', join(root, 'toolkit.tar.gz'), '-C', join(root, 'toolkit'), runtimeId]).status).toBe(0);
  const runtimeDigest = createHash('sha256').update(readFileSync(join(root, 'toolkit.tar.gz'))).digest('hex');
  function archive(commit = commitA, edit?: (source: string) => void) {
    const source = join(root, `Open-Roleplay-Engine-${commit}`);
    mkdirSync(source);
    cpSync('scripts/release', join(source, 'scripts/release'), { recursive: true });
    cpSync('build-portable.sh', join(source, 'build-portable.sh'));
    writeFileSync(join(source, 'scripts/release/macos-launcher.sh'), instrument(readFileSync('scripts/release/macos-launcher.sh', 'utf8')));
    writeFileSync(join(source, 'scripts/release/native-smoke.mjs'), '// Native loads are exercised separately with the actual toolkit.');
    writeFileSync(join(source, 'scripts/release/node-SHASUMS256.txt'), `${runtimeDigest}  ${runtimeId}.tar.gz\n`);
    for (const path of ['src', 'public', 'migrations', 'docs']) mkdirSync(join(source, path));
    for (const path of ['tsconfig.json','tsconfig.server.json','vite.config.ts','vitest.config.ts','playwright.config.ts','index.html','LICENSE','docs/RELEASES.md','package-lock.json','migrations/0014_library_sorting.sql']) writeFileSync(join(source, path), '');
    writeFileSync(join(source, 'package.json'), '{"type":"module"}');
    edit?.(source);
    expect(spawnSync('/usr/bin/tar', ['-czf', join(root, 'source.tar.gz'), '-C', root, `Open-Roleplay-Engine-${commit}`]).status).toBe(0);
    return source;
  }
  archive();
  const env = { HOME: root, PATH: shimPath, ORE_OPEN_BROWSER: '0', ROLEPLAY_PORT: '0', LANG: 'C', LC_ALL: 'en_US.UTF-8' };
  const run = (overrides = {}) => spawn('/bin/bash', [join(parent, 'ORE-launcher.command')], { cwd: '/', env: { ...env, ...overrides }, stdio: ['ignore','pipe','pipe'] });
  const logs = () => existsSync(join(home, 'logs')) ? readdirSync(join(home, 'logs')).map(name => readFileSync(join(home, 'logs', name), 'utf8')).join('\n') : '';
  const calls = () => existsSync(join(root, 'calls')) ? readFileSync(join(root, 'calls'), 'utf8').trim().split('\n') : [];
  return { root, parent, home, tools, run, archive, logs, calls, writeLanguage, env };
}
function observe(child: ChildProcess) {
  children.add(child);
  let output = '';
  child.stdout?.on('data', bytes => { output += String(bytes); });
  child.stderr?.on('data', bytes => { output += String(bytes); });
  const done = new Promise<number | null>((accept, reject) => { child.once('error', reject); child.once('exit', code => { children.delete(child); accept(code); }); });
  async function until(text: string) {
    const deadline = Date.now() + 15000;
    while (!output.includes(text)) {
      if (child.exitCode !== null || Date.now() > deadline) throw new Error(`Missing ${text}: ${output}`);
      await delay(20);
    }
  }
  return { child, done, output: () => output, until, stop: async () => { child.kill('SIGTERM'); return done; } };
}
async function completed(child: ChildProcess) { const observed = observe(child); const status = await observed.done; return { status, output: observed.output() }; }

describe.skipIf(process.platform !== 'darwin')('standalone macOS launcher', () => {
  it('installs an exact archive without adjacent files/global tools, reuses unchanged main and forwards updates', async () => {
    const f = fixture();
    writeFileSync(join(f.parent, '.env'), 'invalid parent secret never read');
    const first = observe(f.run());
    try { await first.until('ORE is ready.'); }
    catch (error) { throw new Error(`${String(error)}\n${f.logs()}`); }
    await first.stop();
    expect(first.output()).toContain('Checking new version...\nActivating new version...');
    expect(first.output()).not.toContain('SYNTHETIC');
    expect(first.output()).not.toContain('Opening your browser');
    expect(f.logs()).toContain('SYNTHETIC DEPENDENCY WARNING'); expect(f.logs()).toContain('SYNTHETIC SERVER WARNING');
    expect(existsSync(join(f.root, 'forbidden'))).toBe(false);
    expect(readFileSync(join(f.parent, 'unrelated.txt'), 'utf8')).toBe('preserve parent');
    expect(readFileSync(join(f.home, '.env'), 'utf8')).toBe('');
    const selectedA = readFileSync(join(f.home, 'current'), 'utf8');
    const buildCalls = readFileSync(join(f.root, 'build-calls'), 'utf8');
    const second = observe(f.run()); await second.until('ORE is ready.'); await second.stop();
    expect(second.output().match(/^ORE$/gm)).toHaveLength(1);
    expect(second.output()).toContain('ORE is up to date.');
    expect(readFileSync(join(f.root, 'build-calls'), 'utf8')).toBe(buildCalls);
    expect(f.calls().filter(url => url.includes('/archive/'))).toHaveLength(1);
    expect(f.calls().filter(url => url.includes('nodejs.org'))).toHaveLength(1);
    writeFileSync(join(f.home, '.env'), 'ORE_OPEN_BROWSER=0\nSYNTHETIC_SECRET="$(exit 42) %s $HOME"\n');
    f.archive(commitB); writeFileSync(join(f.root, 'main.json'), JSON.stringify({ sha: commitB }));
    const third = observe(f.run()); await third.until('ORE is ready.'); await third.stop();
    expect(readFileSync(join(f.home, 'previous'), 'utf8')).toBe(selectedA);
    expect(readFileSync(join(f.home, 'current'), 'utf8')).toContain(commitB.slice(0,12));
    expect(f.calls()).toContain(`https://github.com/olegpro171/Open-Roleplay-Engine/archive/${commitB}.tar.gz`);
    expect(f.calls()).toContain('https://api.github.com/repos/olegpro171/Open-Roleplay-Engine/commits/main');
    expect(f.calls()).toContain(`https://api.github.com/repos/olegpro171/Open-Roleplay-Engine/compare/${commitA}...${commitB}?per_page=1`);
    expect(f.logs()).toContain(commitA); expect(f.logs()).toContain(commitB);
    expect(f.logs()).not.toContain('$(exit 42) %s $HOME');
    expect(readFileSync(join(f.home, '.env'), 'utf8')).toContain('$(exit 42)');
    expect(statSync(join(f.home, 'logs', readdirSync(join(f.home,'logs'))[0])).mode & 0o777).toBe(0o600);
  }, 30000);
  it.each(['ru','ru-RU','ru_RU','en-GB','xx-ZZ',null,'ru;$(exit 1)'])('selects the system language as data: %s', async locale => {
    const f = fixture(locale);
    writeFileSync(join(f.root,'mode'), 'offline');
    const result = await completed(f.run());
    expect(result.status).not.toBe(0);
    expect(readdirSync(join(f.home,'logs')).every(name=>name.endsWith('.txt'))).toBe(true);
    expect(f.logs()).toContain('HTTPS request: https://api.github.com/repos/olegpro171/Open-Roleplay-Engine/commits/main');
    expect(result.output).toContain(locale === 'ru' || locale === 'ru-RU' || locale === 'ru_RU' ? 'Не удалось завершить загрузку ORE.' : "ORE couldn't finish downloading.");
    expect(result.output).not.toContain('curl:');
  });
  it('keeps EN/RU catalog placeholders exact, generated assets current, and substitutions literal', () => {
    expect(spawnSync(process.execPath, ['scripts/release/generate-macos-launcher.mjs','--check']).status).toBe(0);
    expect(spawnSync('/bin/bash',['-n','ORE-launcher.command']).status).toBe(0);
    expect(statSync('ORE-launcher.command').mode & 0o111).toBe(0o111);
    const script = `import {launcherMessage} from './scripts/release/launcher-messages.mjs'; console.log(launcherMessage('openUrl','unsupported',{url:'https://example.invalid/$() %s {url}'}));`;
    expect(spawnSync(process.execPath, ['--input-type=module','-e',script],{encoding:'utf8'}).stdout).toBe('Open: https://example.invalid/$() %s {url}\n');
    const root=mkdtempSync(join(tmpdir(),'ORE-catalog-')); roots.push(root);
    cpSync('scripts/release/launcher-messages.mjs',join(root,'launcher-messages.mjs'));
    const catalog=JSON.parse(readFileSync('scripts/release/launcher-messages.json','utf8'));
    delete catalog.openUrl.ru;
    writeFileSync(join(root,'launcher-messages.json'),JSON.stringify(catalog));
    const missing=spawnSync(process.execPath,['--input-type=module','-e',"import {launcherMessage} from './launcher-messages.mjs'; console.log(launcherMessage('openUrl','ru',{url:'literal %s $()'}));"],{cwd:root,encoding:'utf8'});
    expect(missing.stdout).toBe('Open: literal %s $()\n');
  });
  it.each(['file','directory','link'])('rejects an unrelated adjacent %s without changing it', async kind => {
    const f = fixture();
    if (kind === 'file') writeFileSync(f.home,'unrelated');
    else if (kind === 'link') symlinkSync(f.root,f.home);
    else { mkdirSync(f.home); writeFileSync(join(f.home,'sentinel'),'preserve'); }
    const result = await completed(f.run());
    expect(result.output).toContain("isn't an ORE installation");
    expect(f.calls()).toEqual([]); expect(f.logs()).toBe('');
    if (kind === 'directory') expect(readFileSync(join(f.home,'sentinel'),'utf8')).toBe('preserve');
  });
  it('retries recognized partial installs, ignores parent env and reports invalid installation env lines', async () => {
    const f = fixture(); mkdirSync(f.home); writeFileSync(join(f.home,'.ore-installation'),'ORE-installation:1\n');
    writeFileSync(join(f.home,'.env'),'# comment\r\nprivate invalid secret\r\n');
    const result = await completed(f.run()); expect(result.output).toContain('at line 2.'); expect(f.logs()).not.toContain('private invalid secret');
    writeFileSync(join(f.home,'.env'),'ORE_SKIP_UPDATE=1\n');
    const skip = await completed(f.run()); expect(skip.status).not.toBe(0); expect(f.calls()).toEqual([]);
    const success = observe(f.run({ORE_SKIP_UPDATE:'0'})); await success.until('ORE is ready.'); await success.stop();
  });
  it.each(['behind','diverged','unknown'])('refuses %s ancestry and visibly starts the preserved selection', async status => {
    const f = fixture(); const installed = observe(f.run()); await installed.until('ORE is ready.'); await installed.stop();
    const before = readFileSync(join(f.home,'current'),'utf8');
    writeFileSync(join(f.root,'main.json'),JSON.stringify({sha:commitB})); writeFileSync(join(f.root,'compare.json'),JSON.stringify({status,base_commit:{sha:commitA},merge_base_commit:{sha:commitA}}));
    const fallback = observe(f.run()); await fallback.until('ORE is ready.'); await fallback.stop();
    expect(fallback.output()).toContain("Couldn't check for updates. Starting the installed version.");
    expect(readFileSync(join(f.home,'current'),'utf8')).toBe(before);
    expect(f.calls().filter(url=>url.includes('/archive/'))).toHaveLength(1);
  });
  it('falls back offline, rejects concurrent launches, and never recreates a missing established database', async () => {
    const f = fixture(); const installed = observe(f.run()); await installed.until('ORE is ready.');
    const blocked = await completed(f.run()); expect(blocked.output).toContain("ORE's installation is locked."); expect(blocked.status).toBe(75);
    await installed.stop(); writeFileSync(join(f.root,'mode'),'offline');
    const offline = observe(f.run()); await offline.until('ORE is ready.'); await offline.stop(); expect(offline.output()).toContain("Couldn't check for updates.");
    const database = join(f.home,'data/roleplay.sqlite'); const bytes = readFileSync(database); rmSync(database);
    const failed = await completed(f.run()); expect(failed.output).toContain("ORE couldn't start."); expect(failed.output).not.toContain('Cancelled.');
    expect(existsSync(database)).toBe(false); expect(f.logs()).toContain('Established database is missing');
    writeFileSync(database,bytes);
    // Three process lifecycles share this test. Its total budget must exceed
    // the individual readiness bound, including under concurrent native builds.
  },15000);
  it('rejects source links before extraction/execution and permits safe explicit retry', async () => {
    const f = fixture(); rmSync(join(f.root,`Open-Roleplay-Engine-${commitA}`),{recursive:true});
    f.archive(commitA,source=>symlinkSync('/tmp',join(source,'src','escape')));
    const bad = await completed(f.run()); expect(bad.output).toContain("A downloaded file couldn't be verified."); expect(existsSync(join(f.root,'build-calls'))).toBe(false);
    expect(existsSync(join(f.home,'cache/update.lock'))).toBe(false);
    rmSync(join(f.root,`Open-Roleplay-Engine-${commitA}`),{recursive:true}); f.archive();
    const good = observe(f.run()); await good.until('ORE is ready.'); await good.stop();
  });
  it('rejects malformed metadata, unverified runtime bytes, log creation failure and unsupported systems', async () => {
    const f = fixture(); writeFileSync(join(f.root,'main.json'),'{"sha":42}');
    expect((await completed(f.run())).output).toContain("ORE couldn't finish downloading.");
    writeFileSync(join(f.root,'main.json'),JSON.stringify({sha:commitA})); writeFileSync(join(f.root,'toolkit.tar.gz'),'truncated');
    expect((await completed(f.run())).output).toContain("A downloaded file couldn't be verified."); expect(existsSync(join(f.home,'current'))).toBe(false);
    chmodSync(join(f.home,'logs'),0o500);
    try { expect((await completed(f.run())).output).toContain("ORE couldn't create its log file."); } finally { chmodSync(join(f.home,'logs'),0o700); }
    command(join(f.tools,'uname'),'echo Unsupported');
    expect((await completed(f.run())).output).toContain("This operating system or processor isn't supported.");
  });
  it('cancels an owned download and releases locks without building or claiming success', async () => {
    const f = fixture(); writeFileSync(join(f.root,'mode'),'delay');
    const current = observe(f.run()); await current.until('Checking for updates...'); await current.stop();
    expect(current.output()).toContain('Cancelled. Run the launcher again to retry.');
    expect(existsSync(join(f.home,'current'))).toBe(false); expect(existsSync(join(f.home,'cache/update.lock'))).toBe(false);
  });
  it('preserves installed data/selection on build failure and retries explicitly', async () => {
    const f=fixture(); const first=observe(f.run()); await first.until('ORE is ready.'); await first.stop();
    const selection=readFileSync(join(f.home,'current'),'utf8');
    f.archive(commitB); writeFileSync(join(f.root,'main.json'),JSON.stringify({sha:commitB})); writeFileSync(join(f.root,'fail-build'),'fail');
    const failed=observe(f.run()); await failed.until('ORE is ready.'); await failed.stop();
    expect(failed.output()).toContain("Couldn't finish the update. Starting the installed version.");
    expect(readFileSync(join(f.home,'current'),'utf8')).toBe(selection);
    expect(existsSync(join(f.home,'data/roleplay.sqlite'))).toBe(true);
    rmSync(join(f.root,'fail-build'));
    const retry=observe(f.run()); await retry.until('ORE is ready.'); await retry.stop();
    expect(readFileSync(join(f.home,'current'),'utf8')).toContain(commitB.slice(0,12));
  },15000);
  it('preserves the primary first-install build exit status through cleanup', async () => {
    const f=fixture(); writeFileSync(join(f.root,'fail-build'),'fail');
    const result=await completed(f.run()); expect(result.status).toBe(42);
    expect(result.output).toContain("ORE couldn't build the application.");
    expect(existsSync(join(f.home,'cache/update.lock'))).toBe(false);
    expect(existsSync(join(f.home,'cache/build.lock'))).toBe(false);
  });
  it('rejects actual probe failure, retains its diagnostic, and never activates it', async () => {
    const f=fixture(); writeFileSync(join(f.root,'fail-probe'),'fail');
    const result=await completed(f.run());
    expect(result.output).toContain("ORE couldn't build the application.");
    expect(result.output).not.toContain('SYNTHETIC STARTUP FAILURE');
    expect(f.logs()).toContain('SYNTHETIC STARTUP FAILURE');
    expect(existsSync(join(f.home,'current'))).toBe(false);
    expect(existsSync(join(f.home,'data/roleplay.sqlite'))).toBe(false);
  });
  it('stops after new live startup fails, retaining current/previous rather than launching old code', async () => {
    const f=fixture(); const first=observe(f.run()); await first.until('ORE is ready.'); await first.stop();
    const previous=readFileSync(join(f.home,'current'),'utf8');
    const before=readFileSync(join(f.root,'server-calls'),'utf8').trim().split('\n').length;
    f.archive(commitB); writeFileSync(join(f.root,'main.json'),JSON.stringify({sha:commitB})); writeFileSync(join(f.root,'fail-live'),'fail');
    const result=await completed(f.run());
    expect(result.output).toContain("ORE couldn't start."); expect(result.output).not.toContain('Starting the installed version.');
    expect(result.output).not.toContain('Cancelled.');
    expect(readFileSync(join(f.home,'current'),'utf8')).toContain(commitB.slice(0,12));
    expect(readFileSync(join(f.home,'previous'),'utf8')).toBe(previous);
    expect(readFileSync(join(f.root,'server-calls'),'utf8').trim().split('\n').length-before).toBe(2);
  },15000);
  it('reports activation failure without selecting an incomplete payload', async () => {
    const f=fixture(); const pending=observe(f.run()); await pending.until('Checking new version...');
    chmodSync(join(f.home,'app'),0o500);
    try { await pending.done; expect(pending.output()).toContain("ORE couldn't activate the new version."); expect(existsSync(join(f.home,'current'))).toBe(false); }
    finally { chmodSync(join(f.home,'app'),0o700); }
  });
  it('reports nonzero browser exit while retaining the running server', async () => {
    const f=fixture(); command(join(f.tools,'open'),'exit 9');
    const pending=observe(f.run({ORE_OPEN_BROWSER:'1'})); await pending.until("Your browser couldn't be opened automatically.");
    expect(pending.output()).toContain('Opening your browser...'); expect(pending.output()).toContain('Open: http://127.0.0.1:');
    await pending.stop(); expect(f.logs()).toContain('Browser open failed: exit 9');
  });
  it('reports browser spawn failure without stopping the server', async () => {
    const f=fixture(); const first=observe(f.run()); await first.until('ORE is ready.'); await first.stop();
    const [id]=readFileSync(join(f.home,'current'),'utf8').trim().split('\n');
    const pending=observe(spawn(process.execPath,[join(f.home,'app',id,'scripts/release/portable-launch.mjs'),f.home],{env:{...f.env,PATH:'/nonexistent',ORE_OPEN_BROWSER:'1'},stdio:['ignore','pipe','pipe']}));
    await pending.until("Your browser couldn't be opened automatically."); await pending.stop();
    expect(pending.output()).toContain('ORE stopped.');
  });
  it('refuses unknown helper protocols without recursion or another build', async () => {
    const f=fixture(); const first=observe(f.run()); await first.until('ORE is ready.'); await first.stop();
    const [id]=readFileSync(join(f.home,'current'),'utf8').trim().split('\n');
    const before=f.calls(); writeFileSync(join(f.home,'app',id,'scripts/release/macos-launcher-protocol'),'999\n');
    const failed=await completed(f.run()); expect(failed.output).toContain("ORE couldn't finish setting up."); expect(f.calls()).toEqual(before);
  });
  it('resolves literal relative database overrides against the invoking directory and preserves explicit env precedence', async () => {
    const f=fixture(); mkdirSync(f.home); writeFileSync(join(f.home,'.ore-installation'),'ORE-installation:1\n');
    writeFileSync(join(f.home,'.env'),'ROLEPLAY_DATABASE="wrong-from-file.sqlite"\r\nORE_OPEN_BROWSER=1\r\n');
    const external=join(f.root,'relative %s $().sqlite');
    const pending=observe(f.run({ROLEPLAY_DATABASE:external.slice(1)})); await pending.until('ORE is ready.'); await pending.stop();
    expect(existsSync(external)).toBe(true); expect(existsSync(join(f.home,'data/roleplay.sqlite'))).toBe(false);
    expect(pending.output()).not.toContain('Opening your browser...');
    expect(readFileSync(join(f.home,'.env'),'utf8')).toContain('wrong-from-file.sqlite');
  });
  it.each(['../escape','/absolute-escape'])('refuses archive path rewriting to %s before extraction', async replacement => {
    const f=fixture();
    expect(spawnSync('/usr/bin/tar',['-czf',join(f.root,'source.tar.gz'),'-s',`,Open-Roleplay-Engine-${commitA}/src,${replacement},`,'-C',f.root,`Open-Roleplay-Engine-${commitA}`]).status).toBe(0);
    const result=await completed(f.run()); expect(result.output).toContain("A downloaded file couldn't be verified.");
    expect(existsSync(join(f.root,'build-calls'))).toBe(false);
  });
  it.each([`Roleplay-Engine-${commitA}`, `Other-Repository-${commitA}`, `Open-Roleplay-Engine-${commitB}`])('rejects a mismatched archive root %s before building', async root => {
    const f = fixture();
    expect(spawnSync('/usr/bin/tar', ['-czf', join(f.root, 'source.tar.gz'), '-s', `,Open-Roleplay-Engine-${commitA},${root},`, '-C', f.root, `Open-Roleplay-Engine-${commitA}`]).status).toBe(0);
    const result = await completed(f.run());
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("A downloaded file couldn't be verified.");
    expect(existsSync(join(f.root, 'build-calls'))).toBe(false);
    expect(existsSync(join(f.home, 'current'))).toBe(false);
  });
  it('reports later report write failure instead of promising a usable report', async () => {
    const f=fixture();
    const shim=join(f.tools,'curl');
    writeFileSync(shim,readFileSync(shim,'utf8').replace('set -euo pipefail',"set -euo pipefail\nprintf '%2048s\\n' 'SYNTHETIC LOG FILL'"));
    const pending=observe(spawn('/bin/bash',['-c','ulimit -f 1; exec /bin/bash "$1"','test',join(f.parent,'ORE-launcher.command')],{cwd:'/',env:f.env,stdio:['ignore','pipe','pipe']}));
    await pending.done; expect(pending.output()).toContain("ORE couldn't create its log file.");
    expect(pending.output()).not.toContain('For technical assistance, share this log file:');
    expect(existsSync(join(f.home,'current'))).toBe(false);
  });
  it('shuts down its server and releases only its own lock after controller loss', async () => {
    const f=fixture(); const pending=observe(f.run()); await pending.until('ORE is ready.');
    const match=pending.output().match(/Open: (http:\/\/127\.0\.0\.1:\d+)/u); expect(match).not.toBeNull();
    if(!match) throw Error('Missing owned server URL');
    pending.child.kill('SIGKILL'); await pending.done;
    const deadline=Date.now()+5000;
    while(existsSync(join(f.home,'cache/update.lock')) && Date.now()<deadline) await delay(20);
    expect(existsSync(join(f.home,'cache/update.lock'))).toBe(false);
    await expect(fetch(match[1])).rejects.toThrow();
    const retry=observe(f.run()); await retry.until('ORE is ready.'); await retry.stop();
  },10000);
  it.each(['external', 'internal'])('recovers a missing selected helper through the %s entry', async entry => {
    const f = fixture();
    const first = observe(f.run()); await first.until('ORE is ready.'); await first.stop();
    const selected = readFileSync(join(f.home, 'current'), 'utf8');
    const [id] = selected.split('\n');
    rmSync(join(f.home, 'app', id, 'scripts/release/macos-launcher.sh'));
    const recovered = observe(entry === 'external' ? f.run({ORE_SKIP_UPDATE:'1'}) : spawn('/bin/bash', [join(f.home, 'start.command')], {cwd:'/', env:{...f.env, ORE_SKIP_UPDATE:'1'}, stdio:['ignore','pipe','pipe']}));
    await recovered.until('ORE is ready.'); await recovered.stop();
    expect(readFileSync(join(f.home, 'current'), 'utf8')).toBe(selected);
    expect(existsSync(join(f.home, 'data/roleplay.sqlite'))).toBe(true);
  });
  it.each(['external', 'internal'])('recovers an empty or non-regular selected helper through the %s entry', async entry => {
    const f = fixture();
    const first = observe(f.run()); await first.until('ORE is ready.'); await first.stop();
    const selection = readFileSync(join(f.home, 'current'), 'utf8');
    const [id] = selection.split('\n');
    const script = join(f.home, 'app', id, 'scripts/release/macos-launcher.sh');
    for (const kind of ['empty', 'directory', 'syntax', 'unreadable']) {
      if (kind === 'directory') { rmSync(script); mkdirSync(script); }
      else {
        if (kind === 'syntax') rmSync(script, {recursive:true});
        writeFileSync(script, '');
        if (kind === 'syntax') writeFileSync(script, 'if then\n');
        if (kind === 'unreadable') { writeFileSync(script, '#!/bin/bash\nexit 99\n'); chmodSync(script, 0o000); }
      }
      const recovered = observe(entry === 'external' ? f.run({ORE_SKIP_UPDATE:'1'}) : spawn('/bin/bash', [join(f.home,'start.command')], {cwd:'/', env:{...f.env, ORE_SKIP_UPDATE:'1'}, stdio:['ignore','pipe','pipe']}));
      await recovered.until('ORE is ready.'); await recovered.stop();
      expect(readFileSync(join(f.home,'current'),'utf8')).toBe(selection);
    }
  },30000);
  it.each(['external', 'internal'])('fails cleanly in EN/RU when no usable %s helper remains and rejects unsafe alternatives', async entry => {
    const f = fixture();
    const first = observe(f.run()); await first.until('ORE is ready.'); await first.stop();
    const selection = readFileSync(join(f.home,'current'),'utf8');
    const [id] = selection.split('\n');
    const selected = join(f.home,'app',id,'scripts/release');
    const recovery = join(f.home,'recovery',id);
    const retained = readFileSync(join(recovery,'macos-launcher.sh'));
    const saved = readFileSync(join(f.home,'data/roleplay.sqlite'));
    const reports = readdirSync(join(f.home,'logs'));
    const run = () => entry === 'external' ? f.run() : spawn('/bin/bash',[join(f.home,'start.command')],{cwd:'/',env:f.env,stdio:['ignore','pipe','pipe']});
    rmSync(join(selected,'macos-launcher.sh'));
    rmSync(join(recovery,'macos-launcher.sh'));
    for (const locale of ['en-US','ru-RU']) {
      f.writeLanguage(locale);
      const result = await completed(run());
      expect(result.status).toBe(1);
      expect(result.output).toContain(locale === 'ru-RU' ? 'Не удалось завершить настройку ORE.' : "ORE couldn't finish setting up.");
      expect(result.output).not.toMatch(/No such file|Permission denied|Log file:|Файл журнала:|technical assistance/);
    }
    // An intact recovery copy cannot authorize an unsupported selected protocol.
    writeFileSync(join(recovery,'macos-launcher.sh'),retained);
    writeFileSync(join(selected,'macos-launcher-protocol'),'999\n');
    expect((await completed(run())).status).toBe(1);
    writeFileSync(join(selected,'macos-launcher-protocol'),'1\n');
    symlinkSync(join(recovery,'macos-launcher.sh'),join(selected,'macos-launcher.sh'));
    const unsafe = await completed(run());
    expect(unsafe.status).toBe(1);
    expect(unsafe.output).toContain('не является папкой установки ORE');
    expect(readFileSync(join(f.home,'data/roleplay.sqlite'))).toEqual(saved);
    expect(readFileSync(join(f.home,'current'),'utf8')).toBe(selection);
    expect(readFileSync(join(f.home,'.env'),'utf8')).toBe('');
    expect(readFileSync(join(recovery,'macos-launcher.sh'))).toEqual(retained);
    expect(readdirSync(join(f.home,'logs'))).toEqual(reports);
  });
  it('pins the selected commit even if main moves during the archive transfer', async () => {
    const f=fixture(); const shim=join(f.tools,'curl');
    const transfer=`cp ${quote(join(f.root,'source.tar.gz'))} "$output"`;
    writeFileSync(shim,readFileSync(shim,'utf8').replace(transfer,`printf '%s' '${JSON.stringify({sha:commitB})}' > ${quote(join(f.root,'main.json'))}; ${transfer}`));
    const pending=observe(f.run()); await pending.until('ORE is ready.'); await pending.stop();
    const [id]=readFileSync(join(f.home,'current'),'utf8').split('\n');
    expect(JSON.parse(readFileSync(join(f.home,'app',id,'build-info.json'),'utf8')).commit).toBe(commitA);
    expect(JSON.parse(readFileSync(join(f.root,'main.json'),'utf8')).sha).toBe(commitB);
    expect(f.calls().filter(url=>url.includes('/archive/'))).toEqual([`https://github.com/olegpro171/Open-Roleplay-Engine/archive/${commitA}.tar.gz`]);
  });
  it('uses retained compatible recovery tooling independently of its original payload', async () => {
    const f=fixture(); const first=observe(f.run()); await first.until('ORE is ready.'); await first.stop();
    const old=readFileSync(join(f.home,'current'),'utf8');
    f.archive(commitB); writeFileSync(join(f.root,'main.json'),JSON.stringify({sha:commitB}));
    const next=observe(f.run()); await next.until('ORE is ready.'); await next.stop();
    const [newId]=readFileSync(join(f.home,'current'),'utf8').split('\n');
    writeFileSync(join(f.home,'current'),old);
    const [oldId]=old.split('\n'); rmSync(join(f.home,'app',oldId,'scripts/release/macos-launcher-protocol'));
    rmSync(join(f.home,'app',newId),{recursive:true});
    const recovered=observe(f.run({ORE_SKIP_UPDATE:'1'})); await recovered.until('ORE is ready.'); await recovered.stop();
    expect(recovered.output()).toContain('Updates are paused. Starting the installed version.');
    expect(readFileSync(join(f.home,'current'),'utf8')).toBe(old);
  },15000);
  it('cancels an active build group without late activation or retained locks', async () => {
    const f=fixture(); writeFileSync(join(f.root,'delay-build'),'delay');
    const pending=observe(f.run()); await pending.until('Building new version...');
    const deadline=Date.now()+5000;
    while((!existsSync(join(f.root,'build-calls')) || !readFileSync(join(f.root,'build-calls'),'utf8').includes('run build')) && Date.now()<deadline) await delay(20);
    expect(readFileSync(join(f.root,'build-calls'),'utf8')).toContain('run build');
    await pending.stop();
    expect(pending.output()).toContain('Cancelled. Run the launcher again to retry.');
    expect(existsSync(join(f.home,'current'))).toBe(false);
    expect(existsSync(join(f.home,'cache/build.lock'))).toBe(false);
    expect(existsSync(join(f.home,'cache/update.lock'))).toBe(false);
  },10000);
});
