import Database from 'better-sqlite3';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { AppError } from '../core/errors.js';
import { chatSettingsSchema, connectionSchema, type RequestPreview } from '../shared/contracts.js';
import { libraryCharacterSchema, libraryPersonaSchema, promptSchema } from '../shared/library.js';
import { contextPresetSchema, type SummaryNode, type ContextJob, type ContextStep } from '../shared/context.js';
import { lorebookSchema, lorePlacements, loreRoleSchema } from '../shared/lorebook.js';
import { canonicalTagName, tagNameSchema } from '../shared/tags.js';
import { cropPixels, cropSchema, pictureLimits } from '../shared/pictures.js';
import { backupLimits, backupTables, type BackupTable } from '../shared/backups.js';

export type BackupRow = Record<string, string | number | null | Buffer>;
export const rowSchema = z.record(z.string(), z.union([z.string(), z.number().finite(), z.null(), z.instanceof(Buffer)]));
export const invalidBackup = () => new AppError(422, 'invalid_backup', 'This is not a supported, structurally valid ORE backup. The original file and current data are unchanged.');
export function rows(db: Database.Database, table: BackupTable): BackupRow[] {
  const result = db.prepare(`SELECT * FROM "${table}" ORDER BY rowid LIMIT ?`).all(backupLimits.rows + 1).map(row => rowSchema.parse(row));
  if (result.length > backupLimits.rows) throw invalidBackup();
  return result;
}
export function str(row: BackupRow, key: string): string { return z.string().parse(row[key]); }
export function num(row: BackupRow, key: string): number { return z.number().int().nonnegative().safe().parse(row[key]); }
export function json(row: BackupRow, key = 'data'): unknown {
  const value: unknown = JSON.parse(str(row,key));
  const pending = [{ value,depth: 0 }];
  while (pending.length) {
    const next = pending.pop(); if (!next) break;
    if (next.depth > 100) throw invalidBackup();
    if (next.value && typeof next.value === 'object') for (const child of Object.values(next.value)) pending.push({ value: child,depth: next.depth+1 });
  }
  return value;
}
const id = z.string().min(1).max(100);
const integer = z.number().int().nonnegative().safe();
const ref = z.object({ id, revision: integer });
const refs = z.array(ref).max(backupLimits.rows);
const selection = z.object({ selected: refs, archivedTurnIds: z.array(id).max(backupLimits.rows) });
const source = z.object({ turnId: id, userRevision: integer, assistantRevision: integer, complete: z.boolean() });
const node = z.object({ id, revision: integer, level: integer.positive(), text: z.string().max(1_000_000), turns: z.array(source), children: refs, prior: refs, corrections: refs.optional(), basedOn: ref.optional(), approved: z.boolean(), manual: z.boolean(), createdAt: z.string() }) satisfies z.ZodType<SummaryNode>;
const entryState = z.object({ fingerprint: z.string(), matches: integer });
const diagnostic = z.object({ code: z.string(), message: z.string(), entryId: z.string().optional(), field: z.string().optional() });
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
const requestSchema = z.object({
  layout: z.array(z.object({ messageIndex: integer, kind: z.enum(['prompt','character','persona','memory','history','draft','lore']), label: z.string(), tokens: integer, group: z.object({ id: z.string(), label: z.string() }).optional() })).optional(),
  warnings: z.array(z.string()).optional(), context: selection.optional(), history: z.object({ mode: z.enum(['managed','recent']), verbatimTurnIds: z.array(id) }).optional(),
  lore: loreResolution.nullable().optional(), summarySources: z.array(z.object({ turnId: id, user: z.string(), assistant: z.string() })).optional(),
  endpoint: z.string(), body: z.object({ model: z.string(), messages: z.array(z.object({ role: z.enum(['system','user','assistant']), content: z.string() })), stream: z.literal(true), max_tokens: integer.positive() }),
  coverage: z.array(source), budget: z.object({ inputTokens: integer, targetInputTokens: integer.positive(), reservedOutputTokens: integer.positive(), contextWindow: integer.positive(), method: z.string(), verified: z.literal(false), counting: z.object({ kind: z.enum(['reference','model','fallback']), tokenizer: z.string().nullable(), implementation: z.string().optional(), tokenizerRevision: z.string().optional(), framing: z.enum(['estimated-recipe','fallback']), fallbackReason: z.string().nullable(), limitations: z.string() }).optional() }),
}) satisfies z.ZodType<RequestPreview>;
const operation = z.object({ level: integer.positive(), turnIds: z.array(id), children: refs, repair: ref.optional(), reconcile: refs.optional() });
const refreshSchema = z.object({ before: selection, after: selection, inputBefore: integer, inputAfter: integer, verbatimBefore: integer, verbatimAfter: integer, changed: z.boolean(), protectedSummaries: integer, limited: z.boolean(), limitation: z.string().optional() });
const jobSchema = z.object({ refresh: refreshSchema.optional(), finalRefresh: refreshSchema.optional(), repairCommands: z.record(z.string(),z.string()).optional(), outcome: z.object({ inputTokens: integer, verbatimTurns: integer }).optional(), reusedCount: integer.optional(), generatedCount: integer.optional(), reviewedCount: integer.optional(), unchangedCount: integer.optional(), revalidatedCount: integer.optional(), id, chatId: id, status: z.enum(['running','awaiting_review','succeeded','failed','cancelled','interrupted']), mode: z.enum(['prepare','step','repair','refresh']), generationId: id.nullable(), sourceRevision: integer, config: contextPresetSchema.extend({ id, revision: integer }), stepCount: integer, error: z.string().nullable(), historyTurnIds: z.array(id), createdAt: z.string(), updatedAt: z.string() }) satisfies z.ZodType<ContextJob>;
const stepSchema = z.object({ reused: z.boolean().optional(), repairOutcome: z.enum(['model_unchanged','inputs_unchanged']).optional(), id, jobId: id, status: z.enum(['running','saved','candidate','discarded','failed','interrupted']), operation, request: requestSchema.nullable(), result: ref.nullable(), before: selection, after: selection.nullable(), inputBefore: integer, inputAfter: integer.nullable(), error: z.string().nullable(), createdAt: z.string() }) satisfies z.ZodType<ContextStep>;

