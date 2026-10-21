import { legacyRows, removeVariantSchema } from './support/legacy-variants.js';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/persistence/store.js';
import { readEmbeddedTags } from '../src/core/tags.js';
import { canonicalTagName, characterTagIndex, matchesCharacterTags, normalizeTagName, tagIdsSchema, tagLimits, tagNameSchema } from '../src/shared/tags.js';
import { exportCharacter, importCharacter } from '../src/core/cards.js';
import { assembleRequest } from '../src/core/prompt.js';
import { selectionsSchema, type Character } from '../src/shared/library.js';
import { readCardFile } from '../src/server/card-import.js';
import { createApp } from '../src/server/app.js';
import fixtures from './fixtures/lorebooks.json';

const stores: Store[] = [], folders: string[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function folder() { const dir = mkdtempSync(join(tmpdir(), 'ore-tags-')); folders.push(dir); return dir; }
function open(path = ':memory:') { const store = new Store(path); stores.push(store); return store; }
function rev(store: Store) { return store.libraryUpdate().revision; }
function required<T>(value: T | undefined): T { if (value === undefined) throw new Error('Missing synthetic fixture'); return value; }
const fields: Character = { name: 'Tag keeper', description: 'A keeper.', personality: '', scenario: '', first_mes: '', mes_example: '' };
const modern = (spec = 'chara_card_v2', tags: unknown = ['Fantasy', ' adventure ', 'FANTASY']) => ({ spec, spec_version: spec === 'chara_card_v3' ? '3.0' : '2.0', tags: ['stale-root'], data: { ...fields, tags, extensions: { preserved: true } } });
function card(store: Store, id: string) { return required(store.libraries().characters.find(card => card.id === id)); }
function editable(store: Store, id: string) { const { id: _id, revision: _revision, ...data } = card(store, id); return data; }
function addCharacter(store: Store, data = fields, ids?: string[]) { return store.saveLibrary(rev(store), 'characters', data, undefined, undefined, ids); }
function allRows(database: Database.Database, legacy = false) {
  const result: Record<string, unknown[]> = {};
  for (const { name } of database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('runtime_owner', 'tags', 'character_tags', 'library_state', 'picture_assets', 'character_pictures') ORDER BY name").all() as { name: string }[]) if (!legacy || name !== 'response_variants') result[name] = legacy ? legacyRows(database, name) : database.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all();
  return result;
}
function removeTagSchema(database: Database.Database) {
  removeVariantSchema(database);
  database.exec('DROP TABLE character_pictures; DROP TABLE picture_assets; DROP TRIGGER tagged_character_kind; DROP TABLE character_tags; DROP TABLE tags'); database.pragma('user_version = 8');
}

describe('tag identity and bounded metadata', () => {
  it('normalizes trim/NFC/Unicode lowercase without merging accents, width, spaces or punctuation', () => {
    expect(normalizeTagName('  Cafe\u0301  ')).toBe('Café');
    expect(canonicalTagName(' CAFÉ ')).toBe(canonicalTagName('Cafe\u0301'));
    expect(canonicalTagName(' ПРИКЛЮЧЕНИЕ ')).toBe('приключение');
    expect(canonicalTagName('日本語')).toBe('日本語');
    for (const [a, b] of [['cafe', 'café'], ['a b', 'a  b'], ['a-b', 'a,b'], ['Ａ', 'A'], ['ß', 'SS']]) expect(canonicalTagName(a)).not.toBe(canonicalTagName(b));
    expect(tagNameSchema.parse(`  ${'a'.repeat(100)}  `)).toHaveLength(100);
    expect(() => tagNameSchema.parse(' '.repeat(10))).toThrow();
    expect(() => tagNameSchema.parse('a'.repeat(101))).toThrow();
    expect(tagIdsSchema.parse(Array(200).fill('same'))).toEqual(['same']);
  });
  it('stores literal NUL text and multilingual boundary names without SQLite truncation of validation', () => {
    const store = open();
    const nullTag = store.tags.create(rev(store), '\0literal');
    const unicodeTag = store.tags.create(rev(store), '界'.repeat(100));
    expect(store.tags.catalog().find(tag => tag.id === nullTag)?.name).toBe('\0literal');
    expect(store.tags.catalog().find(tag => tag.id === unicodeTag)?.name).toBe('界'.repeat(100));
    const imported = store.importCard(rev(store), randomUUID(), modern('chara_card_v2', ['\0literal']), 'all');
    expect(store.tags.assigned(required(imported.ids[0]))).toEqual([nullTag]);
  });
  it('uses authoritative nesting, explains equivalent sources, never splits commas or coerces malformed values', () => {
    const parsed = readEmbeddedTags(modern('chara_card_v3', [' Fantasy ', 'FANTASY', 'café', 'cafe\u0301', 'a,b', null, 42, {}, '  ']));
    expect(parsed.candidates.map(tag => [tag.name, tag.sourceIndexes])).toEqual([['Fantasy', [0, 1]], ['café', [2, 3]], ['a,b', [4]]]);
    expect(parsed.notices).toHaveLength(4);
    expect(readEmbeddedTags({ tags: 'one,two' }).candidates).toEqual([]);
    expect(readEmbeddedTags({ tags: 'one,two' }).notices).toHaveLength(1);
    expect(readEmbeddedTags({ tags: [] })).toEqual({ candidates: [], notices: [], omittedNotices: 0 });
    expect(readEmbeddedTags({})).toEqual({ candidates: [], notices: [], omittedNotices: 0 });
  });
  it('bounds parser work and notices, and makes oversized local names explicit', () => {
    const malformed = readEmbeddedTags({ tags: Array(100).fill(null) });
    expect(malformed.notices).toHaveLength(50); expect(malformed.omittedNotices).toBe(50);
    expect(readEmbeddedTags({ tags: ['x'.repeat(101)] }).candidates[0]?.eligible).toBe(false);
    expect(() => readEmbeddedTags({ tags: Array(tagLimits.metadataEntries + 1).fill('x') })).toThrow('entries');
    expect(() => readEmbeddedTags({ tags: ['x'.repeat(tagLimits.metadataCharacters + 1)] })).toThrow('characters');
    expect(() => readEmbeddedTags({ tags: Array.from({ length: tagLimits.candidates + 1 }, (_, i) => `tag-${i}`) })).toThrow('unique candidates');
  });
});

describe('catalog, assignments and isolation', () => {
  it('rejects canonical collisions, preserves stable identities and reports used/unused tags', () => {
    const store = open(), tag = store.tags.create(rev(store), ' Café '), other = store.tags.create(rev(store), 'Unused');
    const id = addCharacter(store, fields, [tag, tag]);
    expect(store.tags.assigned(id)).toEqual([tag]);
    expect(store.tags.catalog().find(item => item.id === tag)).toMatchObject({ name: 'Café', usageCount: 1 });
    expect(store.tags.catalog().find(item => item.id === other)?.usageCount).toBe(0);
    const before = store.libraries();
    expect(() => store.tags.create(rev(store), 'CAFE\u0301')).toThrow('already exists');
    expect(() => store.tags.rename(rev(store), other, 'café')).toThrow('already exists');
    expect(store.libraries()).toEqual(before);
    store.tags.rename(rev(store), tag, 'CAFÉ');
    expect(store.tags.assigned(id)).toEqual([tag]); expect(store.tags.catalog().find(item => item.id === tag)).toMatchObject({ name: 'CAFÉ', revision: 1 });
    const revision = rev(store); store.tags.rename(revision, tag, ' CAFÉ '); expect(rev(store)).toBe(revision);
    expect(() => store.tags.create(revision - 1, 'stale')).toThrow('changed');
  });
  it('preserves omitted assignments, clears explicit empty, rejects wrong kinds and rolls combined saves back', () => {
    const store = open(), tag = store.tags.create(rev(store), 'fantasy'), id = addCharacter(store, fields, [tag]);
    store.saveLibrary(rev(store), 'characters', { ...fields, description: 'Edited' }, id);
    expect(store.tags.assigned(id)).toEqual([tag]);
    const before = store.libraries();
    expect(() => store.saveLibrary(rev(store), 'characters', { ...fields, name: 'Must roll back' }, id, undefined, ['missing'])).toThrow('no longer exists');
    expect(() => store.tags.setAssignments(rev(store), 'default', [tag])).toThrow('Character not found');
    expect(() => store.tags.setAssignments(rev(store), id, ['default'])).toThrow('no longer exists');
    expect(store.libraries()).toEqual(before);
    store.sqlite.exec("CREATE TRIGGER reject_assignment BEFORE INSERT ON character_tags BEGIN SELECT RAISE(ABORT, 'synthetic assignment failure'); END");
    const second = store.tags.create(rev(store), 'second'), saved = store.libraries();
    expect(() => store.saveLibrary(rev(store), 'characters', { ...fields, name: 'Rollback text' }, id, undefined, [second])).toThrow('synthetic assignment failure');
    expect(store.libraries()).toEqual(saved);
    store.sqlite.exec('DROP TRIGGER reject_assignment');
    store.saveLibrary(rev(store), 'characters', editable(store, id), id, undefined, []);
    expect(store.tags.assigned(id)).toEqual([]);
    const revision = rev(store); store.tags.setAssignments(revision, id, []); expect(rev(store)).toBe(revision);
  });
  it('copies assignments, cascades character deletion only to links, and makes tag deletion atomic', () => {
    const store = open(), tag = store.tags.create(rev(store), 'fantasy'), id = addCharacter(store, fields, [tag]);
    const copy = store.duplicateCharacter(rev(store), id);
    expect(store.tags.assigned(copy)).toEqual([tag]);
    store.deleteLibrary(rev(store), 'characters', copy);
    expect(store.tags.catalog().find(item => item.id === tag)?.usageCount).toBe(1);
    const before = store.libraries();
    store.sqlite.exec("CREATE TRIGGER reject_link_delete BEFORE DELETE ON character_tags BEGIN SELECT RAISE(ABORT, 'synthetic delete failure'); END");
    expect(() => store.tags.delete(rev(store), tag)).toThrow('synthetic delete failure'); expect(store.libraries()).toEqual(before);
    store.sqlite.exec('DROP TRIGGER reject_link_delete'); store.tags.delete(rev(store), tag);
    expect(store.tags.assigned(id)).toEqual([]); expect(card(store, id)).toEqual(required(before.characters.find(item => item.id === id)));
  });
  it('enforces SQL uniqueness, references, and character kind independent of UI validation', () => {
    const store = open(), tag = store.tags.create(rev(store), 'fantasy'), id = addCharacter(store, fields, [tag]);
    expect(() => store.sqlite.prepare('INSERT INTO tags (id,name,canonical_key) VALUES (?,?,?)').run('duplicate','FANTASY','fantasy')).toThrow('UNIQUE');
    expect(() => store.sqlite.prepare('INSERT INTO character_tags VALUES (?,?)').run(id,tag)).toThrow('UNIQUE');
    expect(() => store.sqlite.prepare('INSERT INTO character_tags VALUES (?,?)').run(id,'missing')).toThrow('FOREIGN KEY');
    expect(() => store.sqlite.prepare('INSERT INTO character_tags VALUES (?,?)').run('default',tag)).toThrow('require a character');
    expect(() => store.sqlite.prepare("UPDATE library SET kind = 'personas' WHERE id = ?").run(id)).toThrow('cannot change kind');
    expect(store.sqlite.prepare('PRAGMA index_list(character_tags)').all()).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'character_tags_by_tag' })]));
  });
  it('leaves exact prompts, budgets, chats, context and lore epochs untouched by organization', () => {
    const store = open(), source = modern(), id = addCharacter(store, importCharacter(source));
    const chat = store.createChat(selectionsSchema.parse({ title: 'Isolation', connectionId: null, characterId: id, personaId: null, promptId: 'default', targetInputTokens: 32000 }));
    store.sqlite.prepare('INSERT INTO lore_epochs VALUES (?,?)').run(chat, 7);
    const before = store.snapshot(chat), rows = allRows(store.sqlite), connection = { name: 'Mock', endpoint: 'http://localhost:1234/v1', model: 'mock', contextWindow: 100000, maxOutputTokens: 100, customParameters: {} };
    const request = assembleRequest(connection, before.settings, before.turns, before.sources, before.context);
    const t = store.tags.create(rev(store), 'manual');
    store.saveLibrary(rev(store), 'characters', editable(store, id), id, undefined, [t]);
    store.tags.applyEmbedded(rev(store), id, 'all');
    store.tags.rename(rev(store), t, 'Manual'); store.duplicateCharacter(rev(store), id); store.tags.delete(rev(store), t);
    expect(store.snapshot(chat)).toEqual(before);
    const after = store.snapshot(chat); expect(assembleRequest(connection, after.settings, after.turns, after.sources, after.context)).toEqual(request);
    const afterRows = allRows(store.sqlite); delete rows.library; delete afterRows.library;
    expect(afterRows).toEqual(rows); expect(card(store,id)).toEqual(before.sources.character);
    expect(store.libraryUpdate(rev(store))).toHaveProperty('unchanged', true);
    const known = rev(store); store.tags.create(known, 'cache'); expect(store.libraryUpdate(known)).not.toHaveProperty('unchanged');
  });
  it('uses AND filtering and a bounded index on a representative synthetic library', () => {
    const index = characterTagIndex([{characterId:'A',tagId:'fantasy'},{characterId:'A',tagId:'adventure'},{characterId:'B',tagId:'fantasy'}]);
    const filter = (selected: string[]) => ['A','B','C'].filter(id => matchesCharacterTags(index.get(id), selected));
    expect(filter([])).toEqual(['A','B','C']); expect(filter(['fantasy'])).toEqual(['A','B']); expect(filter(['fantasy','adventure'])).toEqual(['A']); expect(filter(['missing'])).toEqual([]);
    const links = Array.from({length:1000},(_,i)=>Array.from({length:128},(_,j)=>({characterId:`character-${i}`, tagId:`tag-${j}`}))).flat();
    const large = characterTagIndex(links); expect(large.size).toBe(1000); expect([...large.values()].every(ids=>matchesCharacterTags(ids,['tag-1','tag-127']))).toBe(true);
  });
});

