import { legacyWindowsLauncher } from '../scripts/release/generate-windows-launcher.mjs';
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { releaseServer } from './support/release-server.js';

const roots: string[] = [];
const children = new Set<ChildProcess>();
const owners = new Map<ChildProcess,string>();
function stopOwned(child: ChildProcess) {
  const marker=owners.get(child);
  if(marker && existsSync(marker)) {
    const pid=Number(readFileSync(marker,'utf8'));
    if(Number.isSafeInteger(pid)&&pid>0) { try { process.kill(pid); } catch { /* Owner already exited. */ } }
  } else child.kill();
}
const ps = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const a = 'a'.repeat(40), b = 'b'.repeat(40);
afterEach(async () => {
  for (const child of children) {
    stopOwned(child);
    if (child.exitCode === null && child.signalCode === null) await new Promise<void>(accept => child.once('exit', () => accept()));
  }
  children.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
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
  let output = '';
  child.stdout?.on('data', bytes => { output += String(bytes); });
  child.stderr?.on('data', bytes => { output += String(bytes); });
  const done = new Promise<number | null>((accept, reject) => { child.once('error', reject); child.once('exit', code => { children.delete(child); accept(code); }); });
  const until = async (text: string) => {
    const deadline = Date.now()+40000;
    while (!output.includes(text)) {
      if (child.exitCode !== null || Date.now() > deadline) throw new Error(`Missing ${text}: ${output}`);
      await delay(20);
    }
  };
  return { child, done, until, output: () => output, stop: async () => { stopOwned(child); return done; } };
}
function fixture(locale = 'en-US') {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ORE-standalone-'))); roots.push(root);
  const parent = join(root, "Chosen папка ' &() % ! $"), home = join(parent, 'ORE-internal');
  mkdirSync(parent); writeFileSync(join(parent,'unrelated.txt'),'preserve');
  const transport = `
function Get-OreHttps([string]$Url,[string]$Output,[int]$Seconds) {
 [IO.File]::AppendAllText(${quote(join(root,'calls'))},$Url+"\x60n")
 if ([IO.File]::Exists(${quote(join(root,'hold-download'))})) { [IO.File]::WriteAllText(${quote(join(root,'download-entered'))},[string]$PID);while(!(Test-OreCancellation)){Start-Sleep -Milliseconds 100};throw (New-Object OperationCanceledException 'Synthetic cancelled transport') }
 if ([IO.File]::Exists(${quote(join(root,'offline'))})) { throw 'SYNTHETIC offline diagnostic' }
 if ($Url.Contains('/commits/main')) { $inputFile=${quote(join(root,'main.json'))} }
 elseif ($Url.Contains('/compare/')) { $inputFile=${quote(join(root,'compare.json'))} }
 elseif ($Url.Contains('nodejs.org')) { $inputFile=${quote(join(root,'toolkit.zip'))} }
 else { $inputFile=${quote(join(root,'source.zip'))} }
 [IO.File]::Copy($inputFile,$Output)
}
`;
  const instrument = (text: string) => text.replace('# Installed mode never delegates again.', transport+'\n[IO.File]::WriteAllText($env:ORE_TEST_PID,[string]$PID)\n# Installed mode never delegates again.').replace('$preference = [Globalization.CultureInfo]::CurrentUICulture.Name', `$preference = ${quote(locale)}`);
  const entry = join(parent,'ORE-launcher.bat'); writeFileSync(entry,instrument(legacyWindowsLauncher()));
  writeFileSync(join(root,'main.json'),JSON.stringify({sha:a}));
  writeFileSync(join(root,'compare.json'),JSON.stringify({status:'ahead',base_commit:{sha:a},merge_base_commit:{sha:a}}));
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
if(process.argv.includes('build')){
 if(existsSync(${JSON.stringify(join(root,'hold-build'))})){writeFileSync(${JSON.stringify(join(root,'build-entered'))},String(process.pid));Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60000);}
 if(existsSync(${JSON.stringify(join(root,'fail-build'))}))process.exit(42);
 for(const path of ['dist/client','dist/server/server','dist/server/shared','node_modules/better-sqlite3'])mkdirSync(path,{recursive:true});
 writeFileSync('node_modules/better-sqlite3/package.json','{"name":"better-sqlite3","version":"fixture","main":"index.cjs"}');
 writeFileSync('node_modules/better-sqlite3/index.cjs',${JSON.stringify(`module.exports=require(${JSON.stringify(resolve('node_modules/better-sqlite3'))});`)});
 writeFileSync('dist/server/server/main.js',${JSON.stringify(server)});writeFileSync('dist/server/server/picture-worker.js','');
 writeFileSync('dist/server/shared/build-info.js','export const databaseSchemaVersion=15;');writeFileSync('dist/client/index.html','<title>ORE</title>');
}`);
  zip(join(root,'toolkit'),join(root,'toolkit.zip'));
  const digest = createHash('sha256').update(readFileSync(join(root,'toolkit.zip'))).digest('hex');
  function archive(commit = a, edit?: (path: string) => void) {
    const source = join(root,`sources-${commit}`,`Open-Roleplay-Engine-${commit}`); mkdirSync(source,{recursive:true});
    cpSync('scripts/release',join(source,'scripts/release'),{recursive:true});
    cpSync('build-portable.ps1',join(source,'build-portable.ps1'));
    writeFileSync(join(source,'scripts/release/windows-launcher.ps1'),instrument(readFileSync('scripts/release/windows-launcher.ps1','utf8')));
    writeFileSync(join(source,'scripts/release/native-smoke.mjs'),'// Exact native checks run separately.');
    writeFileSync(join(source,'scripts/release/build-windows.mjs'),`import {createRequire} from 'node:module';process.argv.push('build');createRequire(import.meta.url)(${JSON.stringify(join(runtimeRoot,'node_modules/npm/bin/npm-cli.js'))});`);
    writeFileSync(join(source,'scripts/release/runtime.conf'),`ORE_NODE_VERSION=${process.versions.node}\n`);
    writeFileSync(join(source,'scripts/release/node-SHASUMS256.txt'),`${digest}  node-v${process.versions.node}-win-x64.zip\n`);
    for(const path of ['src','public','migrations','docs'])mkdirSync(join(source,path));
    for(const path of ['tsconfig.json','tsconfig.server.json','vite.config.ts','vitest.config.ts','playwright.config.ts','index.html','LICENSE','docs/RELEASES.md','package-lock.json','migrations/0014_library_sorting.sql'])writeFileSync(join(source,path),'');
    writeFileSync(join(source,'package.json'),'{"type":"module"}');
    edit?.(source);
    rmSync(join(root,'source.zip'),{force:true}); zip(join(root,`sources-${commit}`),join(root,'source.zip'));
    writeFileSync(join(root,'main.json'),JSON.stringify({sha:commit}));
  }
  let runId=0;
  const run = (extra: NodeJS.ProcessEnv = {}) => {
    const marker=join(root,`owner-${++runId}`);
    const child=spawn('cmd.exe',['/d','/s','/c','""%ORE_TEST_ENTRY%""'],{
      windowsVerbatimArguments:true,cwd:root,env:{...process.env,PATH:`${process.env.SystemRoot}\\System32`,ORE_TEST_ENTRY:entry,ORE_TEST_PID:marker,ORE_NO_PAUSE:'1',ORE_OPEN_BROWSER:'0',ROLEPLAY_PORT:'0',...extra},stdio:['ignore','pipe','pipe'],
    });
    owners.set(child,marker);return child;
  };
  const logs = () => existsSync(join(home,'logs')) ? readdirSync(join(home,'logs')).map(name=>readFileSync(join(home,'logs',name),'utf8')).join('\n') : '';
  const calls = () => existsSync(join(root,'calls')) ? readFileSync(join(root,'calls'),'utf8').trim().split('\n') : [];
  return {root,parent,home,entry,archive,run,logs,calls,instrument};
}

describe.skipIf(process.platform !== 'win32')('standalone Windows 5.1 batch launcher',()=>{
  it('runs the real Release builder with Git outside its sanitized PATH and retains clean-source guards',()=>{
    const f=fixture();f.archive(a,source=>{
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
    const run=(sha=commit)=>spawnSync(ps,['-NoProfile','-ExecutionPolicy','RemoteSigned','-File',join(source,'build-portable.ps1'),'-Mode','Release','-Commit',sha,'-Destination',f.home],{
      encoding:'utf8',timeout:40000,env:{...process.env,PATH:`${join(gitPath,'..')};${process.env.SystemRoot}\\System32`},
    });
    const built=run();expect(built.status,built.stdout+built.stderr+'\n'+f.logs()).toBe(0);
    const pointer=readFileSync(join(f.home,'current'),'utf8');const id=pointer.split('\n')[0];
    expect(JSON.parse(readFileSync(join(f.home,'app',id,'build-info.json'),'utf8'))).toMatchObject({kind:'release',commit});
    expect(existsSync(join(f.home,'cache/build.lock'))).toBe(false);
    const wrong=run('0'.repeat(40));expect(wrong.status).not.toBe(0);expect(wrong.stderr).toContain('exact full checked-out commit');
    writeFileSync(join(source,'src/sentinel.txt'),'dirty');const dirty=run();expect(dirty.status).not.toBe(0);expect(dirty.stderr).toContain('Release source must be clean');
    expect(readFileSync(join(f.home,'current'),'utf8')).toBe(pointer);
  },60000);
  it('reads phases while a write handle is held, waits for complete events, and preserves child failures',()=>{
    const root=mkdtempSync(join(tmpdir(),'ORE-phase-overlap-'));roots.push(root);
    const writer=join(root,'writer.mjs'),events=join(root,'events'),ack=join(root,'ack');
    writeFileSync(writer,`import {appendFileSync,existsSync,writeFileSync} from 'node:fs';
import {launcherEvent} from ${JSON.stringify(new URL('file:///'+resolve('scripts/release/launcher-messages.mjs').replaceAll('\\','/')).href)};
const wait=async path=>{const end=Date.now()+5000;while(!existsSync(path)){if(Date.now()>end)throw Error('Reader did not acknowledge event');await new Promise(r=>setTimeout(r,10));}};
appendFileSync(process.env.ORE_WINDOWS_BUILD_EVENTS,'checking');writeFileSync(process.env.ORE_TEST_PARTIAL,'partial');await wait(process.env.ORE_TEST_RELEASE);
appendFileSync(process.env.ORE_WINDOWS_BUILD_EVENTS,'Version\\n');await wait(process.env.ORE_TEST_ACK);
await launcherEvent('activatingVersion');process.exit(Number(process.env.ORE_TEST_EXIT));`);
    const script=`$ErrorActionPreference='Stop';. $env:ORE_PHASE_TOOLS
function Show-OreMessage([string]$id){[Console]::WriteLine($id);[IO.File]::WriteAllText($env:ORE_TEST_ACK,$id)}
# Hold a real writer open across every polling/final read. A default .NET
# ReadAllText reader cannot coexist with this handle, even between appends.
$held=[IO.File]::Open($env:ORE_WINDOWS_BUILD_EVENTS,[IO.FileMode]::Create,[IO.FileAccess]::Write,[IO.FileShare]::ReadWrite)
$gate=Start-Job -ScriptBlock {param($partial,$release)while(![IO.File]::Exists($partial)){Start-Sleep -Milliseconds 20};Start-Sleep -Milliseconds 350;[IO.File]::WriteAllText($release,'continue')} -ArgumentList $env:ORE_TEST_PARTIAL,$env:ORE_TEST_RELEASE
try{$status=Invoke-OreProcess $env:ORE_PHASE_NODE @($env:ORE_PHASE_WRITER) $env:ORE_PHASE_REPORT -PhaseFile $env:ORE_WINDOWS_BUILD_EVENTS;[Console]::WriteLine('exit='+$status);exit 0}
finally{$held.Dispose();Stop-Job $gate;Remove-Job $gate}`;
    for(const code of ['0','42']){
      for(const file of [events,ack,join(root,'partial'),join(root,'release')])rmSync(file,{force:true});
      const result=powershell(script,{ORE_PHASE_TOOLS:resolve('scripts/release/windows-standalone-common.ps1'),ORE_PHASE_NODE:process.execPath,ORE_PHASE_WRITER:writer,ORE_PHASE_REPORT:join(root,'report.txt'),ORE_WINDOWS_BUILD_EVENTS:events,ORE_TEST_ACK:ack,ORE_TEST_PARTIAL:join(root,'partial'),ORE_TEST_RELEASE:join(root,'release'),ORE_TEST_EXIT:code});
      expect(result.status,result.stdout+result.stderr).toBe(0);
      expect(result.stdout.trim().split(/\r?\n/u)).toEqual(['checkingVersion','activatingVersion','exit='+code]);
    }
    for(const [contents,reason] of [
      ['x'.repeat(129),'Oversized build event'],
      ['checkingVersion\nactivatingVer','Incomplete build event sequence'],
      ['activatingVersion\n','Unexpected build phase'],
    ]){
      writeFileSync(writer,`import {writeFileSync} from 'node:fs';writeFileSync(process.env.ORE_WINDOWS_BUILD_EVENTS,${JSON.stringify(contents)});`);
      writeFileSync(events,'');
      const result=powershell(`$ErrorActionPreference='Stop';. $env:ORE_PHASE_TOOLS
function Show-OreMessage([string]$id){[Console]::WriteLine('phase='+$id)}
try{Invoke-OreProcess $env:ORE_PHASE_NODE @($env:ORE_PHASE_WRITER) $env:ORE_PHASE_REPORT -PhaseFile $env:ORE_WINDOWS_BUILD_EVENTS;exit 2}catch{[Console]::WriteLine($_.Exception.Message);exit 1}`,{ORE_PHASE_TOOLS:resolve('scripts/release/windows-standalone-common.ps1'),ORE_PHASE_NODE:process.execPath,ORE_PHASE_WRITER:writer,ORE_PHASE_REPORT:join(root,'report.txt'),ORE_WINDOWS_BUILD_EVENTS:events});
      expect(result.status,result.stdout+result.stderr).toBe(1);expect(result.stdout).toContain(reason);expect(result.stdout).not.toContain('phase=activatingVersion');
    }
  },45000);
  it('preserves the native spawn failure when no child was created',()=>{
    const root=mkdtempSync(join(tmpdir(),'ORE-process-failure-'));roots.push(root);
    const result=powershell(`$ErrorActionPreference='Stop';. $env:ORE_PROCESS_TOOLS
try { Invoke-OreProcess $env:ORE_MISSING_PROGRAM @() $env:ORE_PROCESS_REPORT;exit 2 }
catch { $cause=$_.Exception;while($cause.InnerException){$cause=$cause.InnerException};[Console]::WriteLine($cause.GetType().FullName);exit 0 }`,{ORE_PROCESS_TOOLS:resolve('scripts/release/windows-standalone-common.ps1'),ORE_MISSING_PROGRAM:join(root,'absent.exe'),ORE_PROCESS_REPORT:join(root,'report.txt')});
    expect(result.status,result.stdout+result.stderr).toBe(0);expect(result.stdout.trim()).toBe('System.ComponentModel.Win32Exception');
  });
  it('keeps generated catalog and PowerShell syntax current',()=>{
    const result=spawnSync(process.execPath,['scripts/release/generate-windows-launcher.mjs','--check'],{encoding:'utf8'});
    expect(result.status,result.stderr).toBe(0);
    const mac=spawnSync(process.execPath,['scripts/release/generate-macos-launcher.mjs','--check'],{encoding:'utf8'});
    expect(mac.status,mac.stderr).toBe(0);
    const parsed=powershell('$t=$null;$e=$null;[Management.Automation.Language.Parser]::ParseFile($env:ORE_TEST_HELPER,[ref]$t,[ref]$e)|Out-Null;if($e.Count){$e|Out-String|Write-Output;exit 1}',{ORE_TEST_HELPER:resolve('scripts/release/windows-launcher.ps1')});
    expect(parsed.status,parsed.stdout+parsed.stderr).toBe(0);
  });
  it('installs from a single file, skips unchanged work, updates exact main, and preserves data/config',async()=>{
    const f=fixture(); f.archive(); writeFileSync(join(f.parent,'.env'),'invalid parent secret');
    const first=observe(f.run()); try { await first.until('ORE is ready.'); } catch(error) { throw new Error(String(error)+'\n'+f.logs()); }
    expect(first.output()).toContain('Checking new version...\r\nActivating new version...');
    expect(first.output()).not.toContain('SYNTHETIC');
    const selected=readFileSync(join(f.home,'current'),'utf8');
    await first.stop();
    // Abrupt console owner loss may leave the conservative directory lock.
    rmSync(join(f.home,'cache/update.lock'),{recursive:true,force:true});
    const buildCalls=readFileSync(join(f.root,'build-calls'),'utf8');
    expect(buildCalls.match(/ci --include=dev/gu)).toHaveLength(1);
    expect(buildCalls.match(/prune --omit=dev/gu)).toHaveLength(1);
    expect(buildCalls).not.toContain('ci --omit=dev');
    expect(f.logs()).toContain('[Timing] install-locked-dependencies:');
    expect(f.logs()).toContain('[Timing] total-build:');
    const second=observe(f.run()); try { await second.until('ORE is ready.'); } catch(error) { throw new Error(String(error)+'\n'+f.logs()); }
    expect(second.output()).toContain('ORE is up to date.');await second.stop();
    rmSync(join(f.home,'cache/update.lock'),{recursive:true,force:true});
    expect(readFileSync(join(f.root,'build-calls'),'utf8')).toBe(buildCalls);
    writeFileSync(join(f.home,'.env'),'ORE_OPEN_BROWSER=0\r\nSYNTHETIC_SECRET="$(throw 42) % ! $HOME"\r\n');
    writeFileSync(join(f.home,'languages/sentinel.json'),'preserved user pack');
    f.archive(b);
    const third=observe(f.run());await third.until('ORE is ready.');await third.stop();
    expect(readFileSync(join(f.home,'previous'),'utf8')).toBe(selected);
    expect(f.calls().filter(url=>url.includes('nodejs.org'))).toHaveLength(1);
    expect(f.calls()).toContain(`https://github.com/olegpro171/Open-Roleplay-Engine/archive/${b}.zip`);
    expect(f.calls()).toContain('https://api.github.com/repos/olegpro171/Open-Roleplay-Engine/commits/main');
    expect(f.calls()).toContain(`https://api.github.com/repos/olegpro171/Open-Roleplay-Engine/compare/${a}...${b}?per_page=1`);
    expect(readFileSync(join(f.home,'languages/sentinel.json'),'utf8')).toBe('preserved user pack');
    expect(readFileSync(join(f.parent,'unrelated.txt'),'utf8')).toBe('preserve');
    expect(f.logs()).toContain('SYNTHETIC NPM WARNING');expect(f.logs()).toContain('SYNTHETIC SERVER WARNING');
    expect(f.logs()).not.toContain('$(throw 42)');
  },120000);
  it.each(['ru-RU','ru_RU','ru','en-US','zz-ZZ',''])('embeds pre-runtime language and keeps raw diagnostics private: %s',async locale=>{
    const f=fixture(locale);writeFileSync(join(f.root,'offline'),'');
    const run=observe(f.run());expect(await run.done).not.toBe(0);
    expect(run.output()).toContain(locale.startsWith('ru')?'Не удалось завершить загрузку ORE.':"ORE couldn't finish downloading.");
    expect(run.output()).not.toContain('SYNTHETIC');expect(f.logs()).toContain('SYNTHETIC offline');
  },30000);
  it('uses English for a missing embedded Russian translation and preserves literal parameters',async()=>{
    const f=fixture('ru-RU');writeFileSync(join(f.root,'offline'),'');
    const text=readFileSync(f.entry,'utf8').replace(/('downloadFailed' = @\{en='(?:[^']|'')*';ru=)'(?:[^']|'')*'/u,"$1''");
    writeFileSync(f.entry,text);const run=observe(f.run());expect(await run.done).not.toBe(0);
    expect(run.output()).toContain("ORE couldn't finish downloading.");expect(run.output()).toContain(f.home);
  },30000);
  it('refuses unrelated folders and reparse paths without changing parent content',async()=>{
    const f=fixture();mkdirSync(f.home);writeFileSync(join(f.home,'sentinel'),'unrelated');
    const run=observe(f.run());expect(await run.done).not.toBe(0);expect(run.output()).toContain("isn't an ORE installation");
    expect(readFileSync(join(f.home,'sentinel'),'utf8')).toBe('unrelated');expect(f.calls()).toEqual([]);
    rmSync(f.home,{recursive:true});symlinkSync(f.root,f.home,'junction');
    const linked=observe(f.run());expect(await linked.done).not.toBe(0);expect(f.calls()).toEqual([]);
  },30000);
  it('rejects reserved configuration and empty database values without exposing values',async()=>{
    const f=fixture();mkdirSync(f.home);writeFileSync(join(f.home,'.ore-installation'),'ORE-installation:1\n');
    for(const text of ['ROLEPLAY_DATABASE=\r\n','ORE_LAUNCH_REPORT=synthetic-secret\n','PATH=synthetic-secret\n']){
      writeFileSync(join(f.home,'.env'),text);const run=observe(f.run());expect(await run.done).not.toBe(0);
      expect(run.output()).toContain('problem in .env at line 1');expect(run.output()).not.toContain('synthetic-secret');expect(f.calls()).toEqual([]);
    }
  },30000);
  it('keeps fallback before live startup, rejects unproven ancestry, and owns concurrent/abrupt children',async()=>{
    const f=fixture();f.archive();
    const launch=async()=>{const run=observe(f.run());try{await run.until('ORE is ready.');}catch(error){throw new Error(String(error)+'\n'+f.logs());}return run;};
    const stop=async(run:ReturnType<typeof observe>)=>{await run.stop();rmSync(join(f.home,'cache/update.lock'),{recursive:true,force:true});};
    const first=await launch();
    const contender=observe(f.run());expect(await contender.done).not.toBe(0);expect(contender.output()).toContain('installation is locked');
    const owner=Number(readFileSync(join(f.home,'cache/update.lock/owner'),'utf8').split('\n')[0]);
    await stop(first);expect(()=>process.kill(owner,0)).toThrow();
    const before=readFileSync(join(f.home,'current'),'utf8');
    writeFileSync(join(f.root,'offline'),'');const offline=await launch();expect(offline.output()).toContain("Couldn't check for updates");await stop(offline);rmSync(join(f.root,'offline'));
    f.archive(b);
    for(const compare of [null,{status:'behind'},{status:'diverged'},{status:'ahead',base_commit:{sha:b},merge_base_commit:{sha:a}},{status:'ahead',base_commit:{sha:a},merge_base_commit:{sha:b}}]){
      writeFileSync(join(f.root,'compare.json'),JSON.stringify(compare));const run=await launch();expect(run.output()).toContain("Couldn't check for updates");await stop(run);
      expect(readFileSync(join(f.home,'current'),'utf8')).toBe(before);
    }
    expect(f.calls().filter(url=>url.includes('/archive/'))).toHaveLength(1);
    writeFileSync(join(f.root,'compare.json'),JSON.stringify({status:'ahead',base_commit:{sha:a},merge_base_commit:{sha:a}}));
    writeFileSync(join(f.root,'fail-build'),'');const failed=await launch();expect(failed.output()).toContain("Couldn't finish the update");await stop(failed);
    expect(readFileSync(join(f.home,'current'),'utf8')).toBe(before);
    rmSync(join(f.root,'fail-build'));const updated=await launch();await stop(updated);
    const selected=readFileSync(join(f.home,'current'),'utf8');expect(selected).not.toBe(before);
    writeFileSync(join(f.root,'fail-live'),'');const live=observe(f.run());expect(await live.done).not.toBe(0);
    expect(live.output()).toContain("ORE couldn't start.");expect(live.output()).not.toContain('Starting the installed version');
    expect(readFileSync(join(f.home,'current'),'utf8')).toBe(selected);
  },180000);
  it('uses complete retained helpers for missing, empty, directory, malformed and unreadable selected helpers; fails closed for protocols/links',async()=>{
    const f=fixture();f.archive();const initial=observe(f.run());await initial.until('ORE is ready.');await initial.stop();rmSync(join(f.home,'cache/update.lock'),{recursive:true,force:true});
    const selected=readFileSync(join(f.home,'current'),'utf8').trim().split('\n')[0];
    const appTools=join(f.home,'app',selected,'scripts/release'), recovery=join(f.home,'recovery',selected);
    const helper=join(appTools,'windows-launcher.ps1'), original=readFileSync(helper);
    for(const kind of ['missing','empty','directory','malformed']){
      rmSync(helper,{recursive:true,force:true});
      if(kind==='empty')writeFileSync(helper,'');if(kind==='directory')mkdirSync(helper);if(kind==='malformed')writeFileSync(helper,'function {');
      const run=observe(f.run({ORE_SKIP_UPDATE:'1'}));try{await run.until('ORE is ready.');}catch(error){throw new Error(kind+': '+String(error)+'\n'+f.logs());}
      await run.stop();rmSync(join(f.home,'cache/update.lock'),{recursive:true,force:true});
    }
    rmSync(helper,{recursive:true,force:true});writeFileSync(helper,original);
    const lockedMarker=join(f.root,'helper-locked');
    const reader=observe(spawn(ps,['-NoProfile','-Command',`$s=[IO.File]::Open($env:ORE_LOCKED_HELPER,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None);[IO.File]::WriteAllText($env:ORE_LOCKED_MARKER,'locked');try{Start-Sleep -Seconds 60}finally{$s.Dispose()}`],{env:{...process.env,ORE_LOCKED_HELPER:helper,ORE_LOCKED_MARKER:lockedMarker},stdio:['ignore','pipe','pipe']}));
    await expect.poll(()=>existsSync(lockedMarker)).toBe(true);
    const locked=observe(f.run({ORE_SKIP_UPDATE:'1'}));await locked.until('ORE is ready.');await locked.stop();await reader.stop();rmSync(join(f.home,'cache/update.lock'),{recursive:true,force:true});
    const missingDependency=join(appTools,'windows-install-verify.mjs');rmSync(missingDependency);
    const recovered=observe(f.run({ORE_SKIP_UPDATE:'1'}));await recovered.until('ORE is ready.');await recovered.stop();rmSync(join(f.home,'cache/update.lock'),{recursive:true,force:true});
    cpSync(join(recovery,'windows-install-verify.mjs'),missingDependency);
    rmSync(helper);rmSync(join(recovery,'windows-launcher.ps1'));
    const absent=observe(f.run());expect(await absent.done).not.toBe(0);expect(absent.output()).toContain("ORE couldn't finish setting up.");expect(absent.output()).not.toContain('Log file:');
    writeFileSync(helper,original);writeFileSync(join(appTools,'windows-launcher-protocol'),'999');
    const protocol=observe(f.run());expect(await protocol.done).not.toBe(0);expect(protocol.output()).not.toContain('Starting ORE');
    writeFileSync(join(appTools,'windows-launcher-protocol'),'1');rmSync(helper);symlinkSync(f.root,helper,'junction');
    const linked=observe(f.run());expect(await linked.done).not.toBe(0);expect(linked.output()).not.toContain('Starting ORE');
  },120000);
  it('requires captured snapshot bytes and owned destinations before changing permissions or installing tools',()=>{
    const f=fixture();f.archive();mkdirSync(f.home);writeFileSync(join(f.home,'unrelated'),'preserve');
    const digest=createHash('sha256').update(readFileSync(join(f.root,'source.zip'))).digest('hex');
    const run=(sha:string)=>spawnSync(ps,['-NoProfile','-ExecutionPolicy','RemoteSigned','-File',resolve('build-portable.ps1'),'-Mode','Snapshot','-Commit',a,'-Destination',f.home,'-Snapshot',join(f.root,'source.zip')],{encoding:'utf8',env:{...process.env,ORE_SNAPSHOT_SOURCE:`https://github.com/olegpro171/Open-Roleplay-Engine/archive/${a}.zip`,ORE_SNAPSHOT_SHA256:sha}});
    const changed=run('0'.repeat(64));expect(changed.status).not.toBe(0);expect(changed.stderr).toContain('Snapshot bytes changed');
    const collision=run(digest);expect(collision.status).not.toBe(0);expect(collision.stderr).toContain('folderCollision');
    expect(readdirSync(f.home)).toEqual(['unrelated']);expect(readFileSync(join(f.home,'unrelated'),'utf8')).toBe('preserve');
  },30000);
  it('kills owned download/build controllers on abrupt loss and never activates late or removes stale ownership automatically',async()=>{
    const f=fixture();f.archive();
    for(const phase of ['download','build']){
      writeFileSync(join(f.root,'hold-'+phase),'');const run=observe(f.run());
      const marker=join(f.root,phase+'-entered');
      const deadline=Date.now()+30000;
      while(!existsSync(marker)&&Date.now()<deadline&&run.child.exitCode===null)await delay(25);
      expect(existsSync(marker),run.output()+'\n'+f.logs()).toBe(true);
      const worker=Number(readFileSync(marker,'utf8'));await run.stop();
      await expect.poll(()=>{try{process.kill(worker,0);return true;}catch{return false;}}).toBe(false);
      expect(existsSync(join(f.home,'current'))).toBe(false);
      const blocked=observe(f.run());expect(await blocked.done).not.toBe(0);expect(blocked.output()).toContain('installation is locked');
      expect(existsSync(join(f.home,'current'))).toBe(false);
      rmSync(join(f.home,'cache/update.lock'),{recursive:true,force:true});rmSync(join(f.home,'cache/build.lock'),{recursive:true,force:true});rmSync(join(f.root,'hold-'+phase));
      expect(readFileSync(join(f.parent,'unrelated.txt'),'utf8')).toBe('preserve');expect(readFileSync(join(f.home,'.env'),'utf8')).toBe('');
    }
  },90000);
  it.each(['setup','running'])('handles a real console Ctrl+C while %s without late work or fallback',phase=>{
    const f=fixture();if(phase==='setup')writeFileSync(join(f.root,'hold-download'),'');else f.archive();
    const result=powershell(`$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OreConsoleTest {
 [DllImport("kernel32.dll")] public static extern bool FreeConsole();
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool AttachConsole(uint id);
 [DllImport("kernel32.dll")] public static extern bool SetConsoleCtrlHandler(IntPtr handler,bool ignore);
 [DllImport("kernel32.dll")] public static extern bool GenerateConsoleCtrlEvent(uint type,uint group);
}
'@
$cmd=Start-Process -FilePath $env:COMSPEC -ArgumentList '/d /s /c ""%ORE_TEST_ENTRY%""' -WindowStyle Hidden -PassThru
try {
 $deadline=[DateTime]::UtcNow.AddSeconds(20)
 while(![IO.File]::Exists($env:ORE_TEST_ENTERED) -and [DateTime]::UtcNow -lt $deadline){Start-Sleep -Milliseconds 50}
 if(![IO.File]::Exists($env:ORE_TEST_ENTERED)){throw 'Console setup did not begin.'}
 [OreConsoleTest]::FreeConsole()|Out-Null
 if(![OreConsoleTest]::AttachConsole([uint32]$cmd.Id)){throw 'Could not attach the test console.'}
 [OreConsoleTest]::SetConsoleCtrlHandler([IntPtr]::Zero,$true)|Out-Null
 if(![OreConsoleTest]::GenerateConsoleCtrlEvent(0,0)){throw 'Could not send Ctrl+C.'}
 [OreConsoleTest]::FreeConsole()|Out-Null
 $ownerId=[int][IO.File]::ReadAllText($env:ORE_TEST_PID)
 $deadline=[DateTime]::UtcNow.AddSeconds(10)
 while((Get-Process -Id $ownerId -ErrorAction SilentlyContinue) -and [DateTime]::UtcNow -lt $deadline){Start-Sleep -Milliseconds 50}
 if(Get-Process -Id $ownerId -ErrorAction SilentlyContinue){throw 'Ctrl+C left the launcher controller running.'}
 # cmd.exe may retain its own native Terminate batch job prompt. The contract
 # stops ORE's controller/workers; it does not authorize killing a user's shell.
}finally{
 if([IO.File]::Exists($env:ORE_TEST_PID)){$ownerId=[int][IO.File]::ReadAllText($env:ORE_TEST_PID);Stop-Process -Id $ownerId -ErrorAction SilentlyContinue}
 if(!$cmd.HasExited){$cmd.Kill()}
}`,{ORE_TEST_ENTRY:f.entry,ORE_TEST_PID:join(f.root,'console-owner'),ORE_TEST_ENTERED:join(f.root,phase==='setup'?'download-entered':'live-ready'),ORE_NO_PAUSE:'1',ORE_OPEN_BROWSER:'0',ROLEPLAY_PORT:'0'});
    expect(result.status,result.stdout+result.stderr+'\n'+f.logs()).toBe(0);
    if(phase==='setup'){
      expect(existsSync(join(f.home,'current'))).toBe(false);expect(f.logs()).not.toContain('Starting selected');
    }else{
      const worker=Number(readFileSync(join(f.root,'live-ready'),'utf8'));
      expect(()=>process.kill(worker,0)).toThrow();expect(existsSync(join(f.home,'current'))).toBe(true);
    }
  },45000);
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
try{Expand-OreZip $env:ORE_BAD_ARCHIVE ('Open-Roleplay-Engine-'+$env:ORE_BAD_COMMIT) $env:ORE_BAD_OUTPUT -Source;exit 2}catch{if([IO.Directory]::Exists($env:ORE_BAD_OUTPUT)){exit 3};exit 0}`,{ORE_BAD_ARCHIVE:archive,ORE_BAD_NAMES:JSON.stringify(cases[index]),ORE_ZIP_POLICY:resolve('scripts/release/windows-snapshot.ps1'),ORE_BAD_COMMIT:a,ORE_BAD_OUTPUT:destination});
      expect(result.status,`${index}: ${result.stdout+result.stderr}`).toBe(0);expect(existsSync(destination)).toBe(false);
    }
  },30000);
});
