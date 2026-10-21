import { message } from '../shared/localization.js';
import { unchangedLoreEntries } from '../core/lorebook.js';
import { lorebookSchema } from '../shared/lorebook.js';
import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Store } from './store.js';
import { AppError } from '../core/errors.js';
import { backupTables, backupLimits, type BackupTable, type BackupUnit, type DataOutcome } from '../shared/backups.js';
import { defaultPrompt } from '../shared/library.js';
import { defaultContextPreset } from '../shared/context.js';
import { rows, str, json, rowSchema, validateContent, type BackupRow } from './backup-validation.js';
import { z } from 'zod';

export function datasetEpoch(db: Database.Database): string {
  return z.object({ epoch: z.string() }).parse(db.prepare('SELECT epoch FROM dataset_state WHERE id = 1').get()).epoch;
}
export function stateToken(db: Database.Database): string {
  // This includes chat children and organization/image state, not only revision counters.
  const hash = createHash('sha256');
  hash.update(datasetEpoch(db));
  for (const table of backupTables) {
    const records = rows(db,table);
    hash.update(`${table}:${records.length}:`);
    for (const row of records) for (const [key,value] of Object.entries(row)) {
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
      hash.update(`${key}:${bytes.length}:`);
      hash.update(bytes);
    }
  }
  return hash.digest('hex');
}
export function insertRow(db: Database.Database, table: BackupTable, row: BackupRow, upsert = false) {
  const keys = Object.keys(row);
  const conflict = upsert ? ` ON CONFLICT(id) DO UPDATE SET ${keys.filter(key => key !== 'id').map(key => `"${key}"=excluded."${key}"`).join(',')}` : '';
  db.prepare(`INSERT INTO "${table}" (${keys.map(key => `"${key}"`).join(',')}) VALUES (${keys.map(() => '?').join(',')})${conflict}`).run(...keys.map(key => row[key] ?? null));
}
export function sanitizePortable(db: Database.Database) {
  db.transaction(() => {
    db.exec('DELETE FROM sessions; DELETE FROM owners; DELETE FROM runtime_owner; DELETE FROM lore_commands; DELETE FROM data_commands;');
    db.prepare("UPDATE dataset_state SET epoch = 'initial' WHERE id = 1").run();
    db.prepare("UPDATE generations SET status = 'interrupted', error = 'The saved operation was interrupted. Retry explicitly.', error_message = ? WHERE status = 'running'").run(JSON.stringify(message('outcome.backupInterrupted')));
    for (const row of rows(db,'generations')) db.prepare('UPDATE generations SET request_id = ? WHERE id = ?').run(randomUUID(), row.id);
    for (const row of rows(db,'context_steps')) {
      const value = z.record(z.string(),z.unknown()).parse(json(row));
      if (value.status === 'candidate' || value.status === 'running') {
        value.status = value.status === 'candidate' ? 'discarded' : 'interrupted'; value.result = null;
        value.error = message('outcome.backupUnapproved').fallback; value.errorMessage = message('outcome.backupUnapproved');
      }
      db.prepare('UPDATE context_steps SET data = ? WHERE id = ?').run(JSON.stringify(value),row.id);
    }
    for (const row of rows(db,'context_jobs')) {
      const value = z.record(z.string(),z.unknown()).parse(json(row));
      delete value.repairCommands;
      if (value.status === 'running' || value.status === 'awaiting_review') {
        value.status = 'interrupted'; value.error = message('outcome.backupUnfinished').fallback; value.errorMessage = message('outcome.backupUnfinished');
      }
      db.prepare('UPDATE context_jobs SET request_id = ?, data = ? WHERE id = ?').run(randomUUID(),JSON.stringify(value),row.id);
    }
    db.exec("DELETE FROM summaries WHERE json_extract(data, '$.approved') = 0");
  })();
}