describe('atomic policy-aware card import and retries', () => {
  it.each(['legacy', 'chara_card_v2', 'chara_card_v3'])('supports all/existing/none JSON and PNG with preserved %s metadata', format => {
    for (const policy of ['all','existing','none'] as const) for (const png of [false,true]) {
      const store = open(), existing = store.tags.create(rev(store), 'fantasy');
      const source = format === 'legacy' ? {...fields,tags:['Fantasy','adventure','FANTASY']} : modern(format);
      const text = Buffer.from(JSON.stringify(source)).toString('base64');
      let base64 = text;
      if (png) {
        const payload = Buffer.from(`chara\0${text}`), chunk = Buffer.alloc(payload.length+12); chunk.writeUInt32BE(payload.length); chunk.write('tEXt',4); payload.copy(chunk,8);
        base64 = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk]).toString('base64');
      }
      const result = store.importCard(rev(store), randomUUID(), readCardFile(base64), policy), id = required(result.ids[0]);
      expect(store.tags.assigned(id)).toHaveLength(policy === 'all' ? 2 : policy === 'existing' ? 1 : 0);
      if (policy !== 'none') expect(store.tags.assigned(id)).toContain(existing);
      expect(store.tags.catalog()).toHaveLength(policy === 'all' ? 2 : 1);
      const exported = exportCharacter(editable(store,id),null);
      expect(exported.data).toMatchObject({tags: format==='legacy' ? source.tags : modern().data.tags});
      expect(JSON.stringify(exported)).not.toContain(existing); expect(JSON.stringify(exported)).not.toContain('canonicalKey');
      expect(card(store,id).source).toEqual(source);
    }
  });
  it('keeps ccv3 authoritative when both PNG chunks are present', () => {
    const chunk = (keyword: string, value: unknown) => { const payload=Buffer.from(`${keyword}\0${Buffer.from(JSON.stringify(value)).toString('base64')}`), output=Buffer.alloc(payload.length+12); output.writeUInt32BE(payload.length);output.write('tEXt',4);payload.copy(output,8);return output; };
    const value=readCardFile(Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('ccv3',modern('chara_card_v3',['V3'])),chunk('chara',{...fields,tags:['V1']})]).toString('base64'));
    const store=open();store.importCard(rev(store),randomUUID(),value,'all');expect(store.tags.catalog().map(tag=>tag.name)).toEqual(['V3']);
  });
  it('reviews without writes, detects stale previews and rolls book/tag/character/command writes back together', () => {
    const store=open(), source={...modern(),data:{...modern().data,character_book:fixtures.v2}};
    const before=store.libraries(), review=store.previewCard(source);expect(store.libraries()).toEqual(before);expect(review.book?.entries).toBe(fixtures.v2.entries.length);
    store.tags.create(rev(store),'concurrent');const current=store.libraries();expect(()=>store.importCard(review.revision,randomUUID(),source,'all')).toThrow('changed');expect(store.libraries()).toEqual(current);
    store.sqlite.exec("CREATE TRIGGER reject_tag_import BEFORE INSERT ON character_tags BEGIN SELECT RAISE(ABORT, 'synthetic mid-import failure'); END");
    const requestId=randomUUID();expect(()=>store.importCard(rev(store),requestId,source,'all')).toThrow('synthetic mid-import failure');expect(store.libraries()).toEqual(current);expect(store.sqlite.prepare('SELECT * FROM lore_commands').all()).toEqual([]);
    store.sqlite.exec('DROP TRIGGER reject_tag_import');store.importCard(rev(store),requestId,source,'all');expect(store.libraries().lorebooks).toHaveLength(1);expect(store.tags.catalog()).toHaveLength(3);
  });
  it('retains complete overlong tag names for review tooltips without relaxing import limits', () => {
    const store = open(), name = 'Long review name '.repeat(30).trim();
    const source = modern('chara_card_v3', [name]);
    const before = store.libraries(), review = store.previewCard(source);
    expect(review.tags.newTags).toEqual([{ name, eligible: false, sourceIndexes: [0] }]);
    expect(review.tags.modes.all.blocked).toContain('100-character');
    expect(() => store.importCard(before.revision, randomUUID(), source, 'all')).toThrow('100-character');
    expect(store.libraries()).toEqual(before);
  });
  it('replays across restart/deletion without resurrection, conflicts on changed policy and permits intentional copies', () => {
    const path=join(folder(),'retry.sqlite');let store=open(path);const requestId=randomUUID(),source=modern(),revision=rev(store);
    const first=store.importCard(revision,requestId,source,'all');expect(store.importCard(revision,requestId,source,'all')).toEqual(first);
    expect(()=>store.importCard(revision,requestId,source,'existing')).toThrow('different command');
    store.close();store=open(path);expect(store.importCard(revision,requestId,source,'all')).toEqual(first);
    const copy=store.importCard(rev(store),randomUUID(),source,'all');expect(copy.ids).not.toEqual(first.ids);expect(store.tags.catalog()).toHaveLength(2);
    for (const id of [...first.ids,...copy.ids])store.deleteLibrary(rev(store),'characters',id);
    for (const tag of store.tags.catalog())store.tags.delete(rev(store),tag.id);
    const before=store.libraries();expect(store.importCard(revision,requestId,source,'all')).toEqual(first);expect(store.libraries()).toEqual(before);
    const noneId=randomUUID(),none=store.importCard(rev(store),noneId,source);expect(store.importCard(0,noneId,source,'none')).toEqual(none);
  });
  it('applies embedded tags additively and idempotently without exporting local changes', () => {
    const store=open(),source=modern(),id=addCharacter(store,importCharacter(source)),manual=store.tags.create(rev(store),'manual');store.tags.setAssignments(rev(store),id,[manual]);
    const before=card(store,id);expect(store.tags.embeddedReview(id).modes.all.assign).toBe(2);
    store.tags.applyEmbedded(rev(store),id,'existing');expect(store.tags.assigned(id)).toEqual([manual]);
    store.tags.applyEmbedded(rev(store),id,'all');expect(store.tags.assigned(id)).toHaveLength(3);const revision=rev(store);
    store.tags.applyEmbedded(revision,id,'all');store.tags.applyEmbedded(revision,id,'none');expect(rev(store)).toBe(revision);expect(card(store,id)).toEqual(before);
    const fantasy=required(store.tags.catalog().find(tag=>tag.name==='Fantasy'));store.tags.rename(rev(store),fantasy.id,'renamed');store.tags.delete(rev(store),manual);
    expect(exportCharacter(editable(store,id),null).data).toMatchObject({tags:source.data.tags});
  });
  it('enforces resulting assignment/catalog bounds while allowing existing matches at capacity', () => {
    const store=open();store.sqlite.transaction(()=>{for(let i=0;i<tagLimits.catalog;i++)store.sqlite.prepare('INSERT INTO tags(id,name,canonical_key) VALUES(?,?,?)').run(`t${i}`,`tag-${i}`,`tag-${i}`);})();
    const id=addCharacter(store,fields,Array.from({length:128},(_,i)=>`t${i}`));
    expect(()=>store.tags.create(rev(store),'over-capacity')).toThrow('limited');
    const source=modern('chara_card_v2',['TAG-1']);expect(store.previewCard(source).tags.modes.all.blocked).toBeNull();
    store.importCard(rev(store),randomUUID(),source,'all');
    const full=addCharacter(store,importCharacter(modern('chara_card_v2',['tag-129'])),Array.from({length:128},(_,i)=>`t${i}`));
    const before=store.libraries();expect(()=>store.tags.applyEmbedded(rev(store),full,'existing')).toThrow('at most 128');expect(store.libraries()).toEqual(before);
    expect(store.previewCard(modern('chara_card_v2',['x'.repeat(101)])).tags.modes.all.blocked).toContain('100');
    store.importCard(rev(store),randomUUID(),modern('chara_card_v2',['x'.repeat(101)]),'existing');expect(store.tags.assigned(id)).toHaveLength(128);
    expect(()=>store.importCard(rev(store),randomUUID(),modern('chara_card_v2',Array.from({length:129},(_,i)=>`tag-${i}`)),'existing')).toThrow('128');
  });
});

