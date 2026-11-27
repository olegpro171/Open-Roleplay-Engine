import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import messages from '../scripts/release/launcher-messages.json';
import { releaseServer } from './support/release-server.js';

const roots: string[] = [];
const children = new Set<ChildProcess>();
const ps = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const a = 'a'.repeat(40), b = 'b'.repeat(40);
afterEach(async () => {
  for (const child of children) {
    child.kill();
    if (child.exitCode === null && child.signalCode === null) await new Promise<void>(accept => child.once('exit', () => accept()));
  }
  children.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});
function powershell(code: string, env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(ps, ['-NoProfile','-ExecutionPolicy','RemoteSigned','-Command',code], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 30000 });
  return result;
}
function zip(source: string, output: string) {
  const result = powershell(`$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; Add-Type -AssemblyName System.IO.Compression
$z=[IO.Compression.ZipFile]::Open($env:ORE_ZIP_TARGET,[IO.Compression.ZipArchiveMode]::Create)
try { foreach($p in Get-ChildItem -LiteralPath $env:ORE_ZIP_SOURCE -Recurse -Force){
 $n=$p.FullName.Substring($env:ORE_ZIP_SOURCE.Length+1).Replace('\\','/')
 if($p.PSIsContainer){$z.CreateEntry($n+'/')|Out-Null}else{[IO.Compression.ZipFileExtensions]::CreateEntryFromFile($z,$p.FullName,$n)|Out-Null}
}}finally{$z.Dispose()}`, { ORE_ZIP_SOURCE: source, ORE_ZIP_TARGET: output });
  expect(result.status, result.stdout+result.stderr).toBe(0);
}
function observe(child: ChildProcess) {
  children.add(child);
  const done = new Promise<number | null>((accept, reject) => {
    child.once('error', reject);
    child.once('exit', code => { children.delete(child); accept(code); });
  });
  return { done };
}
function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ORE-builder-'))); roots.push(root);
  const home = join(root, 'installation');
  const runtimeRoot = join(root,'toolkit',`node-v${process.versions.node}-win-x64`);
  mkdirSync(join(runtimeRoot,'node_modules/npm/bin'),{recursive:true});
  cpSync(process.execPath,join(runtimeRoot,'node.exe')); writeFileSync(join(runtimeRoot,'LICENSE'),'synthetic runtime; native qualification uses official archive');
  const server = `import {createRequire} from 'node:module';const Database=createRequire(import.meta.url)(${JSON.stringify(resolve('node_modules/better-sqlite3'))});
import {mkdirSync,existsSync,appendFileSync} from 'node:fs';import {dirname} from 'node:path';
mkdirSync(dirname(process.env.ROLEPLAY_DATABASE),{recursive:true});const db=new Database(process.env.ROLEPLAY_DATABASE);db.exec('CREATE TABLE IF NOT EXISTS sentinel(text TEXT)');db.close();
appendFileSync(${JSON.stringify(join(root,'server-calls'))},process.env.ROLEPLAY_PORT+'\\n');
if(existsSync(${JSON.stringify(join(root,'fail-live'))})&&process.env.ROLEPLAY_PORT==='0')throw Error('SYNTHETIC LIVE FAILURE');
console.error('SYNTHETIC SERVER WARNING');${releaseServer}
server.once('listening',()=>{if(process.env.ROLEPLAY_PORT==='0')appendFileSync(${JSON.stringify(join(root,'live-ready'))},String(process.pid));});`;
  writeFileSync(join(runtimeRoot,'node_modules/npm/bin/npm-cli.js'),`
const {mkdirSync,writeFileSync,appendFileSync,existsSync}=require('node:fs');
appendFileSync(${JSON.stringify(join(root,'build-calls'))},process.argv.slice(2).join(' ')+'\\n');
console.error('SYNTHETIC NPM WARNING');
if(process.argv.includes('ci')||process.argv.includes('build')){
 if(process.argv.includes('build')&&existsSync(${JSON.stringify(join(root,'hold-build'))})){writeFileSync(${JSON.stringify(join(root,'build-entered'))},String(process.pid));Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60000);}
 if(process.argv.includes('build')&&existsSync(${JSON.stringify(join(root,'fail-build'))}))process.exit(42);
 for(const path of ['dist/client','dist/server/server','dist/server/shared','node_modules/better-sqlite3'])mkdirSync(path,{recursive:true});
 if(!existsSync('node_modules/better-sqlite3/package.json')){
  writeFileSync('node_modules/better-sqlite3/package.json','{"name":"better-sqlite3","version":"fixture","main":"index.cjs"}');
  writeFileSync('node_modules/better-sqlite3/index.cjs',${JSON.stringify(`module.exports=require(${JSON.stringify(resolve('node_modules/better-sqlite3'))});`)});
 }
 writeFileSync('dist/server/server/main.js',${JSON.stringify(server)});writeFileSync('dist/server/server/picture-worker.js','');
 writeFileSync('dist/server/shared/build-info.js','export const databaseSchemaVersion=15;');writeFileSync('dist/client/index.html','<title>ORE</title>');
}`);
  zip(join(root,'toolkit'),join(root,'toolkit.zip'));
  const digest = createHash('sha256').update(readFileSync(join(root,'toolkit.zip'))).digest('hex');
  function copySource(commit = a, edit?: (path: string) => void) {
    const source = join(root,`sources-${commit}`,`Open-Roleplay-Engine-${commit}`); mkdirSync(source,{recursive:true});
    cpSync('scripts/release',join(source,'scripts/release'),{recursive:true});
    writeFileSync(join(source,'scripts/release/native-smoke.mjs'),'// Exact native checks run separately.');
    writeFileSync(join(source,'scripts/release/build-windows.mjs'),`import {createRequire} from 'node:module';process.argv.push('build');createRequire(import.meta.url)(${JSON.stringify(join(runtimeRoot,'node_modules/npm/bin/npm-cli.js'))});`);
    writeFileSync(join(source,'scripts/release/runtime.conf'),`ORE_NODE_VERSION=${process.versions.node}\n`);
    writeFileSync(join(source,'scripts/release/node-SHASUMS256.txt'),`${digest}  node-v${process.versions.node}-win-x64.zip\n`);
    for(const path of ['src','public','migrations','docs'])mkdirSync(join(source,path));
    for(const path of ['tsconfig.json','tsconfig.server.json','vite.config.ts','vitest.config.ts','playwright.config.ts','index.html','LICENSE','docs/RELEASES.md','package-lock.json','migrations/0014_library_sorting.sql'])writeFileSync(join(source,path),'');
    writeFileSync(join(source,'package.json'),'{"type":"module"}');
    edit?.(source);
  }
  const logs = () => existsSync(join(home,'logs')) ? readdirSync(join(home,'logs')).map(name=>readFileSync(join(home,'logs',name),'utf8')).join('\n') : '';
  return { root, home, copySource, logs };
}

