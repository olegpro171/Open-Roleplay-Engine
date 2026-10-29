import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const roots: string[] = [];
const commit = 'a'.repeat(40), newer = 'b'.repeat(40);
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ORE release files-история-')); roots.push(root);
  const archive = Buffer.from('Synthetic prepared archive. Packaging/extraction is tested on Windows.');
  const sha256 = createHash('sha256').update(archive).digest('hex');
  const descriptor = { formatVersion: 1, platform: 'win32', arch: 'x64', commit, archive: 'ORE-windows-x64.zip', sha256, bytes: archive.length, launcherProtocol: 2 };
  writeFileSync(join(root, 'ORE-windows-x64.zip'), archive);
  writeFileSync(join(root, 'ORE-windows-x64.zip.sha256'), `${sha256}  ORE-windows-x64.zip\n`);
  writeFileSync(join(root, 'ORE-windows-x64.json'), JSON.stringify(descriptor));
  writeFileSync(join(root, 'ORE-launcher.bat'), '@echo off\r\n');
  return { root, descriptor };
}
function publish(root: string, scenario = '') {
  const source = `
import {readFileSync,statSync} from 'node:fs';import {join} from 'node:path';
const {publishWindowsRelease}=await import(${JSON.stringify(pathToFileURL(resolve('scripts/release/ci-publish-windows.mjs')).href)});
const {windowsReleaseAssets}=await import(${JSON.stringify(pathToFileURL(resolve('scripts/release/ci-release-files.mjs')).href)});
const directory=process.env.ORE_CI_TEST_DIRECTORY, scenario=process.env.ORE_CI_TEST_SCENARIO;
const commit=${JSON.stringify(commit)},newer=${JSON.stringify(newer)},tag='build-'+commit,events=[];
const assets=windowsReleaseAssets.map(name=>({name,state:'uploaded',size:1}));
let reference=scenario==='published'?{object:{type:'commit',sha:commit}}:null;
let release=scenario==='published'?{id:1,tag_name:tag,draft:false,assets}:scenario==='draft'?{id:1,tag_name:tag,draft:true,assets:[]}:null;
const missing=()=>{const error=new Error('missing');error.notFound=true;throw error};
const client={
async request(path,method='GET',body){
 events.push({path,method,body});
 if(path==='commits/main')return{sha:newer};
 if(path==='compare/'+commit+'...'+newer+'?per_page=1')return{status:scenario==='diverged'?'diverged':'ahead',base_commit:{sha:commit},merge_base_commit:{sha:commit}};
 if(path==='compare/'+newer+'...'+commit+'?per_page=1')return{status:'behind',base_commit:{sha:newer},merge_base_commit:{sha:commit}};
 if(path==='git/ref/tags/'+tag)return scenario==='wrong-tag'?{object:{type:'commit',sha:newer}}:reference??missing();
 if(path==='git/refs'&&method==='POST'){reference={object:{type:'commit',sha:body.sha}};return reference;}
 if(path==='releases/tags/'+tag)return release??missing();
 if(path==='releases'&&method==='POST'){release={id:1,tag_name:body.tag_name,draft:body.draft,assets:[]};return release;}
 if(path==='releases/1'&&method==='GET')return release;
 if(path==='releases/latest')return scenario==='older'?{tag_name:'build-'+newer}:missing();
 if(path==='releases/1'&&method==='PATCH'){release={...release,...body};return release;}
 throw Error('Unexpected API request: '+method+' '+path);
},
async upload(tag,path){events.push({upload:path});if(scenario==='upload-failed')throw Error('Synthetic upload failure');release.assets.push({name:path.split(/[\\\\/]/).at(-1),state:'uploaded',size:scenario==='truncated'?1:statSync(path).size});},
async descriptor(){events.push({download:'descriptor'});return JSON.parse(readFileSync(join(directory,'ORE-windows-x64.json'),'utf8'));}
};
try{const result=await publishWindowsRelease(directory,commit,client);console.log(JSON.stringify({result,events,release}));}
catch(error){console.log(JSON.stringify({error:error.message,events,release}));}
`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', env: { ...process.env, ORE_CI_TEST_DIRECTORY: root, ORE_CI_TEST_SCENARIO: scenario } });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

describe('Windows CI publication', () => {
  it('binds a unique tag to the exact commit and publishes only after all draft assets arrive', () => {
    const f = fixture(), result = publish(f.root);
    expect(result.error).toBeUndefined();
    expect(result.result).toMatchObject({ tag: `build-${commit}`, published: true, latest: true, reused: false });
    expect(result.events.filter((event: { method?: string }) => event.method === 'POST')).toEqual([
      { path: 'git/refs', method: 'POST', body: { ref: `refs/tags/build-${commit}`, sha: commit } },
      expect.objectContaining({ path: 'releases', body: expect.objectContaining({ target_commitish: commit, draft: true }) }),
    ]);
    expect(result.events.at(-1)).toEqual({ path: 'releases/1', method: 'PATCH', body: { draft: false, make_latest: 'true' } });
    expect(result.release.assets).toHaveLength(4);
  });
  it('retains a hidden draft when an upload fails', () => {
    const result = publish(fixture().root, 'upload-failed');
    expect(result.error).toContain('Synthetic upload failure');
    expect(result.release.draft).toBe(true);
    expect(result.events.some((event: { method?: string }) => event.method === 'PATCH')).toBe(false);
  });
  it('keeps a draft hidden when GitHub reports a truncated uploaded file', () => {
    const result = publish(fixture().root, 'truncated');
    expect(result.error).toContain('wrong size');
    expect(result.release.draft).toBe(true);
    expect(result.events.some((event: { method?: string }) => event.method === 'PATCH')).toBe(false);
  });
  it('reuses an already published commit without rewriting any release assets', () => {
    const result = publish(fixture().root, 'published');
    expect(result.result).toMatchObject({ reused: true, published: true });
    expect(result.events.some((event: { upload?: string }) => event.upload)).toBe(false);
    expect(result.events.some((event: { method?: string }) => event.method === 'PATCH')).toBe(false);
  });
  it('resumes an incomplete draft and leaves a newer Latest untouched when builds finish out of order', () => {
    expect(publish(fixture().root, 'draft').result).toMatchObject({ published: true, latest: true });
    const result = publish(fixture().root, 'older');
    expect(result.result).toMatchObject({ published: true, latest: false });
    expect(result.events.at(-1)).toEqual({ path: 'releases/1', method: 'PATCH', body: { draft: false, make_latest: 'false' } });
  });
  it.each(['wrong-tag', 'diverged'])('preserves incompatible existing history: %s', scenario => {
    const result = publish(fixture().root, scenario);
    expect(result.error).toMatch(/another commit|current main history/u);
    expect(result.events.some((event: { upload?: string }) => event.upload)).toBe(false);
    expect(result.events.some((event: { method?: string }) => event.method === 'POST')).toBe(false);
  });
  it.each(['archive', 'checksum', 'descriptor', 'extra-file'])('rejects inconsistent release files before contacting GitHub: %s', kind => {
    const f = fixture();
    if (kind === 'archive') writeFileSync(join(f.root, 'ORE-windows-x64.zip'), 'tampered');
    if (kind === 'checksum') writeFileSync(join(f.root, 'ORE-windows-x64.zip.sha256'), 'wrong checksum');
    if (kind === 'descriptor') writeFileSync(join(f.root, 'ORE-windows-x64.json'), JSON.stringify({ ...f.descriptor, commit: newer }));
    if (kind === 'extra-file') writeFileSync(join(f.root, 'roleplay.sqlite'), 'synthetic private data');
    const result = publish(f.root);
    expect(result.error).toBeTruthy();
    expect(result.events).toEqual([]);
  });
});