describe('version 9 migration and pre-tags command history', () => {
  it('upgrades populated version 8 without importing tags or changing unrelated records; replays legacy None', () => {
    const path=join(folder(),'upgrade.sqlite');let store=open(path);const source={...modern(),data:{...modern().data,character_book:fixtures.v2}},commandId=randomUUID();
    const result=store.importCard(rev(store),commandId,source);const legacyResult={ids:result.ids,books:result.books,diagnostics:result.diagnostics};
    store.sqlite.prepare('UPDATE lore_commands SET command=?,result=? WHERE request_id=?').run(createHash('sha256').update(JSON.stringify({kind:'character',value:source})).digest('hex'),JSON.stringify(legacyResult),commandId);
    const characterId=required(result.ids[0]);store.createChat(selectionsSchema.parse({title:'Migration',targetInputTokens:32000,connectionId:null,promptId:'default',characterId,personaId:null}));
    store.saveLibrary(rev(store),'connections',{name:'Secret',endpoint:'http://localhost:1234/v1',model:'mock',contextWindow:10000,maxOutputTokens:100,customParameters:{}},undefined,'synthetic-tag-secret');
    const rows=allRows(store.sqlite, true);store.close();const old=new Database(path);removeTagSchema(old);const revision=Number((old.prepare('SELECT revision FROM library_state').get() as {revision:number}).revision);old.close();
    store=open(path);expect(store.sqlite.pragma('user_version',{simple:true})).toBe(14);expect(allRows(store.sqlite, true)).toEqual(rows);expect(rev(store)).toBe(revision+3);expect(store.tags.links()).toEqual([]);expect(store.tags.catalog()).toEqual([]);
    expect(store.importCard(0,commandId,source,'none')).toEqual(legacyResult);expect(store.importCard(0,commandId,source)).toEqual(legacyResult);expect(()=>store.importCard(0,commandId,source,'all')).toThrow('different command');
    expect(store.tags.embeddedReview(characterId).newTags).toHaveLength(2);
    const saved=store.libraries();store.close();store=open(path);expect(store.libraries()).toEqual(saved);expect(allRows(store.sqlite, true)).toEqual(rows);
  });
  it('rolls the migration back and can retry safely after a write failure', () => {
    const path=join(folder(),'rollback.sqlite');const store=open(path);addCharacter(store,importCharacter(modern()));store.close();
    const old=new Database(path);removeTagSchema(old);const rows=allRows(old, true);old.exec("CREATE TRIGGER reject_tag_migration BEFORE UPDATE ON library_state BEGIN SELECT RAISE(ABORT, 'synthetic migration failure'); END");old.close();
    expect(()=>new Store(path)).toThrow('synthetic migration failure');const failed=new Database(path);expect(failed.pragma('user_version',{simple:true})).toBe(8);expect(failed.prepare("SELECT name FROM sqlite_master WHERE name='tags'").get()).toBeUndefined();expect(allRows(failed, true)).toEqual(rows);failed.exec('DROP TRIGGER reject_tag_migration');failed.close();
    const recovered=open(path);expect(recovered.sqlite.pragma('user_version',{simple:true})).toBe(14);expect(allRows(recovered.sqlite, true)).toEqual(rows);
  });
});

