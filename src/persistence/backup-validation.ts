import Database from 'better-sqlite3';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { BackupValidationError } from '../core/errors.js';
import { chatSettingsSchema, connectionSchema, pinnedSourceSchema, promptEntryKinds, type RequestPreview } from '../shared/contracts.js';
import { libraryCharacterSchema, libraryPersonaSchema, promptSchema } from '../shared/library.js';
import { summaryRefusalCheckSchema, summaryRetrySchema, contextPresetSchema, type SummaryNode, type ContextJob, type ContextStep } from '../shared/context.js';
import { lorebookSchema, loreDiagnosticSchema, lorePlacements, loreRoleSchema } from '../shared/lorebook.js';
import { canonicalTagName, tagNameSchema } from '../shared/tags.js';
import { cropPixels, cropSchema, pictureLimits } from '../shared/pictures.js';
import { backupLimits, backupTables, type BackupTable } from '../shared/backups.js';
import { localizedMessageSchema } from '../shared/localization.js';

export type BackupRow = Record<string, string | number | null | Buffer>;
export const rowSchema = z.record(z.string(), z.union([z.string(), z.number().finite(), z.null(), z.instanceof(Buffer)]));
export const invalidBackup = (reason: string) => new BackupValidationError(reason);
// Keyset reads release the statement before yielding, so callers can update the
// current row inside the same transaction without keeping a SQLite cursor open.
export function* rows(db: Database.Database, table: BackupTable, projection = '*'): Generator<BackupRow> {
  const first = db.prepare(`SELECT CAST(rowid AS TEXT) AS backup_cursor, ${projection} FROM "${table}" ORDER BY rowid LIMIT 1`);
  const next = db.prepare(`SELECT CAST(rowid AS TEXT) AS backup_cursor, ${projection} FROM "${table}" WHERE rowid > CAST(? AS INTEGER) ORDER BY rowid LIMIT 1`);
  let raw = first.get();
  while (raw !== undefined) {
    const { backup_cursor, ...row } = rowSchema.parse(raw);
    yield row;
    raw = next.get(backup_cursor);
  }
}
// Filter oversized fields in SQLite before better-sqlite3 copies a hostile
// row into JavaScript. UTF-16 databases receive a conservative byte allowance
// here, followed by the exact UTF-8 text check during reconstruction.
export function checkUploadedFieldSizes(db: Database.Database, table: BackupTable) {
  const columns = z.array(z.object({ name: z.string() })).parse(db.prepare(`PRAGMA table_info("${table}")`).all());
  const textBytes = db.pragma('encoding', { simple: true }) === 'UTF-8' ? backupLimits.textBytes : backupLimits.textBytes * 2;
  const bounds: number[] = [];
  const tests = columns.map(({ name }) => {
    const column = `"${name.replaceAll('"', '""')}"`;
    const blobBytes = name === 'original' ? pictureLimits.bytes : name === 'preview' ? pictureLimits.previewBytes : name === 'thumbnail' ? pictureLimits.thumbBytes : backupLimits.textBytes;
    bounds.push(blobBytes, textBytes);
    return `CASE typeof(${column})
      WHEN 'blob' THEN length(${column}) > ?
      WHEN 'text' THEN length(CAST(${column} AS BLOB)) > ?
      ELSE 0 END`;
  });
  if (db.prepare(`SELECT 1 FROM "${table}" WHERE ${tests.join(' OR ')} LIMIT 1`).get(...bounds)) {
    throw invalidBackup(`Table ${table}: a field exceeds its size limit.`);
  }
}
export function str(row: BackupRow, key: string): string {
  if (typeof row[key] !== 'string') throw invalidBackup(`Column ${key} must contain text.`);
  return z.string().parse(row[key]);
}
export function num(row: BackupRow, key: string): number { return z.number().int().nonnegative().safe().parse(row[key]); }
export function json(row: BackupRow, key = 'data'): unknown {
  let value: unknown;
  try { value = JSON.parse(str(row,key)); }
  catch (error) {
    if (error instanceof BackupValidationError) throw error;
    throw invalidBackup(`Column ${key} contains malformed JSON.`);
  }
  const pending = [{ value,depth: 0 }];
  while (pending.length) {
    const next = pending.pop(); if (!next) break;
    if (next.depth > 100) throw invalidBackup('JSON nesting exceeds 100 levels.');
    if (next.value && typeof next.value === 'object') for (const child of Object.values(next.value)) pending.push({ value: child,depth: next.depth+1 });
  }
  return value;
}
// Dictionary keys and issue messages can contain uploaded values; expose only known field names.
const diagnosticFields = new Set(['id','revision','name','title','text','level','turns','children','prior','corrections','basedOn',
  'approved','manual','createdAt','connectionId','promptId','characterId','personaId','contextPresetId','lorebookId',
  'endpoint','model','contextWindow','maxOutputTokens','customParameters','api_key','blocks','role','content',
  'messages','body','request','usage','inputTokens','outputTokens','totalTokens','status','jobId','chatId','result',
  'selected','archivedTurnIds','complete','turnId','settings','data','scanDepth','tokenBudget','entries','key',
  'description','personality','scenario','greeting','width','height','x','y']);