function childCount(db: Database.Database, chatId: string): number {
  return ['turns','generations','summaries','context_jobs','lore_states','lore_operations'].reduce((sum,table) => sum + z.object({ n: z.number() }).parse(db.prepare(`SELECT count(*) n FROM ${table} WHERE chat_id = ?`).get(chatId)).n,0)
    + z.object({ n: z.number() }).parse(db.prepare('SELECT count(*) n FROM response_variants JOIN turns ON turns.id = response_variants.turn_id WHERE turns.chat_id = ?').get(chatId)).n
    + z.object({ n: z.number() }).parse(db.prepare('SELECT count(*) n FROM context_steps JOIN context_jobs ON context_jobs.id = context_steps.job_id WHERE context_jobs.chat_id = ?').get(chatId)).n;
}
export function importUnits(current: Database.Database, incoming: Database.Database): BackupUnit[] {
  const units: BackupUnit[] = [];
  for (const kind of ['chats','connections','library','tags'] as const) {
    for (const row of rows(incoming,kind)) {
      const old = current.prepare(`SELECT id FROM ${kind} WHERE id = ?`).get(row.id);
      const data = kind === 'tags' ? { name: row.name } : z.record(z.string(),z.unknown()).parse(json(row,kind === 'library' ? 'data' : 'settings'));
      units.push({ kind, id: str(row,'id'), name: z.string().parse(data.name ?? data.title), overlap: Boolean(old), children: kind === 'chats' && old ? childCount(current,str(row,'id')) : 0 });
    }
  }
  return units;
}

