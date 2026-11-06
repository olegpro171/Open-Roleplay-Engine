import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
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
  expect(hash('ORE-launcher.bat')).toBe('a47a49e16f7fe0d535e00a4f05603fcc8689d464de0f42c93017dd482f9ef890');
});

describe.skipIf(process.platform !== 'win32')('Windows PowerShell 5.1 builder and ZIP policy', () => {
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
