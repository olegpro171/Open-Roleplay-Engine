import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statfsSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { Store } from '../persistence/store.js';
import { BackupStore, insertRow, sanitizePortable } from '../persistence/backup-store.js';
import { invalidBackup, rows, rowSchema, validateContent } from '../persistence/backup-validation.js';
import { backupLimits, backupTables, type BackupTable, type BackupReview, type BackupPage, type BackupLeaf, type BackupMetadata, type DataOutcome } from '../shared/backups.js';
import { AppError } from '../core/errors.js';

const masterSchema = z.array(z.object({ type: z.string(), name: z.string(), tbl_name: z.string(), sql: z.string().nullable() }));
const schemaEntries = (db: Database.Database) => masterSchema.parse(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name").all());
const metadataSchema = z.object({ format: z.literal('ore-sqlite'), version: z.literal(1), schema: z.number().int(), build: z.string().max(100), createdAt: z.string().datetime() }).strict();
const metadataSql = 'CREATE TABLE backup_metadata (id INTEGER PRIMARY KEY CHECK(id = 1), data TEXT NOT NULL)';
const hidden = new Set(['credentials']);
export class BackupService {
  readonly persistence: BackupStore;
  private readonly directory: string;
  private readonly template: Buffer;
  private readonly schema: ReturnType<typeof schemaEntries>;
  private readonly build = z.object({ version: z.string().min(1).max(100) }).parse(JSON.parse(readFileSync(resolve('package.json'),'utf8'))).version;
  private readonly stages = new Map<string, { path: string; owner: string; digest: string; expires: number; metadata: BackupMetadata | null; plan?: ReturnType<BackupStore['preflight']> }>();
  private readonly timer: ReturnType<typeof setInterval>;
  private closed = false;
  constructor(private store: Store, filename: string, migrationsDirectory?: string) {
    this.persistence = new BackupStore(store);
    if (filename === ':memory:') this.directory = mkdtempSync(join(tmpdir(),'ore-backups-'));
    else {
      this.directory = join(dirname(filename),`.ore-backups-${basename(filename)}`);
      // Only this database's private staging directory; never the source upload path.
      rmSync(this.directory,{ recursive: true, force: true }); mkdirSync(this.directory,{ mode: 0o700 });
    }
    const factory = new Store(':memory:',migrationsDirectory);
    this.template = factory.sqlite.serialize(); this.schema = schemaEntries(factory.sqlite); factory.close();
    this.timer = setInterval(() => this.expire(),60_000); this.timer.unref();
  }
  private expire() { for (const [id, stage] of this.stages) if (stage.expires < Date.now()) this.remove(id); }
  private remove(id: string) {
    const stage = this.stages.get(id); if (!stage) return;
    this.stages.delete(id); rmSync(dirname(stage.path),{ recursive: true, force: true });
  }
  private stage(id: string, owner: string) {
    this.expire(); const stage = this.stages.get(id);
    if (!stage || stage.owner !== owner) throw new AppError(404,'backup_expired','This backup inspection expired or was cancelled. Select the file again.');
    return stage;
  }
  cancel(id: string, owner: string) { this.stage(id,owner); this.remove(id); }
  private space(bytes: number) {
    const space = statfsSync(this.directory);
    if (space.bavail * space.bsize < bytes * 4 + 16 * 1024 * 1024) throw new AppError(507,'backup_disk_space','There is not enough free disk space to stage this backup safely. Free space and try again.');
  }
  private validateSchema(db: Database.Database) {
    const version = db.pragma('user_version',{ simple: true });
    if (version !== 12 && version !== 13) throw new AppError(422,'backup_schema','Only ORE schema 12 and 13 are supported. Future and older unsupported schemas cannot be imported.');
    const expected = this.schema.filter(entry => version === 13 || !['dataset_state','data_commands'].includes(entry.tbl_name));
    const actual = schemaEntries(db);
    const portableMetadata = actual.find(entry => entry.name === 'backup_metadata');
    if (portableMetadata && portableMetadata.sql !== metadataSql) throw invalidBackup();
    if (JSON.stringify(actual.filter(entry => entry.name !== 'backup_metadata')) !== JSON.stringify(expected)) throw invalidBackup();
    if (!portableMetadata) return null;
    const records = db.prepare('SELECT data FROM backup_metadata').all();
    if (records.length !== 1) throw invalidBackup();
    const metadata = metadataSchema.parse(JSON.parse(z.object({ data: z.string().max(1000) }).parse(records[0]).data));
    if (metadata.schema !== version) throw invalidBackup();
    return metadata;
  }
  upload(bytes: Buffer, owner: string): BackupReview {
    this.expire();
    if (this.closed) throw new AppError(503,'server_stopping','The server is stopping.');
    if (this.stages.size >= 3) throw new AppError(429,'backup_staging_full','Cancel an existing backup inspection before selecting another file.');
    if (bytes.length > backupLimits.bytes || bytes.length < 100 || bytes.subarray(0,16).toString('binary') !== 'SQLite format 3\0') throw invalidBackup();
    this.space(bytes.length);
    const id = randomUUID(), directory = mkdtempSync(join(this.directory,'stage-'));
    const original = join(directory,'upload.sqlite'), path = join(directory,'content.sqlite');
    let source: Database.Database | undefined, trusted: Database.Database | undefined;
    try {
      writeFileSync(original,bytes,{ mode: 0o600, flag: 'wx' });
      source = new Database(original,{ readonly: true, fileMustExist: true }); source.pragma('trusted_schema = OFF');
      const metadata = this.validateSchema(source);
      // Never migrate/open the upload with Store. Rebuild rows using only the shipped trusted schema.
      writeFileSync(path,this.template,{ mode: 0o600, flag: 'wx' });
      trusted = new Database(path); trusted.pragma('foreign_keys = ON');
      trusted.transaction(() => {
        trusted?.pragma('defer_foreign_keys = ON');
        trusted?.exec('DELETE FROM chats; DELETE FROM library;');
        let count = 0;
        for (const table of backupTables) {
          for (const row of rows(sourceDatabase(),table)) {
            if (++count > backupLimits.rows || Object.values(row).some(value => typeof value === 'string' && Buffer.byteLength(value) > backupLimits.textBytes)) throw invalidBackup();
            insertRow(trustedDatabase(),table,row);
          }
        }
      })();
      validateContent(trusted);
      sanitizePortable(trusted);
      validateContent(trusted);
      trusted.close(); trusted = undefined; source.close(); source = undefined;
      rmSync(original);
      this.stages.set(id,{ path,owner,digest: createHash('sha256').update(bytes).digest('hex'),expires: Date.now()+backupLimits.ttlMs,metadata });
      return this.review(id,owner);
    } catch (error) {
      if (trusted?.open) trusted.close(); if (source?.open) source.close();
      this.stages.delete(id); rmSync(directory,{ recursive: true, force: true });
      if (error instanceof AppError) throw error;
      if (error instanceof Error && 'code' in error && ['ENOSPC','SQLITE_FULL'].includes(String(error.code))) throw new AppError(507,'backup_disk_space','Backup staging ran out of disk space. Free space and select the file again.');
      // SQLite/Zod errors may include source values. Never send those messages to the browser.
      throw invalidBackup();
    }
    function sourceDatabase() { if (!source) throw invalidBackup(); return source; }
    function trustedDatabase() { if (!trusted) throw invalidBackup(); return trusted; }
  }
  review(id: string, owner: string, offset = 0): BackupReview {
    const stage = this.stage(id,owner), db = new Database(stage.path,{ readonly: true });
    try {
      const token = this.persistence.token;
      const plan = stage.plan?.token === token ? stage.plan : this.persistence.preflight(db);
      stage.plan = plan;
      return { stageId: id,digest: stage.digest,token: plan.token,metadata: stage.metadata,
        additions: plan.units.filter(unit => !unit.overlap).length,overlaps: plan.units.filter(unit => unit.overlap).length,
        units: plan.units.slice(offset,offset+backupLimits.page),totalUnits: plan.units.length,
        effects: plan.effects.slice(offset,offset+backupLimits.page),totalEffects: plan.effects.length,
        blockers: plan.blockers,expiresAt: new Date(stage.expires).toISOString() };
    } finally { db.close(); }
  }
  commit(id: string, owner: string, input: { requestId: string; digest: string; token: string; overwrite: boolean }) {
    const replay = this.persistence.replay(input.requestId,`import:${input.digest}:${input.token}:${input.overwrite}`); if (replay) return replay;
    const stage = this.stage(id,owner);
    if (stage.digest !== input.digest) throw new AppError(409,'backup_digest','The backup changed. Select and review it again.');
    const db = new Database(stage.path,{ readonly: true });
    let outcome: DataOutcome;
    try { outcome = this.persistence.commit(input,db); }
    finally { db.close(); }
    // Windows cannot remove an open SQLite file. Close before deleting staging.
    this.remove(id);
    return outcome;
  }
  page(id: string, owner: string, table: BackupTable, offset: number, chat?: string): BackupPage {
    const stage = this.stage(id,owner), db = new Database(stage.path,{ readonly: true });
    try {
      const where = !chat ? '' : ['turns','generations','summaries','context_states','context_jobs','lore_states','lore_epochs','lore_operations'].includes(table) ? ' WHERE chat_id = ?' : table === 'response_variants' ? ' WHERE turn_id IN (SELECT id FROM turns WHERE chat_id = ?)' : table === 'context_steps' ? ' WHERE job_id IN (SELECT id FROM context_jobs WHERE chat_id = ?)' : '';
      const params = where ? [chat] : [];
      const total = z.object({ n: z.number() }).parse(db.prepare(`SELECT count(*) n FROM "${table}"${where}`).get(...params)).n;
      const labelExpression = table === 'chats' ? "json_extract(settings,'$.title')"
        : table === 'library' ? "json_extract(data,'$.name')"
        : table === 'connections' ? "json_extract(settings,'$.name')"
        : table === 'tags' ? 'name'
        : table === 'turns' ? "'Turn ' || position || CASE WHEN complete = 0 THEN ' · pending' ELSE '' END"
        : table === 'summaries' ? "id || ' · revision ' || revision"
        : table === 'character_tags' ? "character_id || ' · ' || tag_id"
        : table === 'lore_states' ? "chat_id || ' · ' || book_id"
        : table === 'character_pictures' ? 'character_id'
        : table === 'context_states' || table === 'lore_epochs' ? 'chat_id'
        : table === 'lore_operations' ? 'operation_id' : 'id';
      // Branches never fetch transcript bodies, request JSON or image BLOBs.
      const result = db.prepare(`SELECT rowid AS key, substr(${labelExpression},1,200) AS label${table === 'chats' ? ', id AS chatId' : ''} FROM "${table}"${where} ORDER BY rowid LIMIT ? OFFSET ?`).all(...params,backupLimits.page,offset);
      const items = z.array(z.object({ key: z.number(), label: z.string(), chatId: z.string().optional() })).parse(result);
      return { table,offset,total,items };
    } finally { db.close(); }
  }
  leaf(id: string, owner: string, table: BackupTable, key: number, offset: number, field?: string): BackupLeaf {
    const stage = this.stage(id,owner), db = new Database(stage.path,{ readonly: true });
    try {
      if (hidden.has(table)) {
        const credential = z.object({ id: z.string(), present: z.number() }).parse(db.prepare('SELECT id, length(CAST(api_key AS BLOB)) > 0 AS present FROM credentials WHERE rowid = ?').get(key));
        return { label: 'Connection credential',text: null,fields: [{ name: 'Connection ID',value: credential.id },{ name: 'Saved API key',value: credential.present ? 'Present' : 'Absent' }],offset: 0,total: 0 };
      }
      const columns = z.array(z.object({ name: z.string(), type: z.string() })).parse(db.prepare(`PRAGMA table_info("${table}")`).all());
      const textFields = columns.filter(column => column.type === 'TEXT').map(column => column.name);
      if (field && !textFields.includes(field)) throw new AppError(400,'backup_field','Select a text field belonging to this record.');
      const preferred = ['data','settings','user_text','request','resolution','text'];
      const selectedField = field ?? preferred.find(name => textFields.includes(name)) ?? textFields[0];
      const expressions = columns.flatMap((column,index) => [
        `CASE WHEN typeof("${column.name}") = 'blob' OR length(CAST("${column.name}" AS BLOB)) > 200 THEN NULL ELSE "${column.name}" END AS "value${index}"`,
        `length(CAST("${column.name}" AS BLOB)) AS "bytes${index}"`,
      ]);
      const raw = db.prepare(`SELECT ${expressions.join(',')} FROM "${table}" WHERE rowid = ?`).get(key);
      if (!raw) throw new AppError(404,'backup_record_missing','This backup record is unavailable.');
      const summary = rowSchema.parse(raw);
      const fields = columns.map((column,index) => ({ name: column.name,value: summary[`value${index}`] !== null ? String(summary[`value${index}`]) : summary[`bytes${index}`] !== null ? `${summary[`bytes${index}`]} bytes` : 'None' }));
      let text: string | null = null;
      if (selectedField) text = z.object({ text: z.string().nullable() }).parse(db.prepare(`SELECT "${selectedField}" AS text FROM "${table}" WHERE rowid = ?`).get(key)).text;
      return { label: table,text: text?.slice(offset,offset+8192) ?? null,fields,textFields,field: selectedField,offset,total: text?.length ?? 0,
        ...(table === 'picture_assets' || table === 'character_pictures' ? { imageUrl: `/api/data/stages/${id}/image/${table}/${key}` } : {}) };
    } finally { db.close(); }
  }
  image(id: string, owner: string, table: 'picture_assets' | 'character_pictures', key: number): Buffer {
    const stage = this.stage(id,owner), db = new Database(stage.path,{ readonly: true });
    try {
      const row = db.prepare(`SELECT ${table === 'picture_assets' ? 'preview' : 'thumbnail'} AS image FROM ${table} WHERE rowid = ?`).get(key);
      return z.object({ image: z.instanceof(Buffer) }).parse(row).image;
    } finally { db.close(); }
  }
  async export() {
    const size = z.number().parse(this.store.sqlite.pragma('page_count',{ simple: true })) * z.number().parse(this.store.sqlite.pragma('page_size',{ simple: true }));
    if (size > backupLimits.bytes) throw new AppError(413,'backup_too_large','The database exceeds the supported 128 MiB backup limit.');
    this.space(size);
    const directory = mkdtempSync(join(this.directory,'download-')), path = join(directory,'backup.sqlite');
    try {
      await this.store.sqlite.backup(path); chmodSync(path,0o600);
      if (this.closed) throw new AppError(503,'server_stopping','The server is stopping. Try again after restart.');
      const db = new Database(path);
      try {
        db.pragma('secure_delete = ON'); sanitizePortable(db);
        validateContent(db);
        db.exec(metadataSql);
        const metadata: BackupMetadata = { format: 'ore-sqlite',version: 1,schema: 13,build: this.build,createdAt: new Date().toISOString() };
        db.prepare('INSERT INTO backup_metadata VALUES (1,?)').run(JSON.stringify(metadata));
        // Rebuild pages so removed login/repair secrets cannot remain in free pages or WAL frames.
        db.pragma('journal_mode = DELETE'); db.exec('VACUUM');
      } finally { db.close(); }
      if (statSync(path).size > backupLimits.bytes) throw new AppError(413,'backup_too_large','The completed backup exceeds the supported 128 MiB limit.');
      return { path,cleanup: () => rmSync(directory,{ recursive: true,force: true }) };
    } catch (error) { rmSync(directory,{ recursive: true,force: true }); throw error; }
  }
  close() { this.closed = true; clearInterval(this.timer); this.stages.clear(); if (existsSync(this.directory)) rmSync(this.directory,{ recursive: true,force: true }); }
}