it('reproduces the generated launchers and keeps external compatibility baselines byte-exact', () => {
  const generated = spawnSync(process.execPath, ['scripts/release/generate-windows-launcher.mjs', '--check'], { encoding: 'utf8' });
  expect(generated.status, generated.stdout + generated.stderr).toBe(0);
  const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
  expect(hash('tests/fixtures/windows-launcher/f553710121c8.bat')).toBe('36da2eba41f560881797eaf4cd042ec3f11769b60b2e6fbbdcc98a3dc2f357ef');
  expect(hash('tests/fixtures/windows-launcher/b6387180d351.bat')).toBe('000184cb43b98b3fcdf26cfbbc556d2bd699a7f86b9d1b951705a4fd2cdde5af');
  expect(hash('ORE-launcher.bat')).toBe('8090ad854f44a6477d54c7a3082994e7c87aab677ffcbd1311c37bfd8d4f47ff');
});

describe.skipIf(process.platform !== 'win32')('Windows PowerShell 5.1 builder and ZIP policy', () => {
  it.each(['en','ru'] as const)('keeps the home language in the version worker and waits on return (%s)', language => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(),'ORE menu language-'))); roots.push(root);
    const entry = join(root,'ORE-launcher.bat');
    const input = `function Read-OreChoice($Title,$Primary,$Choices,$Notice,$Focus,$Seconds) {
 [Console]::WriteLine((Get-OreMessage $Title)+'|'+$Seconds+'|'+$Focus+'|'+$Notice)
 if ($Title -eq 'menuHome' -and $Seconds -eq 3) { return $Choices[1] }
 if ($Title -eq 'menuHome' -and !$Seconds -and !$script:visitedSettings) { $script:visitedSettings=$true; return $Choices[2] }
 if ($Title -eq 'menuHome' -and $Seconds -eq 0 -and $Focus -eq 0) { return $Choices[0] }
 return (New-OreChoice '' 'back')
}
function Get-OreHttps { throw 'Offline fixture' }
`;
    const parent = language === 'ru' ? 'ru-RU' : 'en-US';
    const worker = language === 'ru' ? 'en-US' : 'ru-RU';
    const batch = readFileSync('ORE-launcher.bat','utf8')
      .replace('# Bootstrap contract 2.', () => input+'# Bootstrap contract 2.')
      .replace('$script:OreLanguage = if', () => `[Threading.Thread]::CurrentThread.CurrentUICulture = if ($ManageOnly -or $SettingsOnly -or $StartOnly -or $InstallOnly) { '${worker}' } else { '${parent}' }\n$script:OreLanguage = if`)
      .replace('$interactive = ![Console]::IsInputRedirected -and ![Console]::IsOutputRedirected','$interactive = $true');
    writeFileSync(entry,batch.replace(/\r?\n/gu,'\r\n'));
    const run = spawnSync('cmd.exe',['/d','/s','/c','""%ORE_MENU_ENTRY%""'],{
      cwd:root,windowsVerbatimArguments:true,encoding:'utf8',timeout:20000,env:{...process.env,ORE_MENU_ENTRY:entry},
    });
    expect(run.status,run.stderr+run.stdout).toBe(0);
    expect(run.stdout).toContain(messages.menuHome[language]+'|3');
    expect(run.stdout).toContain(messages.menuManage[language]+'|');
    expect(run.stdout).toContain(messages.menuSettings[language]+'|');
    expect(run.stdout).toContain(messages.menuHome[language]+'|0|0|');
    expect(run.stdout).toContain(messages.menuHome[language]+'|0|1|'+messages.menuRecoveryHint[language]);
  });
  it('starts after three idle seconds and cancels the timer on a non-navigation key', () => {
    const run = powershell(`$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object Text.UTF8Encoding $false
$batch=[IO.File]::ReadAllText($env:ORE_TEST_BATCH)
$start=$batch.LastIndexOf('# ORE_POWERSHELL_PAYLOAD')+'# ORE_POWERSHELL_PAYLOAD'.Length
. ([scriptblock]::Create($batch.Substring($start,$batch.IndexOf('# Bootstrap contract 2.')-$start)))
$script:OreLanguage='ru'
$script:OreTerminal=@{Color=$false;Start=-1}
function Write-OreTerminalPanel { [Console]::WriteLine($script:OreTerminal.Choices[0]) }
function Test-OreMenuKey { return $script:inputReady }
$script:inputReady=$false
$choices=@((New-OreChoice (Get-OreMessage menuStart) start),(New-OreChoice (Get-OreMessage menuManage) manage))
$elapsed=[Diagnostics.Stopwatch]::StartNew()
$result=Read-OreChoice menuHome '' $choices -AutoStartSeconds 3
[Console]::WriteLine($result.Action+' '+$elapsed.ElapsedMilliseconds)
$script:inputReady=$true
$script:keys=New-Object Collections.Queue
foreach ($key in @('Spacebar','DownArrow','Enter')) { $script:keys.Enqueue($key) }
function Read-OreMenuKey { return $script:keys.Dequeue() }
$result=Read-OreChoice menuHome '' $choices -AutoStartSeconds 3
[Console]::WriteLine($result.Action)`,{ORE_TEST_BATCH:resolve('ORE-launcher.bat')});
    expect(run.status,run.stderr).toBe(0);
    const lines=run.stdout.trim().split(/\r?\n/u);
    const countdown=[3,2,1].map(n=>messages.menuStartCountdown.ru.replace('{seconds}',String(n)));
    expect(lines.slice(0,3)).toEqual(countdown);
    expect(lines[3]).toMatch(/^start \d+$/u);
    expect(Number(lines[3].split(' ')[1])).toBeGreaterThanOrEqual(3000);
    expect(lines.slice(4)).toEqual([countdown[0],messages.menuStart.ru,messages.menuStart.ru,'manage']);
  });
  it('remembers browser choices, honours cancellation and opens the selected Windows shortcut once after readiness', () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(),'ORE browser settings-'))); roots.push(root);
    const home = join(root,'ORE-internal'), cache = join(home,'cache');
    mkdirSync(cache,{recursive:true});
    writeFileSync(join(home,'.ore-installation'),'ORE-installation:1\n');
    const entry = join(root,'ORE-launcher.bat'), helper = join(root,'session.ps1');
    const link = join(root,'ORE & app.lnk'), opened = join(root,'opened');
    const env = {...process.env, ORE_TEST_BATCH:entry,ORE_TEST_HELPER:helper,ORE_TEST_HOME:home,ORE_TEST_SHORTCUT:link,
      ORE_TEST_OPENED:opened,ORE_OPEN_BROWSER:undefined};
    writeFileSync(link,'desktop shell boundary fixture');
    writeFileSync(entry,readFileSync('ORE-launcher.bat','utf8').replace('# Bootstrap contract 2.',
      `function Get-OrePackageHelper { return $env:ORE_TEST_HELPER }
function Open-OreWebAppShortcut($path) { [IO.File]::AppendAllText($env:ORE_TEST_OPENED,$path+[Environment]::NewLine) }
# Bootstrap contract 2.`.replaceAll('\n','\r\n')));
    writeFileSync(helper,`param([switch]$Installed,$Installation,$Invoking,$Language,$LauncherVersion)
# ORE capability: minimum-launcher-version
Write-Output ('browser='+$env:ORE_OPEN_BROWSER)
$env:ORE_LAUNCH_READY_RECEIPT=Join-Path $Installation ('cache/ready-'+[guid]::NewGuid()+'.tmp')
[IO.File]::WriteAllText((Join-Path $Installation ('cache/ready-'+[guid]::NewGuid()+'.tmp')),'')
if ($env:ORE_TEST_READY -eq '1') {
 [IO.File]::WriteAllText($env:ORE_LAUNCH_READY_RECEIPT,'')
 $clock=[Diagnostics.Stopwatch]::StartNew()
 while ($subscription -and [IO.File]::Exists($env:ORE_TEST_SHORTCUT) -and ![IO.File]::Exists($env:ORE_TEST_OPENED) -and $clock.ElapsedMilliseconds -lt 5000) { Start-Sleep -Milliseconds 40 }
 [IO.File]::Delete($env:ORE_LAUNCH_READY_RECEIPT)
 [IO.File]::WriteAllText($env:ORE_LAUNCH_READY_RECEIPT,'')
}
exit 0`);
    function start(ready = false) {
      const result=spawnSync('cmd.exe',['/d','/s','/c','""%ORE_TEST_BATCH%""'],{env:{...env,ORE_TEST_READY:ready?'1':'0'},
        cwd:root,windowsVerbatimArguments:true,encoding:'utf8',timeout:20000});
      expect(result.status,result.stderr+result.stdout).toBe(0);
      return result.stdout;
    }
    expect(start()).toMatch(/browser=\r?\n/u);
    const settings = (actions:string) => powershell(`$ErrorActionPreference='Stop'
$batch=[IO.File]::ReadAllText($env:ORE_TEST_BATCH)
$start=$batch.LastIndexOf('# ORE_POWERSHELL_PAYLOAD')+'# ORE_POWERSHELL_PAYLOAD'.Length
. ([scriptblock]::Create($batch.Substring($start,$batch.IndexOf('# Bootstrap contract 2.')-$start)))
$Installation=$env:ORE_TEST_HOME
$script:OreLanguage='en'
$keys=New-Object Collections.Queue
foreach ($id in $env:ORE_TEST_ACTIONS.Split(',')) { $keys.Enqueue($id) }
function Read-OreWebAppShortcut { if ($env:ORE_TEST_ACTIONS -ne 'shortcut,back') { return $env:ORE_TEST_SHORTCUT } }
function Read-OreChoice($Title,$Primary,$Choices) {
 $action=$keys.Dequeue()
 return ($Choices | Where-Object { $_.Action -eq $action } | Select-Object -First 1)
}
Show-OreLauncherSettings
[Console]::WriteLine((Get-OreBrowserSetting).Mode)`,{...env,ORE_TEST_ACTIONS:actions});
    for (const [actions,mode] of [['none,back','none'],['shortcut,back','none'],['none,shortcut,back','shortcut']]) {
      const r=settings(actions); expect(r.status,r.stderr).toBe(0); expect(r.stdout.trim()).toBe(mode);
      expect(start()).toContain('browser=0');
      expect(existsSync(opened)).toBe(false);
    }
    writeFileSync(join(home,'.env'),'ORE_OPEN_BROWSER=0\n');
    expect(start(true)).toContain('browser=0');
    expect(existsSync(opened)).toBe(false);
    writeFileSync(join(home,'.env'),'');
    expect(start(true)).toContain('browser=0');
    expect(readFileSync(opened,'utf8').trim().split(/\r?\n/u)).toEqual([link]);
    rmSync(link);
    expect(start(true)).toContain('browser=0');
    expect(readFileSync(opened,'utf8').trim().split(/\r?\n/u)).toEqual([link]);
    const restored=settings('default,back');
    expect(restored.status,restored.stderr).toBe(0);
    expect(start()).toMatch(/browser=\r?\n/u);
  },60000);
  it('compares published requirements with the running launcher in the background catalogue', () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ORE-catalogue-'))); roots.push(root);
    mkdirSync(join(root,'cache'));
    const batch = readFileSync('ORE-launcher.bat', 'utf8');
    const version = Number(/^\$LauncherVersion = (\d+)$/mu.exec(batch)?.[1]);
    const records = [a,b].map((commit,index) => {
      const tag = 'build-'+commit, archive = 'ORE-windows-x64.zip';
      const assets = [archive,archive+'.sha256','ORE-windows-x64.json'].map(name => ({
        name, state: 'uploaded', browser_download_url: 'https://github.com/olegpro171/Open-Roleplay-Engine/releases/download/'+tag+'/'+name,
      }));
      writeFileSync(join(root,tag+'.json'),JSON.stringify({formatVersion:2, platform:'win32', arch:'x64', launcherProtocol:2,
        minimumLauncherVersion:version+index, commit, archive, sha256:'a'.repeat(64), bytes:1}));
      return {name:index ? 'ORE 2.0 Spring Edition' : 'ORE 1.9',tag_name:tag,published_at:'2026-11-28T10:00:00Z',draft:false,prerelease:false,assets};
    });
    writeFileSync(join(root,'page.json'),JSON.stringify(records));
    const result = powershell(`$ErrorActionPreference='Stop'
$batch=[IO.File]::ReadAllText($env:ORE_TEST_BATCH)
$start=$batch.LastIndexOf('# ORE_POWERSHELL_PAYLOAD')+'# ORE_POWERSHELL_PAYLOAD'.Length
. ([scriptblock]::Create($batch.Substring($start,$batch.IndexOf('# Bootstrap contract 2.')-$start)))
$Installation=$env:ORE_TEST_CATALOGUE
$script:OreReport=Join-Path $Installation 'report.txt'
$script:OreLanguage='en'
[Console]::OutputEncoding=New-Object Text.UTF8Encoding $false
function Get-OreHttps($Url,$Output,$Seconds) {
 $name = if ($Url -match '/releases/download/(build-[a-f0-9]+)/') { $Matches[1]+'.json' } else { 'page.json' }
 [IO.File]::Copy((Join-Path $env:ORE_TEST_CATALOGUE $name),$Output)
}
function Read-OreChoice($Title,$Primary,$Choices) {
 [Console]::WriteLine((ConvertTo-Json -Compress -InputObject @($Choices | ForEach-Object { @{action=$_.Action;label=$_.Label;disabled=$_.Disabled} })))
 return (New-OreChoice '' 'back')
}
$null=Select-OrePublishedVersion @(@{Commit='${a}'},@{Commit='${b}'}) $null`, {ORE_TEST_BATCH:resolve('ORE-launcher.bat'),ORE_TEST_CATALOGUE:root});
    expect(result.status,result.stderr).toBe(0);
    const [first,second,back] = JSON.parse(result.stdout.trim().split(/\r?\n/u).at(-1)!);
    expect(first).toMatchObject({action:'menuAvailable',disabled:false});
    expect(second).toMatchObject({action:'menuNewer',disabled:true});
    expect(first.label.trimStart()).toMatch(/^ORE 1\.9 /u);
    expect(second.label).toContain('ORE 2.0 Spring Edition');
    expect(second.label).toContain('Requires launcher '+(version+1));
    for (const field of ['2026-11-28','Installed']) {
      expect(first.label.indexOf(field)).toBeGreaterThan(0);
      expect(second.label.indexOf(field)).toBe(first.label.indexOf(field));
    }
    expect(back.label).toBe('Back');
  });
  it('refreshes installed and selected titles after a GitHub rename, including older tags, and keeps them offline', () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(),'ORE retained names-'))); roots.push(root);
    mkdirSync(join(root,'cache'));
    const builds = [a,b].map(commit => {
      const id = 'release-'+commit.slice(0,12)+'-test';
      const app = join(root,'app',id);
      mkdirSync(app,{recursive:true});
      writeFileSync(join(app,'build-info.json'),JSON.stringify({kind:'release',platform:'win32',arch:'x64',node:'24.19.0',commit}));
      return id;
    });
    writeFileSync(join(root,'current'),builds[0]+'\nnode-v24.19.0-win32-x64\n');
    const release = (commit:string,name:string) => ({tag_name:'build-'+commit,name,draft:false,prerelease:false});
    const page = join(root,'page.json');
    writeFileSync(page,JSON.stringify([release(a,'First public title')]));
    writeFileSync(join(root,'older.json'),JSON.stringify(release(b,'Older release with its own title')));
    const inspect = () => {
      const result = powershell(`$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object Text.UTF8Encoding $false
$batch=[IO.File]::ReadAllText($env:ORE_TEST_BATCH)
$start=$batch.LastIndexOf('# ORE_POWERSHELL_PAYLOAD')+'# ORE_POWERSHELL_PAYLOAD'.Length
. ([scriptblock]::Create($batch.Substring($start,$batch.IndexOf('# Bootstrap contract 2.')-$start)))
$Installation=$env:ORE_TEST_CATALOGUE
$script:OreLanguage='en'
$script:OreReport=Join-Path $Installation 'report.txt'
function Get-OreHttps($Url,$Output,$Seconds) {
 if ($Url -like '*/releases?per_page=*') { $file='page.json' }
 elseif ($Url -ceq 'https://api.github.com/repos/olegpro171/Open-Roleplay-Engine/releases/tags/build-${b}') { $file='older.json' }
 else { throw 'Unexpected URL' }
 [IO.File]::Copy((Join-Path $env:ORE_TEST_CATALOGUE $file),$Output)
}
function Read-OreChoice($Title,$Primary,$Choices,$Notice,$Focus,$Seconds,$Refresh) {
 if ($Refresh) {
    if (!$Refresh.Wait(5000)) { throw 'Title refresh timed out' }
    return (New-OreChoice '' 'refresh' 1)
 }
 [Console]::WriteLine((ConvertTo-Json -Compress @{summary=$Primary;titles=@($Choices | Where-Object Action -eq 'local' | ForEach-Object { $_.Columns[0] });focus=$Focus}))
 return (New-OreChoice '' 'back')
}
Show-OreVersionManager`,{ORE_TEST_BATCH:resolve('ORE-launcher.bat'),ORE_TEST_CATALOGUE:root});
      expect(result.status,result.stderr).toBe(0);
      return JSON.parse(result.stdout.trim());
    };
    expect(inspect().titles).toEqual(['First public title','Older release with its own title']);
    writeFileSync(page,JSON.stringify([release(a,'Лунный свет 2.1')]));
    const renamed = inspect();
    expect(renamed.titles).toEqual(['Лунный свет 2.1','Older release with its own title']);
    expect(renamed.summary).toContain('Лунный свет 2.1');
    expect(renamed.focus).toBe(1);
    rmSync(page);
    expect(inspect()).toEqual(renamed);
  });
  it.each(['en', 'ru'] as const)('keeps the focused action visible with room for only one choice (%s)', language => {
    const result = powershell(`$ErrorActionPreference='Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
$batch = [IO.File]::ReadAllText($env:ORE_TEST_BATCH)
$start = $batch.LastIndexOf('# ORE_POWERSHELL_PAYLOAD')+'# ORE_POWERSHELL_PAYLOAD'.Length
# Redirected tests supply the console dimensions as well as the keystrokes.
$screen = $batch.Substring($start,$batch.IndexOf('# Bootstrap contract 2.')-$start).Replace('[Console]::WindowHeight','11')
. ([scriptblock]::Create($screen))
$script:OreLanguage=$env:ORE_TEST_LANGUAGE
$script:OreTerminal=@{Color=$false;Start=-1}
$script:keys = New-Object Collections.Queue
$script:keys.Enqueue('DownArrow'); $script:keys.Enqueue('Enter')
function Read-OreMenuKey { return $script:keys.Dequeue() }
function Write-OreTerminalPanel { [Console]::WriteLine((ConvertTo-Json -Compress -InputObject (@(Get-OreTerminalLines 38) -join [Environment]::NewLine))) }
$choice = Read-OreChoice 'menuHome' (Get-OreMessage 'menuLatest') @(
 (New-OreChoice (Get-OreMessage 'menuStart') 'start')
 (New-OreChoice (Get-OreMessage 'menuManage') 'manage')
)
[Console]::WriteLine($choice.Action)`, { ORE_TEST_BATCH: resolve('ORE-launcher.bat'), ORE_TEST_LANGUAGE: language });
    expect(result.status, result.stderr).toBe(0);
    const [initial, moved, action] = result.stdout.trimEnd().split(/\r?\n/u);
    expect(JSON.parse(initial)).toContain('› '+messages.menuStart[language]);
    expect(JSON.parse(moved)).toContain('› '+messages.menuManage[language]);
    expect(JSON.parse(moved)).toContain(messages.menuKeys[language]);
    expect(action).toBe('manage');
  });
  it('replaces the old menu after shrinking and widening a real Windows console', () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(),'ORE console resize-'))); roots.push(root);
    const output = join(root,'frames.json');
    const script = `$ErrorActionPreference='Stop'
try {
  [Console]::OutputEncoding=New-Object Text.UTF8Encoding $false
  $batch=[IO.File]::ReadAllText($env:ORE_TEST_BATCH)
  $start=$batch.LastIndexOf('# ORE_POWERSHELL_PAYLOAD')+'# ORE_POWERSHELL_PAYLOAD'.Length
  . ([scriptblock]::Create($batch.Substring($start,$batch.IndexOf('# Bootstrap contract 2.')-$start)))
  $script:OreLanguage='ru'
  $frames=New-Object Collections.ArrayList
  Add-Type -Name Screen -Namespace ResizeTest -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern IntPtr GetStdHandle(int id);
[DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
public static extern bool ReadConsoleOutputCharacter(IntPtr handle, System.Text.StringBuilder text, int length, int origin, out int read);
'@
  function Read-Screen {
    $size=[Console]::BufferWidth*[Console]::BufferHeight
    $screen=[Text.StringBuilder]::new($size)
    $read=0
    if (![ResizeTest.Screen]::ReadConsoleOutputCharacter([ResizeTest.Screen]::GetStdHandle(-11),$screen,$size,0,[ref]$read)) {
      throw (New-Object ComponentModel.Win32Exception)
    }
    $null=$frames.Add($screen.ToString().TrimEnd())
  }
  function Read-OreMenuKey {
    Read-Screen
    switch ($script:step++) {
      0 { [Console]::SetWindowSize(36,16); [Console]::SetBufferSize(36,100); return 'DownArrow' }
      1 { [Console]::SetBufferSize(80,100); [Console]::SetWindowSize(80,20); return 'UpArrow' }
      default { [Console]::SetWindowSize(48,16); [Console]::SetBufferSize(48,100); return 'Escape' }
    }
  }
  foreach ($plain in @($true,$false)) {
    [Console]::SetWindowSize(76,20); [Console]::SetBufferSize(76,100); [Console]::Clear()
    [Console]::WriteLine('Earlier terminal output')
    $script:OreTerminal=New-OreTerminal -InteractiveMenu
    $script:OreTerminal.PlainConsole=$plain
    $script:step=0
    Show-OreGreeting $LauncherVersion
    $null=Read-OreChoice menuHome (Get-OreMessage menuLatest) @(
      (New-OreChoice (Get-OreMessage menuStart) start)
      (New-OreChoice (Get-OreMessage menuManage) manage)
    )
    Read-Screen
  }
  [IO.File]::WriteAllText($env:ORE_TEST_SCREEN,(ConvertTo-Json -InputObject $frames))
} catch { [IO.File]::WriteAllText($env:ORE_TEST_SCREEN,$_.Exception.ToString()); exit 1 }`;
    const run=powershell(`$child=Start-Process (Join-Path $PSHOME 'powershell.exe') -WindowStyle Hidden -PassThru -Wait -ArgumentList @('-NoProfile','-EncodedCommand',$env:ORE_TEST_SCRIPT)
exit $child.ExitCode`,{ORE_TEST_BATCH:resolve('ORE-launcher.bat'),ORE_TEST_SCRIPT:Buffer.from(script,'utf16le').toString('base64'),ORE_TEST_SCREEN:output});
    const contents=existsSync(output) ? readFileSync(output,'utf8') : '';
    expect(run.status,run.stderr+contents).toBe(0);
    const frames: string[]=JSON.parse(contents);
    expect(frames).toHaveLength(8);
    for (const [index,frame] of frames.entries()) {
      expect(frame).toContain('Earlier terminal output');
      expect(frame).toContain('Open Roleplay Engine');
      const step=index % 4;
      for (const label of [messages.menuHome.ru,messages.menuStart.ru,messages.menuManage.ru]) {
        expect(frame.split(label).length-1,`frame ${index}, ${label}\n${frame.trimEnd()}`).toBe(step===3 ? 0 : 1);
      }
      if (step!==3) expect(frame).toContain('› '+(step===1 ? messages.menuManage.ru : messages.menuStart.ru));
    }
  });
  it.each(['en', 'ru'] as const)('keeps the ready address during updates and replaces it on shutdown or failure (%s)', language => {
    const result = powershell(`$ErrorActionPreference='Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
$helper = [IO.File]::ReadAllText($env:ORE_TEST_HELPER)
. ([scriptblock]::Create($helper.Substring(0,$helper.IndexOf('# The installed helper owns the lease'))))
$script:OreLanguage=$env:ORE_TEST_LANGUAGE
$script:OreTerminal=@{Title='launching'; Role='accent'; Symbol=''; Color=$false}
$script:OreReport='C:\\ORE\\logs\\startup.txt'
# Capture complete user-visible frames in place of cursor movement.
function Write-OreTerminalPanel { [Console]::WriteLine((ConvertTo-Json -Compress -InputObject (@(Get-OreTerminalLines 80) -join [Environment]::NewLine))) }
Show-OreMessage firstInstall
Show-OreMessage downloadingVersion
Receive-OreTerminalEvent starting
Receive-OreTerminalEvent 'openUrl https://user:password@localhost/'
Receive-OreTerminalEvent 'openUrl http://127.0.0.1:39172'
Show-OreMessage upToDate
Show-OreMessage updateCheckFailed
Show-OreMessage logFile @{absolutePath='C:\\ORE\\logs\\update.txt'}
Show-OreMessage updateReadyOnRestart
Receive-OreTerminalEvent browserFailed
Receive-OreTerminalEvent stopped
Show-OreMessage checkingUpdates
$script:OreTerminal=@{Title='launching'; Role='accent'; Symbol=''; Color=$false}
Receive-OreTerminalEvent starting
Receive-OreTerminalEvent portConflict
Show-OreMessage upToDate`, {
      ORE_TEST_HELPER: resolve('scripts/release/windows-package-launcher.ps1'), ORE_TEST_LANGUAGE: language,
    });
    expect(result.status, result.stderr).toBe(0);
    const frames: string[] = result.stdout.trim().split(/\r?\n/u).map(line => JSON.parse(line));
    const url = 'http://127.0.0.1:39172';
    expect(frames).toHaveLength(12);
    expect(frames[1]).toContain(messages.verifyNext[language]);
    expect(frames[2]).not.toContain(messages.verifyNext[language]);
    expect(frames.slice(0, 3).join('')).not.toContain(url);
    expect(frames.join('')).not.toContain('password');
    for (const frame of frames.slice(3, 9)) {
      expect(frame).toContain(url);
      expect(frame).toContain(messages.running[language]);
      expect(frame).toContain('Ctrl+C');
    }
    expect(frames[4]).toContain(messages.upToDate[language]);
    expect(frames[5]).toContain(messages.updateCheckFailed[language]);
    expect(frames[6]).toContain('update.txt');
    expect(frames[7]).toContain(messages.updateReadyOnRestart[language]);
    expect(frames[8]).toContain(messages.browserFailed[language]);
    expect(frames[9]).toContain(messages.stopped[language]);
    expect(frames[11]).toContain(messages.portConflict[language]);
    expect(frames[11]).toContain('startup.txt');
    expect(frames.slice(9).join('')).not.toContain(url);
    expect(frames.slice(9).join('')).not.toContain('update.txt');
  });
  it('runs the real Release builder with Git outside its sanitized PATH and retains clean-source guards',()=>{
    const f=fixture();f.copySource(a,source=>{
      for(const directory of ['src','public'])writeFileSync(join(source,directory,'sentinel.txt'),'tracked build input');
    });
    const source=join(f.root,`sources-${a}`,`Open-Roleplay-Engine-${a}`);
    const gitPath=powershell('(Get-Command git.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source').stdout.trim();
    const git=(...args:string[])=>{
      const result=spawnSync(gitPath,['-C',source,...args],{encoding:'utf8'});
      expect(result.status,result.stdout+result.stderr).toBe(0);return result.stdout.trim();
    };
    git('init','-q','-b','main');git('config','core.autocrlf','false');git('add','.');
    git('-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid','commit','-qm','Synthetic release');
    const commit=git('rev-parse','HEAD');mkdirSync(join(f.home,'cache'),{recursive:true});
    cpSync(join(f.root,'toolkit.zip'),join(f.home,`cache/node-v${process.versions.node}-win-x64.zip`));
    const run=(sha=commit,branch='main')=>spawnSync(ps,['-NoProfile','-ExecutionPolicy','RemoteSigned','-File',join(source,'scripts/release/build-portable.ps1'),'-Mode','Release','-ReleaseBranch',branch,'-Commit',sha,'-Destination',f.home],{
      encoding:'utf8',timeout:40000,env:{...process.env,PATH:`${join(gitPath,'..')};${process.env.SystemRoot}\\System32`},
    });
    const built=run();expect(built.status,built.stdout+built.stderr+'\n'+f.logs()).toBe(0);
    // A staging candidate keeps its actual SHA even before it belongs to main.
    const mainCommit=commit;
    writeFileSync(join(source,'src/sentinel.txt'),'staging candidate');git('add','.');
    git('-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid','commit','-qm','Synthetic staging candidate');
    const stagedCommit=git('rev-parse','HEAD');
    git('checkout','--detach',stagedCommit);
    git('update-ref','refs/heads/main',mainCommit);
    git('update-ref','refs/remotes/origin/staging',stagedCommit);
    const notMain=run(stagedCommit);expect(notMain.status).not.toBe(0);
    const staged=run(stagedCommit,'staging');expect(staged.status,staged.stdout+staged.stderr+'\n'+f.logs()).toBe(0);
    const pointer=readFileSync(join(f.home,'current'),'utf8');const id=pointer.split('\n')[0];
    expect(JSON.parse(readFileSync(join(f.home,'app',id,'build-info.json'),'utf8'))).toMatchObject({kind:'release',commit:stagedCommit});
    expect(existsSync(join(f.home,'cache/build.lock'))).toBe(false);
    const wrong=run('0'.repeat(40),'staging');expect(wrong.status).not.toBe(0);expect(wrong.stderr).toContain('exact full checked-out commit');
    writeFileSync(join(source,'src/sentinel.txt'),'dirty');const dirty=run(stagedCommit,'staging');expect(dirty.status).not.toBe(0);expect(dirty.stderr).toContain('Release source must be clean');
    expect(readFileSync(join(f.home,'current'),'utf8')).toBe(pointer);
  },60000);
  it('rebuilds after a killed development builder without clearing locks or changing retained state',async()=>{
    const f=fixture();f.copySource();
    const source=join(f.root,`sources-${a}`,`Open-Roleplay-Engine-${a}`);
    const gitPath=powershell('(Get-Command git.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source').stdout.trim();
    const git=(...args:string[])=>{
      const result=spawnSync(gitPath,['-C',source,...args],{encoding:'utf8'});
      expect(result.status,result.stdout+result.stderr).toBe(0);
    };
    git('init','-q','-b','main');git('add','.');
    git('-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid','commit','-qm','Synthetic development source');
    mkdirSync(join(f.home,'cache'),{recursive:true});
    cpSync(join(f.root,'toolkit.zip'),join(f.home,`cache/node-v${process.versions.node}-win-x64.zip`));
    const args=['-NoProfile','-ExecutionPolicy','RemoteSigned','-File',join(source,'scripts/release/build-portable.ps1'),'-Mode','Development','-ReuseDevelopmentDependencies','-Destination',f.home];
    const env={...process.env,PATH:`${join(gitPath,'..')};${process.env.SystemRoot}\\System32`};
    const build=()=>spawnSync(ps,args,{encoding:'utf8',timeout:40000,env});
    const first=build();expect(first.status,first.stdout+first.stderr+'\n'+f.logs()).toBe(0);
    const pointer=readFileSync(join(f.home,'current'),'utf8');
    const database=join(f.home,'data/retained.sqlite');writeFileSync(database,'synthetic retained data');
    writeFileSync(join(f.home,'.env'),'SYNTHETIC_SETTING=preserved\n');
    writeFileSync(join(f.root,'hold-build'),'');
    // Exercise two consecutive controller losses, including dirty working-tree
    // input. Killing the real builder bypasses PowerShell finally cleanup.
    for(const edit of ['first local edit','different local edit']){
      writeFileSync(join(source,'src/local-edit.txt'),edit);
      rmSync(join(f.root,'build-entered'),{force:true});
      const child=spawn(ps,args,{env,stdio:'ignore'});
      const running=observe(child);
      await expect.poll(()=>existsSync(join(f.root,'build-entered')),{timeout:30000}).toBe(true);
      const blocked=build();expect(blocked.status,blocked.stdout+blocked.stderr).not.toBe(0);
      expect(readFileSync(join(f.home,'current'),'utf8')).toBe(pointer);
      expect(readFileSync(database,'utf8')).toBe('synthetic retained data');
      child.kill();await running.done;
      expect(existsSync(join(f.home,'cache/build.lock'))).toBe(false);
    }
    rmSync(join(f.root,'hold-build'));
    const restarted=build();expect(restarted.status,restarted.stdout+restarted.stderr+'\n'+f.logs()).toBe(0);
    expect(readFileSync(join(f.home,'current'),'utf8')).not.toBe(pointer);
    expect(readFileSync(database,'utf8')).toBe('synthetic retained data');
    expect(readFileSync(join(f.home,'.env'),'utf8')).toBe('SYNTHETIC_SETTING=preserved\n');
    expect(existsSync(join(f.home,'cache/build.lock'))).toBe(false);
    const installs=()=>readFileSync(join(f.root,'build-calls'),'utf8').match(/ci --include=dev/gu)?.length ?? 0;
    expect(installs()).toBe(1);
    const packaged=spawnSync(process.execPath,[join(source,'scripts/release/package-portable.mjs'),f.home,join(f.root,'artifacts')],{encoding:'utf8'});
    expect(packaged.status).not.toBe(0);
    expect(packaged.stderr).toContain('Create a normal portable build before packaging');
    expect(existsSync(join(f.root,'artifacts'))).toBe(false);
    // Source edits reused dependencies above; either package input must instead
    // invalidate the cache, even when the other file remains byte-for-byte equal.
    writeFileSync(join(source,'package.json'),'{"type":"module","private":true}');
    const manifestChanged=build();expect(manifestChanged.status,manifestChanged.stdout+manifestChanged.stderr).toBe(0);
    expect(installs()).toBe(2);
    writeFileSync(join(source,'package-lock.json'),'changed synthetic lockfile');
    const lockChanged=build();expect(lockChanged.status,lockChanged.stdout+lockChanged.stderr).toBe(0);
    expect(installs()).toBe(3);
    const retained=readFileSync(join(f.home,'current'),'utf8');
    expect(readdirSync(join(f.home,'app'))).toEqual([retained.split('\n')[0]]);
    expect(readdirSync(join(f.home,'cache/development-dependencies'),{withFileTypes:true}).filter(entry=>entry.isDirectory())).toHaveLength(1);
    writeFileSync(join(source,'scripts/release/native-smoke.mjs'),'throw Error("SYNTHETIC native verification failed");');
    const nativeFailed=build();expect(nativeFailed.status).not.toBe(0);
    expect(nativeFailed.stdout+nativeFailed.stderr).toContain('SYNTHETIC native verification failed');
    expect(installs()).toBe(3);
    expect(readFileSync(join(f.home,'current'),'utf8')).toBe(retained);
    writeFileSync(join(source,'scripts/release/native-smoke.mjs'),'// Native verification restored.');
    const retry=build();expect(retry.status,retry.stdout+retry.stderr).toBe(0);
    expect(installs()).toBe(4);
    const ready=readFileSync(join(f.home,'current'),'utf8');
    const dependency=join(f.home,'app',ready.split('\n')[0],'node_modules/better-sqlite3/index.cjs');
    chmodSync(dependency,0o644);
    writeFileSync(dependency,readFileSync(dependency,'utf8')+'\n// Simulated changed cache bytes.');
    chmodSync(dependency,0o444);
    const damaged=build();expect(damaged.status).not.toBe(0);
    expect(damaged.stdout+damaged.stderr).toContain('Development dependency cache changed');
    expect(readFileSync(join(f.home,'current'),'utf8')).toBe(ready);
    const repaired=build();expect(repaired.status,repaired.stdout+repaired.stderr).toBe(0);
    expect(installs()).toBe(5);
    expect(readFileSync(database,'utf8')).toBe('synthetic retained data');
  },120000);
  it('preserves the native spawn failure when no child was created',()=>{
    const root=mkdtempSync(join(tmpdir(),'ORE-process-failure-'));roots.push(root);
    const result=powershell(`$ErrorActionPreference='Stop';. $env:ORE_PROCESS_TOOLS
try { Invoke-OreProcess $env:ORE_MISSING_PROGRAM @() $env:ORE_PROCESS_REPORT;exit 2 }
catch { $cause=$_.Exception;while($cause.InnerException){$cause=$cause.InnerException};[Console]::WriteLine($cause.GetType().FullName);exit 0 }`,{ORE_PROCESS_TOOLS:resolve('scripts/release/windows-standalone-common.ps1'),ORE_MISSING_PROGRAM:join(root,'absent.exe'),ORE_PROCESS_REPORT:join(root,'report.txt')});
    expect(result.status,result.stdout+result.stderr).toBe(0);expect(result.stdout.trim()).toBe('System.ComponentModel.Win32Exception');
  });
  it('delivers interactive output while the child runs and drains the final status on cancellation', () => {
    const root = mkdtempSync(join(tmpdir(), 'ORE-terminal-events-')); roots.push(root);
    const child = join(root, 'foreground.mjs');
    writeFileSync(child, `
      import { existsSync } from 'node:fs';
      import { setTimeout as delay } from 'node:timers/promises';
      console.log('openUrl http://127.0.0.1:39172');
      const deadline = Date.now() + 8000;
      while (!existsSync(process.env.ORE_TEST_ACK)) {
        if (Date.now() >= deadline) throw new Error('Presenter did not acknowledge readiness');
        await delay(10);
      }
      console.error('private diagnostic');
      console.log('stopped');
      process.exitCode = 42;
    `);
    const report = join(root, 'launcher.txt');
    const result = powershell(`$ErrorActionPreference='Stop'; . $env:ORE_PROCESS_TOOLS
function Test-OreCancellation { return [IO.File]::Exists($env:ORE_TEST_ACK) }
$present = { param($line)
    [Console]::WriteLine($line)
    if ($line.StartsWith('openUrl ')) { [IO.File]::WriteAllText($env:ORE_TEST_ACK,'') }
}
exit (Invoke-OreProcess $env:ORE_TEST_NODE @($env:ORE_TEST_CHILD) $env:ORE_TEST_REPORT -Console -OnOutputLine $present)`, {
      ORE_TEST_NODE: process.execPath, ORE_PROCESS_TOOLS: resolve('scripts/release/windows-standalone-common.ps1'),
      ORE_TEST_CHILD: child, ORE_TEST_ACK: join(root, 'ack'), ORE_TEST_REPORT: report,
    });
    expect(result.status, result.stdout + result.stderr).toBe(42);
    expect(result.stdout.trim().split(/\r?\n/u)).toEqual(['openUrl http://127.0.0.1:39172', 'stopped']);
    expect(readFileSync(report, 'utf8')).toContain('private diagnostic');
  });
  it('validates every ZIP name/type/collision before writing any extracted content',()=>{
    const root=mkdtempSync(join(tmpdir(),'ORE-zip-policy-'));roots.push(root);
    const cases=[['Open-Roleplay-Engine-'+a+'/src/a','Open-Roleplay-Engine-'+a+'/../escape'],['X/src/a'],['Open-Roleplay-Engine-'+a+'/src/CON.txt'],['Open-Roleplay-Engine-'+a+'/src/a:stream'],['Open-Roleplay-Engine-'+a+'/src/A','Open-Roleplay-Engine-'+a+'/src/a'],['Open-Roleplay-Engine-'+a+'/src/name.'],['Open-Roleplay-Engine-'+a+'/src/file','Open-Roleplay-Engine-'+a+'/src/file/nested'],['Open-Roleplay-Engine-'+a+'/C:/x'],['Open-Roleplay-Engine-'+a+'/src/link']];
    cases.push(['Roleplay-Engine-'+a+'/src/a'], ['Open-Roleplay-Engine-'+b+'/src/a']);
    for(let index=0;index<cases.length;index++){
      const archive=join(root,`bad-${index}.zip`),destination=join(root,`out-${index}`);
      const result=powershell(`$ErrorActionPreference='Stop';Add-Type -AssemblyName System.IO.Compression;Add-Type -AssemblyName System.IO.Compression.FileSystem
$z=[IO.Compression.ZipFile]::Open($env:ORE_BAD_ARCHIVE,[IO.Compression.ZipArchiveMode]::Create)
foreach($name in ($env:ORE_BAD_NAMES|ConvertFrom-Json)){$entry=$z.CreateEntry($name);if($name.EndsWith('/link')){$entry.ExternalAttributes=-1610612736}}
$z.Dispose();. $env:ORE_ZIP_POLICY
try{Expand-OreZip $env:ORE_BAD_ARCHIVE ('Open-Roleplay-Engine-'+$env:ORE_BAD_COMMIT) $env:ORE_BAD_OUTPUT;exit 2}catch{if([IO.Directory]::Exists($env:ORE_BAD_OUTPUT)){exit 3};exit 0}`,{ORE_BAD_ARCHIVE:archive,ORE_BAD_NAMES:JSON.stringify(cases[index]),ORE_ZIP_POLICY:resolve('scripts/release/windows-snapshot.ps1'),ORE_BAD_COMMIT:a,ORE_BAD_OUTPUT:destination});
      expect(result.status,`${index}: ${result.stdout+result.stderr}`).toBe(0);expect(existsSync(destination)).toBe(false);
    }
  },30000);
});