export function parseRecord<T>(schema: z.ZodType<T>, row: BackupRow, table: BackupTable, field = 'data'): T {
  try { return schema.parse(json(row,field)); }
  catch (error) {
    if (!(error instanceof z.ZodError)) throw error;
    const issues = error.issues.slice(0,5).map(issue => {
      const path = issue.path.map(part => typeof part === 'number' ? part : typeof part === 'string' && diagnosticFields.has(part) ? part : '[key]').join('.');
      return `${path || '(root)'}: ${issue.code}`;
    });
    throw invalidBackup(`Table ${table}, column ${field}: ${issues.join('; ')}.`);
  }
}
const id = z.string().min(1).max(100);
const integer = z.number().int().nonnegative().safe();
const ref = z.object({ id, revision: integer });
const refs = z.array(ref).max(backupLimits.rows);
export const selection = z.object({ selected: refs, archivedTurnIds: z.array(id).max(backupLimits.rows) });
const source = z.object({ turnId: id, userRevision: integer, assistantRevision: integer, complete: z.boolean() });
const node = z.object({ refusalCheck: summaryRefusalCheckSchema.optional(), regeneration: z.literal('refusal').optional(), id, revision: integer, level: integer.positive(), text: z.string().max(1_000_000), turns: z.array(source), children: refs, prior: refs, corrections: refs.optional(), basedOn: ref.optional(), approved: z.boolean(), manual: z.boolean(), createdAt: z.string() }) satisfies z.ZodType<SummaryNode>;
const entryState = z.object({ fingerprint: z.string(), matches: integer });
const diagnostic = loreDiagnosticSchema;
const loreResolution = z.object({
  version: z.literal('ore-lore-v1'), detailsAvailable: z.boolean().optional(),
  book: ref.extend({ name: z.string() }), epoch: integer,
  settings: z.object({ scanDepth: integer, tokenBudget: integer, recursiveScanning: z.boolean() }),
  scan: z.array(z.object({ turnId: id, partId: id, revision: integer, role: z.enum(['user','assistant']) })), assistantCount: integer,
  outcomes: z.array(z.object({ id, name: z.string(), status: z.enum(['admitted','excluded']), reason: z.string(), text: z.string(), tokens: integer, fingerprint: z.string(),
    destination: z.object({ controlId: z.string().optional(), placement: z.enum(lorePlacements), role: loreRoleSchema, depth: integer, anchorId: z.string().optional() }).nullable() })),
  diagnostics: z.array(diagnostic), tokens: integer, pressure: z.boolean(), stateBefore: z.record(z.string(),entryState), stateDelta: z.record(z.string(),entryState),
});
const usageSchema = z.object({ inputTokens: integer, outputTokens: integer, totalTokens: integer });
export const requestSchema = z.object({
  layout: z.array(z.object({ messageIndex: integer, kind: z.enum(promptEntryKinds), pinnedSources: z.array(pinnedSourceSchema).max(backupLimits.rows).optional(), label: z.string(), labelMessage: localizedMessageSchema.optional(), tokens: integer, group: z.object({ id: z.string(), label: z.string() }).optional() })).optional(),
  warnings: z.array(z.string()).optional(), warningMessages: z.array(localizedMessageSchema).optional(), context: selection.optional(), history: z.object({ mode: z.enum(['managed','recent']), verbatimTurnIds: z.array(id) }).optional(),
  lore: loreResolution.nullable().optional(), summarySources: z.array(z.object({ turnId: id, user: z.string(), assistant: z.string() })).optional(),
  // Historical provider parameters are inspection data. A branch copy preserves them verbatim.
  endpoint: z.string(), body: z.looseObject({ model: z.string(), messages: z.array(z.object({ role: z.enum(['system','user','assistant']), content: z.string() })), stream: z.literal(true), max_tokens: integer.positive() }),
  coverage: z.array(source), budget: z.object({ inputTokens: integer, targetInputTokens: integer.positive(), reservedOutputTokens: integer.positive(), contextWindow: integer.positive(), method: z.string(), verified: z.literal(false), counting: z.object({ kind: z.enum(['reference','model','fallback']), tokenizer: z.string().nullable(), implementation: z.string().optional(), tokenizerRevision: z.string().optional(), framing: z.enum(['estimated-recipe','fallback']), fallbackReason: z.string().nullable(), limitations: z.string() }).optional() }),
}) satisfies z.ZodType<RequestPreview>;
const operation = z.object({ level: integer.positive(), turnIds: z.array(id), children: refs, repair: ref.optional(), reconcile: refs.optional() });
const refreshSchema = z.object({ before: selection, after: selection, inputBefore: integer, inputAfter: integer, verbatimBefore: integer, verbatimAfter: integer, changed: z.boolean(), protectedSummaries: integer, limited: z.boolean(), limitation: z.string().optional(), limitationMessage: localizedMessageSchema.optional() });
export const jobSchema = z.object({ automatic: z.literal(true).optional(), errorMessage: localizedMessageSchema.optional(), retry: summaryRetrySchema.optional(), refresh: refreshSchema.optional(), finalRefresh: refreshSchema.optional(), repairCommands: z.record(z.string(),z.string()).optional(), outcome: z.object({ inputTokens: integer, verbatimTurns: integer }).optional(), working: z.object({ inputTokens: integer, targetInputTokens: integer.positive(), operation: operation.pick({ level: true }).nullable() }).optional(), reusedCount: integer.optional(), generatedCount: integer.optional(), reviewedCount: integer.optional(), unchangedCount: integer.optional(), revalidatedCount: integer.optional(), id, chatId: id, status: z.enum(['running','awaiting_review','succeeded','failed','cancelled','interrupted']), mode: z.enum(['prepare','step','repair','refresh']), generationId: id.nullable(), sourceRevision: integer, config: contextPresetSchema.extend({ id, revision: integer }), stepCount: integer, error: z.string().nullable(), historyTurnIds: z.array(id), createdAt: z.string(), updatedAt: z.string() }) satisfies z.ZodType<ContextJob>;
export const stepSchema = z.object({ rejectedText: z.string().max(4_000_000).optional(), errorMessage: localizedMessageSchema.optional(), resultDeleted: z.literal(true).optional(), reused: z.boolean().optional(), repairOutcome: z.enum(['model_unchanged','inputs_unchanged']).optional(), id, jobId: id, status: z.enum(['running','saved','candidate','discarded','failed','interrupted']), operation, request: requestSchema.nullable(), result: ref.nullable(), before: selection, after: selection.nullable(), inputBefore: integer, inputAfter: integer.nullable(), error: z.string().nullable(), createdAt: z.string() }) satisfies z.ZodType<ContextStep>;