function validateRendition(bytes: Buffer, edge: number) {
  const signature = Buffer.from([137,80,78,71,13,10,26,10]);
  if (bytes.length < 33 || !bytes.subarray(0,8).equals(signature) || bytes.subarray(12,16).toString('ascii') !== 'IHDR') throw invalidBackup();
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (width < 1 || height < 1 || width > edge || height > edge) throw invalidBackup();
}

export function validateContent(db: Database.Database) {
  let count = 0;
  for (const table of backupTables) {
    const columns = z.array(z.object({ name: z.string(), type: z.enum(['TEXT','INTEGER','BLOB']), notnull: z.number(), pk: z.number() })).parse(db.prepare(`PRAGMA table_info("${table}")`).all());
    for (const row of rows(db, table)) {
      for (const column of columns) {
        const value = row[column.name];
        if (value === null && !column.notnull && !column.pk) continue;
        if (column.type === 'TEXT') z.string().parse(value);
        else if (column.type === 'INTEGER') z.number().int().safe().parse(value);
        else z.instanceof(Buffer).parse(value);
      }
      if (++count > backupLimits.rows) throw invalidBackup();
      for (const value of Object.values(row)) if (typeof value === 'string' && Buffer.byteLength(value) > backupLimits.textBytes) throw invalidBackup();
      for (const field of ['data','settings','request','usage','resolution','context_selection','crop']) if (typeof row[field] === 'string') json(row,field);
    }
  }
  if (z.array(z.unknown()).parse(db.pragma('foreign_key_check')).length || db.pragma('quick_check', { simple: true }) !== 'ok') throw invalidBackup();
  const libraries = new Map(rows(db, 'library').map(row => [str(row, 'id'), row]));
  const connections = new Set(rows(db, 'connections').map(row => { id.parse(row.id); num(row, 'revision'); connectionSchema.parse(json(row, 'settings')); return str(row, 'id'); }));
  const requireLibrary = (value: string | null | undefined, kind: string) => { if (value && libraries.get(value)?.kind !== kind) throw invalidBackup(); };
  const requireConnection = (value: string | null | undefined) => { if (value && !connections.has(value)) throw invalidBackup(); };
  for (const row of libraries.values()) {
    id.parse(row.id); num(row, 'revision');
    const value = json(row);
    switch (row.kind) {
      case 'characters': requireLibrary(libraryCharacterSchema.parse(value).lorebookId, 'lorebooks'); break;
      case 'personas': libraryPersonaSchema.parse(value); break;
      case 'prompts': promptSchema.parse(value); break;
      case 'contexts': requireConnection(contextPresetSchema.parse(value).connectionId); break;
      case 'lorebooks': lorebookSchema.parse(value); break;
      default: throw invalidBackup();
    }
    if (connections.has(str(row, 'id'))) throw invalidBackup();
  }
  for (const row of rows(db, 'credentials')) { requireConnection(str(row, 'id')); z.string().max(10_000).regex(/^[^\r\n]*$/).parse(row.api_key); }
  for (const row of rows(db, 'tags')) { id.parse(row.id); num(row, 'revision'); if (canonicalTagName(tagNameSchema.parse(row.name)) !== row.canonical_key) throw invalidBackup(); }
  for (const row of rows(db, 'character_tags')) requireLibrary(str(row, 'character_id'), 'characters');
  const turns = new Map(rows(db, 'turns').map(row => [str(row, 'id'), row]));
  const turnsByChat = new Map<string, BackupRow[]>();
  for (const turn of turns.values()) { const chat = str(turn,'chat_id'); const own = turnsByChat.get(chat) ?? []; own.push(turn); turnsByChat.set(chat,own); }
  for (const own of turnsByChat.values()) own.sort((a,b) => num(a,'position')-num(b,'position'));
  const variants = new Map(rows(db, 'response_variants').map(row => [str(row, 'id'), row]));
  const generations = new Map(rows(db, 'generations').map(row => [str(row, 'id'), row]));
  for (const row of turns.values()) {
    id.parse(row.id); id.parse(row.user_id); id.parse(row.assistant_id);
    num(row, 'user_revision'); num(row, 'assistant_revision'); num(row, 'position');
    const chosen = typeof row.selected_variant_id === 'string' ? variants.get(row.selected_variant_id) : undefined;
    if (row.complete === 1 && (!chosen || chosen.turn_id !== row.id || chosen.text !== row.assistant_text)) throw invalidBackup();
    if (row.complete === 0 && row.selected_variant_id !== null) throw invalidBackup();
  }
  for (const row of variants.values()) {
    id.parse(row.id); num(row, 'source_revision');
    if (row.generation_id && (generations.get(String(row.generation_id))?.turn_id !== row.turn_id || generations.get(String(row.generation_id))?.status !== 'succeeded')) throw invalidBackup();
  }
  for (const row of generations.values()) {
    id.parse(row.id); num(row, 'source_revision');
    if (turns.get(str(row, 'turn_id'))?.chat_id !== row.chat_id) throw invalidBackup();
    if (row.request !== null) requestSchema.parse(json(row, 'request'));
    if (row.usage !== null) usageSchema.parse(json(row,'usage'));
    if (row.context_selection !== null) selection.extend({ revision: integer }).parse(json(row, 'context_selection'));
  }
  const nodes = new Map<string, { chat: string; value: z.infer<typeof node> }>();
  for (const row of rows(db, 'summaries')) {
    const value = node.parse(json(row));
    if (value.id !== row.id || value.revision !== row.revision) throw invalidBackup();
    const key = `${value.id}:${value.revision}`;
    if (nodes.has(key)) throw invalidBackup();
    nodes.set(key, { chat: str(row, 'chat_id'), value });
  }
  // Iterative traversal bounds dependency work and rejects cycles without recursive stack growth.
  const checked = new Set<string>();
  for (const key of nodes.keys()) {
    const stack: { key: string; exit: boolean }[] = [{ key, exit: false }], visiting = new Set<string>();
    while (stack.length) {
      const frame = stack.pop(); if (!frame) break;
      if (frame.exit) { visiting.delete(frame.key); checked.add(frame.key); continue; }
      if (checked.has(frame.key)) continue;
      if (visiting.has(frame.key)) throw invalidBackup();
      const current = nodes.get(frame.key); if (!current) throw invalidBackup();
      visiting.add(frame.key); stack.push({ key: frame.key, exit: true });
      for (const dependency of [...current.value.children, ...current.value.prior, ...(current.value.corrections ?? []), ...(current.value.basedOn ? [current.value.basedOn] : [])]) {
        const dep = `${dependency.id}:${dependency.revision}`;
        if (nodes.get(dep)?.chat !== current.chat) throw invalidBackup();
        stack.push({ key: dep, exit: false });
      }
      const coveredIds = current.value.turns.map(source => source.turnId);
      if (new Set(coveredIds).size !== coveredIds.length) throw invalidBackup();
      if (current.value.children.length) {
        const childCoverage = current.value.children.flatMap(child => {
          const dependency = nodes.get(`${child.id}:${child.revision}`);
          if (!dependency || dependency.value.level >= current.value.level || (current.value.approved && !dependency.value.approved)) throw invalidBackup();
          return dependency.value.turns.map(source => source.turnId);
        });
        if (JSON.stringify(childCoverage) !== JSON.stringify(coveredIds)) throw invalidBackup();
      }
      for (const covered of current.value.turns) {
        const turn = turns.get(covered.turnId);
        // Deleted historical sources are valid stale memory, but never cross-chat sources.
        if (turn && turn.chat_id !== current.chat) throw invalidBackup();
      }
    }
  }
  for (const row of rows(db, 'context_states')) {
    num(row, 'revision'); const state = selection.parse(json(row));
    const coverage: string[] = [];
    for (const selected of state.selected) {
      const chosen = nodes.get(`${selected.id}:${selected.revision}`);
      if (!chosen?.value.approved || chosen.chat !== row.chat_id) throw invalidBackup();
      coverage.push(...chosen.value.turns.map(source => source.turnId).filter(turnId => turns.has(turnId)));
    }
    const archived = state.archivedTurnIds.filter(turnId => turns.has(turnId));
    const prefix = (turnsByChat.get(str(row,'chat_id')) ?? []).slice(0, archived.length).map(turn => str(turn,'id'));
    if (new Set(coverage).size !== coverage.length || JSON.stringify(coverage) !== JSON.stringify(archived) || JSON.stringify(prefix) !== JSON.stringify(archived)) throw invalidBackup();
  }
  const jobs = new Map(rows(db, 'context_jobs').map(row => {
    const job = jobSchema.parse(json(row));
    if (job.id !== row.id || job.chatId !== row.chat_id || (job.generationId && generations.get(job.generationId)?.chat_id !== row.chat_id)) throw invalidBackup();
    return [job.id, job];
  }));
  for (const row of rows(db, 'context_steps')) {
    const step = stepSchema.parse(json(row));
    if (step.id !== row.id || step.jobId !== row.job_id || !jobs.has(step.jobId)) throw invalidBackup();
    if (step.result && nodes.get(`${step.result.id}:${step.result.revision}`)?.chat !== jobs.get(step.jobId)?.chatId) throw invalidBackup();
  }
  for (const row of rows(db, 'chats')) {
    id.parse(row.id); num(row, 'revision'); const settings = chatSettingsSchema.parse(json(row, 'settings'));
    requireConnection(settings.connectionId); requireLibrary(settings.promptId, 'prompts'); requireLibrary(settings.characterId, 'characters'); requireLibrary(settings.personaId, 'personas'); requireLibrary(settings.contextPresetId, 'contexts'); requireLibrary(settings.lorebookId, 'lorebooks');
    const own = turnsByChat.get(str(row,'id')) ?? [];
    if (own.slice(0,-1).some(turn => turn.complete !== 1)) throw invalidBackup();
  }
  for (const row of rows(db, 'lore_states')) {
    requireLibrary(str(row, 'book_id'), 'lorebooks'); num(row, 'epoch');
    z.record(z.string(), z.object({ fingerprint: z.string(), matches: integer })).parse(json(row));
  }
  for (const row of rows(db, 'lore_epochs')) num(row,'epoch');
  for (const row of rows(db, 'lore_operations')) loreResolution.parse(json(row,'resolution'));
  const assets = new Map(rows(db, 'picture_assets').map(row => {
    const original = z.instanceof(Buffer).parse(row.original);
    const preview = z.instanceof(Buffer).parse(row.preview);
    validateRendition(preview,pictureLimits.previewEdge);
    if (createHash('sha256').update(original).digest('hex') !== row.digest) throw invalidBackup();
    return [str(row,'id'), row];
  }));
  for (const row of rows(db, 'character_pictures')) {
    requireLibrary(str(row, 'character_id'), 'characters');
    const thumbnail = z.instanceof(Buffer).parse(row.thumbnail);
    validateRendition(thumbnail,pictureLimits.thumbEdge);
    z.string().uuid().parse(row.key); num(row,'revision');
    const asset = assets.get(str(row, 'asset_id')); if (!asset) throw invalidBackup();
    cropPixels({ width: num(asset,'width'), height: num(asset,'height') }, cropSchema.parse(json(row,'crop')));
  }
}
