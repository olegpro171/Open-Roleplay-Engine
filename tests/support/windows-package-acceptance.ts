// Native CI qualification with real packaged dependencies and synthetic release transport.
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { inventory } from '../../scripts/release/stage.mjs';

const [releaseArgument, originalCommit] = process.argv.slice(2);
if (process.platform !== 'win32' || !releaseArgument || !/^[a-f0-9]{40}$/u.test(originalCommit ?? '')) throw Error('Expected Windows release directory and full commit.');
const releaseDirectory = resolve(releaseArgument);
const root = mkdtempSync(join(tmpdir(), 'ORE-package-история-'));
const parent = join(root, 'chosen folder'), home = join(parent, 'ORE-internal');
mkdirSync(parent); writeFileSync(join(parent, 'unrelated.txt'), 'preserved');
const entry = join(parent, 'ORE-launcher.bat');
const ps = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const calls = join(root, 'requests.txt');
const reservation = createServer();
await new Promise<void>(accept => reservation.listen(0, '127.0.0.1', accept));
const address = reservation.address(); assert(address && typeof address !== 'string');
const port = address.port;
await new Promise<void>(accept => reservation.close(() => accept()));
const transport = `
function Get-OreHttps([string]$Url,[string]$Output,[int]$Seconds) {
 [IO.File]::AppendAllText($env:ORE_PACKAGE_TEST_CALLS,$Url+"\n")
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
`;
const instrument = (text: string) => text.replace('# Installed mode never delegates again.', transport+'\n# Installed mode never delegates again.');
writeFileSync(entry, instrument(readFileSync(join(releaseDirectory, 'ORE-launcher.bat'), 'utf8')));
function powershell(code: string, env: NodeJS.ProcessEnv) {
 const result = spawnSync(ps, ['-NoProfile', '-ExecutionPolicy', 'RemoteSigned', '-Command', "$ErrorActionPreference='Stop'; . $env:ORE_TEST_PATH_TOOLS; "+code], { env: { ...process.env, ORE_TEST_PATH_TOOLS: resolve('scripts/release/windows-snapshot.ps1'), ...env }, encoding: 'utf8' });
 assert.equal(result.status, 0, result.stdout+result.stderr);
}
const originalPayload = join(root, 'original');
powershell('Expand-OreZip $env:ORE_TEST_ARCHIVE $env:ORE_TEST_ARCHIVE_ROOT $env:ORE_TEST_EXTRACT -LongPaths', { ORE_TEST_ARCHIVE: join(releaseDirectory, 'ORE-windows-x64.zip'), ORE_TEST_ARCHIVE_ROOT: `ORE-${originalCommit.slice(0, 12)}-release-win32-x64`, ORE_TEST_EXTRACT: originalPayload });
function release(commit: string) {
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
  writeFileSync(helper, instrument(readFileSync(helper, 'utf8')));
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
 writeFileSync(join(transportRoot, 'compare.json'), JSON.stringify({ status: 'ahead', base_commit: { sha: originalCommit }, merge_base_commit: { sha: originalCommit } }));
 return transportRoot;
}
let current: ChildProcess | undefined, output = '', marker = '', runId = 0, transportRoot = release(originalCommit);
let origin = '', cookie = '';
function start() {
 output = ''; marker = join(root, 'owner-'+ ++runId);
 current = spawn('cmd.exe', ['/d', '/s', '/c', '""%ORE_TEST_ENTRY%""'], { windowsVerbatimArguments: true, cwd: parent, env: { ...process.env, PATH: `${process.env.SystemRoot}\\System32`, ORE_TEST_ENTRY: entry, ORE_NO_PAUSE: '1', ORE_OPEN_BROWSER: '0', ROLEPLAY_PORT: String(port), ORE_PACKAGE_TEST_OWNER: marker, ORE_PACKAGE_TEST_CALLS: calls, ORE_PACKAGE_TEST_OFFLINE: join(root, 'offline'), ORE_PACKAGE_TEST_TRANSPORT: transportRoot }, stdio: ['ignore', 'pipe', 'pipe'] });
 current.stdout?.on('data', bytes => { output += String(bytes); }); current.stderr?.on('data', bytes => { output += String(bytes); });
 return current;
}
async function launch() {
 const child = start(), deadline = Date.now()+180000;
 while (!output.includes('Keep this window open while using ORE.')) {
  if (child.exitCode !== null || Date.now() > deadline) throw Error('Package launcher failed: '+output+'\n'+(existsSync(join(home, 'logs')) ? readdirSync(join(home, 'logs')).filter(name => name.endsWith('.txt')).map(name => readFileSync(join(home, 'logs', name), 'utf8')).join('\n') : 'No log directory was created.'));
  await delay(50);
 }
 const address = /Open: (http:\/\/[^\s]+)/u.exec(output); assert(address, output); origin = address[1];
 assert((await fetch(origin)).ok);
}
async function stop() {
 if (!current) return; const child = current; current = undefined;
 if (child.exitCode !== null) return;
 const done = new Promise<void>(accept => child.once('exit', () => accept()));
 if (existsSync(marker)) process.kill(Number(readFileSync(marker, 'utf8'))); else child.kill();
 await done;
 // Deliberately no lock/cache cleanup: relaunch itself must recover.
}
try {
 await launch();
 const selected = readFileSync(join(home, 'current'), 'utf8');
 const response = await fetch(origin+'/api/setup', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'synthetic-package-password' }) });
 assert(response.ok, await response.clone().text()); cookie = response.headers.get('set-cookie')?.split(';')[0] ?? '';
 const epoch = response.headers.get('X-ORE-Epoch') ?? 'initial';
 const created = await fetch(origin+'/api/chats', { method: 'POST', headers: { cookie, Origin: origin, 'Content-Type': 'application/json', 'X-ORE-Epoch': epoch }, body: JSON.stringify({ title: 'Retained package story', targetInputTokens: 1000, characterId: null, personaId: null }) });
 assert(created.ok, await created.clone().text()); const chat = await created.json();
 const content = async () => { const response = await fetch(origin+'/api/chats/'+chat.id, { headers: { cookie } }); assert(response.ok); const state = await response.json(); return { settings: state.settings, turns: state.turns }; };
 const saved = await content();
 await stop();
 writeFileSync(join(home, '.env'), 'ORE_OPEN_BROWSER=0\n'); writeFileSync(join(home, 'languages/synthetic.json'), '{"preserve":true}');
 const location = readFileSync(join(home, 'database-location.json'));
 await launch(); assert(output.includes('ORE is up to date.')); assert.equal(readFileSync(join(home, 'current'), 'utf8'), selected);
 assert.deepEqual(await content(), saved);
 await stop();
 writeFileSync(join(root, 'offline'), ''); await launch(); assert(output.includes("Couldn't check for updates")); await stop(); rmSync(join(root, 'offline'));
 const nextCommit = originalCommit === 'b'.repeat(40) ? 'c'.repeat(40) : 'b'.repeat(40); transportRoot = release(nextCommit);
 const checksumFile = join(transportRoot, 'ORE-windows-x64.zip.sha256'), checksum = readFileSync(checksumFile);
 writeFileSync(checksumFile, 'corrupted'); await launch(); assert(output.includes("Couldn't finish the update")); assert.equal(readFileSync(join(home, 'current'), 'utf8'), selected); await stop(); writeFileSync(checksumFile, checksum);
 await launch(); assert.notEqual(readFileSync(join(home, 'current'), 'utf8'), selected); assert.equal(readFileSync(join(home, 'previous'), 'utf8'), selected);
 assert.deepEqual(await content(), saved); await stop();
 const database = join(home, 'data/roleplay.sqlite'), retainedDatabase = database+'.retained';
 renameSync(database, retainedDatabase);
 try {
  const failed = start();
  const status = await new Promise<number | null>((accept, reject) => { const timer = setTimeout(() => reject(Error('Missing database startup did not stop.')), 30000); failed.once('exit', code => { clearTimeout(timer); accept(code); }); });
  current = undefined; assert.notEqual(status, 0); assert(output.includes("ORE couldn't start.")); assert(!output.includes('Starting the installed version.')); assert(!existsSync(database));
 } finally { renameSync(retainedDatabase, database); }
 assert.deepEqual(readFileSync(join(home, 'database-location.json')), location);
 assert.equal(readFileSync(join(home, '.env'), 'utf8'), 'ORE_OPEN_BROWSER=0\n'); assert.equal(readFileSync(join(home, 'languages/synthetic.json'), 'utf8'), '{"preserve":true}');
 assert.equal(readFileSync(join(parent, 'unrelated.txt'), 'utf8'), 'preserved');
 assert(!existsSync(join(home, 'cache/update.lock'))); assert(!existsSync(join(home, 'cache/build.lock'))); assert(!existsSync(join(home, 'cache/database-location.lock')));
 const requests = readFileSync(calls, 'utf8'); assert(!requests.includes('nodejs.org')); assert(!requests.includes('/archive/'));
 console.log('PASS: package install, actual server/SQLite, forced-stop relaunch without cleanup, installed-helper delegation, unchanged reuse, offline/corrupt fallback, populated update and retained configuration.');
} catch (error) {
 console.error(output);
 const logs = join(home, 'logs');
 if (process.env.RUNNER_TEMP && existsSync(logs)) cpSync(logs, join(process.env.RUNNER_TEMP, 'ORE-package-acceptance-logs'), { recursive: true });
 throw error;
} finally { await stop(); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