export function mergeContent(destination: Database.Database, incoming: Database.Database) {
  const incomingChats = new Set(rows(incoming,'chats').map(row => str(row,'id')));
  const incomingLibrary = rows(incoming,'library');
  const incomingConnections = rows(incoming,'connections');
  const incomingById = new Map(incomingLibrary.map(row => [str(row,'id'),row]));
  const libraries = new Map(rows(destination,'library').map(row => [str(row,'id'),row]));
  const connectionIds = new Set(rows(destination,'connections').map(row => str(row,'id')));
  for (const row of incomingLibrary) if ((libraries.has(str(row,'id')) && libraries.get(str(row,'id'))?.kind !== row.kind) || connectionIds.has(str(row,'id'))) throw new AppError(422,'backup_collision',message("errors.an_incoming_library_identity_belongs_to_another_kind"));
  for (const row of incomingConnections) if (libraries.has(str(row,'id'))) throw new AppError(422,'backup_collision',message("errors.an_incoming_connection_identity_belongs_to_another_library"));
  for (const row of rows(incoming,'tags')) {
    const conflict = destination.prepare('SELECT id FROM tags WHERE canonical_key = ? AND id != ?').get(row.canonical_key,row.id);
    if (conflict) throw new AppError(422,'backup_tag_conflict',message("errors.different_tag_identities_share_a_normalized_name_rename"));
  }
  // Reject child identities owned by an unaffected chat, including tables without SQL ownership constraints.
  const ownershipQueries: Partial<Record<BackupTable,string>> = {
    turns: 'SELECT chat_id FROM turns WHERE id = ?', generations: 'SELECT chat_id FROM generations WHERE id = ?',
    summaries: 'SELECT chat_id FROM summaries WHERE id = ?', context_jobs: 'SELECT chat_id FROM context_jobs WHERE id = ?',
    response_variants: 'SELECT turns.chat_id FROM response_variants JOIN turns ON turns.id = response_variants.turn_id WHERE response_variants.id = ?',
    context_steps: 'SELECT context_jobs.chat_id FROM context_steps JOIN context_jobs ON context_jobs.id = context_steps.job_id WHERE context_steps.id = ?',
    lore_operations: 'SELECT chat_id FROM lore_operations WHERE operation_id = ?',
  };
  for (const table of backupTables) {
    const query = ownershipQueries[table]; if (!query) continue;
    for (const row of rows(incoming,table)) {
      const old = destination.prepare(query).all(table === 'lore_operations' ? row.operation_id : row.id).map(item => z.object({ chat_id: z.string() }).parse(item));
      let chat = row.chat_id;
      if (table === 'response_variants') chat = rowSchema.parse(incoming.prepare('SELECT chat_id FROM turns WHERE id = ?').get(row.turn_id)).chat_id;
      if (table === 'context_steps') chat = rowSchema.parse(incoming.prepare('SELECT chat_id FROM context_jobs WHERE id = ?').get(row.job_id)).chat_id;
      if (old.some(owner => owner.chat_id !== chat)) throw new AppError(422,'backup_ownership_conflict',message("errors.a_child_identity_belongs_to_a_different_chat"));
    }
  }
  const retainedEffects: { id: string; title: string; reason: string }[] = [];
  const libraryIds = new Set(incomingLibrary.map(row => str(row,'id')));
  const connectionChanges = new Set(incomingConnections.map(row => str(row,'id')));
  for (const row of rows(destination,'chats')) {
    if (incomingChats.has(str(row,'id'))) continue;
    const settings = z.record(z.string(),z.unknown()).parse(json(row,'settings'));
    const context = typeof settings.contextPresetId === 'string' ? libraries.get(settings.contextPresetId) : undefined;
    const summaryConnection = context ? z.record(z.string(),z.unknown()).parse(json(context)).connectionId : null;
    const affected = ['promptId','characterId','personaId','contextPresetId','lorebookId'].some(key => typeof settings[key] === 'string' && libraryIds.has(settings[key])) || connectionChanges.has(String(settings.connectionId)) || connectionChanges.has(String(summaryConnection));
    if (affected) {
      retainedEffects.push({ id: str(row,'id'), title: z.string().parse(settings.title), reason: 'Shared incoming settings affect future requests. Saved turns, memory and historical requests are retained.' });
      destination.prepare('UPDATE chats SET revision = revision + 1 WHERE id = ?').run(row.id);
      const nameChanged = ['characterId','personaId'].some(key => {
        const before = libraries.get(String(settings[key])), after = incomingById.get(String(settings[key]));
        return before && after && z.record(z.string(),z.unknown()).parse(json(before)).name !== z.record(z.string(),z.unknown()).parse(json(after)).name;
      });
      if (nameChanged) {
        destination.prepare('INSERT INTO lore_epochs(chat_id,epoch) VALUES (?,1) ON CONFLICT(chat_id) DO UPDATE SET epoch=epoch+1').run(row.id);
        destination.prepare('DELETE FROM lore_states WHERE chat_id = ?').run(row.id);
      }
    }
  }
  // Numeric revisions can move backwards on import. Reuse the ordinary edit policy,
  // retaining only entries with exactly matching semantic/activation fingerprints.
  for (const incomingBook of incomingLibrary.filter(row => row.kind === 'lorebooks')) {
    const previous = libraries.get(str(incomingBook,'id'));
    if (!previous) continue;
    const retained = unchangedLoreEntries(lorebookSchema.parse(json(previous)),lorebookSchema.parse(json(incomingBook)));
    const states = destination.prepare('SELECT chat_id,data FROM lore_states WHERE book_id = ?').all(incomingBook.id);
    for (const raw of states) {
      const state = z.object({ chat_id: z.string(), data: z.string() }).parse(raw);
      const entries = z.record(z.string(),z.object({ fingerprint: z.string(), matches: z.number().int().nonnegative() })).parse(JSON.parse(state.data));
      destination.prepare('UPDATE lore_states SET data = ? WHERE chat_id = ? AND book_id = ?').run(JSON.stringify(Object.fromEntries(Object.entries(entries).filter(([entryId]) => retained.has(entryId)))),state.chat_id,incomingBook.id);
    }
  }
  for (const chat of incomingChats) destination.prepare('DELETE FROM chats WHERE id = ?').run(chat);
  for (const row of incomingLibrary) {
    destination.prepare('DELETE FROM character_tags WHERE character_id = ?').run(row.id);
    destination.prepare('DELETE FROM character_pictures WHERE character_id = ?').run(row.id);
  }
  for (const row of incomingConnections) destination.prepare('DELETE FROM credentials WHERE id = ?').run(row.id);
  const assetMap = new Map<string,string>();
  for (const row of rows(incoming,'picture_assets')) {
    const old = destination.prepare('SELECT * FROM picture_assets WHERE id = ?').get(row.id);
    let identity = str(row,'id');
    if (old && !isDeepStrictEqual(old,row)) identity = createHash('sha256').update('ore-asset').update(str(row,'id')).update(str(row,'digest')).digest('hex');
    assetMap.set(str(row,'id'),identity);
    const existing = destination.prepare('SELECT * FROM picture_assets WHERE id = ?').get(identity);
    const mapped = { ...row, id: identity };
    if (existing && !isDeepStrictEqual(existing,mapped)) throw new AppError(422,'backup_asset_conflict',message("errors.an_immutable_picture_asset_could_not_be_mapped"));
    if (!existing) insertRow(destination,'picture_assets',mapped);
  }
  // Deferrable checks allow independent saved records to refer forward to one another.
  for (const table of backupTables) {
    if (table === 'picture_assets') continue;
    for (const row of rows(incoming,table)) {
      const mapped = table === 'character_pictures' ? { ...row, asset_id: assetMap.get(str(row,'asset_id')) ?? null } : row;
      insertRow(destination,table,mapped,table === 'connections' || table === 'library' || table === 'tags');
    }
  }
  destination.exec('DELETE FROM picture_assets WHERE NOT EXISTS (SELECT 1 FROM character_pictures WHERE asset_id = picture_assets.id)');
  destination.exec('UPDATE library_state SET revision = revision + 1 WHERE id = 1');
  return retainedEffects;
}

