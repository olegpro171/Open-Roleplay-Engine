// Native CI qualification with real packaged dependencies and synthetic release transport.
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { inventory } from '../../scripts/release/stage.mjs';

const [releaseArgument, originalCommit] = process.argv.slice(2);
if (process.platform !== 'win32' || !releaseArgument || !/^[a-f0-9]{40}$/u.test(originalCommit ?? '')) throw Error('Expected Windows release directory and full commit.');
const releaseDirectory = resolve(releaseArgument);
const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ORE-package-история-')));
const parent = join(root, "chosen папка ' &() % !"), home = join(parent, 'ORE-internal');
mkdirSync(parent); writeFileSync(join(parent, 'unrelated.txt'), 'preserved');
const entry = join(parent, 'ORE-launcher.bat');
const ps = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const calls = join(root, 'requests.txt');
const shippedCommit = 'f553710121c858731bb479659965a09c271df524';
const shipped = readFileSync(resolve('tests/fixtures/windows-launcher/f553710121c8.bat'));
assert.equal(createHash('sha256').update(shipped).digest('hex'), '36da2eba41f560881797eaf4cd042ec3f11769b60b2e6fbbdcc98a3dc2f357ef');
const cutover = readFileSync(join(releaseDirectory, 'ORE-launcher.bat'));
assert.deepEqual(cutover, readFileSync(resolve('ORE-launcher.bat')));
const markerLine = '# ORE_POWERSHELL_PAYLOAD';
const shippedText = shipped.toString('utf8');
const shippedHelper = '\ufeff' + shippedText.slice(shippedText.lastIndexOf(markerLine) + markerLine.length).trimStart();

