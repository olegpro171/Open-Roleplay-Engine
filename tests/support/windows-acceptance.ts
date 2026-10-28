// Explicit unpublished-candidate qualification. GitHub metadata/source transport
// is synthetic; official runtime checks, npm, build, SQLite and server are real.
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:net';

assert.equal(process.platform,'win32');
const repository=resolve('.');
const root=mkdtempSync(join(repository,'release-artifacts','ORE-windows-native-'));
const parent=join(root,"Chosen папка ' &() % ! $"),home=join(parent,'ORE-internal');
mkdirSync(parent);writeFileSync(join(parent,'unrelated.txt'),'preserve parent');writeFileSync(join(parent,'.env'),'invalid parent file must stay unread');
const ps=join(process.env.SystemRoot??'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
const version=readFileSync('scripts/release/runtime.conf','utf8').match(/^ORE_NODE_VERSION=([0-9.]+)$/m)?.[1];assert(version);
const quote=(value:string)=>`'${value.replaceAll("'","''")}'`;
const transport=`
function Get-OreHttps([string]$Url,[string]$Output,[int]$Seconds) {
 [IO.File]::AppendAllText(${quote(join(root,'calls'))},$Url+"\x60n")
 if($Url.Contains('/commits/main')){$inputFile=${quote(join(root,'main.json'))}}
 elseif($Url.Contains('/compare/')){$inputFile=${quote(join(root,'compare.json'))}}
 elseif($Url.Contains('nodejs.org')){$inputFile=${quote(join(repository,`ore-portable/cache/node-v${version}-win-x64.zip`))}}
 else{$inputFile=${quote(join(root,'source.zip'))}}
 [IO.File]::Copy($inputFile,$Output)
}
`;
const instrument=(source:string)=>source.replace('# Installed mode never delegates again.',transport+'\nif($env:ORE_ACCEPTANCE_OWNER){[IO.File]::WriteAllText($env:ORE_ACCEPTANCE_OWNER,[string]$PID)}\n# Installed mode never delegates again.').replace('$preference = [Globalization.CultureInfo]::CurrentUICulture.Name',"$preference = 'en-US'");
const entry=join(parent,'ORE-launcher.bat');writeFileSync(entry,instrument(readFileSync('ORE-launcher.bat','utf8')));
const inputs=['build-portable.ps1','package.json','package-lock.json','tsconfig.json','tsconfig.server.json','vite.config.ts','vitest.config.ts','playwright.config.ts','index.html','src','public','migrations','scripts/release','LICENSE','docs/RELEASES.md'];
const a='c'.repeat(40),b='d'.repeat(40);
function archive(commit:string){
 const sourceParent=join(root,'source-'+commit),source=join(sourceParent,'Roleplay-Engine-'+commit);mkdirSync(source,{recursive:true});
 for(const input of inputs)cpSync(join(repository,input),join(source,input),{recursive:true});
 writeFileSync(join(source,'scripts/release/windows-launcher.ps1'),instrument(readFileSync('scripts/release/windows-launcher.ps1','utf8')));
 rmSync(join(root,'source.zip'),{force:true});
 const zip=spawnSync(ps,['-NoProfile','-Command',`$ErrorActionPreference='Stop';Add-Type -AssemblyName System.IO.Compression;Add-Type -AssemblyName System.IO.Compression.FileSystem
$z=[IO.Compression.ZipFile]::Open($env:ORE_ACCEPTANCE_ZIP,[IO.Compression.ZipArchiveMode]::Create)
try{foreach($p in Get-ChildItem -LiteralPath $env:ORE_ACCEPTANCE_SOURCE -Recurse -Force){$n=$p.FullName.Substring($env:ORE_ACCEPTANCE_SOURCE.Length+1).Replace('\\','/');if($p.PSIsContainer){$z.CreateEntry($n+'/')|Out-Null}else{[IO.Compression.ZipFileExtensions]::CreateEntryFromFile($z,$p.FullName,$n)|Out-Null}}}finally{$z.Dispose()}`],{encoding:'utf8',env:{...process.env,ORE_ACCEPTANCE_SOURCE:sourceParent,ORE_ACCEPTANCE_ZIP:join(root,'source.zip')}});
 assert.equal(zip.status,0,zip.stdout+zip.stderr);writeFileSync(join(root,'main.json'),JSON.stringify({sha:commit}));
}
const reservation=createServer();await new Promise<void>(accept=>reservation.listen(0,'127.0.0.1',accept));const address=reservation.address();assert(address&&typeof address!=='string');const port=address.port;await new Promise<void>(accept=>reservation.close(()=>accept()));
const origin=`http://127.0.0.1:${port}`;
let child:ChildProcess|undefined,output='',runId=0,marker='';
function start(){
 output='';marker=join(root,`owner-${++runId}`);
 child=spawn('cmd.exe',['/d','/s','/c','""%ORE_ACCEPTANCE_ENTRY%""'],{windowsVerbatimArguments:true,cwd:root,env:{...process.env,PATH:`${process.env.SystemRoot}\\System32`,ORE_ACCEPTANCE_ENTRY:entry,ORE_ACCEPTANCE_OWNER:marker,ORE_NO_PAUSE:'1',ORE_OPEN_BROWSER:'0',ROLEPLAY_PORT:String(port)},stdio:['ignore','pipe','pipe']});
 child.stdout?.on('data',bytes=>{output+=String(bytes);process.stdout.write(bytes);});child.stderr?.on('data',bytes=>{output+=String(bytes);process.stderr.write(bytes);});
 return child;
}
async function launch(){
 start();
 const deadline=Date.now()+600000;
 while(!output.includes('ORE is ready.')){if(child?.exitCode!==null||Date.now()>deadline)throw Error('Native startup failed: '+output);await delay(100);}
 assert((await fetch(origin)).ok);
}
async function stop(){
 if(!child)return;const current=child;child=undefined;
 if(current.exitCode!==null||current.signalCode!==null)return;
 const exited=new Promise<void>(accept=>current.once('exit',()=>accept()));
 if(existsSync(marker)){const pid=Number(readFileSync(marker,'utf8'));process.kill(pid);}else current.kill();
 await exited;
 // This is explicit test recovery after verified owner termination, never a
 // production stale-lock heuristic. Job closure kills the owner's descendants.
 const lock=join(home,'cache/update.lock');
 if(existsSync(lock))rmSync(lock,{recursive:true});
}
console.log('Isolated Windows candidate: '+root);
try{
 archive(a);await launch();
 let response=await fetch(origin+'/api/setup',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({password:'synthetic-windows-password'})});assert(response.ok,await response.clone().text());
 const cookie=response.headers.get('set-cookie')?.split(';')[0]??'',epoch=response.headers.get('X-ORE-Epoch')??'initial';
 response=await fetch(origin+'/api/chats',{method:'POST',headers:{cookie,Origin:origin,'Content-Type':'application/json','X-ORE-Epoch':epoch},body:JSON.stringify({title:'Native Windows retained story',targetInputTokens:1000,characterId:null,personaId:null})});assert(response.ok,await response.clone().text());
 const chat=await response.json();
 const content=async()=>{const saved=await fetch(origin+'/api/chats/'+chat.id,{headers:{cookie}});assert(saved.ok);const value=await saved.json();return{settings:value.settings,turns:value.turns};};
 const saved=await content();await stop();const first=readFileSync(join(home,'current'),'utf8');
 writeFileSync(join(home,'languages/synthetic.json'),'{"preserve":"synthetic pack"}');
 await launch();assert(output.includes('ORE is up to date.'));assert.deepEqual(await content(),saved);await stop();
 archive(b);writeFileSync(join(root,'compare.json'),JSON.stringify({status:'ahead',base_commit:{sha:a},merge_base_commit:{sha:a}}));
 await launch();assert.deepEqual(await content(),saved);assert.equal(readFileSync(join(home,'previous'),'utf8'),first);await stop();
 const recovery=spawnSync(ps,['-NoProfile','-ExecutionPolicy','RemoteSigned','-File',join(home,'recover-windows.ps1'),'--previous'],{cwd:root,encoding:'utf8',env:{...process.env,ORE_HOME:home}});assert.equal(recovery.status,0,recovery.stdout+recovery.stderr);
 assert.equal(readFileSync(join(home,'current'),'utf8'),first);
 await launch();assert(output.includes('Updates are paused.'));assert.deepEqual(await content(),saved);await stop();
 const database=join(home,'data/roleplay.sqlite'),missing=database+'.synthetic-missing';
 const {renameSync}=await import('node:fs');renameSync(database,missing);
 try {
  const broken=start();const status=await new Promise<number|null>(accept=>broken.once('exit',accept));child=undefined;
  assert.notEqual(status,0);assert(output.includes("ORE couldn't start."));assert(!output.includes("Couldn't check for updates."));assert(!output.includes("Couldn't finish the update."));assert(!existsSync(database));
 } finally { renameSync(missing,database); }
 assert.equal(readFileSync(join(home,'languages/synthetic.json'),'utf8'),'{"preserve":"synthetic pack"}');assert.equal(readFileSync(join(parent,'unrelated.txt'),'utf8'),'preserve parent');
 const report=readdirSync(join(home,'logs')).filter(name=>name.endsWith('.txt')).map(name=>readFileSync(join(home,'logs',name),'utf8')).join('\n');
 assert(report.includes('Native/runtime smoke passed:'));assert(!report.includes('synthetic-windows-password'));
 console.log('PASS: official private runtime; real locked build/native/probe; same-main reuse; populated restart/forward update; compatible recovery; missing-database refusal; retained config/languages/parent.');
 console.log('Candidate installation: '+home);
}finally{await stop();}