it('validates authenticated APIs, modes and IDs while keeping previews read-only and credentials private', async () => {
  const instance=await createApp({database:':memory:'});
  try {
    const headers={host:'localhost',origin:'http://localhost'};
    const setup=await instance.app.inject({method:'POST',url:'/api/setup',headers,payload:{password:'synthetic-tag-password'}});
    const auth={...headers,cookie:String(setup.headers['set-cookie']).split(';')[0]};
    const send=(url:string,payload:Record<string,unknown>,method:'POST'|'PUT'|'DELETE'='POST')=>instance.app.inject({method,url,headers:auth,payload});
    const source=modern(),base64=Buffer.from(JSON.stringify(source)).toString('base64'),before=instance.store.libraries();
    const preview = await send('/api/library/characters/preview', { base64 });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ name: fields.name, description: fields.description });
    expect(instance.store.libraries()).toEqual(before);
    expect((await send('/api/library/import',{kind:'characters',base64,revision:before.revision,tagPolicy:'typo'})).statusCode).toBe(400);
    expect((await instance.app.inject({method:'POST',url:'/api/library/tags',headers,payload:{revision:before.revision,name:'unauthorized'}})).statusCode).toBe(401);
    expect((await send('/api/library/tags',{revision:before.revision,name:'  '})).statusCode).toBe(400);
    const tag=await send('/api/library/tags',{revision:before.revision,name:'fantasy'});expect(tag.statusCode).toBe(200);
    const imported=await send('/api/library/import',{kind:'characters',base64,revision:rev(instance.store),tagPolicy:'existing',requestId:randomUUID()});expect(imported.statusCode).toBe(200);
    const id=required(instance.store.libraries().characters[0]).id;
    expect((await send(`/api/library/characters/${id}/tags`,{revision:rev(instance.store),tagIds:['missing']},'PUT')).statusCode).toBe(422);
    expect((await send(`/api/library/characters/default/tags`,{revision:rev(instance.store),tagIds:[]},'PUT')).statusCode).toBe(404);
    const saved=instance.store.libraries();expect((await send(`/api/library/${id}`,{revision:rev(instance.store),kind:'characters',data:{...editable(instance.store,id),description:'Combined'},tagIds:[]},'PUT')).statusCode).toBe(200);expect(instance.store.tags.assigned(id)).toEqual([]);
    expect((await send(`/api/library/tags/${required(saved.tags[0]).id}`,{revision:saved.revision,name:'stale'},'PUT')).statusCode).toBe(409);
  } finally {await instance.app.close();}
});

