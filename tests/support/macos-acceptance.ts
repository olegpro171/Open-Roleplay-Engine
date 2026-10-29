// Explicit native candidate qualification; transport supplies synthetic main
// snapshots of the working tree because publishing the candidate is not allowed.
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

assert.equal(process.platform,'darwin');
const repository=resolve('.');
const root=realpathSync(mkdtempSync(join(tmpdir(),'ORE-native-candidate-')));
const parent=join(root,'Chosen папка $ %s'),tools=join(root,'tools');
const home=join(parent,'ORE-internal');
mkdirSync(parent); mkdirSync(tools);
if (process.env.ORE_NATIVE_CACHE) {
 const cache=resolve(process.env.ORE_NATIVE_CACHE);
 assert(cache.includes('ORE-native-candidate-'),'Reuse only a prior synthetic candidate cache.');
 mkdirSync(home); writeFileSync(join(home,'.ore-installation'),'ORE-installation:1\n');
 cpSync(join(cache,'runtime'),join(home,'runtime'),{recursive:true});
 mkdirSync(join(home,'cache'));
 cpSync(join(cache,'cache/npm'),join(home,'cache/npm'),{recursive:true});
}
const quote=(value:string)=>`'${value.replaceAll("'","'\\''")}'`;
const path=`${tools}:/usr/bin:/bin:/usr/sbin:/sbin`;
const instrument=(text:string)=>text.replaceAll('export PATH=/usr/bin:/bin:/usr/sbin:/sbin',`export PATH=${quote(path)}`);
writeFileSync(join(parent,'ORE-launcher.command'),instrument(readFileSync('ORE-launcher.command','utf8')),{mode:0o755});
for(const name of ['git','node','npm','python','python3','jq','brew','cc','clang','make','xcodebuild','xcrun']) writeFileSync(join(tools,name),`#!/bin/bash\nprintf '%s\\n' ${quote(name)} >> ${quote(join(root,'forbidden'))}\nexit 99\n`,{mode:0o755});
writeFileSync(join(root,'preferences'),JSON.stringify({AppleLanguages:['en-US']}));
writeFileSync(join(tools,'defaults'),`#!/bin/bash\ncat ${quote(join(root,'preferences'))}\n`,{mode:0o755});
writeFileSync(join(tools,'curl'),`#!/bin/bash
set -euo pipefail
url=''; output=''; args=("$@")
while [ "$#" -gt 0 ]; do case "$1" in https://*) url=$1;; -o) shift; output=$1;; esac; shift; done
printf '%s\\n' "$url" >> ${quote(join(root,'calls'))}
case "$url" in
 */commits/main) cp ${quote(join(root,'main.json'))} "$output";;
 */compare/*) cp ${quote(join(root,'compare.json'))} "$output";;
 */archive/*.tar.gz) cp ${quote(join(root,'source.tar.gz'))} "$output";;
 *) exec /usr/bin/curl "\${args[@]}";;
esac
`,{mode:0o755});
const inputs=['build-portable.sh','package.json','package-lock.json','tsconfig.json','tsconfig.server.json','vite.config.ts','vitest.config.ts','playwright.config.ts','index.html','src','public','migrations','scripts/release','LICENSE','docs/RELEASES.md'];
const commitA='c'.repeat(40),commitB='d'.repeat(40);
function archive(commit:string) {
 const source=join(root,`Open-Roleplay-Engine-${commit}`); mkdirSync(source);
 for(const input of inputs) cpSync(join(repository,input),join(source,input),{recursive:true});
 writeFileSync(join(source,'scripts/release/macos-launcher.sh'),instrument(readFileSync('scripts/release/macos-launcher.sh','utf8')));
 assert.equal(spawnSync('/usr/bin/tar',['-czf',join(root,'source.tar.gz'),'-C',root,`Open-Roleplay-Engine-${commit}`]).status,0);
 writeFileSync(join(root,'main.json'),JSON.stringify({sha:commit}));
}
const reservation=createServer(); await new Promise<void>(accept=>reservation.listen(0,'127.0.0.1',accept));
const address=reservation.address(); assert(address && typeof address!=='string');
const port=address.port; await new Promise<void>(accept=>reservation.close(()=>accept()));
let child:ChildProcess|undefined;
let output='';
const origin=`http://127.0.0.1:${port}`;
async function launch() {
 output='';
 child=spawn('/bin/bash',[join(parent,'ORE-launcher.command')],{cwd:'/',env:{HOME:root,PATH:path,ORE_OPEN_BROWSER:'0',ROLEPLAY_PORT:String(port),LANG:'C',LC_ALL:'en_US.UTF-8'},stdio:['ignore','pipe','pipe']});
 child.stdout?.on('data',bytes=>{output+=String(bytes);process.stdout.write(bytes);}); child.stderr?.on('data',bytes=>{output+=String(bytes);process.stderr.write(bytes);});
 const deadline=Date.now()+600000;
 while(!output.includes('ORE is ready.')&&!output.includes('ORE запущен.')) {
  if(child.exitCode!==null||child.signalCode!==null||Date.now()>deadline) throw Error(`Native launch failed: ${output}`);
  await delay(50);
 }
 assert((await fetch(origin)).ok);
}
async function stop() {
 if(!child) return;
 const current=child; child=undefined;
 if(current.exitCode!==null||current.signalCode!==null) return;
 const exit=new Promise<void>(accept=>current.once('exit',()=>accept())); current.kill('SIGTERM'); await exit;
}
console.log(`Isolated native candidate: ${root}`);
try {
 archive(commitA); await launch();
 let response=await fetch(origin+'/api/setup',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({password:'synthetic-candidate-password'})});
 assert(response.ok,await response.text());
 const cookie=response.headers.get('set-cookie')?.split(';')[0]??'';
 const epoch=response.headers.get('X-ORE-Epoch')??'initial';
 response=await fetch(origin+'/api/chats',{method:'POST',headers:{cookie,Origin:origin,'Content-Type':'application/json','X-ORE-Epoch':epoch},body:JSON.stringify({title:'Native retained story',targetInputTokens:1000,characterId:null,personaId:null})});
 assert(response.ok,await response.clone().text());
 const chat=await response.json();
 const content=async()=>{
  const saved=await fetch(origin+'/api/chats/'+chat.id,{headers:{cookie}});
  assert(saved.ok,await saved.clone().text());
  const value=await saved.json();
  return {settings:value.settings,turns:value.turns};
 };
 const savedContent=await content();
 await stop();
 const first=readFileSync(join(home,'current'),'utf8');
 await launch(); assert(output.includes('ORE is up to date.')); assert.deepEqual(await content(),savedContent); await stop();
 writeFileSync(join(root,'preferences'),JSON.stringify({AppleLanguages:['ru-RU']}));
 writeFileSync(join(root,'compare.json'),JSON.stringify({status:'ahead',base_commit:{sha:commitA},merge_base_commit:{sha:commitA}}));
 archive(commitB); await launch(); await stop();
 assert.equal(readFileSync(join(home,'previous'),'utf8'),first);
 const [id,runtime]=readFileSync(join(home,'current'),'utf8').trim().split('\n');
 const recovery=spawnSync(join(home,'runtime',runtime,'bin/node'),[join(home,'app',id,'scripts/release/recover.mjs'),home,'--previous'],{encoding:'utf8',env:{HOME:root,PATH:path}});
 assert.equal(recovery.status,0,recovery.stdout+recovery.stderr);
 await launch(); assert(output.includes('Обновления приостановлены.')); await stop();
 assert.equal(readFileSync(join(home,'current'),'utf8'),first);
 assert(!existsSync(join(root,'forbidden')),'Forbidden global/developer tool was invoked.');
 const logs=readdirSync(join(home,'logs')).map(name=>readFileSync(join(home,'logs',name),'utf8')).join('\n');
 assert(logs.includes('Native/runtime smoke passed')); assert(!logs.includes('synthetic-candidate-password'));
 console.log(`Native candidate passed; retained for inspection: ${root}`);
} finally {await stop();}
