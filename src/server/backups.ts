import { message } from '../shared/localization.js';
import Database from 'better-sqlite3';
import { databaseSchemaVersion } from '../shared/build-info.js';
import { buildInfo } from './installation.js';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statfsSync, statSync, closeSync, createWriteStream, openSync, readSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { PassThrough, Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { Store } from '../persistence/store.js';
import { BackupStore, insertRow, sanitizePortable } from '../persistence/backup-store.js';
import { checkUploadedFieldSizes, invalidBackup, rows, rowSchema, validateContent } from '../persistence/backup-validation.js';
import { backupLimits, backupTables, type BackupTable, type BackupReview, type BackupPage, type BackupLeaf, type BackupMetadata, type DataOutcome } from '../shared/backups.js';
import { AppError, BackupValidationError } from '../core/errors.js';
import { isProtectedFile, protectedPayloadMaxBytes, protectFile, unprotectFile, validateFilePassword } from './protected-files.js';

import { prepareTranscriptExport } from './transcript-export.js';
import { upgradeSingleBranches } from '../persistence/branch-upgrade.js';

const masterSchema = z.array(z.object({ type: z.string(), name: z.string(), tbl_name: z.string(), sql: z.string().nullable() }));
const schemaEntries = (db: Database.Database) => masterSchema.parse(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name").all());
// SQLite retains migration-file line endings; platform checkout settings can differ.
// Keep every other character significant when checking the shipped definitions.
const normalizeSchemaSql = (sql: string | null) => sql?.replace(/\r\n/g,'\n') ?? null;
const metadataSchema = z.object({ format: z.literal('ore-sqlite'), version: z.literal(1), schema: z.number().int(), build: z.string().max(100), createdAt: z.string().datetime() }).strict();
const metadataSql = 'CREATE TABLE backup_metadata (id INTEGER PRIMARY KEY CHECK(id = 1), data TEXT NOT NULL)';
const hidden = new Set(['credentials']);
export class BackupService {
  readonly persistence: BackupStore;
  private readonly directory: string;
  private readonly template: Buffer;
  private readonly schema: ReturnType<typeof schemaEntries>;
  private readonly schema16: ReturnType<typeof schemaEntries>;
  private readonly schema15: ReturnType<typeof schemaEntries>;
  private readonly schema14: ReturnType<typeof schemaEntries>;
  private readonly legacySchema: ReturnType<typeof schemaEntries>;
  private readonly build = buildInfo().commit ?? 'unrecorded-development';
  private readonly stages = new Map<string, { path: string; owner: string; digest: string; expires: number; metadata: BackupMetadata | null; plan?: ReturnType<BackupStore['preflight']> }>();
  private readonly timer: ReturnType<typeof setInterval>;
  private closed = false;
  private readonly uploads = new Set<AbortController>();
  constructor(private store: Store, filename: string, migrationsDirectory?: string) {
    if (filename === ':memory:') this.directory = mkdtempSync(join(tmpdir(),'ore-backups-'));
    else {
      this.directory = join(dirname(filename),`.ore-backups-${basename(filename)}`);
      // Only this database's private staging directory; never the source upload path.
      rmSync(this.directory,{ recursive: true, force: true }); mkdirSync(this.directory,{ mode: 0o700 });
    }
    this.persistence = new BackupStore(store, this.directory);
    const factory = new Store(':memory:',migrationsDirectory);
    try {
      this.template = factory.sqlite.serialize();
      this.schema = schemaEntries(factory.sqlite);
      factory.sqlite.exec('DROP INDEX turns_pinned; ALTER TABLE turns DROP COLUMN pinned');
      this.schema16 = schemaEntries(factory.sqlite);
      factory.sqlite.exec(`DROP INDEX chats_group;
        DROP INDEX context_step_source_request;
        ALTER TABLE summaries DROP COLUMN fork_source_request;
        ALTER TABLE chats DROP COLUMN branch_name;
        ALTER TABLE chats DROP COLUMN group_id;
        DROP TABLE chat_groups;
        DROP TABLE branch_commands;`);
      this.schema15 = schemaEntries(factory.sqlite);
      factory.sqlite.exec('ALTER TABLE generations DROP COLUMN error_message');
      this.schema14 = schemaEntries(factory.sqlite);
      // Reconstruct exact shipped older table definitions for strict upload validation.
      factory.sqlite.exec('DROP INDEX turn_message_date');
      for (const table of ['library', 'connections', 'chats']) {
        factory.sqlite.exec(`ALTER TABLE ${table} DROP COLUMN created_at; ALTER TABLE ${table} DROP COLUMN updated_at;`);
      }
      factory.sqlite.exec('ALTER TABLE turns DROP COLUMN message_at');
      this.legacySchema = schemaEntries(factory.sqlite);
    } finally { factory.close(); }
    this.timer = setInterval(() => this.expire(),60_000); this.timer.unref();
  }
  private expire() { for (const [id, stage] of this.stages) if (stage.expires < Date.now()) this.remove(id); }
  private remove(id: string) {
    const stage = this.stages.get(id); if (!stage) return;
    this.stages.delete(id); rmSync(dirname(stage.path),{ recursive: true, force: true });
  }
  private stage(id: string, owner: string) {
    this.expire(); const stage = this.stages.get(id);
    if (!stage || stage.owner !== owner) throw new AppError(404,'backup_expired',message("errors.this_backup_inspection_expired_or_was_cancelled_select"));
    return stage;
  }
  cancel(id: string, owner: string) { this.stage(id,owner); this.remove(id); }
  private space(bytes: number) {
    const space = statfsSync(this.directory);
    if (space.bavail * space.bsize < bytes * 4 + 16 * 1024 * 1024) throw new AppError(507,'backup_disk_space',message("errors.there_is_not_enough_free_disk_space_to"));
  }
  private validateSchema(db: Database.Database) {
    const version = db.pragma('user_version',{ simple: true });
    if (version !== 12 && version !== 13 && version !== 14 && version !== 15 && version !== 16 && version !== databaseSchemaVersion) throw invalidBackup(`Unsupported database schema version ${String(version)}; supported versions are 12 through ${databaseSchemaVersion}.`);
    const expected = (version === databaseSchemaVersion ? this.schema : version === 16 ? this.schema16 : version === 15 ? this.schema15 : version === 14 ? this.schema14 : this.legacySchema).filter(entry => version !== 12 || !['dataset_state','data_commands'].includes(entry.tbl_name));
    const maxObjects = expected.length + 1;
    const maxSqlLength = Math.max(metadataSql.length, ...expected.map(entry => entry.sql?.length ?? 0)) * 2 + 1;
    const actual = masterSchema.parse(db.prepare(`SELECT substr(type, 1, 50) AS type, substr(name, 1, 200) AS name,
      substr(tbl_name, 1, 200) AS tbl_name, substr(sql, 1, ?) AS sql
      FROM sqlite_master LIMIT ?`).all(maxSqlLength, maxObjects + 1));
    const portableMetadata = actual.find(entry => entry.name === 'backup_metadata');
    if (portableMetadata && normalizeSchemaSql(portableMetadata.sql) !== normalizeSchemaSql(metadataSql)) throw invalidBackup('Backup metadata table definition differs from the shipped definition.');
    const content = actual.filter(entry => entry.name !== 'backup_metadata');
    for (const entry of expected) {
      const found = content.find(candidate => candidate.name === entry.name);
      if (!found) throw invalidBackup(`Schema object ${entry.name} is missing.`);
      if (found.type !== entry.type || found.tbl_name !== entry.tbl_name
        || normalizeSchemaSql(found.sql) !== normalizeSchemaSql(entry.sql)) {
        throw invalidBackup(`Schema object ${entry.name} differs from the shipped definition.`);
      }
    }
    if (content.length !== expected.length) throw invalidBackup('The database contains unexpected schema objects (tables, indexes, views or triggers).');
    if (!portableMetadata) return null;
    const count = db.prepare('SELECT count(*) FROM backup_metadata').pluck().get();
    const record = db.prepare("SELECT data FROM backup_metadata WHERE typeof(data) = 'text' AND length(CAST(data AS BLOB)) <= 4000 LIMIT 1").get();
    if (count !== 1 || !record) throw invalidBackup('Expected exactly one backup metadata record.');
    const metadata = metadataSchema.parse(JSON.parse(z.object({ data: z.string().max(1000) }).parse(record).data));
    if (metadata.schema !== version) throw invalidBackup('Backup metadata schema version does not match the database version.');
    return metadata;
  }
  private beginUpload() {
    this.expire();
    if (this.closed) throw new AppError(503,'server_stopping',message("errors.the_server_is_stopping"));
    if (this.stages.size + this.uploads.size >= 3) throw new AppError(429,'backup_staging_full',message("errors.cancel_an_existing_backup_inspection_before_selecting_another"));
    this.space(0);
    return mkdtempSync(join(this.directory, 'stage-'));
  }
  async inspect(stream: Readable, owner: string, password = ''): Promise<BackupReview> {
    validateFilePassword(password);
    const directory = this.beginUpload();
    const controller = new AbortController();
    this.uploads.add(controller);
    const upload = join(directory, 'upload');
    const hash = createHash('sha256');
    let bytes = 0;
    let nextSpaceCheck = 0;
    // Pipeline may destroy its source on disk failure. Keep the HTTP request
    // alive long enough for Fastify to return the upload error.
    const input = new PassThrough();
    const onError = (error: Error) => { input.destroy(error); };
    const onClose = () => { if (!stream.readableEnded) input.destroy(new Error('Backup upload interrupted.')); };
    stream.once('error', onError);
    stream.once('close', onClose);
    try {
      const checkSpace = () => this.space(bytes);
      const transfer = pipeline(input, new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          try {
            if (bytes >= nextSpaceCheck) {
              checkSpace();
              nextSpaceCheck = bytes + 8 * 1024 * 1024;
            }
            hash.update(chunk);
            callback(null, chunk);
          } catch (error) { callback(error instanceof Error ? error : new Error('Backup upload failed.')); }
        },
      }), createWriteStream(upload, { flags: 'wx', mode: 0o600 }), { signal: controller.signal });
      if (stream.destroyed && !stream.readableEnded) onClose();
      else stream.pipe(input);
      await transfer;
      this.space(bytes);
      let source = upload;
      if (isProtectedFile(this.header(upload))) {
        source = join(directory, 'decrypted.sqlite');
        await unprotectFile(upload, source, 'backup', password, controller.signal);
        rmSync(upload);
      }
      if (this.closed) throw new AppError(503,'server_stopping',message("errors.the_server_is_stopping"));
      return this.stageUpload(source, owner, hash.digest('hex'));
    } catch (error) {
      rmSync(directory, { recursive: true, force: true });
      if (this.closed) throw new AppError(503,'server_stopping',message("errors.the_server_is_stopping"));
      if (error instanceof Error && 'code' in error && error.code === 'ENOSPC') {
        throw new AppError(507,'backup_disk_space',message("errors.backup_staging_ran_out_of_disk_space_free"));
      }
      throw error;
    } finally {
      stream.unpipe(input);
      stream.off('error', onError);
      stream.off('close', onClose);
      this.uploads.delete(controller);
      if (this.closed && this.uploads.size === 0) rmSync(this.directory, { recursive: true, force: true });
    }
  }
  private header(path: string) {
    const fd = openSync(path, 'r');
    const bytes = Buffer.alloc(16);
    try { return bytes.subarray(0, readSync(fd, bytes)); }
    finally { closeSync(fd); }
  }
  private stageUpload(original: string, owner: string, digest: string): BackupReview {
    const id = randomUUID(), directory = dirname(original), path = join(directory,'content.sqlite');
    if (statSync(original).size < 100) throw invalidBackup('File is shorter than a SQLite database header (100 bytes).');
    if (this.header(original).toString('binary') !== 'SQLite format 3\0') throw invalidBackup('File does not have the SQLite 3 header signature.');
    let source: Database.Database | undefined, trusted: Database.Database | undefined;
    let phase = 'Opening uploaded SQLite database';
    try {
      source = new Database(original,{ readonly: true, fileMustExist: true }); source.pragma('trusted_schema = OFF');
      phase = 'Validating database schema and backup metadata';
      const metadata = this.validateSchema(source);
      const sourceVersion = z.number().int().parse(source.pragma('user_version', { simple: true }));
      const singleBranches = sourceVersion < 16;
      // Never migrate/open the upload with Store. Rebuild rows using only the shipped trusted schema.
      writeFileSync(path,this.template,{ mode: 0o600, flag: 'wx' });
      trusted = new Database(path); trusted.pragma('foreign_keys = ON'); trusted.pragma('temp_store = FILE');
      trusted.transaction(() => {
        trusted?.pragma('defer_foreign_keys = ON');
        trusted?.exec('DELETE FROM chat_groups; DELETE FROM library;');
        let count = 0;
        for (const table of backupTables) {
          if (singleBranches && table === 'chat_groups') continue;
          phase = `Reading table ${table}`;
          checkUploadedFieldSizes(sourceDatabase(), table);
          let ordinal = 0;
          for (const row of rows(sourceDatabase(),table)) {
            phase = `Reconstructing table ${table}, record ${++ordinal}`;
            if (++count > backupLimits.rows) throw invalidBackup('Portable content exceeds the 100,000-row limit.');
            if (Object.values(row).some(value => typeof value === 'string' && Buffer.byteLength(value) > backupLimits.textBytes)) throw invalidBackup(`Table ${table}, record ${ordinal}: a text field exceeds the 16 MiB limit.`);
            insertRow(trustedDatabase(),table,row);
          }
        }
        if (singleBranches) upgradeSingleBranches(trustedDatabase());
        phase = 'Committing reconstructed backup tables';
      })();
      phase = 'Validating reconstructed backup content';
      validateContent(trusted);
      phase = 'Removing runtime authority from staged content';
      sanitizePortable(trusted);
      phase = 'Validating sanitized backup content';
      validateContent(trusted);
      trusted.close(); trusted = undefined; source.close(); source = undefined;
      rmSync(original);
      this.stages.set(id,{ path,owner,digest,expires: Date.now()+backupLimits.ttlMs,metadata });
      return this.review(id,owner);
    } catch (error) {
      if (trusted?.open) trusted.close(); if (source?.open) source.close();
      this.stages.delete(id);
      if (error instanceof BackupValidationError) throw invalidBackup(`${phase}: ${error.details}`);
      if (error instanceof AppError) throw error;
      if (error instanceof Error && 'code' in error && ['ENOSPC','SQLITE_FULL'].includes(String(error.code))) throw new AppError(507,'backup_disk_space',message("errors.backup_staging_ran_out_of_disk_space_free"));
      // SQLite/Zod messages, paths and received values can contain secrets from the upload.
      let reason = 'Unexpected staging or content-validation failure.';
      if (error instanceof z.ZodError) reason = `Record validation failed (${[...new Set(error.issues.map(issue => issue.code))].join(', ')}).`;
      else if (error instanceof SyntaxError) reason = 'Malformed JSON.';
      else if (error instanceof Error && 'code' in error && typeof error.code === 'string' && /^SQLITE_[A-Z_]+$/.test(error.code)) reason = `SQLite rejected the backup (${error.code}).`;
      throw invalidBackup(`${phase}: ${reason}`);
    }
    function sourceDatabase() { if (!source) throw invalidBackup('Uploaded database is unavailable.'); return source; }
    function trustedDatabase() { if (!trusted) throw invalidBackup('Trusted staging database is unavailable.'); return trusted; }
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
    if (stage.digest !== input.digest) throw new AppError(409,'backup_digest',message("errors.the_backup_changed_select_and_review_it_again"));
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
      const labelExpression = table === 'chat_groups' ? "json_extract(settings,'$.title')"
        : table === 'chats' ? "(SELECT json_extract(settings,'$.title') FROM chat_groups WHERE id = chats.group_id) || coalesce(' · ' || branch_name, '')"
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
      if (field && !textFields.includes(field)) throw new AppError(400,'backup_field',message("errors.select_a_text_field_belonging_to_this_record"));
      const preferred = ['data','settings','user_text','request','resolution','text'];
      const selectedField = field ?? preferred.find(name => textFields.includes(name)) ?? textFields[0];
      const expressions = columns.flatMap((column,index) => [
        `CASE WHEN typeof("${column.name}") = 'blob' OR length(CAST("${column.name}" AS BLOB)) > 200 THEN NULL ELSE "${column.name}" END AS "value${index}"`,
        `length(CAST("${column.name}" AS BLOB)) AS "bytes${index}"`,
      ]);
      const raw = db.prepare(`SELECT ${expressions.join(',')} FROM "${table}" WHERE rowid = ?`).get(key);
      if (!raw) throw new AppError(404,'backup_record_missing',message("errors.this_backup_record_is_unavailable"));
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
  exportTranscript(chatId: string, revision: number) {
    return prepareTranscriptExport(this.store, this.directory, chatId, revision);
  }
  async export(password = '') {
    validateFilePassword(password);
    const size = z.number().parse(this.store.sqlite.pragma('page_count',{ simple: true })) * z.number().parse(this.store.sqlite.pragma('page_size',{ simple: true }));
    this.space(size);
    const directory = mkdtempSync(join(this.directory,'download-')), path = join(directory,'backup.sqlite');
    try {
      await this.store.sqlite.backup(path); chmodSync(path,0o600);
      if (this.closed) throw new AppError(503,'server_stopping',message("errors.the_server_is_stopping_try_again_after_restart"));
      const db = new Database(path);
      try {
        db.pragma('temp_store = FILE'); db.pragma('secure_delete = ON'); sanitizePortable(db);
        validateContent(db);
        db.exec(metadataSql);
        const metadata: BackupMetadata = { format: 'ore-sqlite',version: 1,schema: databaseSchemaVersion,build: this.build,createdAt: new Date().toISOString() };
        db.prepare('INSERT INTO backup_metadata VALUES (1,?)').run(JSON.stringify(metadata));
        // Rebuild pages so removed login/repair secrets cannot remain in free pages or WAL frames.
        db.pragma('journal_mode = DELETE'); db.exec('VACUUM');
      } finally { db.close(); }
      if (statSync(path).size > protectedPayloadMaxBytes) throw new AppError(413,'backup_too_large',message("errors.backup_exceeds_encryption_capacity"));
      const protectedPath = join(directory, 'backup.orebackup');
      await protectFile(path, protectedPath, 'backup', password);
      if (this.closed) throw new AppError(503,'server_stopping',message("errors.the_server_is_stopping_try_again_after_restart"));
      rmSync(path);
      return { path: protectedPath,cleanup: () => rmSync(directory,{ recursive: true,force: true }) };
    } catch (error) { rmSync(directory,{ recursive: true,force: true }); throw error; }
  }
  close() {
    this.closed = true;
    clearInterval(this.timer);
    this.stages.clear();
    for (const upload of this.uploads) upload.abort();
    if (this.uploads.size === 0) rmSync(this.directory, { recursive: true, force: true });
  }
}