it('keeps real generation requests/history and lore state unchanged, and blocks shared tag writes during a response', async () => {
  const calls: import('../src/shared/contracts.js').RequestPreview[] = [];
  let hold = false;
  let release = () => {};
  const provider: import('../src/provider/openai.js').Provider = { async stream(request, _key, signal, onText) {
    calls.push(structuredClone(request));
    if (hold) await new Promise<void>(resolve => { release = resolve; signal.addEventListener('abort', () => resolve(), { once: true }); });
    onText('Synthetic keeper responds.'); return { finishReason: 'stop' };
  } };
  const f = await createApp({ database: ':memory:', provider });
  try {
    const setup = await f.app.inject({ method: 'POST', url: '/api/setup', headers: { host: 'localhost', origin: 'http://localhost' }, payload: { password: 'synthetic-tag-isolation-password' } });
    const headers = { host: 'localhost', origin: 'http://localhost', cookie: String(setup.headers['set-cookie']).split(';')[0] };
    const send = (url: string, payload: Record<string, unknown>) => f.app.inject({ method: 'POST', url, headers, payload });
    const imported = f.store.importCard(rev(f.store), randomUUID(), { ...modern(), data: { ...modern().data, character_book: fixtures.v2 } });
    const characterId = required(imported.ids[0]), connectionId = f.store.saveLibrary(rev(f.store), 'connections', { name: 'Synthetic', endpoint: 'http://localhost:1234/v1', model: 'synthetic', contextWindow: 100000, maxOutputTokens: 1000, customParameters: {} }, undefined, 'SYNTHETIC-TAG-SECRET');
    const chatId = f.store.createChat(selectionsSchema.parse({ title: 'Live isolation', targetInputTokens: 32000, connectionId, characterId, personaId: null, promptId: 'default' }));
    expect((await send(`/api/chats/${chatId}/turns`, { revision: f.store.snapshot(chatId).revision, requestId: randomUUID(), text: 'tower' })).statusCode).toBe(202);
    await expect.poll(() => f.store.snapshot(chatId).turns.at(-1)?.complete).toBe(true);
    const before = f.store.snapshot(chatId);
    const previewBefore = await send(`/api/chats/${chatId}/preview`, { revision: before.revision, text: 'again' }); expect(previewBefore.statusCode).toBe(200);
    const tag = f.store.tags.create(rev(f.store), '<script>literal tag</script>');
    f.store.tags.setAssignments(rev(f.store), characterId, [tag]); f.store.tags.applyEmbedded(rev(f.store), characterId, 'all'); f.store.tags.rename(rev(f.store), tag, 'Manual tag');
    const copy = f.store.duplicateCharacter(rev(f.store), characterId); f.store.deleteLibrary(rev(f.store), 'characters', copy); f.store.tags.delete(rev(f.store), tag);
    expect(f.store.snapshot(chatId)).toEqual(before);
    const previewAfter = await send(`/api/chats/${chatId}/preview`, { revision: before.revision, text: 'again' }); expect(previewAfter.json<unknown>()).toEqual(previewBefore.json<unknown>());
    expect(JSON.stringify(f.store.libraries()) + previewAfter.body).not.toContain('SYNTHETIC-TAG-SECRET'); expect(calls).toHaveLength(1);
    hold = true;
    expect((await send(`/api/chats/${chatId}/turns`, { revision: before.revision, requestId: randomUUID(), text: 'again' })).statusCode).toBe(202);
    await expect.poll(() => calls.length).toBe(2);
    const saved = f.store.libraries(), catalogTag = required(saved.tags[0]);
    expect(() => f.store.tags.create(saved.revision, 'blocked')).toThrow('response');
    expect(() => f.store.tags.rename(saved.revision, catalogTag.id, 'blocked')).toThrow('response');
    expect(() => f.store.tags.delete(saved.revision, catalogTag.id)).toThrow('response');
    expect(() => f.store.tags.setAssignments(saved.revision, characterId, [])).toThrow('response');
    expect(() => f.store.tags.applyEmbedded(saved.revision, characterId, 'all')).toThrow('response');
    expect(f.store.tags.embeddedReview(characterId).existing).toHaveLength(2);
    expect((await send('/api/library/characters/preview', { base64: Buffer.from(JSON.stringify(modern())).toString('base64') })).statusCode).toBe(200);
    expect(f.store.libraries()).toEqual(saved); release();
    await expect.poll(() => f.store.snapshot(chatId).turns.at(-1)?.complete).toBe(true);
    expect(calls[1]?.body).toEqual(previewAfter.json<import('../src/shared/contracts.js').RequestPreview>().body);
    expect(f.store.snapshot(chatId).generations.find(generation => generation.id === before.generations[0]?.id)?.request).toEqual(before.generations[0]?.request);
  } finally { release(); await f.app.close(); }
});