export class BackupStore {
  constructor(private store: Store) {}
  get epoch() { return datasetEpoch(this.store.sqlite); }
  get token() { return stateToken(this.store.sqlite); }
  replay(requestId: string, digest: string): DataOutcome | null {
    const row = this.store.sqlite.prepare('SELECT digest,outcome FROM data_commands WHERE id = ?').get(requestId);
    if (!row) return null;
    const saved = z.object({ digest: z.string(), outcome: z.string() }).parse(row);
    if (saved.digest !== digest) throw new AppError(409,'data_command_conflict',message("errors.this_command_identity_was_already_used_for_different"));
    return z.object({ ok: z.literal(true), epoch: z.string(), kind: z.enum(['import','wipe']) }).parse(JSON.parse(saved.outcome));
  }
  preflight(incoming: Database.Database) {
    const current = this.store.sqlite;
    const units = importUnits(current,incoming), token = this.token;
    const snapshot = current.serialize();
    if (snapshot.length > backupLimits.bytes) throw new AppError(413,'backup_too_large',message("errors.the_current_database_exceeds_the_supported_128_mib"));
    // SQLite deserialization into memory requires rollback-journal header bytes.
    // serialize() already contains committed WAL pages; this edits only the private copy.
    snapshot[18] = 1; snapshot[19] = 1;
    const clone = new Database(snapshot);
    clone.pragma('foreign_keys = ON');
    try {
      const effects = clone.transaction(() => { clone.pragma('defer_foreign_keys = ON'); const effects = mergeContent(clone,incoming); validateContent(clone); return effects; })();
      return { token, units, effects, blockers: [] as string[] };
    } catch (error) {
      return { token, units, effects: [], blockers: [error instanceof AppError ? error.message : 'The combined backup violates a saved reference, identity or unique constraint. No data was changed.'] };
    } finally { clone.close(); }
  }
  commit(input: { requestId: string; digest: string; token: string; overwrite: boolean }, incoming?: Database.Database, sessionHash?: string): DataOutcome {
    const kind = incoming ? 'import' : 'wipe';
    const commandDigest = `${kind}:${input.digest}:${input.token}:${input.overwrite}`;
    const replay = this.replay(input.requestId,commandDigest); if (replay) return replay;
    if (!incoming && !input.overwrite) throw new AppError(409,'wipe_confirmation',message("errors.confirm_the_wipe_before_continuing"));
    if (incoming) {
      const plan = this.preflight(incoming);
      if (plan.blockers.length) throw new AppError(422,'backup_blocked',plan.blockers.join(' '));
    }
    return this.store.sqlite.transaction(() => {
      this.store.ensureIdle();
      if (input.token !== this.token) throw new AppError(409,'stale_backup_review',message("errors.saved_data_changed_since_review_refresh_the_preview"));
      this.store.sqlite.pragma('defer_foreign_keys = ON');
      if (incoming) {
        if (!input.overwrite && importUnits(this.store.sqlite,incoming).some(unit => unit.overlap)) throw new AppError(409,'overwrite_required',message("errors.explicit_overwrite_approval_is_required_for_overlapping_identities"));
        mergeContent(this.store.sqlite,incoming);
      } else {
        this.store.sqlite.exec('DELETE FROM chats; DELETE FROM credentials; DELETE FROM character_tags; DELETE FROM character_pictures; DELETE FROM picture_assets; DELETE FROM tags; DELETE FROM library; DELETE FROM connections; DELETE FROM lore_commands;');
        const createdAt = new Date().toISOString();
        insertRow(this.store.sqlite,'library',{ created_at: createdAt, id: 'default', kind: 'prompts', revision: 0, data: JSON.stringify(defaultPrompt) });
        insertRow(this.store.sqlite,'library',{ created_at: createdAt, id: 'default-context', kind: 'contexts', revision: 0, data: JSON.stringify(defaultContextPreset) });
        this.store.sqlite.prepare('DELETE FROM sessions WHERE hash != ?').run(sessionHash ?? '');
        this.store.sqlite.exec('UPDATE library_state SET revision = revision + 1 WHERE id = 1');
      }
      const outcome: DataOutcome = { ok: true, epoch: randomUUID(), kind };
      this.store.sqlite.prepare('UPDATE dataset_state SET epoch = ? WHERE id = 1').run(outcome.epoch);
      this.store.sqlite.prepare('INSERT INTO data_commands(id,digest,outcome) VALUES (?,?,?)').run(input.requestId,commandDigest,JSON.stringify(outcome));
      return outcome;
    }).immediate();
  }
}