function validateRendition(bytes: Buffer, edge: number) {
  const signature = Buffer.from([137,80,78,71,13,10,26,10]);
  if (bytes.length < 33 || !bytes.subarray(0,8).equals(signature) || bytes.subarray(12,16).toString('ascii') !== 'IHDR') throw invalidBackup('Picture rendition has an invalid PNG header.');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (width < 1 || height < 1 || width > edge || height > edge) throw invalidBackup('Picture rendition dimensions exceed the allowed bounds.');
}

export function validateContent(db: Database.Database) {
  let count = 0;
  for (const table of backupTables) {
    const columns = z.array(z.object({ name: z.string(), type: z.enum(['TEXT','INTEGER','BLOB']), notnull: z.number(), pk: z.number() })).parse(db.prepare(`PRAGMA table_info("${table}")`).all());
    for (const row of rows(db, table)) {
      for (const column of columns) {
        const value = row[column.name];
        if (value === null && !column.notnull && !column.pk) continue;
        const valid = column.type === 'TEXT' ? typeof value === 'string'
          : column.type === 'INTEGER' ? typeof value === 'number' && Number.isSafeInteger(value)
          : Buffer.isBuffer(value);
        if (!valid) throw invalidBackup(`Table ${table}, column ${column.name}: expected ${column.type}.`);
      }
      if (++count > backupLimits.rows) throw invalidBackup('Portable content exceeds the 100,000-row limit.');
      for (const value of Object.values(row)) if (typeof value === 'string' && Buffer.byteLength(value) > backupLimits.textBytes) throw invalidBackup('A text field exceeds the 16 MiB limit.');
      for (const field of ['created_at', 'updated_at', 'message_at']) {
        if (['library', 'connections', 'chats', 'turns'].includes(table) && row[field] !== undefined && row[field] !== null) z.iso.datetime({ precision: 3 }).parse(row[field]);
      }
      for (const field of ['data','settings','request','usage','resolution','context_selection','crop']) if (typeof row[field] === 'string') json(row,field);
    }
  }
  if (z.array(z.unknown()).parse(db.prepare('SELECT 1 FROM pragma_foreign_key_check LIMIT 1').all()).length || db.pragma('quick_check', { simple: true }) !== 'ok') throw invalidBackup('SQLite integrity or foreign-key check failed.');
  const libraryKind = db.prepare('SELECT kind FROM library WHERE id = ?').pluck();
  const connection = db.prepare('SELECT 1 FROM connections WHERE id = ?');
  const requireLibrary = (value: string | null | undefined, kind: string) => { if (value && libraryKind.get(value) !== kind) throw invalidBackup('A library reference is missing or has the wrong kind.'); };
  const requireConnection = (value: string | null | undefined) => { if (value && !connection.get(value)) throw invalidBackup('A Connection reference is missing.'); };
  for (const row of rows(db, 'connections')) {
    id.parse(row.id); num(row, 'revision'); parseRecord(connectionSchema,row,'connections','settings');
  }
  for (const row of rows(db, 'library')) {
    id.parse(row.id); num(row, 'revision');
    switch (row.kind) {
      case 'characters': requireLibrary(parseRecord(libraryCharacterSchema,row,'library').lorebookId, 'lorebooks'); break;
      case 'personas': parseRecord(libraryPersonaSchema,row,'library'); break;
      case 'prompts': parseRecord(promptSchema,row,'library'); break;
      case 'contexts': requireConnection(parseRecord(contextPresetSchema,row,'library').connectionId); break;
      case 'lorebooks': parseRecord(lorebookSchema,row,'library'); break;
      default: throw invalidBackup('A library record has an unsupported kind.');
    }
    if (connection.get(row.id)) throw invalidBackup('An identity is shared by a library record and a Connection.');
  }
  for (const row of rows(db, 'credentials')) { requireConnection(str(row, 'id')); z.string().max(10_000).regex(/^[^\r\n]*$/).parse(row.api_key); }
  for (const row of rows(db, 'tags')) { id.parse(row.id); num(row, 'revision'); if (canonicalTagName(tagNameSchema.parse(row.name)) !== row.canonical_key) throw invalidBackup('A tag canonical key does not match its normalized name.'); }
  for (const row of rows(db, 'character_tags')) requireLibrary(str(row, 'character_id'), 'characters');
  const turnChat = db.prepare('SELECT chat_id FROM turns WHERE id = ?').pluck();
  const chosenVariant = db.prepare('SELECT 1 FROM response_variants WHERE id = ? AND turn_id = ? AND text = ?');
  const successfulGeneration = db.prepare("SELECT 1 FROM generations WHERE id = ? AND turn_id = ? AND status = 'succeeded'");
  const generationChat = db.prepare('SELECT chat_id FROM generations WHERE id = ?').pluck();
  for (const row of rows(db, 'turns', 'id, user_id, assistant_id, user_revision, assistant_revision, position, complete, pinned, selected_variant_id, assistant_text')) {
    id.parse(row.id); id.parse(row.user_id); id.parse(row.assistant_id);
    num(row, 'user_revision'); num(row, 'assistant_revision'); num(row, 'position');
    if (row.complete === 1 && !chosenVariant.get(row.selected_variant_id, row.id, row.assistant_text)) throw invalidBackup('A completed turn has a missing or inconsistent selected response variant.');
    if (row.pinned !== 0 && (row.pinned !== 1 || row.complete !== 1)) throw invalidBackup('Only completed turns can be pinned.');
    if (row.complete === 0 && row.selected_variant_id !== null) throw invalidBackup('A pending turn has a selected response variant.');
  }
  for (const row of rows(db, 'response_variants', 'id, source_revision, generation_id, turn_id')) {
    id.parse(row.id); num(row, 'source_revision');
    if (row.generation_id && !successfulGeneration.get(row.generation_id, row.turn_id)) throw invalidBackup('A response variant references a missing, unsuccessful or unrelated generation.');
  }
  for (const row of rows(db, 'generations', 'id, source_revision, turn_id, chat_id, request, usage, error_message, context_selection')) {
    id.parse(row.id); num(row, 'source_revision');
    if (turnChat.get(row.turn_id) !== row.chat_id) throw invalidBackup('A generation references a turn in another chat or a missing turn.');
    if (row.request !== null) parseRecord(requestSchema,row,'generations','request');
    if (row.usage !== null) parseRecord(usageSchema,row,'generations','usage');
    if (row.error_message !== null) parseRecord(localizedMessageSchema,row,'generations','error_message');
    if (row.context_selection !== null) selection.extend({ revision: integer }).parse(json(row, 'context_selection'));
  }
  const summary = db.prepare('SELECT chat_id, data FROM summaries WHERE id = ? AND revision = ?');
  const summaryChat = db.prepare('SELECT chat_id FROM summaries WHERE id = ? AND revision = ?').pluck();
  const readSummary = (reference: z.infer<typeof ref>) => {
    const raw = summary.get(reference.id, reference.revision);
    if (!raw) return undefined;
    const row = rowSchema.parse(raw);
    return { chat: str(row, 'chat_id'), value: parseRecord(node, row, 'summaries') };
  };
  // Keep graph edges on disk. DFS retains only record identities and edge
  // positions, even when many summaries contain large source lists.
  db.exec(`CREATE TEMP TABLE backup_summary_edges (
    id TEXT, revision INTEGER, position INTEGER, target TEXT, target_revision INTEGER,
    PRIMARY KEY(id, revision, position)
  ) WITHOUT ROWID`);
  try {
    const insertEdge = db.prepare('INSERT INTO backup_summary_edges VALUES (?, ?, ?, ?, ?)');
    for (const row of rows(db, 'summaries')) {
      const value = parseRecord(node, row, 'summaries');
      if (row.fork_source_request !== null) {
        const request = parseRecord(requestSchema, row, 'summaries', 'fork_source_request');
        for (const source of [...request.coverage, ...request.summarySources ?? []]) {
          const owner = turnChat.get(source.turnId);
          if (owner !== undefined && owner !== row.chat_id) throw invalidBackup('An inherited memory source belongs to another branch.');
        }
      }
      if (value.id !== row.id || value.revision !== row.revision) throw invalidBackup('A summary identity or revision differs from its stored data.');
      const coveredIds = value.turns.map(source => source.turnId);
      if (new Set(coveredIds).size !== coveredIds.length) throw invalidBackup('A summary covers the same turn more than once.');
      let edgePosition = 0;
      for (const dependencies of [value.children, value.prior, value.corrections ?? [], value.basedOn ? [value.basedOn] : []]) {
        for (const dependency of dependencies) {
          if (summaryChat.get(dependency.id, dependency.revision) !== row.chat_id) throw invalidBackup('A summary dependency is missing or belongs to another chat.');
          insertEdge.run(value.id, value.revision, edgePosition++, dependency.id, dependency.revision);
        }
      }
      let offset = 0;
      for (const child of value.children) {
        const dependency = readSummary(child);
        if (!dependency || dependency.value.level >= value.level || (value.approved && !dependency.value.approved)) throw invalidBackup('A child summary has an invalid level or approval state.');
        for (const source of dependency.value.turns) {
          if (coveredIds[offset++] !== source.turnId) throw invalidBackup('A summary coverage does not match its children.');
        }
      }
      if (value.children.length && offset !== coveredIds.length) throw invalidBackup('A summary coverage does not match its children.');
      for (const covered of value.turns) {
        const chat = turnChat.get(covered.turnId);
        // Deleted historical sources are valid stale memory, but never cross-chat sources.
        if (chat !== undefined && chat !== row.chat_id) throw invalidBackup('A summary source belongs to another chat.');
      }
    }
    const edge = db.prepare('SELECT target AS id, target_revision AS revision FROM backup_summary_edges WHERE id = ? AND revision = ? AND position = ?');
    const visited = new Map<string, 'visiting' | 'checked'>();
    for (const row of rows(db, 'summaries', 'id, revision')) {
      const root = ref.parse(row);
      const key = `${root.id}:${root.revision}`;
      if (visited.has(key)) continue;
      visited.set(key, 'visiting');
      const stack = [{ ...root, key, position: 0 }];
      while (stack.length) {
        const frame = stack.at(-1);
        if (!frame) break;
        const raw = edge.get(frame.id, frame.revision, frame.position++);
        if (!raw) {
          visited.set(frame.key, 'checked');
          stack.pop();
          continue;
        }
        const target = ref.parse(raw);
        const targetKey = `${target.id}:${target.revision}`;
        const state = visited.get(targetKey);
        if (state === 'visiting') throw invalidBackup('Summary dependencies contain a cycle.');
        if (state === 'checked') continue;
        visited.set(targetKey, 'visiting');
        stack.push({ ...target, key: targetKey, position: 0 });
      }
    }
  } finally {
    db.exec('DROP TABLE backup_summary_edges');
  }
  const chatPrefix = db.prepare('SELECT id FROM turns WHERE chat_id = ? ORDER BY position LIMIT ?').pluck();
  for (const row of rows(db, 'context_states')) {
    num(row, 'revision'); const state = parseRecord(selection,row,'context_states');
    const archived = state.archivedTurnIds.filter(turnId => turnChat.get(turnId) !== undefined);
    const prefix = chatPrefix.all(row.chat_id, archived.length);
    const invalidCoverage = () => invalidBackup('Selected memory coverage is overlapping or does not match the archived transcript prefix.');
    if (JSON.stringify(prefix) !== JSON.stringify(archived)) throw invalidCoverage();
    let offset = 0;
    for (const selected of state.selected) {
      const chosen = readSummary(selected);
      if (!chosen?.value.approved || chosen.chat !== row.chat_id) throw invalidBackup('Selected memory references a missing, unapproved or unrelated summary.');
      for (const source of chosen.value.turns) {
        if (turnChat.get(source.turnId) !== undefined && archived[offset++] !== source.turnId) throw invalidCoverage();
      }
    }
    if (offset !== archived.length) throw invalidCoverage();
  }
  const jobChat = db.prepare('SELECT chat_id FROM context_jobs WHERE id = ?').pluck();
  for (const row of rows(db, 'context_jobs')) {
    const job = parseRecord(jobSchema,row,'context_jobs','data');
    if (job.id !== row.id || job.chatId !== row.chat_id) {
      throw invalidBackup('A preparation job has inconsistent identity, chat or generation references.');
    }
    if (job.generationId !== null) {
      const owner = generationChat.get(job.generationId);
      // Whole-turn deletion cascades to generations. Finished preparation
      // retains the former generation ID as historical provenance.
      const active = job.status === 'running' || job.status === 'awaiting_review';
      if (owner === undefined ? active : owner !== job.chatId) {
        throw invalidBackup('A preparation job has inconsistent identity, chat or generation references.');
      }
    }
  }
  for (const row of rows(db, 'context_steps')) {
    const step = parseRecord(stepSchema,row,'context_steps','data');
    if (step.id !== row.id || step.jobId !== row.job_id || jobChat.get(step.jobId) === undefined) throw invalidBackup('A preparation step has inconsistent identity or job references.');
    if (step.result) {
      const result = summaryChat.get(step.result.id, step.result.revision);
      if (result !== undefined ? result !== jobChat.get(step.jobId) : !step.resultDeleted) throw invalidBackup('A preparation result is missing without a deletion marker or belongs to another chat.');
    }
  }
  const earlierPending = db.prepare('SELECT 1 FROM turns WHERE chat_id = ? AND complete != 1 AND position < (SELECT max(position) FROM turns WHERE chat_id = ?) LIMIT 1');
  for (const row of rows(db, 'chat_groups')) {
    id.parse(row.id);
    if (!db.prepare('SELECT 1 FROM chats WHERE group_id = ?').get(row.id)) throw invalidBackup('A chat has no branches.');
    const settings = parseRecord(chatSettingsSchema.omit({ authorNote: true }),row,'chat_groups','settings');
    requireConnection(settings.connectionId); requireLibrary(settings.promptId, 'prompts'); requireLibrary(settings.characterId, 'characters'); requireLibrary(settings.personaId, 'personas'); requireLibrary(settings.contextPresetId, 'contexts'); requireLibrary(settings.lorebookId, 'lorebooks');
  }
  for (const row of rows(db, 'chats')) {
    id.parse(row.id); num(row, 'revision'); id.parse(row.group_id);
    z.string().trim().min(1).max(100).nullable().parse(row.branch_name);
    parseRecord(chatSettingsSchema.pick({ authorNote: true }),row,'chats','settings');
    if (earlierPending.get(row.id, row.id)) throw invalidBackup('A pending turn occurs before the latest turn.');
  }
  for (const row of rows(db, 'lore_states')) {
    requireLibrary(str(row, 'book_id'), 'lorebooks'); num(row, 'epoch');
    z.record(z.string(), z.object({ fingerprint: z.string(), matches: integer })).parse(json(row));
  }
  for (const row of rows(db, 'lore_epochs')) num(row,'epoch');
  for (const row of rows(db, 'lore_operations')) parseRecord(loreResolution,row,'lore_operations','resolution');
  for (const row of rows(db, 'picture_assets')) {
    const original = z.instanceof(Buffer).parse(row.original);
    const preview = z.instanceof(Buffer).parse(row.preview);
    validateRendition(preview,pictureLimits.previewEdge);
    if (createHash('sha256').update(original).digest('hex') !== row.digest) throw invalidBackup('A picture digest does not match its original bytes.');
  }
  const assetDimensions = db.prepare('SELECT width, height FROM picture_assets WHERE id = ?');
  for (const row of rows(db, 'character_pictures')) {
    requireLibrary(str(row, 'character_id'), 'characters');
    const thumbnail = z.instanceof(Buffer).parse(row.thumbnail);
    validateRendition(thumbnail,pictureLimits.thumbEdge);
    z.string().uuid().parse(row.key); num(row,'revision');
    const asset = rowSchema.safeParse(assetDimensions.get(row.asset_id));
    if (!asset.success) throw invalidBackup('A character picture references a missing asset.');
    cropPixels({ width: num(asset.data,'width'), height: num(asset.data,'height') }, cropSchema.parse(json(row,'crop')));
  }
}