const reservation = createServer();
await new Promise<void>(accept => reservation.listen(0, '127.0.0.1', accept));
const address = reservation.address(); assert(address && typeof address !== 'string');
const port = address.port;
await new Promise<void>(accept => reservation.close(() => accept()));
const transport = `
function Get-OreHttps([string]$Url,[string]$Output,[int]$Seconds) {
 [IO.File]::AppendAllText($env:ORE_PACKAGE_TEST_CALLS,$Url+"\n")
 if($Url.EndsWith('.zip') -and [IO.File]::Exists($env:ORE_PACKAGE_TEST_HOLD)) {
  [IO.File]::WriteAllText($env:ORE_PACKAGE_TEST_ENTERED,[string]$PID)
  while(!(Test-OreCancellation)){Start-Sleep -Milliseconds 25}
  throw 'Synthetic interrupted download'
 }
 if([IO.File]::Exists($env:ORE_PACKAGE_TEST_OFFLINE)){throw 'Synthetic network unavailable'}
 if($Url.Contains('/releases/latest')){$name='release.json'}
 elseif($Url.Contains('/compare/')){$name='compare.json'}
 elseif($Url.EndsWith('.zip.sha256')){$name='ORE-windows-x64.zip.sha256'}
 elseif($Url.EndsWith('.zip')){$name='ORE-windows-x64.zip'}
 elseif($Url.EndsWith('.json')){$name='ORE-windows-x64.json'}
 else{throw 'Unexpected test download'}
 [IO.File]::Copy((Join-Path $env:ORE_PACKAGE_TEST_TRANSPORT $name),$Output)
}
[IO.File]::WriteAllText($env:ORE_PACKAGE_TEST_OWNER,[string]$PID)
[Console]::WriteLine('Acceptance helper: '+$env:ORE_PACKAGE_TEST_HELPER_VERSION)

`;
function instrument(text: string, before: string, version: string) {
 assert(text.includes(before), before);
 const code = transport.replace('$env:ORE_PACKAGE_TEST_HELPER_VERSION', "'"+version+"'");
 return text.replace(before, code+'\n'+before);
}
// A local transport seam is used only when there is no installed helper yet.
const freshBootstrap = Buffer.from(instrument(cutover.toString('utf8'), '# Bootstrap contract 2.', 'bootstrap'));
function powershell(code: string, env: NodeJS.ProcessEnv) {
 const result = spawnSync(ps, ['-NoProfile', '-ExecutionPolicy', 'RemoteSigned', '-Command', "$ErrorActionPreference='Stop'; . $env:ORE_TEST_PATH_TOOLS; "+code], { env: { ...process.env, ORE_TEST_PATH_TOOLS: resolve('scripts/release/windows-snapshot.ps1'), ...env }, encoding: 'utf8' });
 assert.equal(result.status, 0, result.stdout+result.stderr);
}
const originalPayload = join(root, 'original');
powershell('Expand-OreZip $env:ORE_TEST_ARCHIVE $env:ORE_TEST_ARCHIVE_ROOT $env:ORE_TEST_EXTRACT -LongPaths', { ORE_TEST_ARCHIVE: join(releaseDirectory, 'ORE-windows-x64.zip'), ORE_TEST_ARCHIVE_ROOT: `ORE-${originalCommit.slice(0, 12)}-release-win32-x64`, ORE_TEST_EXTRACT: originalPayload });
function release(commit: string, previousCommit: string, helperVersion: string) {
 const transportRoot = join(root, 'transport-'+commit), packRoot = join(root, 'pack-'+commit);
 mkdirSync(transportRoot); mkdirSync(packRoot);
 const payload = join(packRoot, `ORE-${commit.slice(0, 12)}-release-win32-x64`);
 cpSync(originalPayload, payload, { recursive: true });
 const [oldId, runtime] = readFileSync(join(payload, 'current'), 'utf8').trim().split('\n');
 const id = `release-${commit}`;
 renameSync(join(payload, 'app', oldId), join(payload, 'app', id));
 renameSync(join(payload, 'recovery', oldId), join(payload, 'recovery', id));
 writeFileSync(join(payload, 'current'), `${id}\n${runtime}\n`);
 writeFileSync(join(payload, 'recovery/current'), `${id}\n${runtime}\n`);
 const app = join(payload, 'app', id);
 const info = JSON.parse(readFileSync(join(app, 'build-info.json'), 'utf8')); info.commit = commit;
 writeFileSync(join(app, 'build-info.json'), JSON.stringify(info));
 for (const tools of [join(app, 'scripts/release'), join(payload, 'recovery', id)]) {
  const helper = join(tools, 'windows-package-launcher.ps1');
  const historical = commit === shippedCommit;
  const body = historical ? shippedHelper : readFileSync(helper, 'utf8');
  const insert = historical ? '# Installed mode never delegates again.' : '# The installed helper owns the lease';
  writeFileSync(helper, instrument(body, insert, helperVersion));
 }
 const manifest = JSON.parse(readFileSync(join(app, 'manifest.json'), 'utf8'));
 manifest.commit = commit; manifest.files = inventory(app).filter(file => file.path !== 'manifest.json');
 writeFileSync(join(app, 'manifest.json'), JSON.stringify(manifest));
 writeFileSync(join(payload, 'checksums.json'), JSON.stringify(inventory(payload).filter(file => file.path !== 'checksums.json')));
 powershell(`Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
Initialize-OreLongPaths
$zip=[IO.Compression.ZipFile]::Open($env:ORE_TEST_ARCHIVE,[IO.Compression.ZipArchiveMode]::Create)
try {
 foreach($path in @(Get-OreLongFiles $env:ORE_TEST_SOURCE)) {
  $relative=$path.Substring($env:ORE_TEST_SOURCE.Length+1).Replace('\\','/')
  $entry=$zip.CreateEntry($relative)
  $inputStream=[OreLongPaths]::OpenRead($env:ORE_TEST_SOURCE,$path);$outputStream=$entry.Open()
  try{$inputStream.CopyTo($outputStream)}finally{$inputStream.Dispose();$outputStream.Dispose()}
 }
 foreach($name in @('data','cache','logs','languages')){$zip.CreateEntry($env:ORE_TEST_ARCHIVE_ROOT+'/'+$name+'/')|Out-Null}
}finally{$zip.Dispose()}`, { ORE_TEST_SOURCE: packRoot, ORE_TEST_ARCHIVE_ROOT: `ORE-${commit.slice(0, 12)}-release-win32-x64`, ORE_TEST_ARCHIVE: join(transportRoot, 'ORE-windows-x64.zip') });
 const archive = readFileSync(join(transportRoot, 'ORE-windows-x64.zip'));
 const sha256 = createHash('sha256').update(archive).digest('hex');
 writeFileSync(join(transportRoot, 'ORE-windows-x64.json'), JSON.stringify({ formatVersion: 1, platform: 'win32', arch: 'x64', commit, archive: 'ORE-windows-x64.zip', sha256, bytes: archive.length, launcherProtocol: 2 }));
 writeFileSync(join(transportRoot, 'ORE-windows-x64.zip.sha256'), `${sha256}  ORE-windows-x64.zip\n`);
 const assets = ['ORE-windows-x64.zip', 'ORE-windows-x64.zip.sha256', 'ORE-windows-x64.json'].map(name => ({ name, state: 'uploaded', browser_download_url: `https://github.com/olegpro171/Open-Roleplay-Engine/releases/download/build-${commit}/${name}` }));
 writeFileSync(join(transportRoot, 'release.json'), JSON.stringify({ tag_name: `build-${commit}`, draft: false, prerelease: false, assets }));
 writeFileSync(join(transportRoot, 'compare.json'), JSON.stringify({ status: 'ahead', base_commit: { sha: previousCommit }, merge_base_commit: { sha: previousCommit } }));
 return transportRoot;
}
const offline = join(root, 'offline'), hold = join(root, 'hold'), entered = join(root, 'entered');
const first = release(shippedCommit, shippedCommit, 'historical');
const qualified = release(originalCommit, shippedCommit, 'cutover');
const nextCommit = 'b'.repeat(40) === originalCommit ? 'c'.repeat(40) : 'b'.repeat(40);
const later = release(nextCommit, originalCommit, 'later');
let transportRoot = first, runId = 0, origin = '', cookie = '';
type Run = ReturnType<typeof start>;
let current: Run | undefined;
const running = new Set<Run>();
function start(directory = parent) {
 let output = '', helperMs: number | undefined;
 const owner = join(root, 'owner-'+ ++runId);
 const started = performance.now();
 const child = spawn('cmd.exe', ['/d', '/s', '/c', '""%ORE_TEST_ENTRY%""'], {
  windowsVerbatimArguments: true, cwd: directory,
  env: { ...process.env, PATH: `${process.env.SystemRoot}\\System32`, ORE_TEST_ENTRY: join(directory, 'ORE-launcher.bat'), ORE_NO_PAUSE: '1', ORE_OPEN_BROWSER: '0', ORE_SKIP_UPDATE: undefined, ROLEPLAY_DATABASE: undefined, ROLEPLAY_PORT: String(port), ORE_PACKAGE_TEST_OWNER: owner, ORE_PACKAGE_TEST_CALLS: calls, ORE_PACKAGE_TEST_OFFLINE: offline, ORE_PACKAGE_TEST_HOLD: hold, ORE_PACKAGE_TEST_ENTERED: entered, ORE_PACKAGE_TEST_TRANSPORT: transportRoot },
  stdio: ['ignore', 'pipe', 'pipe'],
 });
 const append = (bytes: Buffer) => {
  output += String(bytes);
  if (helperMs === undefined && /Acceptance helper: (?:historical|cutover|later)/u.test(output)) helperMs = Math.round(performance.now()-started);
 };
 child.stdout?.on('data', append);
 child.stderr?.on('data', append);
 const done = new Promise<number | null>((accept, reject) => { child.once('error', reject); child.once('close', accept); });
 const run = { child, done, owner, output: () => output, helperMs: () => helperMs };
 running.add(run);
 child.once('close', () => running.delete(run));
 return run;
}
async function waitFor(run: Run, matches: () => boolean, expectation: string) {
 const deadline = Date.now()+180000;
 while (!matches()) {
  if (run.child.exitCode !== null || run.child.signalCode !== null || Date.now() > deadline) throw Error(expectation+': '+run.output());
  await delay(50);
 }
}
async function launch(directory = parent) {
 const run = current = start(directory);
 await waitFor(run, () => run.output().includes('Keep this window open while using ORE.'), 'ORE did not start');
 const address = /Open: (http:\/\/[^\s]+)/u.exec(run.output());
 assert(address, run.output()); origin = address[1];
 assert((await fetch(origin)).ok);
 return run.output();
}
async function stop(run = current) {
 if (!run) return;
 if (run === current) current = undefined;
 if (run.child.exitCode === null && run.child.signalCode === null) {
  if (existsSync(run.owner)) {
   try { process.kill(Number(readFileSync(run.owner, 'utf8'))); } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') throw error;
   }
  } else run.child.kill();
 }
 await run.done;
 // Deliberately no lock/cache cleanup: relaunch itself must recover.
}
async function expectExit(run: Run, text: RegExp) {
 const timeout = new AbortController();
 try {
  const status = await Promise.race([run.done, delay(90000, undefined, { signal: timeout.signal }).then(() => { throw Error('Launcher did not stop: '+run.output()); })]);
  assert.notEqual(status, 0);
  assert.match(run.output(), text);
 } finally { timeout.abort(); }
}
function recover(...args: string[]) {
 const result = spawnSync(ps, ['-NoProfile', '-ExecutionPolicy', 'RemoteSigned', '-File', join(home, 'recover-windows.ps1'), ...args], {
  env: { ...process.env, ORE_NO_PAUSE: '1', ROLEPLAY_DATABASE: undefined },
  encoding: 'utf8', timeout: 90000,
 });
 assert.equal(result.status, 0, result.stdout+result.stderr);
 return result.stdout;
}
const selection = () => readFileSync(join(home, 'current'), 'utf8');
try {
 // Seed a populated historical-protocol install using the real packaged app
 // and runtime with the published launcher payload as its installed helper.
 writeFileSync(entry, freshBootstrap);
 assert.match(await launch(), /Acceptance helper: historical/u);
 const original = selection();
 const response = await fetch(origin+'/api/setup', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'synthetic-package-password' }) });
 assert(response.ok, await response.clone().text()); cookie = response.headers.get('set-cookie')?.split(';')[0] ?? '';
 const epoch = response.headers.get('X-ORE-Epoch') ?? 'initial';
 const created = await fetch(origin+'/api/chats', { method: 'POST', headers: { cookie, Origin: origin, 'Content-Type': 'application/json', 'X-ORE-Epoch': epoch }, body: JSON.stringify({ title: 'Retained package story', targetInputTokens: 1000, characterId: null, personaId: null }) });
 assert(created.ok, await created.clone().text()); const chat = await created.json();
 const content = async () => {
  const response = await fetch(origin+'/api/chats/'+chat.id, { headers: { cookie } });
  assert(response.ok);
  const state = await response.json();
  return { settings: state.settings, turns: state.turns };
 };
 const saved = await content();
 await stop();

 writeFileSync(join(home, '.env'), 'ORE_OPEN_BROWSER=0\n');
 writeFileSync(join(home, 'languages/synthetic.json'), '{"preserve":true}');
 const location = readFileSync(join(home, 'database-location.json'));
 writeFileSync(entry, shipped);
 assert.match(await launch(), /ORE is up to date/u);
 assert.equal(selection(), original);
 await stop();

 // The bytes downloaded by the previous testers must still update.
 transportRoot = qualified;
 assert.match(await launch(), /Acceptance helper: historical/u);
 const selected = selection();
 assert.notEqual(selected, original);
 assert.equal(readFileSync(join(home, 'previous'), 'utf8'), original);
 assert.deepEqual(await content(), saved);
 await stop();
 assert.deepEqual(readFileSync(entry), shipped);

 // Compare external handoff on the exact same populated app with updates
 // paused, eliminating update/network time and installed-helper differences.
 const pause = join(home, 'updates-paused');
 writeFileSync(pause, 'retain pause');
 writeFileSync(offline, '');
 const requestsBefore = readFileSync(calls, 'utf8');
 assert.match(await launch(), /Updates are paused/u);
 const oldMs = current?.helperMs();
 await stop();
 writeFileSync(entry, cutover);
 assert.match(await launch(), /Updates are paused/u);
 const newMs = current?.helperMs();
 assert(oldMs !== undefined && newMs !== undefined);
 console.log(`External handoff to same helper on populated install: shipped ${oldMs} ms, cutover ${newMs} ms.`);
 assert.equal(readFileSync(calls, 'utf8'), requestsBefore);
 assert.equal(readFileSync(pause, 'utf8'), 'retain pause');
 assert.deepEqual(await content(), saved);
 const competing = start();
 await expectExit(competing, /installation is locked/u);
 await stop();
 recover('--resume-updates');
 assert(!existsSync(pause));
 assert.match(await launch(), /Couldn't check for updates/u);
 assert.deepEqual(await content(), saved);
 await stop();
 rmSync(offline);

 // Continue using the exact cutover bytes across corrupt and interrupted
 // updates and a subsequent successful update to different helper behavior.
 transportRoot = later;
 const checksumFile = join(later, 'ORE-windows-x64.zip.sha256'), checksum = readFileSync(checksumFile);
 writeFileSync(checksumFile, 'corrupted');
 assert.match(await launch(), /Couldn't finish the update/u);
 assert.equal(selection(), selected);
 await stop();
 writeFileSync(checksumFile, checksum);
 writeFileSync(hold, '');
 const interrupted = current = start();
 await waitFor(interrupted, () => existsSync(entered), 'Update did not reach archive transfer');
 await stop();
 rmSync(hold);
 assert.equal(selection(), selected);
 assert.match(await launch(), /Acceptance helper: cutover/u);
 const updated = selection();
 assert.notEqual(updated, selected);
 assert.deepEqual(await content(), saved);
 await stop();
 assert.match(await launch(), /Acceptance helper: later/u);
 assert.equal(selection(), updated);
 await stop();
 assert.deepEqual(readFileSync(entry), cutover);

 // Recovery is independent of the external file. It pauses updates and can
 // restart an explicitly retained selection with the frozen cutover batch.
 assert.match(recover('--list'), /release-/u);
 recover('--previous');
 assert.equal(selection(), selected);
 assert(existsSync(pause));
 assert.match(await launch(), /Updates are paused/u);
 assert.deepEqual(await content(), saved);
 await stop();

 const selectedTools = join(home, 'app', selected.split('\n')[0], 'scripts/release');
 const selectedHelper = join(selectedTools, 'windows-package-launcher.ps1');
 const usableHelper = readFileSync(selectedHelper);
 writeFileSync(selectedHelper, 'function malformed {');
 assert.match(await launch(), /Acceptance helper: later/u);
 assert.equal(selection(), selected);
 await stop();
 writeFileSync(selectedHelper, usableHelper);
 const protocol = join(selectedTools, 'windows-package-protocol');
 const protocolBytes = readFileSync(protocol);
 writeFileSync(protocol, '99\n');
 try { await expectExit(start(), /No compatible ORE launcher helper/u); }
 finally { writeFileSync(protocol, protocolBytes); }
 const retainedTools = selectedTools+'-retained';
 renameSync(selectedTools, retainedTools);
 try {
  symlinkSync(retainedTools, selectedTools, 'junction');
  await expectExit(start(), /No compatible ORE launcher helper/u);
 } finally {
  rmSync(selectedTools, { force: true });
  renameSync(retainedTools, selectedTools);
 }
 assert.equal(selection(), selected);

 const database = join(home, 'data/roleplay.sqlite'), retainedDatabase = database+'.retained';
 renameSync(database, retainedDatabase);
 try {
  await expectExit(start(), /ORE couldn't start\./u);
  assert(!existsSync(database));
 } finally { renameSync(retainedDatabase, database); }
 assert.deepEqual(readFileSync(join(home, 'database-location.json')), location);
 assert.equal(readFileSync(join(home, '.env'), 'utf8'), 'ORE_OPEN_BROWSER=0\n');
 assert.equal(readFileSync(join(home, 'languages/synthetic.json'), 'utf8'), '{"preserve":true}');
 assert.equal(readFileSync(join(parent, 'unrelated.txt'), 'utf8'), 'preserved');
 for (const lock of ['update.lock', 'build.lock', 'database-location.lock']) assert(!existsSync(join(home, 'cache', lock)));

 const clean = join(root, 'later clean install');
 mkdirSync(clean);
 writeFileSync(join(clean, 'ORE-launcher.bat'), freshBootstrap);
 writeFileSync(offline, '');
 await expectExit(start(clean), /ORE couldn't finish downloading/u);
 assert(!existsSync(join(clean, 'ORE-internal/current')));
 rmSync(offline);
 assert.match(await launch(clean), /Acceptance helper: later/u);
 assert(readFileSync(join(clean, 'ORE-internal/current'), 'utf8').includes(nextCommit));
 assert.deepEqual(readFileSync(join(clean, 'ORE-launcher.bat')), freshBootstrap);
 await stop();

 // The separate protocol-1 bridge uses the old selection only as provenance.
 // This deliberately minimal home cannot run an old helper or an old build.
 const bridge = join(root, 'legacy source bridge'), bridgeHome = join(bridge, 'ORE-internal');
 const legacyTools = join(bridgeHome, 'app/release-legacy/scripts/release');
 mkdirSync(legacyTools, { recursive: true });
 mkdirSync(join(bridgeHome, 'languages'));
 writeFileSync(join(bridgeHome, '.ore-installation'), 'ORE-installation:1\n');
 writeFileSync(join(bridgeHome, '.env'), 'ORE_OPEN_BROWSER=0\n');
 writeFileSync(join(bridgeHome, 'languages/retain.json'), '{"legacy":true}');
 writeFileSync(join(bridgeHome, 'current'), 'release-legacy\nnode-v24.19.0-win32-x64\n');
 writeFileSync(join(legacyTools, 'windows-launcher-protocol'), '1\n');
 writeFileSync(join(legacyTools, '../../build-info.json'), JSON.stringify({ kind: 'release', platform: 'win32', arch: 'x64', commit: originalCommit }));
 writeFileSync(join(bridge, 'ORE-launcher.bat'), freshBootstrap);
 const bridgePause = join(bridgeHome, 'updates-paused');
 writeFileSync(bridgePause, 'preserve');
 await expectExit(start(bridge), /No compatible ORE launcher helper/u);
 assert.equal(readFileSync(bridgePause, 'utf8'), 'preserve');
 rmSync(bridgePause);
 assert.match(await launch(bridge), /Acceptance helper: later/u);
 assert(readFileSync(join(bridgeHome, 'current'), 'utf8').includes(nextCommit));
 assert.equal(readFileSync(join(bridgeHome, '.env'), 'utf8'), 'ORE_OPEN_BROWSER=0\n');
 assert.equal(readFileSync(join(bridgeHome, 'languages/retain.json'), 'utf8'), '{"legacy":true}');
 await stop();

 const requests = readFileSync(calls, 'utf8');
 assert(!requests.includes('nodejs.org')); assert(!requests.includes('/archive/'));
 console.log('PASS: shipped protocol-2 update, in-place cutover, unchanged batch with a later helper, later clean install, offline/paused startup, corrupt/interrupted update, competing start, recovery and saved data.');
} catch (error) {
 console.error(current?.output());
 const logs = join(home, 'logs');
 if (process.env.RUNNER_TEMP && existsSync(logs)) cpSync(logs, join(process.env.RUNNER_TEMP, 'ORE-package-acceptance-logs'), { recursive: true });
 throw error;
} finally {
 await Promise.all([...running].map(run => stop(run)));
 rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
