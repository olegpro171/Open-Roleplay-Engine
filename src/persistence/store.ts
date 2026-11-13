import { message } from '../shared/localization.js';
import { PictureStore } from './picture-store.js';
import type { PictureImportIntent } from '../shared/pictures.js';
import type { PreparedPicture } from './picture-data.js';
import type { CharacterSaveCommand, ImportBranch, ImportChat } from '../shared/library.js';
import { defaultChatInputTarget, resolveChatDefaults, roleplayConnectionId, type ChatDefaultsStatus } from '../shared/chat-defaults.js';
import { libraryDeletionResultSchema, type LibraryDeletionChoice, type LibraryDeletionCommand, type LibraryDeletionReview } from '../shared/library-deletion.js';
import { hasLibraryDependencies, libraryItemLabels, resolveLibraryDependencies, selectionKeys } from './library-dependencies.js';
import { datasetEpoch } from './backup-store.js';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { and, asc, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { upgradeSingleBranches } from './branch-upgrade.js';
import { savePreUpgradeSnapshot } from './schema-backup.js';
import { databaseSchemaVersion } from '../shared/build-info.js';
import { AppError } from '../core/errors.js';
import { MessageError, outcomeMessage, type LocalizedMessage } from '../shared/localization.js';
import { replaceNameMacros } from '../core/prompt.js';
import type { ChatSettings, ChatSnapshot, EngineSnapshot, GenerationPage, Connection, Generation, GenerationStatus, RequestPreview, ResponseVariant, TokenUsage, Turn } from '../shared/contracts.js';
import { regenerationView } from '../core/regeneration.js';
import { assertRefusalSelection } from '../core/summary-refusals.js';
import { hasPromptMarker } from '../shared/library.js';
import { readCharacterAlternateGreetings, characterLabel, characterSchema, libraryCharacterSchema, libraryPersonaSchema, personaSchema, defaultPrompt, defaultInstructions, selectionsSchema, type Character, type LibraryCharacter, type LibraryPersona, type ChatSummary, type ImportedTurn, type LibraryKind, type LibrarySnapshot, type Persona, type PromptPreset, type Saved, type UnchangedLibrary, type PromptSources } from '../shared/library.js';
import { lorebookSchema, loreDiagnosticSchema, type Lorebook, type LoreImportPreview, type LoreResolution, type LoreState } from '../shared/lorebook.js';
import { importCharacterLorebook, importLorebook, loreCompatibility, markLoreEdits } from '../core/lorebook-formats.js';
import { assertCharacterSourceDepth, importCharacter } from '../core/cards.js';
import { characterCardLimits } from '../shared/character-card-limits.js';
import { semanticFingerprint, unchangedLoreEntries } from '../core/lorebook.js';
import * as schema from './schema.js';
import * as legacyLibrarySchema from './legacy-library-schema.js';
import { appendContinuation, trimBoundaryNewlines } from '../shared/text.js';
import { continuationTarget } from '../core/continuation.js';
import { transcriptPartLimit } from '../shared/library.js';
import { contextPresetSchema, defaultContextPreset, type ContextPreset } from '../shared/context.js';
import { upgradedContextPrompts } from './context-prompt-upgrade.js';
import { ContextStore } from './context-store.js';
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { legacyLorePrompt, legacyRoleplayPrompt } from './legacy-prompt.js';
import { TagStore } from './tag-store.js';
import { readEmbeddedTags } from '../core/tags.js';
import { characterImportResultSchema, tagPolicySchema, type TagPolicy, type CharacterImportReview } from '../shared/tags.js';
import { upgradePrompt } from '../core/prompt-upgrade.js';
import { cardInstructionFields, readCardInstruction, readCharacterDepthPrompt } from '../shared/card-instructions.js';
import { authorNoteSchema, defaultAuthorNote, type AuthorNoteStatus } from '../shared/author-note.js';
import { contextAtFork } from '../core/branch-context.js';
import { copyBranchContent } from './branch-copy.js';
import type { CopyBranch } from '../shared/branches.js';
import type { ContextState } from '../shared/context.js';
import { changedMemoryShape, resizedMemoryLayout, shortenedMemoryLayout } from '../core/memory-layout.js';
import { assertMemoryImpact, memoryCleanupImpact, type MemoryLayoutReview } from './memory-layout-review.js';

function parseImport<T>(parse: () => T): T {
  try { return parse(); }
  catch (error) {
    if (error instanceof z.ZodError || error instanceof AppError) throw error;
    throw new AppError(400, 'invalid_lorebook', error instanceof MessageError ? error.localized : error instanceof Error ? error.message : message("errors.the_imported_lorebook_could_not_be_read"));
  }
}

const initialSettings: ChatSettings = {
  title: 'A new story', instructions: defaultInstructions,
  character: '', persona: '', targetInputTokens: defaultChatInputTarget,
  connectionId: null, promptId: 'default', characterId: null, personaId: null,
  contextPresetId: null,
  lorebookId: null,
};

export const defaultMigrationsDirectory = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../../migrations/' : '../../../migrations/', import.meta.url));

function checkCharacterRecordSize(card: LibraryCharacter) {
  if (Buffer.byteLength(JSON.stringify(card)) > characterCardLimits.recordBytes) {
    throw new AppError(400, 'character_record_too_large', message('errors.character_record_too_large'));
  }
}

export class Store {
  readonly sqlite: Database.Database;
  readonly db;
  readonly contexts: ContextStore;
  readonly tags: TagStore;
  readonly pictures: PictureStore;
  private readonly ownerToken = randomUUID();

  constructor(filename: string, migrationsDirectory = defaultMigrationsDirectory, options: { mustExist?: boolean } = {}) {
    if (filename !== ':memory:' && !options.mustExist) mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.sqlite = new Database(filename, { fileMustExist: options.mustExist ?? false });
    if (filename !== ':memory:') chmodSync(filename, 0o600);
    const storedVersion: unknown = this.sqlite.pragma('user_version', { simple: true });
    if (typeof storedVersion !== 'number' || storedVersion < 0 || storedVersion > databaseSchemaVersion) {
      this.sqlite.close();
      throw new Error(`Unsupported database schema ${String(storedVersion)}. This ORE supports up to ${databaseSchemaVersion}. Use the newer application; the database was not downgraded.`);
    }
    this.sqlite.pragma('journal_mode = WAL');
    this.sqlite.pragma('foreign_keys = ON');
    this.sqlite.pragma('busy_timeout = 5000');
    let version = storedVersion;
    const newDatabase = version === 0;
    if (version === 0) {
      this.sqlite.transaction(() => {
        this.sqlite.exec(readFileSync(resolve(migrationsDirectory, '0001_initial.sql'), 'utf8'));
        this.sqlite.pragma('user_version = 1');
      })();
      version = 1;
    }
    this.db = drizzle(this.sqlite, { schema });
    try {
      // Claim ownership before migrating an existing database.
      this.sqlite.transaction(() => {
        const owner = this.sqlite.prepare('SELECT process_id FROM runtime_owner WHERE id = 1').get() as { process_id: number } | undefined;
        if (owner) {
          let alive = true;
          try { process.kill(owner.process_id, 0); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false; }
          if (alive) throw Object.assign(new Error('Another server is already using this database. Stop it before starting another.'), { code: 'ORE_DATABASE_OWNED' });
        }
        this.sqlite.prepare('INSERT INTO runtime_owner (id, process_id, token) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET process_id = excluded.process_id, token = excluded.token').run(process.pid, this.ownerToken);
      }).immediate();
      if (!newDatabase && version < databaseSchemaVersion && filename !== ':memory:') {
        savePreUpgradeSnapshot(this.sqlite, filename, version);
      }
      const migrationSchema = { ...schema, ...legacyLibrarySchema };
      const migrationDb = drizzle(this.sqlite, { schema: migrationSchema });
      if (version === 1) {
        this.sqlite.transaction(() => {
          this.sqlite.exec(readFileSync(resolve(migrationsDirectory, '0002_libraries.sql'), 'utf8'));
          migrationDb.insert(migrationSchema.library).values({ id: 'default', kind: 'prompts', revision: 0, data: newDatabase ? defaultPrompt : legacyRoleplayPrompt }).run();
          const chat = migrationDb.select().from(migrationSchema.chats).where(eq(migrationSchema.chats.id, 'main')).get();
          if (chat) {
            const settings = { ...chat.settings, connectionId: migrationDb.select().from(migrationSchema.connections).get()?.id ?? null, promptId: 'migrated-prompt', characterId: null as string | null, personaId: null as string | null };
            migrationDb.insert(migrationSchema.library).values({ id: settings.promptId, kind: 'prompts', revision: 0, data: { name: 'Saved prompt', blocks: legacyRoleplayPrompt.blocks.map(b => b.kind === 'text' ? { ...b, text: chat.settings.instructions } : b) } }).run();
            if (settings.character !== '') {
              settings.characterId = 'migrated-character';
              migrationDb.insert(migrationSchema.library).values({ id: settings.characterId, kind: 'characters', revision: 0, data: { name: 'Character', description: settings.character, personality: '', scenario: '', first_mes: '', mes_example: '' } }).run();
            }
            if (settings.persona !== '') {
              settings.personaId = 'migrated-persona';
              migrationDb.insert(migrationSchema.library).values({ id: settings.personaId, kind: 'personas', revision: 0, data: { name: 'You', description: settings.persona } }).run();
            }
            migrationDb.update(migrationSchema.chats).set({ settings }).where(eq(migrationSchema.chats.id, 'main')).run();
          }
          this.sqlite.pragma('user_version = 2');
        })();
        version = 2;
      }
      if (version === 2) {
        this.sqlite.transaction(() => {
          this.sqlite.exec(readFileSync(resolve(migrationsDirectory, '0003_context.sql'), 'utf8'));
          migrationDb.insert(migrationSchema.library).values({ id: 'default-context', kind: 'contexts', revision: 0, data: defaultContextPreset }).run();
          this.sqlite.prepare('UPDATE library_state SET revision = revision + 1 WHERE id = 1').run();
          this.sqlite.pragma('user_version = 3');
        })();
        version = 3;
      }
      if (version === 3) {
        this.sqlite.transaction(() => {
          this.sqlite.exec(readFileSync(resolve(migrationsDirectory, '0004_token_usage.sql'), 'utf8'));
          this.sqlite.pragma('user_version = 4');
        })();
        version = 4;
      }
      if (version === 4) {
        this.sqlite.transaction(() => {
          const builtIn = migrationDb.select().from(migrationSchema.library).where(and(eq(migrationSchema.library.id, 'default'), eq(migrationSchema.library.kind, 'prompts'))).get();
          const previousDefault = { ...legacyLorePrompt, blocks: legacyLorePrompt.blocks.filter(block => block.id !== 'summary' && !block.marker?.startsWith('lore_')) };
          // Upgrade only the exact old factory preset. Edited defaults and all
          // user presets keep their deliberate marker choices.
          if (builtIn && isDeepStrictEqual(builtIn.data, previousDefault)) {
            this.sqlite.prepare('UPDATE library SET data = ?, revision = revision + 1 WHERE id = ?').run(JSON.stringify({ ...legacyLorePrompt, blocks: legacyLorePrompt.blocks.filter(block => !block.marker?.startsWith('lore_')) }), 'default');
            for (const chat of migrationDb.select().from(migrationSchema.chats).all()) if (chat.settings.promptId === 'default') this.bumpRevision(chat.id);
            this.sqlite.prepare('UPDATE library_state SET revision = revision + 1 WHERE id = 1').run();
          }
          this.sqlite.pragma('user_version = 5');
        })();
        version = 5;
      }
      if (version === 5) {
        this.sqlite.transaction(() => {
          const changedIds = new Set<string>();
          for (const preset of migrationDb.select().from(migrationSchema.library).where(eq(migrationSchema.library.kind, 'contexts')).all()) {
            const changes = upgradedContextPrompts(contextPresetSchema.parse(preset.data));
            if (!Object.keys(changes).length) continue;
            migrationDb.update(migrationSchema.library).set({ data: { ...preset.data, ...changes }, revision: preset.revision + 1 }).where(eq(migrationSchema.library.id, preset.id)).run();
            changedIds.add(preset.id);
          }
          if (changedIds.size) {
            for (const chat of migrationDb.select().from(migrationSchema.chats).all()) {
              if (chat.settings.contextPresetId && changedIds.has(chat.settings.contextPresetId)) this.bumpRevision(chat.id);
            }
            this.sqlite.prepare('UPDATE library_state SET revision = revision + 1 WHERE id = 1').run();
          }
          this.sqlite.pragma('user_version = 6');
        })();
        version = 6;
      }
      if (version === 6) {
        this.sqlite.transaction(() => {
          this.sqlite.exec(readFileSync(resolve(migrationsDirectory, '0007_lorebooks.sql'), 'utf8'));
          const builtIn = migrationDb.select().from(migrationSchema.library).where(and(eq(migrationSchema.library.id, 'default'), eq(migrationSchema.library.kind, 'prompts'))).get();
          const previousDefault = { ...legacyLorePrompt, blocks: legacyLorePrompt.blocks.filter(block => !block.marker?.startsWith('lore_')) };
          if (builtIn && isDeepStrictEqual(builtIn.data, previousDefault)) {
            this.sqlite.prepare('UPDATE library SET data = ?, revision = revision + 1 WHERE id = ?').run(JSON.stringify(legacyLorePrompt), 'default');
            for (const chat of migrationDb.select().from(migrationSchema.chats).all()) if (chat.settings.promptId === 'default') this.bumpRevision(chat.id);
            this.bumpLibrary();
          }
          this.sqlite.pragma('user_version = 7');
        })();
        version = 7;
      }
      if (version === 7) {
        this.sqlite.transaction(() => {
          const changedIds = new Set<string>();
          for (const preset of migrationDb.select().from(migrationSchema.library).where(eq(migrationSchema.library.kind, 'prompts')).all()) {
            const data = upgradePrompt(preset.data);
            if (isDeepStrictEqual(data, preset.data)) continue;
            migrationDb.update(migrationSchema.library).set({ data, revision: preset.revision + 1 }).where(eq(migrationSchema.library.id, preset.id)).run();
            changedIds.add(preset.id);
          }
          for (const chat of migrationDb.select().from(migrationSchema.chats).all()) {
            // A selected book now authorizes automatic insertion even in a
            // preset that previously omitted all lore controls.
            if (changedIds.has(chat.settings.promptId ?? '') || chat.settings.lorebookId) this.bumpRevision(chat.id);
          }
          if (changedIds.size) this.bumpLibrary();
          this.sqlite.pragma('user_version = 8');
        })();
        version = 8;
      }
      if (version === 8) {
        this.sqlite.transaction(() => {
          this.sqlite.exec(readFileSync(resolve(migrationsDirectory, '0009_tags.sql'), 'utf8'));
          this.bumpLibrary();
          this.sqlite.pragma('user_version = 9');
        })();
        version = 9;
      }
      if (version === 9) {
        this.sqlite.transaction(() => {
          this.sqlite.exec(readFileSync(resolve(migrationsDirectory, '0010_pictures.sql'), 'utf8'));
          this.bumpLibrary();
          this.sqlite.pragma('user_version = 10');
        })();
        version = 10;
      }
      if (version === 10) {
        this.sqlite.transaction(() => {
          this.sqlite.exec(readFileSync(resolve(migrationsDirectory, '0011_response_variants.sql'), 'utf8'));
          this.sqlite.pragma('user_version = 11');
        })();
        version = 11;
      }
      if (version === 11) {
        this.sqlite.transaction(() => {
          this.sqlite.exec(readFileSync(resolve(migrationsDirectory, '0012_reasoning.sql'), 'utf8'));
          this.sqlite.pragma('user_version = 12');
        })();
        version = 12;
      }
      if (version === 12) {
        this.sqlite.transaction(() => {
          this.sqlite.exec(readFileSync(resolve(migrationsDirectory, '0013_data_management.sql'), 'utf8'));
          this.sqlite.pragma('user_version = 13');
        })();
        version = 13;
      }
      if (version === 13) {
        this.sqlite.transaction(() => {
          this.sqlite.exec(readFileSync(resolve(migrationsDirectory, '0014_library_sorting.sql'), 'utf8'));
          this.bumpLibrary();
          this.sqlite.pragma('user_version = 14');
        })();
        version = 14;
      }
      if (version === 14) {
        this.sqlite.transaction(() => {
          this.sqlite.exec(readFileSync(resolve(migrationsDirectory, '0015_localized_outcomes.sql'), 'utf8'));
          this.sqlite.pragma('user_version = 15');
        })();
        version = 15;
      }
      if (version === 15) {
        this.sqlite.transaction(() => {
          this.sqlite.exec(readFileSync(resolve(migrationsDirectory, '0016_chat_branches.sql'), 'utf8'));
          upgradeSingleBranches(this.sqlite);
          this.sqlite.pragma('user_version = 16');
        })();
        version = 16;
      }
      if (version === 16) {
        this.sqlite.transaction(() => {
          this.sqlite.exec(readFileSync(resolve(migrationsDirectory, '0017_pinned_turns.sql'), 'utf8'));
          this.sqlite.pragma('user_version = 17');
        })();
        version = 17;
      }
      if (version === 17) {
        this.sqlite.transaction(() => {
          this.sqlite.exec(readFileSync(resolve(migrationsDirectory, '0018_large_card_pictures.sql'), 'utf8'));
          this.sqlite.pragma('user_version = 18');
        })();
        version = 18;
      }
      if (version === 18) {
        this.sqlite.transaction(() => {
          this.sqlite.exec(readFileSync(resolve(migrationsDirectory, '0019_continuation.sql'), 'utf8'));
          this.sqlite.pragma('user_version = 19');
        })();
        version = 19;
      }
      if (version !== databaseSchemaVersion) throw new Error('Unsupported database schema version.');
      this.pictures = new PictureStore(this.sqlite, () => this.bumpLibrary());
      this.contexts = new ContextStore(this);
      this.tags = new TagStore(this.sqlite, expected => this.checkLibrary(expected), () => this.bumpLibrary());
      if (newDatabase) this.db.update(schema.library).set({ createdAt: new Date().toISOString() }).run();
      if (newDatabase) this.sqlite.transaction(() => this.insertChat('main', initialSettings))();
    } catch (error) {
      this.sqlite.prepare('DELETE FROM runtime_owner WHERE token = ?').run(this.ownerToken);
      this.sqlite.close(); throw error;
    }
  }

  private insertChat(id: string, settings: ChatSettings) {
    const { authorNote, ...shared } = settings;
    this.db.insert(schema.chatGroups).values({ id, settings: shared }).run();
    this.db.insert(schema.chats).values({ id, groupId: id, revision: 0, settings: { authorNote } }).run();
  }
  private chatRecords() {
    return this.db.select({ row: schema.chats, group: schema.chatGroups }).from(schema.chats)
      .innerJoin(schema.chatGroups, eq(schema.chats.groupId, schema.chatGroups.id));
  }
  private readChatRecord(record: { row: typeof schema.chats.$inferSelect; group: typeof schema.chatGroups.$inferSelect }) {
    return { ...record.row, groupId: record.group.id, settings: { ...record.group.settings, authorNote: record.row.settings.authorNote } };
  }
  private chat(chatId: string) {
    const row = this.chatRecords().where(eq(schema.chats.id, chatId)).get();
    if (!row) throw new AppError(404, 'chat_not_found', message("errors.chat_not_found"));
    return this.readChatRecord(row);
  }
  private chats() {
    return this.chatRecords().all().map(row => this.readChatRecord(row));
  }
  private siblingIds(groupId: string) {
    return this.db.select({ id: schema.chats.id }).from(schema.chats).where(eq(schema.chats.groupId, groupId)).all().map(row => row.id);
  }
  private saveSharedSettings(chatId: string, settings: ChatSettings, memoryImpactToken?: string) {
    const previous = this.chat(chatId);
    const siblings = this.siblingIds(previous.groupId);
    for (const id of siblings) {
      this.ensureIdle(id);
      if (settings.contextPresetId === null && this.contexts.selectionCheckpoint(id).archivedCount) {
        throw new AppError(409, 'restore_context_first', message("errors.clear_memory_in_memory_before_disabling_the_context"));
      }
    }
    const review = this.selectionMemoryReview(previous, settings.contextPresetId);
    assertMemoryImpact(review.impact, memoryImpactToken);
    this.applyMemoryLayoutReviews(review.branches);
    const { authorNote, ...shared } = settings;
    this.writeSharedChatSelections(previous.groupId, previous.settings, shared, siblings);
    this.db.update(schema.chats).set({ settings: { authorNote } }).where(eq(schema.chats.id, chatId)).run();
  }
  private writeSharedChatSelections(groupId: string, previous: ChatSettings, settings: Omit<ChatSettings, 'authorNote'>, branches: string[]) {
    this.db.update(schema.chatGroups).set({ settings }).where(eq(schema.chatGroups.id, groupId)).run();
    if (settings.characterId !== previous.characterId || settings.personaId !== previous.personaId) {
      for (const id of branches) this.resetLoreEpoch(id);
    }
    this.touchSharedChat(groupId);
  }
  private touchSharedChat(groupId: string) {
    this.db.update(schema.chats).set({ updatedAt: new Date().toISOString(), revision: sql`${schema.chats.revision} + 1` })
      .where(eq(schema.chats.groupId, groupId)).run();
  }
  private selected<T>(id: string | null | undefined, kind: LibraryKind): Saved<T> | null {
    if (!id) return null;
    const row = this.db.select().from(schema.library).where(and(eq(schema.library.id, id), eq(schema.library.kind, kind))).get();
    if (!row) throw new AppError(422, 'missing_selection', message("errors.a_selected_library_item_no_longer_exists"));
    // Organizational metadata must never enter PromptSources or source revisions.
    const data = kind === 'characters' ? this.promptCharacter(libraryCharacterSchema.parse(row.data))
      : kind === 'personas' ? this.promptPersona(libraryPersonaSchema.parse(row.data)) : row.data;
    return { ...data, id: row.id, revision: row.revision } as unknown as Saved<T>;
  }
  private promptCharacter(card: LibraryCharacter): Character {
    const { titleComment: _titleComment, speechColor: _speechColor, ...fields } = card;
    return characterSchema.parse(fields);
  }
  private promptPersona(persona: LibraryPersona): Persona {
    const { titleComment: _titleComment, speechColor: _speechColor, ...fields } = persona;
    return personaSchema.parse(fields);
  }
  private comparableCharacter(card: LibraryCharacter): Character {
    const fields = this.promptCharacter(card);
    const greetings = readCharacterAlternateGreetings(fields);
    // Exposing preserved greetings in the editor does not itself change content.
    const result = greetings.success ? { ...fields, alternate_greetings: greetings.data } : fields;
    for (const field of cardInstructionFields) {
      const value = readCardInstruction(fields, field);
      if (value.success) result[field] = value.data;
    }
    const note = readCharacterDepthPrompt(fields);
    if (note.success) result.depth_prompt = note.data;
    return result;
  }
  chatHeader(chatId = 'main') {
    const chat = this.chat(chatId);
    const connectionId = roleplayConnectionId(chat.settings.connectionId);
    const connection = connectionId ? this.db.select().from(schema.connections).where(eq(schema.connections.id, connectionId)).get()?.settings ?? null : null;
    const hasApiKey = Boolean(connectionId && this.db.select().from(schema.credentials).where(eq(schema.credentials.id, connectionId)).get()?.apiKey);
    return {
      id: chatId, groupId: chat.groupId, branchName: chat.branchName, revision: chat.revision,
      settings: { ...chat.settings, lorebookId: chat.settings.lorebookId ?? null }, connection, hasApiKey,
      sources: {
        prompt: this.selected<PromptPreset>(chat.settings.promptId, 'prompts'),
        character: this.selected<Character>(chat.settings.characterId, 'characters'),
        persona: this.selected<Persona>(chat.settings.personaId, 'personas'),
        lorebook: this.selected<Lorebook>(chat.settings.lorebookId, 'lorebooks'),
      },
    };
  }
  summaryFileBranch(chatId: string) {
    const { createdAt, settings, branchName } = this.chat(chatId);
    return { createdAt, branchName, contextPresetId: settings.contextPresetId };
  }
  readTurnSources(chatId: string) {
    return this.db.select({ turnId: schema.turns.id, userRevision: schema.turns.userRevision,
      assistantRevision: sql<number>`coalesce(${schema.responseVariants.sourceRevision}, ${schema.turns.assistantRevision})`, complete: schema.turns.complete,
    }).from(schema.turns).leftJoin(schema.responseVariants, eq(schema.responseVariants.id, schema.turns.selectedVariantId))
      .where(eq(schema.turns.chatId, chatId)).orderBy(asc(schema.turns.position)).all();
  }
  readTurns(chatId: string, range?: { first: number; last: number }): Turn[] {
    const condition = and(eq(schema.turns.chatId, chatId), range ? gte(schema.turns.position, range.first) : undefined, range ? lte(schema.turns.position, range.last) : undefined);
    const variants = new Map<string, ResponseVariant[]>();
    const savedVariants = this.db.select({ id: schema.responseVariants.id, turnId: schema.responseVariants.turnId, text: schema.responseVariants.text,
      sourceRevision: schema.responseVariants.sourceRevision, generationId: schema.responseVariants.generationId, createdAt: schema.responseVariants.createdAt })
      .from(schema.responseVariants).innerJoin(schema.turns, eq(schema.turns.id, schema.responseVariants.turnId)).where(condition).orderBy(asc(sql`${schema.responseVariants}.rowid`)).all();
    for (const { turnId, ...variant } of savedVariants) {
      const group = variants.get(turnId);
      if (group) group.push(variant);
      else variants.set(turnId, [variant]);
    }
    return this.db.select().from(schema.turns).where(condition).orderBy(asc(schema.turns.position)).all().map(row => {
      const responses = variants.get(row.id) ?? [];
      const selected = responses.find(variant => variant.id === row.selectedVariantId);
      if (row.complete && (!selected || selected.text !== row.assistantText)) throw new AppError(500, 'invalid_response_variant', message("errors.the_saved_response_selection_is_inconsistent_the_transcript"));
      return {
        id: row.id, position: row.position, complete: row.complete,
        ...(row.pinned ? { pinned: true } : {}),
        user: { id: row.userId, revision: row.userRevision, text: row.userText },
        assistant: { id: row.assistantId, revision: row.assistantRevision, text: row.assistantText,
          ...(selected ? { variantId: selected.id, sourceRevision: selected.sourceRevision } : {}) },
        variants: responses,
      };
    });
  }
  engineSnapshot(chatId = 'main'): EngineSnapshot {
    const header = this.chatHeader(chatId);
    const turns = this.readTurns(chatId);
    return { ...header, turns, loreState: this.loreState(chatId, header.settings.lorebookId), context: this.contexts.snapshot(chatId, header.settings.contextPresetId ?? null) };
  }
  // Retained for explicit legacy inspection. Runtime engine and UI tools use
  // engineSnapshot so old requests never participate in current calculations.
  snapshot(chatId = 'main'): ChatSnapshot {
    const generations: Generation[] = this.db.select({
      id: schema.generations.id, turnId: schema.generations.turnId, status: schema.generations.status,
      sourceRevision: schema.generations.sourceRevision, kind: schema.generationKind,
      request: schema.generations.request, usage: schema.generations.usage, partialText: schema.generations.partialText,
      reasoningText: sql<string>`substr(${schema.generations.reasoningText}, -2000)`,
      error: schema.generations.error, errorMessage: schema.generations.errorMessage, createdAt: schema.generations.createdAt, updatedAt: schema.generations.updatedAt,
    }).from(schema.generations).where(eq(schema.generations.chatId, chatId)).orderBy(desc(sql`rowid`)).all().map(row => ({
      id: row.id, turnId: row.turnId, status: row.status, sourceRevision: row.sourceRevision, kind: row.kind,
      request: row.request, usage: row.usage, partialText: row.partialText, reasoningText: row.reasoningText, error: row.error, errorMessage: row.errorMessage, createdAt: row.createdAt, updatedAt: row.updatedAt,
    }));
    return { ...this.engineSnapshot(chatId), generations };
  }
  generationPage(chatId: string, input: { before?: string; selected?: string; limit: number }): GenerationPage {
    this.chat(chatId);
    let boundary: number | undefined;
    if (input.before) {
      const row = this.db.select({ rowid: sql<number>`rowid` }).from(schema.generations)
        .where(and(eq(schema.generations.chatId, chatId), eq(schema.generations.id, input.before))).get();
      if (!row) throw new AppError(404, 'generation_not_found', message('errors.saved_response_request_not_found'));
      boundary = row.rowid;
    }
    const descriptors = () => this.db.select({
      id: schema.generations.id, turnId: schema.generations.turnId, status: schema.generations.status,
      sourceRevision: schema.generations.sourceRevision, kind: schema.generationKind,
      requestAvailable: sql<number>`${schema.generations.request} IS NOT NULL`, usage: schema.generations.usage,
      error: schema.generations.error, errorMessage: schema.generations.errorMessage,
      createdAt: schema.generations.createdAt, updatedAt: schema.generations.updatedAt,
    }).from(schema.generations);
    const rows = descriptors().where(and(eq(schema.generations.chatId, chatId), boundary === undefined ? undefined : sql`rowid < ${boundary}`))
      .orderBy(desc(sql`rowid`)).limit(input.limit + 1).all();
    const descriptor = (row: typeof rows[number]) => ({ ...row, requestAvailable: Boolean(row.requestAvailable) });
    const items = rows.slice(0, input.limit).map(descriptor);
    let selected: GenerationPage['selected'];
    if (input.selected) {
      selected = items.find(item => item.id === input.selected);
      if (!selected) {
        const row = descriptors().where(and(eq(schema.generations.chatId, chatId), eq(schema.generations.id, input.selected))).get();
        selected = row ? descriptor(row) : null;
      }
    }
    return { items, nextBefore: rows.length > input.limit ? items.at(-1)?.id ?? null : null, ...(input.selected ? { selected } : {}) };
  }
  promptSources(input: ReturnType<typeof selectionsSchema.parse>): PromptSources {
    return {
      prompt: this.selected<PromptPreset>(input.promptId, 'prompts'),
      character: this.selected<Character>(input.characterId, 'characters'),
      persona: this.selected<Persona>(input.personaId, 'personas'),
      lorebook: this.selected<Lorebook>(input.lorebookId, 'lorebooks'),
    };
  }
  checkRevision(expected: number, chatId = 'main') {
    if (this.chat(chatId).revision !== expected) throw new AppError(409, 'revision_conflict', message("errors.the_chat_changed_on_another_device_review_the"));
  }
  generationRunning(chatId?: string) {
    const condition = chatId ? and(eq(schema.generations.status, 'running'), eq(schema.generations.chatId, chatId)) : eq(schema.generations.status, 'running');
    return Boolean(this.db.select({ id: schema.generations.id }).from(schema.generations).where(condition).get());
  }
  ensureIdle(chatId?: string) {
    if (this.generationRunning(chatId)) throw new AppError(409, 'generation_running', message("errors.cancel_or_wait_for_the_current_response_before"));
    if (this.contexts.running(chatId)) throw new AppError(409, 'context_running', message("errors.stop_or_wait_for_memory_preparation_before_editing"));
  }
  bumpRevision(chatId = 'main') {
    const row = this.db.select({ revision: schema.chats.revision }).from(schema.chats).where(eq(schema.chats.id, chatId)).get();
    if (!row) throw new AppError(404, 'chat_not_found', message("errors.chat_not_found"));
    const revision = row.revision + 1;
    this.db.update(schema.chats).set({ revision }).where(eq(schema.chats.id, chatId)).run();
    return revision;
  }
  libraryRevision() { return (this.sqlite.prepare('SELECT revision FROM library_state WHERE id = 1').get() as { revision: number }).revision; }
  private checkLibrary(expected: number) {
    if (this.libraryRevision() !== expected) throw new AppError(409, 'revision_conflict', message("errors.the_library_changed_on_another_device_reopen_the"));
    this.ensureIdle();
  }
  private bumpLibrary() { this.sqlite.prepare('UPDATE library_state SET revision = revision + 1 WHERE id = 1').run(); }
  private bumpAffected(kind: LibraryKind, id: string, exceptGroup?: string) {
    const key = selectionKeys[kind];
    for (const chat of this.chats()) {
      if (chat.groupId === exceptGroup) continue;
      const usesConnection = kind === 'connections'
        && (roleplayConnectionId(chat.settings.connectionId) === id || this.contextPreset(chat.settings.contextPresetId)?.connectionId === id);
      if (chat.settings[key] === id || usesConnection) this.bumpRevision(chat.id);
    }
  }
  private layoutReview(chat: ReturnType<Store['chat']>, before: ContextState, cleanup: MemoryLayoutReview['cleanup']): MemoryLayoutReview {
    return { id: chat.id, title: chat.settings.title, branchName: chat.branchName, revision: chat.revision, before, cleanup };
  }
  private memoryTurnMembership(chatId: string) {
    return this.db.select({ id: schema.turns.id, complete: schema.turns.complete })
      .from(schema.turns).where(eq(schema.turns.chatId, chatId)).orderBy(asc(schema.turns.position)).all();
  }
  private shapeLayoutReview(chatId: string, next: ContextPreset) {
    const before = this.contexts.savedState(chatId);
    const turns = before.summaries.length ? this.memoryTurnMembership(chatId) : [];
    return { before, cleanup: resizedMemoryLayout(before, turns, next) };
  }
  private shapeLayoutReviews(chats: ReturnType<Store['chats']>, next: ContextPreset) {
    return chats.map(chat => {
      this.ensureIdle(chat.id);
      this.contexts.ensureLayoutReviewClosed(chat.id);
      const { before, cleanup } = this.shapeLayoutReview(chat.id, next);
      return this.layoutReview(chat, before, cleanup);
    });
  }
  private describeMemoryImpact(branches: MemoryLayoutReview[], command: unknown) {
    if (!branches.length) return { branches, impact: null };
    const turnIds = this.sqlite.prepare('SELECT id FROM turns WHERE chat_id = ? ORDER BY position');
    const ordinals = new Map<string, Map<string, number>>();
    const impact = memoryCleanupImpact(branches, command, (chatId, turnId) => {
      let branch = ordinals.get(chatId);
      if (!branch) {
        const rows = turnIds.all(chatId) as { id: string }[];
        branch = new Map(rows.map(({ id }, index) => [id, index + 1]));
        ordinals.set(chatId, branch);
      }
      return branch.get(turnId) ?? null;
    });
    return { branches, impact };
  }
  private applyMemoryLayoutReviews(branches: MemoryLayoutReview[]) {
    for (const { id, before, cleanup } of branches) {
      if (cleanup.deletedIds.size || cleanup.after.archivedTurnIds.length !== before.archivedTurnIds.length || cleanup.after.selected.length !== before.selected.length) {
        this.contexts.applyLayoutCleanup(id, cleanup);
      }
    }
  }
  private presetMemoryReview(revision: number, previous: Saved<ContextPreset> | null, next: ContextPreset) {
    const branches = previous && changedMemoryShape(previous, next)
      ? this.shapeLayoutReviews(this.chats().filter(chat => chat.settings.contextPresetId === previous.id), next) : [];
    return this.describeMemoryImpact(branches, ['preset', revision, previous?.id, next.batchSize, next.promotionGroup]);
  }
  contextPresetMemoryImpact(revision: number, presetId: string, next: ContextPreset) {
    return this.sqlite.transaction(() => {
      this.checkLibrary(revision);
      return this.presetMemoryReview(revision, this.contextPreset(presetId), next).impact;
    })();
  }
  private selectionMemoryReview(chat: ReturnType<Store['chat']>, presetId: string | null | undefined) {
    if (presetId === chat.settings.contextPresetId) return { branches: [], impact: null };
    const previous = this.contextPreset(chat.settings.contextPresetId);
    const next = this.contextPreset(presetId);
    const branches = next && changedMemoryShape(previous, next)
      ? this.shapeLayoutReviews(this.chats().filter(branch => branch.groupId === chat.groupId), next) : [];
    return this.describeMemoryImpact(branches, ['selection', chat.groupId, previous?.id, previous?.revision, next?.id, next?.revision]);
  }
  contextSelectionMemoryImpact(revision: number, chatId: string, presetId: string | null) {
    return this.sqlite.transaction(() => {
      this.checkRevision(revision, chatId);
      return this.selectionMemoryReview(this.chat(chatId), presetId).impact;
    })();
  }
  private chatSummaries(): ChatSummary[] {
    return this.chats().map(chat => ({ id: chat.id, groupId: chat.groupId, branchName: chat.branchName, title: chat.settings.title, characterId: chat.settings.characterId ?? null, revision: chat.revision,
      createdAt: chat.createdAt, updatedAt: chat.updatedAt,
      lastMessageAt: this.db.select({ date: sql<string | null>`max(${schema.turns.messageAt})` }).from(schema.turns).where(eq(schema.turns.chatId, chat.id)).get()?.date ?? null,
      turnCount: (this.sqlite.prepare('SELECT count(*) AS n FROM turns WHERE chat_id = ?').get(chat.id) as { n: number }).n,
      running: this.generationRunning(chat.id) || this.contexts.running(chat.id),
    }));
  }
  libraryUpdate(knownRevision?: number): (LibrarySnapshot & Required<Pick<LibrarySnapshot, 'lorebookUses'>>) | UnchangedLibrary;
  libraryUpdate(knownRevision: number | undefined, includeLorebookUses: boolean): LibrarySnapshot | UnchangedLibrary;
  libraryUpdate(knownRevision?: number, includeLorebookUses = true): LibrarySnapshot | UnchangedLibrary {
    const revision = this.libraryRevision();
    return knownRevision === revision ? { unchanged: true, revision, chats: this.chatSummaries() } : this.libraries(includeLorebookUses);
  }
  libraries(): LibrarySnapshot & Required<Pick<LibrarySnapshot, 'lorebookUses'>>;
  libraries(includeLorebookUses: boolean): LibrarySnapshot;
  libraries(includeLorebookUses = true): LibrarySnapshot {
    const rows = this.db.select().from(schema.library).all();
    const list = <T>(kind: string) => rows.filter(r => r.kind === kind).map(r => ({ ...r.data, id: r.id, revision: r.revision })) as unknown as Saved<T>[];
    return {
      characterPictures: this.pictures.list(),
      tags: this.tags.catalog(), characterTags: this.tags.links(),
      dates: Object.fromEntries([
        ...rows.map(row => [row.id, { createdAt: row.createdAt, updatedAt: row.updatedAt }]),
        ...this.db.select().from(schema.connections).all().map(row => [row.id, { createdAt: row.createdAt, updatedAt: row.updatedAt }]),
      ]),
      revision: this.libraryRevision(), personas: list<LibraryPersona>('personas'), characters: list<LibraryCharacter>('characters'), prompts: list<PromptPreset>('prompts'),
      contexts: list<ContextPreset>('contexts').map(preset => ({ ...preset, repairPrompt: preset.repairPrompt ?? defaultContextPreset.repairPrompt })),
      lorebooks: list<Lorebook>('lorebooks'),
      ...(includeLorebookUses ? { lorebookUses: this.legacyLorebookUses(list<Lorebook>('lorebooks'), list<LibraryCharacter>('characters')) } : {}),
      connections: this.db.select().from(schema.connections).all().map(r => ({ ...r.settings, id: r.id, revision: r.revision, hasApiKey: Boolean(this.db.select().from(schema.credentials).where(eq(schema.credentials.id, r.id)).get()?.apiKey) })),
      chats: this.chatSummaries(),
    };
  }
  private legacyLorebookUses(books: Saved<Lorebook>[], characters: Saved<LibraryCharacter>[]) {
    const uses = new Map(books.map(book => [book.id, {
      bookId: book.id, characters: new Array<{ id: string; name: string; titleComment?: string }>(),
      chats: new Array<{ id: string; title: string }>(),
    }]));
    for (const { id, name, titleComment, lorebookId } of characters) {
      if (lorebookId) uses.get(lorebookId)?.characters.push({ id, name, ...(titleComment ? { titleComment } : {}) });
    }
    for (const { id, settings } of this.db.select().from(schema.chatGroups).all()) {
      if (settings.lorebookId) uses.get(settings.lorebookId)?.chats.push({ id, title: settings.title });
    }
    return [...uses.values()];
  }
  importContextPreset(revision: number, preset: ContextPreset) {
    return this.sqlite.transaction(() => {
      const connectionId = preset.connectionId;
      const usedChatConnection = connectionId !== null
        && !this.db.select({ id: schema.connections.id }).from(schema.connections).where(eq(schema.connections.id, connectionId)).get();
      const id = this.saveLibrary(revision, 'contexts', usedChatConnection ? { ...preset, connectionId: null } : preset);
      return { id, usedChatConnection };
    })();
  }
  private updateLibraryRecord(id: string, data: typeof schema.library.$inferInsert['data'] | SQL, revision?: number) {
    this.db.update(schema.library).set({ data, revision, updatedAt: new Date().toISOString() })
      .where(eq(schema.library.id, id)).run();
  }
  saveLibrary(expected: number, kind: LibraryKind, data: LibraryCharacter | LibraryPersona | PromptPreset | ContextPreset | Connection | Lorebook, id?: string, apiKey?: string, tagIds?: string[], memoryImpactToken?: string) {
    if (kind === 'prompts') data = upgradePrompt(data);
    return this.sqlite.transaction(() => {
      this.checkLibrary(expected);
      const identity = id ?? randomUUID();
      if (kind === 'connections') {
        const old = this.db.select().from(schema.connections).where(eq(schema.connections.id, identity)).get();
        if (id && !old) throw new AppError(404, 'item_not_found', message("errors.connection_not_found"));
        this.db.insert(schema.connections).values({ id: identity, settings: data as Connection, revision: (old?.revision ?? -1) + 1 }).onConflictDoUpdate({ target: schema.connections.id, set: { updatedAt: new Date().toISOString(), settings: data as Connection, revision: (old?.revision ?? -1) + 1 } }).run();
        if (apiKey !== undefined) this.db.insert(schema.credentials).values({ id: identity, apiKey }).onConflictDoUpdate({ target: schema.credentials.id, set: { apiKey } }).run();
      } else {
        const old = this.db.select().from(schema.library).where(and(eq(schema.library.id, identity), eq(schema.library.kind, kind))).get();
        if (id && !old) throw new AppError(404, 'item_not_found', message("errors.library_item_not_found"));
        if (kind === 'contexts') {
          // HTTP commands validate strictly. Trusted callers can pass the saved
          // preset including its identity and revision, which live in columns.
          const next = contextPresetSchema.strip().parse(data);
          if (next.connectionId) this.connection(next.connectionId);
          const review = this.presetMemoryReview(expected, old ? this.contextPreset(identity) : null, next);
          assertMemoryImpact(review.impact, memoryImpactToken);
          this.applyMemoryLayoutReviews(review.branches);
          data = next;
        }
        if (kind === 'lorebooks') {
          const book = lorebookSchema.parse(data);
          const previous = old ? lorebookSchema.parse(old.data) : null;
          const edited = previous ? markLoreEdits(previous, book) : book;
          const previousEntries = new Map(previous?.entries.map(entry => [entry.id, entry]));
          data = { ...edited, entries: edited.entries.map(entry => {
            const before = previousEntries.get(entry.id);
            const sameEpoch = { ...entry, activationRevision: before?.activationRevision ?? 0 };
            const changed = previous && before && semanticFingerprint(previous, before) !== semanticFingerprint(edited, sameEpoch);
            return { ...sameEpoch, id: previous ? entry.id : randomUUID(), activationRevision: (before?.activationRevision ?? 0) + Number(Boolean(changed)) };
          }) };
          if (old) {
            const retained = previous ? unchangedLoreEntries(previous, data) : new Set<string>();
            const states = this.sqlite.prepare('SELECT chat_id, data FROM lore_states WHERE book_id = ?').all(identity) as { chat_id: string; data: string }[];
            for (const state of states) {
              const entries = JSON.parse(state.data) as LoreState['entries'];
              this.sqlite.prepare('UPDATE lore_states SET data = ? WHERE chat_id = ? AND book_id = ?').run(JSON.stringify(Object.fromEntries(Object.entries(entries).filter(([entryId]) => retained.has(entryId)))), state.chat_id, identity);
            }
          }
        }
        if (kind === 'characters') {
          const card = libraryCharacterSchema.parse(data), previous = old ? libraryCharacterSchema.parse(old.data) : null;
          const lorebookId = card.lorebookId === undefined ? previous?.lorebookId : card.lorebookId;
          this.selected(lorebookId, 'lorebooks');
          // Older clients and internal card-only writes preserve local metadata.
          const titleComment = card.titleComment ?? previous?.titleComment ?? '';
          const speechColor = card.speechColor === undefined ? previous?.speechColor : card.speechColor;
          const alternate_greetings = card.alternate_greetings ?? previous?.alternate_greetings;
          const instructions: Pick<Character, 'system_prompt' | 'post_history_instructions' | 'depth_prompt'> = {};
          for (const field of cardInstructionFields) {
            const value = card[field] ?? previous?.[field];
            if (value !== undefined) instructions[field] = value;
          }
          const depthPrompt = card.depth_prompt ?? previous?.depth_prompt;
          if (depthPrompt !== undefined) instructions.depth_prompt = depthPrompt;
          const updated: LibraryCharacter = { ...this.promptCharacter(card), ...instructions, ...(alternate_greetings !== undefined ? { alternate_greetings } : {}), ...(lorebookId !== undefined ? { lorebookId } : {}), ...(titleComment ? { titleComment } : {}), ...(speechColor ? { speechColor } : {}) };
          checkCharacterRecordSize(updated);
          data = updated;
          if (previous && previous.name !== card.name) for (const chat of this.chats()) if (chat.settings.characterId === identity) this.resetLoreEpoch(chat.id);
          if (old && previous && isDeepStrictEqual(this.comparableCharacter(previous), this.comparableCharacter(updated))) {
            const metadataChanged = !isDeepStrictEqual(old.data, data);
            if (metadataChanged) this.updateLibraryRecord(identity, data);
            const tagsChanged = tagIds !== undefined && this.tags.replaceInTransaction(identity, tagIds);
            if (metadataChanged || tagsChanged) {
              if (!metadataChanged) this.db.update(schema.library).set({ updatedAt: new Date().toISOString() }).where(eq(schema.library.id, identity)).run();
              this.bumpLibrary();
            }
            return identity;
          }
        }
        if (kind === 'personas') {
          const persona = libraryPersonaSchema.parse(data);
          const previous = old ? libraryPersonaSchema.parse(old.data) : null;
          const titleComment = persona.titleComment ?? previous?.titleComment ?? '';
          const speechColor = persona.speechColor === undefined ? previous?.speechColor : persona.speechColor;
          const updated: LibraryPersona = { ...this.promptPersona(persona), ...(titleComment ? { titleComment } : {}), ...(speechColor ? { speechColor } : {}) };
          data = updated;
          if (previous && previous.name !== updated.name) for (const chat of this.chats()) if (chat.settings.personaId === identity) this.resetLoreEpoch(chat.id);
          if (old && previous && isDeepStrictEqual(this.promptPersona(previous), this.promptPersona(updated))) {
            if (!isDeepStrictEqual(old.data, updated)) {
              this.updateLibraryRecord(identity, updated);
              this.bumpLibrary();
            }
            return identity;
          }
        }
        const saved = data as LibraryCharacter | LibraryPersona | PromptPreset | ContextPreset | Lorebook;
        if (old) this.updateLibraryRecord(identity, saved, old.revision + 1);
        else this.db.insert(schema.library).values({ id: identity, kind, revision: 0, data: saved }).run();
      }
      if (kind === 'characters' && tagIds !== undefined) this.tags.replaceInTransaction(identity, tagIds);
      this.bumpLibrary(); this.bumpAffected(kind, identity); return identity;
    })();
  }
  private characterSaveFingerprint(input: CharacterSaveCommand, id?: string) {
    const picture = input.picture?.mode === 'replace' ? { mode: 'replace', digest: createHash('sha256').update(Buffer.from(input.picture.base64, 'base64')).digest('hex'), crop: input.picture.crop } : input.picture;
    return { kind: 'character-save-v1', id: id ?? null, data: input.data, tagIds: input.tagIds, picture, expectedPicture: input.expectedPicture };
  }
  replayCharacterSave(input: CharacterSaveCommand, id?: string) {
    if (!input.requestId) {
      if (input.picture) throw new AppError(400, 'missing_command', message("errors.picture_saves_require_a_command_identity"));
      return { found: false as const };
    }
    return this.recordedLibraryCommand(input.requestId, this.libraryCommandFingerprint(this.characterSaveFingerprint(input, id)), value => z.object({ id: z.string() }).parse(value));
  }
  checkCharacterSave(input: CharacterSaveCommand, id?: string) {
    this.checkLibrary(input.revision);
    if (id) this.selected<Character>(id, 'characters');
    if (input.picture) {
      if (input.expectedPicture === undefined) throw new AppError(400, 'missing_picture_precondition', message("errors.picture_saves_require_the_reviewed_picture_identity"));
      this.pictures.check(id, input.expectedPicture);
    }
  }
  saveCharacter(input: CharacterSaveCommand, id?: string, prepared?: PreparedPicture) {
    const replay = this.replayCharacterSave(input, id);
    if (replay.found) return replay.result;
    if (input.picture && input.picture.mode !== 'remove') {
      if (!prepared || !isDeepStrictEqual(prepared.crop, input.picture.crop) || (input.picture.mode === 'replace' && prepared.digest !== createHash('sha256').update(Buffer.from(input.picture.base64, 'base64')).digest('hex'))) throw new Error('Prepared picture does not match the save command.');
    }
    const execute = () => {
      this.checkCharacterSave(input, id);
      const identity = this.saveLibrary(input.revision, 'characters', input.data, id, undefined, input.tagIds);
      const pictureChanged = this.pictures.apply(identity, input.picture, prepared);
      if (id && pictureChanged) this.db.update(schema.library).set({ updatedAt: new Date().toISOString() }).where(eq(schema.library.id, identity)).run();
      return { id: identity };
    };
    return input.requestId ? this.loreCommand(input.revision, input.requestId, this.characterSaveFingerprint(input, id), value => z.object({ id: z.string() }).parse(value), execute) : this.sqlite.transaction(execute)();
  }
  importLibrary(expected: number, kind: 'characters' | 'personas', items: (Character | Persona)[]) {
    return this.sqlite.transaction(() => {
      this.checkLibrary(expected);
      return items.map(data => this.saveLibrary(this.libraryRevision(), kind, data));
    })();
  }
  private recordedLibraryCommand<T>(requestId: string, fingerprint: string, parse: (value: unknown) => T, legacyFingerprint?: string | string[], conflict = message('errors.this_import_identity_was_already_used_for_a')): { found: false } | { found: true; result: T } {
    const existing = this.sqlite.prepare('SELECT command, result FROM lore_commands WHERE request_id = ?').get(requestId) as { command: string; result: string } | undefined;
    if (!existing) return { found: false };
    if (existing.command !== fingerprint && !(Array.isArray(legacyFingerprint) ? legacyFingerprint : [legacyFingerprint]).includes(existing.command)) throw new AppError(409, 'request_id_conflict', conflict);
    return { found: true, result: parse(JSON.parse(existing.result)) };
  }
  private libraryCommandFingerprint(command: unknown) {
    return createHash('sha256').update(JSON.stringify(command)).digest('hex');
  }
  private loreCommand<T>(expected: number, requestId: string, command: unknown, parse: (value: unknown) => T, execute: () => T, legacyCommand?: unknown): T {
    const fingerprint = this.libraryCommandFingerprint(command);
    const legacyFingerprint = legacyCommand === undefined ? undefined : this.libraryCommandFingerprint(legacyCommand);
    return this.sqlite.transaction(() => {
      const existing = this.recordedLibraryCommand(requestId, fingerprint, parse, legacyFingerprint);
      if (existing.found) return existing.result;
      this.checkLibrary(expected);
      const result = execute();
      this.sqlite.prepare('INSERT INTO lore_commands (request_id, command, result) VALUES (?, ?, ?)').run(requestId, fingerprint, JSON.stringify(result));
      return result;
    })();
  }
  importBook(expected: number, requestId: string, value: unknown) {
    const preview = parseImport(() => importLorebook(value, randomUUID));
    const resultSchema = z.object({ id: z.string(), diagnostics: z.array(loreDiagnosticSchema) });
    return this.loreCommand(expected, requestId, { kind: 'lorebook', value }, value => resultSchema.parse(value), () => {
      const id = this.saveLibrary(this.libraryRevision(), 'lorebooks', preview.book);
      return { id, diagnostics: this.savedLoreDiagnostics(preview, id) };
    });
  }
  private savedLoreDiagnostics(preview: LoreImportPreview, bookId: string) {
    const saved = this.selected<Lorebook>(bookId, 'lorebooks');
    const identities = new Map(preview.book.entries.map((entry, index) => [entry.id, saved?.entries[index]?.id]));
    return preview.diagnostics.map(diagnostic => diagnostic.entryId ? { ...diagnostic, entryId: identities.get(diagnostic.entryId) ?? diagnostic.entryId } : diagnostic);
  }
  private analyzeCard(value: unknown) {
    assertCharacterSourceDepth(value);
    const card = parseImport(() => importCharacter(value));
    checkCharacterRecordSize(card);
    const raw = z.record(z.string(), z.unknown()).parse(value);
    const data = raw.spec === 'chara_card_v2' || raw.spec === 'chara_card_v3' ? z.record(z.string(), z.unknown()).parse(raw.data) : raw;
    const book = data.character_book == null ? null : parseImport(() => importCharacterLorebook(data.character_book, card.name, randomUUID, raw.spec === 'chara_card_v3' ? 'v3' : 'v2'));
    return { card, book, tags: readEmbeddedTags(raw) };
  }
  previewCard(value: unknown): CharacterImportReview {
    const { card, book, tags } = this.analyzeCard(value);
    return { revision: this.libraryRevision(), name: card.name, description: card.description,
      book: book ? { name: book.book.name, entries: book.book.entries.length } : null,
      diagnostics: book?.diagnostics ?? [], tags: this.tags.review(tags) };
  }
  replayCard(requestId: string, value: unknown, policy: TagPolicy, artwork?: PictureImportIntent) {
    // Most commands are new. Avoid serializing large source metadata for legacy
    // fingerprint variants unless there is a receipt to compare against.
    if (!this.sqlite.prepare('SELECT 1 FROM lore_commands WHERE request_id = ?').get(requestId)) return { found: false } as const;
    const command = artwork ? { kind: 'character-picture-v1', value, tagPolicy: policy, artwork } : { kind: 'character', value, tagPolicy: policy };
    const legacy = [{ kind: 'character', value, tagPolicy: policy }, ...(policy === 'none' ? [{ kind: 'character', value }] : [])];
    return this.recordedLibraryCommand(requestId, this.libraryCommandFingerprint(command), value => characterImportResultSchema.parse(value), legacy.map(value => this.libraryCommandFingerprint(value)));
  }
  importCard(expected: number, requestId: string, value: unknown, policyInput: TagPolicy = 'none', artwork?: PictureImportIntent, prepared?: PreparedPicture) {
    const policy = tagPolicySchema.parse(policyInput);
    // Replay precedes analysis and revision checks, so historical success remains
    // available after deletion, catalog growth or stricter parser limits.
    const command = artwork ? { kind: 'character-picture-v1', value, tagPolicy: policy, artwork } : { kind: 'character', value, tagPolicy: policy };
    const parseResult = (value: unknown) => characterImportResultSchema.parse(value);
    const recorded = this.replayCard(requestId, value, policy, artwork);
    if (recorded.found) return recorded.result;
    // Card/book analysis is read-only and stays outside the write transaction.
    const { card, book: preview, tags } = this.analyzeCard(value);
    return this.loreCommand(expected, requestId, command, parseResult, () => {
      const bookId = preview ? this.saveLibrary(this.libraryRevision(), 'lorebooks', preview.book) : null;
      const resolved = this.tags.resolveInTransaction(tags, policy);
      const id = this.saveLibrary(this.libraryRevision(), 'characters', { ...card, lorebookId: bookId }, undefined, undefined, resolved.ids);
      if (artwork?.mode === 'retain' && artwork.digest) {
        if (!prepared || prepared.digest !== artwork.digest) throw new Error('Imported artwork must be prepared before commit.');
        this.pictures.apply(id, { mode: 'replace', crop: prepared.crop }, prepared);
      }
      return { ...(artwork ? { picture: { saved: artwork.mode === 'retain' && Boolean(artwork.digest) } } : {}), ids: [id], books: preview && bookId ? [{ id: bookId, name: preview.book.name, entries: preview.book.entries.length }] : [],
        diagnostics: preview && bookId ? this.savedLoreDiagnostics(preview, bookId) : [], tags: resolved.report };
    });
  }
  duplicateConnection(expected: number, connectionId: string) {
    return this.sqlite.transaction(() => {
      this.checkLibrary(expected);
      const original = this.db.select().from(schema.connections).where(eq(schema.connections.id, connectionId)).get();
      if (!original) throw new AppError(404, 'connection_not_found', message("errors.connection_not_found"));
      const apiKey = this.connectionApiKey(connectionId);
      return this.saveLibrary(expected, 'connections', {
        ...original.settings, name: `${original.settings.name.slice(0, 90)} copy`,
      }, undefined, apiKey);
    })();
  }
  duplicateCharacter(expected: number, characterId: string) {
    return this.sqlite.transaction(() => {
      this.checkLibrary(expected);
      const original = this.db.select().from(schema.library).where(and(eq(schema.library.id, characterId), eq(schema.library.kind, 'characters'))).get();
      if (!original) throw new AppError(404, 'character_not_found', message("errors.character_not_found"));
      const data = libraryCharacterSchema.parse(original.data);
      const id = this.saveLibrary(expected, 'characters', { ...data, name: `${data.name.slice(0, 90)} copy` }, undefined, undefined, this.tags.assigned(characterId));
      this.pictures.duplicate(characterId, id);
      return id;
    })();
  }
  extractBook(expected: number, requestId: string, characterId: string) {
    const resultSchema = z.object({ bookId: z.string(), diagnostics: z.array(loreDiagnosticSchema) });
    return this.loreCommand(expected, requestId, { kind: 'extract', characterId }, value => resultSchema.parse(value), () => {
      const card = this.selected<Character>(characterId, 'characters');
      if (!card) throw new AppError(404, 'item_not_found', message("errors.character_not_found"));
      if (card.lorebookId) {
        const book = this.selected<Lorebook>(card.lorebookId, 'lorebooks');
        return { bookId: card.lorebookId, diagnostics: book ? loreCompatibility(book) : [] };
      }
      const raw = card.source ?? {}, data = raw.spec === 'chara_card_v2' || raw.spec === 'chara_card_v3' ? z.record(z.string(), z.unknown()).parse(raw.data) : raw;
      if (data.character_book == null) throw new AppError(422, 'no_embedded_book', message("errors.this_character_has_no_preserved_embedded_lorebook"));
      const preview = parseImport(() => importCharacterLorebook(data.character_book, card.name, randomUUID, raw.spec === 'chara_card_v3' ? 'v3' : 'v2'));
      const bookId = this.saveLibrary(this.libraryRevision(), 'lorebooks', preview.book);
      const { id: _id, revision: _revision, ...editable } = card;
      this.saveLibrary(this.libraryRevision(), 'characters', { ...editable, lorebookId: bookId }, characterId);
      return { bookId, diagnostics: this.savedLoreDiagnostics(preview, bookId) };
    });
  }
  loreState(chatId: string, bookId?: string | null): LoreState {
    const epoch = (this.sqlite.prepare('SELECT epoch FROM lore_epochs WHERE chat_id = ?').get(chatId) as { epoch: number } | undefined)?.epoch ?? 0;
    const row = bookId ? this.sqlite.prepare('SELECT epoch, data FROM lore_states WHERE chat_id = ? AND book_id = ?').get(chatId, bookId) as { epoch: number; data: string } | undefined : undefined;
    const entries = row?.epoch === epoch ? z.record(z.string(), z.object({ fingerprint: z.string(), matches: z.number().int().nonnegative() })).parse(JSON.parse(row.data)) : {};
    return { epoch, entries };
  }
  private resetLoreEpoch(chatId: string) {
    this.sqlite.prepare('INSERT INTO lore_epochs (chat_id, epoch) VALUES (?, 1) ON CONFLICT(chat_id) DO UPDATE SET epoch = epoch + 1').run(chatId);
    this.sqlite.prepare('DELETE FROM lore_states WHERE chat_id = ?').run(chatId);
  }
  private assertLoreCurrent(chatId: string, resolution: LoreResolution) {
    const settings = this.chat(chatId).settings;
    const book = this.selected<Lorebook>(settings.lorebookId, 'lorebooks');
    if (!book || book.id !== resolution.book.id || book.revision !== resolution.book.revision || this.loreState(chatId, book.id).epoch !== resolution.epoch) throw new AppError(409, 'stale_lore', message("errors.the_lorebook_selection_or_activation_state_changed_retry"));
  }
  saveLoreOperation(chatId: string, operationId: string, resolution: LoreResolution | null) {
    if (!resolution) return;
    this.sqlite.transaction(() => {
      this.assertLoreCurrent(chatId, resolution);
      this.sqlite.prepare('INSERT INTO lore_operations (operation_id, chat_id, resolution) VALUES (?, ?, ?) ON CONFLICT(operation_id) DO NOTHING').run(operationId, chatId, JSON.stringify(resolution));
    })();
  }
  loreOperation(operationId: string): LoreResolution | null {
    const row = this.sqlite.prepare('SELECT resolution FROM lore_operations WHERE operation_id = ?').get(operationId) as { resolution: string } | undefined;
    // This table contains only resolver results captured by saveLoreOperation.
    return row ? JSON.parse(row.resolution) as LoreResolution : null;
  }
  replaceLoreOperation(chatId: string, operationId: string, resolution: LoreResolution | null) {
    if (resolution) this.assertLoreCurrent(chatId, resolution);
    this.sqlite.prepare('DELETE FROM lore_operations WHERE operation_id = ? AND chat_id = ?').run(operationId, chatId);
    this.saveLoreOperation(chatId, operationId, resolution);
  }
  private commitLoreState(chatId: string, resolution: LoreResolution) {
    this.assertLoreCurrent(chatId, resolution);
    const state = this.loreState(chatId, resolution.book.id);
    if (JSON.stringify(state.entries) !== JSON.stringify(resolution.stateBefore)) throw new AppError(409, 'stale_lore_state', message("errors.lore_activation_state_changed_before_the_response_completed"));
    this.sqlite.prepare('INSERT INTO lore_states (chat_id, book_id, epoch, data) VALUES (?, ?, ?, ?) ON CONFLICT(chat_id, book_id) DO UPDATE SET epoch = excluded.epoch, data = excluded.data').run(chatId, resolution.book.id, resolution.epoch, JSON.stringify({ ...state.entries, ...resolution.stateDelta }));
  }
  private checkDeletableLibraryItem(kind: LibraryKind, id: string) {
    if (kind === 'prompts' && id === 'default') throw new AppError(409, 'default_prompt', message("errors.the_default_prompt_can_be_edited_or_restored"));
    if (kind === 'contexts' && id === 'default-context') throw new AppError(409, 'default_context', message("errors.default_context_cannot_be_deleted"));
    const target = libraryItemLabels(this.db, kind, id)[0];
    if (!target) throw new AppError(404, 'item_not_found', message(kind === 'connections' ? 'errors.connection_not_found' : 'errors.library_item_not_found'));
    return target;
  }
  private removeLibraryItem(kind: LibraryKind, id: string) {
    if (kind === 'connections') this.db.delete(schema.credentials).where(eq(schema.credentials.id, id)).run();
    const deleted = kind === 'connections'
      ? this.db.delete(schema.connections).where(eq(schema.connections.id, id)).run()
      : this.db.delete(schema.library).where(and(eq(schema.library.id, id), eq(schema.library.kind, kind))).run();
    if (deleted.changes !== 1) throw new Error('Library deletion did not remove its target.');
  }
  private finishLibraryDeletion() {
    this.pictures.cleanup();
    this.bumpLibrary();
  }
  deleteLibrary(expected: number, kind: LibraryKind, id: string) {
    this.sqlite.transaction(() => {
      this.checkLibrary(expected);
      this.checkDeletableLibraryItem(kind, id);
      const dependencies = resolveLibraryDependencies(this.db, kind, id);
      if (kind === 'lorebooks' && hasLibraryDependencies(dependencies)) {
        const uses = [...dependencies.characters.map(card => `character “${card.name}”`),
          ...dependencies.chats.map(chat => `chat “${chat.name}”`)];
        throw new AppError(409, 'item_in_use', message('errors.this_lorebook_is_used_by_choose_none_or', { value: uses.join(', ') }));
      }
      if (hasLibraryDependencies(dependencies)) {
        throw new AppError(409, 'item_in_use', message(dependencies.contexts.length && !dependencies.chats.some(chat => chat.direct)
          ? 'errors.a_context_preset_uses_this_summarization_connection_change' : 'errors.select_a_different_item_in_the_chats_using'));
      }
      this.removeLibraryItem(kind, id);
      this.finishLibraryDeletion();
    })();
  }
  newChatDefaults(settings: ChatDefaultsStatus['settings']) {
    return resolveChatDefaults(settings, this.chatDefaultItems());
  }
  private chatDefaultItems() {
    return {
      connections: libraryItemLabels(this.db, 'connections'),
      prompts: libraryItemLabels(this.db, 'prompts'),
      contexts: libraryItemLabels(this.db, 'contexts'),
    };
  }
  private deletionBookmark(kind: LibraryKind, id: string, defaults: () => ChatDefaultsStatus['settings']) {
    if (kind !== 'connections' && kind !== 'prompts' && kind !== 'contexts') return null;
    const settings = defaults();
    if (settings[kind] !== id) return null;
    const items = this.chatDefaultItems();
    items[kind] = items[kind].filter(item => item.id !== id);
    const { connectionId, promptId, contextPresetId } = resolveChatDefaults(settings, items);
    const fallbackId = kind === 'connections' ? connectionId : kind === 'prompts' ? promptId : contextPresetId;
    const fallback = items[kind].find(item => item.id === fallbackId);
    return { fallback: fallback ? { id: fallback.id, name: fallback.name } : null };
  }
  private characterDeletionLorebook(characterId: string) {
    const row = this.db.select({
      lorebookId: sql<string | null>`json_extract(${schema.library.data}, '$.lorebookId')`,
    }).from(schema.library).where(eq(schema.library.id, characterId)).get();
    if (!row?.lorebookId) return undefined;
    const book = libraryItemLabels(this.db, 'lorebooks', row.lorebookId)[0];
    if (!book) return undefined;
    const uses = resolveLibraryDependencies(this.db, 'lorebooks', book.id);
    const inUse = uses.chats.length > 0 || uses.characters.some(character => character.id !== characterId);
    return { book, inUse };
  }
  private resolveLibraryDeletion(kind: LibraryKind, id: string, choice: LibraryDeletionChoice, settings: () => ChatDefaultsStatus['settings'], includeReplacements: boolean, coordinatingWork: boolean) {
    const target = this.checkDeletableLibraryItem(kind, id);
    const dependencies = resolveLibraryDependencies(this.db, kind, id);
    const labels = dependencies.chats.flatMap(chat => chat.branches.map(({ id, branchName }) => ({
      id, branchName, name: chat.name,
    })));
    const blockers: LibraryDeletionReview['blockers'] = [];
    const actionBlockers: LibraryDeletionReview['action']['blockers'] = [];
    const linkedLorebook = kind === 'characters' ? this.characterDeletionLorebook(id) : undefined;
    if (choice.deleteLorebookId && (choice.deleteLorebookId !== linkedLorebook?.book.id || linkedLorebook.inUse)) {
      actionBlockers.push({ reason: 'lorebook_unavailable', branches: [] });
    }
    if (coordinatingWork || this.generationRunning() || this.contexts.running()) {
      blockers.push({ reason: 'busy', branches: labels.filter(branch => this.generationRunning(branch.id) || this.contexts.running(branch.id)) });
    }
    const repairs = labels.filter(branch => this.contexts.hasOpenLayoutReview(branch.id));
    if (repairs.length) blockers.push({ reason: 'repair', branches: repairs });

    const replacementId = choice.mode === 'replace' ? choice.replacementId : kind === 'prompts' && dependencies.chats.length ? 'default' : null;
    const replacement = replacementId && replacementId !== id ? libraryItemLabels(this.db, kind, replacementId)[0] : undefined;
    if ((replacementId && !replacement) || (choice.mode === 'replace' && !hasLibraryDependencies(dependencies))) {
      actionBlockers.push({ reason: 'replacement', branches: [] });
    }
    const memory = kind === 'contexts' ? labels.map(branch => ({ ...branch, ...this.contexts.selectionCheckpoint(branch.id) })) : [];
    const previous = kind === 'contexts' ? this.contextPreset(id) : null;
    const next = kind === 'contexts' && replacement ? this.contextPreset(replacement.id) : null;
    const layout = next && changedMemoryShape(previous, next) ? memory.map(branch => {
      const { before, cleanup } = this.shapeLayoutReview(branch.id, next);
      const altersCoverage = !isDeepStrictEqual(before.selected, cleanup.after.selected)
        || !isDeepStrictEqual(before.archivedTurnIds, cleanup.after.archivedTurnIds);
      return { id: branch.id, deletedIds: [...cleanup.deletedIds].sort(), altersCoverage };
    }) : [];
    if (kind === 'contexts' && choice.mode === 'clear') {
      const excluded = new Set(memory.filter(branch => branch.archivedCount > 0).map(branch => branch.id));
      if (excluded.size) actionBlockers.push({ reason: 'excluded', branches: labels.filter(branch => excluded.has(branch.id)) });
    }
    const layoutChanges = new Set(layout.filter(branch => branch.deletedIds.length || branch.altersCoverage).map(branch => branch.id));
    if (layoutChanges.size) actionBlockers.push({ reason: 'layout', branches: labels.filter(branch => layoutChanges.has(branch.id)) });

    const bookmark = this.deletionBookmark(kind, id, settings);
    const version = this.libraryCommandFingerprint([
      'library-deletion-v1', datasetEpoch(this.sqlite), kind, target, dependencies, memory, bookmark,
      ...(linkedLorebook ? [linkedLorebook] : []),
    ]);
    const token = this.libraryCommandFingerprint([version, choice, replacement, layout, actionBlockers]);
    const named = ({ id, name }: { id: string; name: string }) => ({ id, name });
    const review: LibraryDeletionReview = {
      target: named(target), version, bookmark, blockers,
      ...(linkedLorebook && { linkedLorebook: { ...named(linkedLorebook.book), inUse: linkedLorebook.inUse } }),
      dependencies: {
        chats: dependencies.chats.map(({ id, name, direct, memoryPreset }) => ({ id, name, direct, memoryPreset: memoryPreset && named(memoryPreset) })),
        characters: dependencies.characters.map(named), contexts: dependencies.contexts.map(named),
      },
      replacements: includeReplacements && hasLibraryDependencies(dependencies)
        ? libraryItemLabels(this.db, kind).filter(item => item.id !== id).map(named) : [],
      action: { choice, token, blockers: actionBlockers },
    };
    return { review, dependencies, replacementId };
  }
  reviewLibraryDeletion(kind: LibraryKind, id: string, choice: LibraryDeletionChoice, settings: () => ChatDefaultsStatus['settings'], coordinatingWork = false) {
    return this.sqlite.transaction(() => this.resolveLibraryDeletion(kind, id, choice, settings, true, coordinatingWork).review)();
  }
  commitLibraryDeletion(id: string, command: LibraryDeletionCommand, settings: () => ChatDefaultsStatus['settings'], hasCoordinatingWork: () => boolean = () => false) {
    const transaction = { phase: 'receipt' as 'receipt' | 'mutation' | 'commit' };
    try {
      return this.sqlite.transaction(() => {
        const { kind, requestId, token, choice } = command;
        const fingerprint = this.libraryCommandFingerprint(['library-deletion-v1', datasetEpoch(this.sqlite), kind, id, token, choice]);
        const recorded = this.recordedLibraryCommand(requestId, fingerprint, libraryDeletionResultSchema.parse, undefined,
          message('errors.that_request_identity_was_already_used_for_a'));
        if (recorded.found) return { result: recorded.result, affectedBranches: [] };
        transaction.phase = 'mutation';
        const { review, dependencies, replacementId } = this.resolveLibraryDeletion(kind, id, choice, settings, false, hasCoordinatingWork());
        if (review.action.token !== token) throw new AppError(409, 'library_deletion_stale', message('library_delete.stale'));
        const blocker = [...review.blockers, ...review.action.blockers][0];
        if (blocker) throw new AppError(409, 'library_deletion_blocked', message(`library_delete.${blocker.reason}`));
        this.applyLibraryDeletionSelections(kind, dependencies, replacementId);
        if (hasLibraryDependencies(resolveLibraryDependencies(this.db, kind, id))) {
          throw new AppError(409, 'library_deletion_stale', message('library_delete.stale'));
        }
        this.removeLibraryItem(kind, id);
        if (choice.deleteLorebookId) {
          if (hasLibraryDependencies(resolveLibraryDependencies(this.db, 'lorebooks', choice.deleteLorebookId))) {
            throw new AppError(409, 'library_deletion_stale', message('library_delete.stale'));
          }
          this.removeLibraryItem('lorebooks', choice.deleteLorebookId);
        }
        this.finishLibraryDeletion();
        const result = { ok: true } as const;
        this.sqlite.prepare('INSERT INTO lore_commands (request_id, command, result) VALUES (?, ?, ?)').run(requestId, fingerprint, JSON.stringify(result));
        transaction.phase = 'commit';
        return { result, affectedBranches: dependencies.chats.flatMap(chat => chat.branches.map(branch => branch.id)) };
      }).immediate();
    } catch (error) {
      // A failed receipt lookup or an error from COMMIT cannot establish that
      // this command never committed. Preserve the client's exact retry.
      if (transaction.phase !== 'mutation' || error instanceof AppError && error.status < 500) throw error;
      const failure = new AppError(500, 'library_deletion_rolled_back', message('library_delete.rollback'));
      failure.cause = error;
      throw failure;
    }
  }
  private applyLibraryDeletionSelections(kind: LibraryKind, dependencies: ReturnType<typeof resolveLibraryDependencies>, replacementId: string | null) {
    for (const { id, direct, branches } of dependencies.chats) {
      if (!direct) {
        this.touchSharedChat(id);
        continue;
      }
      const group = this.db.select().from(schema.chatGroups).where(eq(schema.chatGroups.id, id)).get();
      if (!group) throw new AppError(409, 'library_deletion_stale', message('library_delete.stale'));
      const settings = { ...group.settings, [selectionKeys[kind]]: replacementId };
      this.writeSharedChatSelections(id, group.settings, settings, branches.map(branch => branch.id));
    }
    for (const { id, revision } of dependencies.contexts) {
      this.updateLibraryRecord(id, sql`json_set(${schema.library.data}, '$.connectionId', ${replacementId})`, revision + 1);
    }
    for (const { id } of dependencies.characters) {
      // The default is local metadata. Existing chat selections and Character
      // content revisions stay authoritative.
      this.updateLibraryRecord(id, sql`json_set(${schema.library.data}, '$.lorebookId', ${replacementId})`);
    }
  }
  private validateSelections(settings: ReturnType<typeof selectionsSchema.parse>) {
    if (settings.connectionId && !this.db.select().from(schema.connections).where(eq(schema.connections.id, settings.connectionId)).get()) throw new AppError(422, 'missing_connection', message("errors.selected_connection_not_found"));
    this.selected(settings.promptId, 'prompts'); this.selected(settings.characterId, 'characters'); this.selected(settings.personaId, 'personas');
    this.contextPreset(settings.contextPresetId);
    this.selected(settings.lorebookId, 'lorebooks');
  }
  private insertNewChat(input: ReturnType<typeof selectionsSchema.parse>) {
    this.validateSelections(input);
    const card = this.selected<Character>(input.characterId, 'characters');
    const lorebookId = input.lorebookId === undefined ? card?.lorebookId ?? null : input.lorebookId;
    this.selected(lorebookId, 'lorebooks');
    const id = randomUUID();
    this.insertChat(id, { ...initialSettings, ...input, lorebookId });
    return { id, card };
  }
  createChat(input: ReturnType<typeof selectionsSchema.parse>) {
    return this.sqlite.transaction(() => {
      const { id, card } = this.insertNewChat(input);
      const persona = this.selected<Persona>(input.personaId, 'personas');
      const alternateGreetings = readCharacterAlternateGreetings(card ?? {});
      if (!alternateGreetings.success) throw new AppError(422, 'invalid_alternate_greetings', message("errors.this_character_has_invalid_preserved_alternate_greetings_open"));
      const greetings = card ? [card.first_mes, ...alternateGreetings.data]
        .map(text => trimBoundaryNewlines(replaceNameMacros(text, persona?.name ?? 'You', card.name)))
        .filter(text => text.trim().length > 0) : [];
      const [greeting, ...alternatives] = greetings;
      if (greeting !== undefined) this.insertTurn(id, 1, { user: '', assistant: greeting, complete: true }, alternatives);
      this.bumpLibrary(); return id;
    })();
  }
  updateChat(expected: number, chatId: string, input: ReturnType<typeof selectionsSchema.parse>, memoryImpactToken?: string) {
    this.sqlite.transaction(() => {
      this.checkRevision(expected, chatId); this.ensureIdle(chatId); this.validateSelections(input);
      const previous = this.chat(chatId).settings;
      const settings = { ...previous, ...input, instructions: '', character: '', persona: '' };
      this.saveSharedSettings(chatId, settings, memoryImpactToken);
      // Lorebook usage labels and links are cached with the library revision.
      if (settings.title !== previous.title || settings.lorebookId !== previous.lorebookId) this.bumpLibrary();
    })();
  }
  authorNote(chatId: string): AuthorNoteStatus {
    const chat = this.chat(chatId);
    return { revision: chat.revision, settings: chat.settings.authorNote ?? defaultAuthorNote };
  }
  saveAuthorNote(chatId: string, input: AuthorNoteStatus): AuthorNoteStatus {
    const note = authorNoteSchema.parse(input.settings);
    return this.sqlite.transaction(() => {
      this.checkRevision(input.revision, chatId);
      this.ensureIdle(chatId);
      const chat = this.chat(chatId);
      const previous = chat.settings.authorNote ?? defaultAuthorNote;
      if (isDeepStrictEqual(previous, note)) return this.authorNote(chatId);
      this.db.update(schema.chats).set({ settings: { authorNote: note }, updatedAt: new Date().toISOString() })
        .where(eq(schema.chats.id, chatId)).run();
      this.bumpRevision(chatId);
      return this.authorNote(chatId);
    })();
  }
  deleteChat(expected: number, chatId: string, branches?: { id: string; revision: number }[]) {
    this.sqlite.transaction(() => {
      this.checkRevision(expected, chatId); this.ensureIdle(chatId);
      const { groupId } = this.chat(chatId);
      const siblings = this.siblingIds(groupId);
      if (siblings.length > 1 || branches !== undefined) {
        const revisions = new Map(branches?.map(branch => [branch.id, branch.revision]));
        if (revisions.size !== siblings.length || siblings.some(id => revisions.get(id) !== this.chat(id).revision)) {
          throw new AppError(409, 'branch_list_changed', message('branches.delete_stale'));
        }
      }
      for (const id of siblings) this.ensureIdle(id);
      this.db.delete(schema.chatGroups).where(eq(schema.chatGroups.id, groupId)).run();
      this.bumpLibrary();
    })();
  }
  private checkBranchIdle(chatId: string) {
    this.ensureIdle(chatId);
    if (this.sqlite.prepare("SELECT 1 FROM context_jobs WHERE chat_id = ? AND json_extract(data, '$.status') = 'awaiting_review'").get(chatId)) {
      throw new AppError(409, 'repair_awaits_review', message('errors.approve_or_discard_the_existing_repair_candidate_before'));
    }
  }
  forkSource(chatId: string, input: CopyBranch): { snapshot: EngineSnapshot; earlier: boolean } {
    this.checkRevision(input.revision, chatId);
    this.checkBranchIdle(chatId);
    const snapshot = this.engineSnapshot(chatId);
    if (!input.through) return { snapshot, earlier: false };
    const position = snapshot.turns.findIndex(turn => turn.id === input.through && turn.complete);
    if (position < 0) throw new AppError(409, 'fork_turn_unavailable', message('branches.turn_unavailable'));
    if (position === snapshot.turns.length - 1) return { snapshot, earlier: false };
    const turns = snapshot.turns.slice(0, position + 1);
    return { earlier: true, snapshot: { ...snapshot, turns, context: contextAtFork(snapshot.context, turns), loreState: { epoch: 0, entries: {} } } };
  }
  private branchCommand(chatId: string, input: CopyBranch) {
    return JSON.stringify({ chatId, name: input.name, through: input.through ?? null });
  }
  private creationReceipt(requestId: string, fingerprint: string) {
    const row = this.sqlite.prepare('SELECT command, result FROM branch_commands WHERE id = ?').get(requestId);
    if (row === undefined) return null;
    const record = z.object({ command: z.string(), result: z.string() }).parse(row);
    if (record.command !== fingerprint) throw new AppError(409, 'request_id_conflict', message('errors.that_request_identity_was_already_used_for_a'));
    return record.result;
  }
  copiedBranch(chatId: string, input: CopyBranch) {
    return this.creationReceipt(input.requestId, this.branchCommand(chatId, input));
  }
  commitBranch(chatId: string, input: CopyBranch, source: ReturnType<Store['forkSource']>, state: ContextState) {
    return this.sqlite.transaction(() => {
      const existing = this.copiedBranch(chatId, input);
      if (existing) return existing;
      this.checkRevision(input.revision, chatId);
      this.checkBranchIdle(chatId);
      const chat = this.chat(chatId);
      const id = randomUUID();
      this.db.insert(schema.chats).values({ id, groupId: chat.groupId, branchName: input.name,
        revision: chat.revision, settings: { authorNote: chat.settings.authorNote } }).run();
      copyBranchContent(this.sqlite, source.snapshot, id, state, source.earlier);
      this.sqlite.prepare('INSERT INTO branch_commands VALUES (?, ?, ?)').run(input.requestId, this.branchCommand(chatId, input), id);
      this.bumpLibrary();
      return id;
    })();
  }
  renameBranch(chatId: string, revision: number, name: string) {
    this.sqlite.transaction(() => {
      this.checkRevision(revision, chatId);
      this.ensureIdle(chatId);
      this.db.update(schema.chats).set({ branchName: name }).where(eq(schema.chats.id, chatId)).run();
      this.bumpRevision(chatId);
      this.bumpLibrary();
    })();
  }
  deleteBranch(chatId: string, revision: number) {
    return this.sqlite.transaction(() => {
      this.checkRevision(revision, chatId);
      this.checkBranchIdle(chatId);
      const sibling = this.siblingIds(this.chat(chatId).groupId).find(id => id !== chatId);
      if (!sibling) throw new AppError(409, 'last_branch', message('branches.last_branch'));
      this.db.delete(schema.chats).where(eq(schema.chats.id, chatId)).run();
      this.bumpLibrary();
      return sibling;
    })();
  }
  private insertTurn(chatId: string, position: number, turn: ImportedTurn, alternatives: string[] = []) {
    const id = randomUUID(), variantId = turn.complete ? `original-${id}` : null;
    this.db.insert(schema.turns).values({ id, chatId, position, complete: turn.complete,
      userId: randomUUID(), userRevision: 0, userText: turn.user, assistantId: randomUUID(), assistantRevision: alternatives.length, assistantText: turn.assistant, selectedVariantId: variantId }).run();
    if (variantId) {
      const revisions = new Map<string, number>();
      // Reserve distinct content revisions before any edit/selection can advance
      // the assistant revision. Equal greetings may share a content baseline.
      for (const [index, text] of [turn.assistant, ...alternatives].entries()) {
        const sourceRevision = revisions.get(text) ?? index;
        revisions.set(text, sourceRevision);
        this.db.insert(schema.responseVariants).values({ id: index === 0 ? variantId : randomUUID(), turnId: id, text, sourceRevision, generationId: null, createdAt: '' }).run();
      }
    }
  }
  importChat(input: ImportChat, resolveSettings: () => ReturnType<typeof selectionsSchema.parse>) {
    return this.commitTranscriptImport(input, ['chat', input.title, input.characterId, input.personaId],
      () => this.insertNewChat(resolveSettings()).id);
  }
  importBranch(groupId: string, input: ImportBranch) {
    return this.commitTranscriptImport(input, ['branch', groupId, input.name], () => {
      const group = this.db.select({ id: schema.chatGroups.id }).from(schema.chatGroups).where(eq(schema.chatGroups.id, groupId)).get();
      if (!group) throw new AppError(404, 'chat_not_found', message('errors.chat_not_found'));
      // The branch uses the group's live settings. No source branch state or
      // revision participates, so adding it can coexist with sibling work.
      const id = randomUUID();
      this.db.insert(schema.chats).values({ id, groupId, branchName: input.name, revision: 0, settings: {} }).run();
      return id;
    });
  }
  private commitTranscriptImport({ requestId, turns }: ImportChat | ImportBranch, destination: (string | null)[], create: () => string) {
    const digest = createHash('sha256');
    for (const { user, assistant, complete } of turns) digest.update(JSON.stringify([user, assistant, complete])).update('\n');
    const fingerprint = `transcript:${createHash('sha256').update(JSON.stringify([...destination, digest.digest('hex')])).digest('hex')}`;
    return this.sqlite.transaction(() => {
      const existing = this.creationReceipt(requestId, fingerprint);
      if (existing) {
        this.chat(existing);
        return { id: existing, created: false };
      }
      const id = create();
      turns.forEach((turn, i) => this.insertTurn(id, i + 1, turn));
      this.sqlite.prepare('INSERT INTO branch_commands VALUES (?, ?, ?)').run(requestId, fingerprint, id);
      this.bumpLibrary();
      return { id, created: true };
    })();
  }
  saveSettings(expected: number, connection: Connection, settings: ChatSettings, apiKey?: string, chatId = 'main', memoryImpactToken?: string) {
    this.sqlite.transaction(() => {
      this.checkRevision(expected, chatId); this.ensureIdle();
      this.selected(settings.promptId, 'prompts'); this.selected(settings.characterId, 'characters'); this.selected(settings.personaId, 'personas');
      this.contextPreset(settings.contextPresetId);
      this.selected(settings.lorebookId, 'lorebooks');
      const { groupId, settings: previous } = this.chat(chatId);
      const connectionId = settings.connectionId ?? 'main';
      const old = this.db.select().from(schema.connections).where(eq(schema.connections.id, connectionId)).get();
      this.db.insert(schema.connections).values({ id: connectionId, settings: connection, revision: (old?.revision ?? -1) + 1 }).onConflictDoUpdate({ target: schema.connections.id, set: { updatedAt: new Date().toISOString(), settings: connection, revision: (old?.revision ?? -1) + 1 } }).run();
      if (apiKey !== undefined) this.db.insert(schema.credentials).values({ id: connectionId, apiKey }).onConflictDoUpdate({ target: schema.credentials.id, set: { apiKey } }).run();
      this.saveSharedSettings(chatId, { ...settings, authorNote: settings.authorNote ?? previous.authorNote, connectionId,
        lorebookId: settings.lorebookId === undefined ? previous.lorebookId ?? null : settings.lorebookId,
        contextPresetId: settings.contextPresetId === undefined ? previous.contextPresetId ?? null : settings.contextPresetId }, memoryImpactToken);
      this.bumpAffected('connections', connectionId, groupId);
      this.bumpLibrary();
    })();
  }
  begin(expected: number, requestId: string, text?: string, chatId = 'main'): { id: string; fresh: boolean } {
    if (text !== undefined) {
      text = trimBoundaryNewlines(text);
      if (!text.trim()) throw new AppError(400, 'blank_input', message("errors.write_a_turn_before_sending_it"));
    }
    return this.sqlite.transaction(() => {
      const command = JSON.stringify({ kind: text === undefined ? 'retry' : 'submit', text });
      const existing = this.db.select().from(schema.generations).where(eq(schema.generations.requestId, requestId)).get();
      if (existing) {
        if (existing.command !== command || existing.chatId !== chatId) throw new AppError(409, 'request_id_conflict', message("errors.that_request_identity_was_already_used_for_a"));
        return { id: existing.id, fresh: false };
      }
      this.checkRevision(expected, chatId); this.ensureIdle(chatId);
      const snapshot = this.engineSnapshot(chatId);
      if (!snapshot.connection) throw new AppError(422, 'connection_required', message("errors.save_a_connection_before_sending_a_turn"));
      if (hasPromptMarker(snapshot.sources.prompt, 'summary')) assertRefusalSelection(snapshot.context);
      let turn = snapshot.turns.at(-1);
      if (text !== undefined) {
        if (turn && !turn.complete) throw new AppError(409, 'pending_turn', message("errors.resolve_or_delete_the_pending_turn_before_submitting"));
        this.insertTurn(chatId, (turn?.position ?? 0) + 1, { user: text, assistant: '', complete: false });
        turn = this.engineSnapshot(chatId).turns.at(-1);
      } else if (!turn || turn.complete) throw new AppError(409, 'no_pending_turn', message("errors.there_is_no_pending_turn_to_retry"));
      const id = randomUUID(), now = new Date().toISOString();
      this.db.insert(schema.generations).values({ id, chatId, requestId, command, turnId: turn!.id, status: 'running', sourceRevision: this.bumpRevision(chatId), request: null, partialText: '', error: null, createdAt: now, updatedAt: now }).run();
      return { id, fresh: true };
    })();
  }
  generation(id: string) { return this.db.select().from(schema.generations).where(eq(schema.generations.id, id)).get(); }
  beginCompletedResponse(expected: number, requestId: string, turnId: string, chatId: string, kind: 'regeneration' | 'continuation') {
    return this.sqlite.transaction(() => {
      const regenerating = kind === 'regeneration';
      const command = JSON.stringify({ kind: regenerating ? 'regenerate' : 'continue', turnId });
      const existing = this.db.select().from(schema.generations).where(eq(schema.generations.requestId, requestId)).get();
      if (existing) {
        if (existing.command !== command || existing.chatId !== chatId) throw new AppError(409, 'request_id_conflict', message("errors.that_request_identity_was_already_used_for_a"));
        return { id: existing.id, fresh: false };
      }
      this.checkRevision(expected, chatId);
      this.ensureIdle(chatId);
      const snapshot = this.engineSnapshot(chatId);
      if (hasPromptMarker(snapshot.sources.prompt, 'summary')) assertRefusalSelection(snapshot.context);
      const target = snapshot.turns.at(-1);
      if (regenerating && (!target?.complete || target.id !== turnId)) throw new AppError(409, 'latest_turn_only', message("errors.only_the_latest_completed_turn_can_be_regenerated"));
      if (!snapshot.connection) throw new AppError(422, 'connection_required', message(regenerating
        ? "errors.select_a_connection_before_regenerating_a_response" : 'continue.connection_required'));
      const context = regenerating ? regenerationView(snapshot).context : null;
      const continuationVariantId = regenerating ? null : continuationTarget(snapshot, turnId).variantId;
      const id = randomUUID(), now = new Date().toISOString();
      this.db.insert(schema.generations).values({ id, chatId, requestId, command, turnId, kind: regenerating ? 'regeneration' : 'response', status: 'running',
        continuationVariantId, sourceRevision: this.bumpRevision(chatId),
        contextSelection: context && { revision: context.revision, selected: context.selected, archivedTurnIds: context.archivedTurnIds },
        request: null, partialText: '', error: null, createdAt: now, updatedAt: now }).run();
      return { id, fresh: true };
    })();
  }
  beginRegeneration(expected: number, requestId: string, turnId: string, chatId: string) {
    return this.beginCompletedResponse(expected, requestId, turnId, chatId, 'regeneration');
  }
  generationSnapshot(id: string): EngineSnapshot {
    const generation = this.generation(id);
    if (!generation) throw new AppError(404, 'generation_not_found', message("errors.response_attempt_not_found"));
    const snapshot = this.engineSnapshot(generation.chatId);
    if (generation.continuationVariantId !== null) {
      const target = continuationTarget(snapshot, generation.turnId);
      if (target.variantId !== generation.continuationVariantId) throw new AppError(409, 'stale_result', message('continue.target_changed'));
      return { ...snapshot, continuationTurnId: target.id };
    }
    if (generation.kind !== 'regeneration') return snapshot;
    if (snapshot.turns.at(-1)?.id !== generation.turnId || !generation.contextSelection) throw new AppError(409, 'stale_result', message("errors.the_regeneration_endpoint_is_no_longer_available"));
    return regenerationView({ ...snapshot, context: { ...snapshot.context, ...generation.contextSelection } });
  }
  saveGenerationContext(id: string, state: Pick<ChatSnapshot['context'], 'revision' | 'selected' | 'archivedTurnIds'>) {
    const generation = this.generation(id);
    if (!generation || generation.kind !== 'regeneration' || generation.status !== 'running') throw new AppError(409, 'inactive_generation', message("errors.this_regeneration_is_no_longer_active"));
    this.checkRevision(generation.sourceRevision, generation.chatId);
    this.db.update(schema.generations).set({ contextSelection: { revision: state.revision, selected: state.selected, archivedTurnIds: state.archivedTurnIds } }).where(eq(schema.generations.id, id)).run();
  }
  setTurnPin(chatId: string, turnId: string, expected: number, pinned: boolean) {
    return this.sqlite.transaction(() => {
      this.checkRevision(expected, chatId);
      this.checkBranchIdle(chatId);
      const condition = and(eq(schema.turns.id, turnId), eq(schema.turns.chatId, chatId));
      const turn = this.db.select({ complete: schema.turns.complete, pinned: schema.turns.pinned }).from(schema.turns).where(condition).get();
      if (!turn?.complete) throw new AppError(409, 'pin_unavailable', message('pins.turn_unavailable'));
      if (turn.pinned === pinned) return expected;
      this.db.update(schema.turns).set({ pinned }).where(condition).run();
      return this.bumpRevision(chatId);
    })();
  }

  pinCount(chatId: string): number {
    return this.db.select({ count: sql<number>`count(*)` }).from(schema.turns)
      .where(and(eq(schema.turns.chatId, chatId), sql`${schema.turns.pinned} = 1`)).get()?.count ?? 0;
  }

  selectVariant(expected: number, turnId: string, variantId: string, chatId: string) {
    this.sqlite.transaction(() => {
      this.checkRevision(expected, chatId);
      this.ensureIdle(chatId);
      const turn = this.db.select().from(schema.turns).where(and(eq(schema.turns.id, turnId), eq(schema.turns.chatId, chatId))).get();
      const variant = this.db.select().from(schema.responseVariants).where(and(eq(schema.responseVariants.id, variantId), eq(schema.responseVariants.turnId, turnId))).get();
      if (!turn?.complete || !variant) throw new AppError(404, 'variant_not_found', message("errors.this_saved_response_is_not_available_for_the"));
      if (turn.selectedVariantId === variant.id) return;
      this.db.update(schema.turns).set({ selectedVariantId: variant.id, assistantText: variant.text, assistantRevision: turn.assistantRevision + 1 }).where(eq(schema.turns.id, turnId)).run();
      this.resetLoreEpoch(chatId);
      this.bumpRevision(chatId);
    })();
  }
  apiKey(chatId = 'main'): string {
    const id = this.chat(chatId).settings.connectionId ?? 'main';
    return this.db.select().from(schema.credentials).where(eq(schema.credentials.id, id)).get()?.apiKey ?? '';
  }
  connectionApiKey(id: string): string {
    if (!this.db.select().from(schema.connections).where(eq(schema.connections.id, id)).get()) throw new AppError(404, 'connection_not_found', message("errors.connection_not_found"));
    return this.db.select().from(schema.credentials).where(eq(schema.credentials.id, id)).get()?.apiKey ?? '';
  }
  connection(id: string): Connection {
    const row = this.db.select().from(schema.connections).where(eq(schema.connections.id, id)).get();
    if (!row) throw new AppError(422, 'missing_connection', message("errors.the_summarization_connection_is_missing"));
    return row.settings;
  }
  contextPreset(id: string | null | undefined) {
    const preset = this.selected<ContextPreset>(id, 'contexts');
    return preset ? { ...preset, repairPrompt: preset.repairPrompt ?? defaultContextPreset.repairPrompt } : null;
  }
  saveRequest(id: string, request: RequestPreview) {
    this.sqlite.transaction(() => {
      const generation = this.generation(id);
      if (!generation || generation.status !== 'running') throw new AppError(409, 'inactive_generation', message("errors.the_response_is_no_longer_active"));
      this.checkRevision(generation.sourceRevision, generation.chatId);
      if (request.lore) this.assertLoreCurrent(generation.chatId, request.lore);
      this.db.update(schema.generations).set({ request }).where(eq(schema.generations.id, id)).run();
    })();
  }
  checkpoint(id: string, partialText: string, reasoningText?: string) {
    if (this.generation(id)?.status !== 'running') return false;
    this.db.update(schema.generations).set({ partialText, ...(reasoningText !== undefined ? { reasoningText } : {}), updatedAt: new Date().toISOString() }).where(eq(schema.generations.id, id)).run(); return true;
  }
  finish(id: string, status: Exclude<GenerationStatus, 'running' | 'interrupted'>, text: string, error: string | LocalizedMessage | null = null, usage: TokenUsage | null = null, reasoningText?: string) {
    const outcome = outcomeMessage(error);
    return this.sqlite.transaction(() => {
      const generation = this.generation(id);
      if (!generation || generation.status !== 'running') return false;
      if (status === 'succeeded') {
        const regeneration = generation.kind === 'regeneration';
        const continuation = generation.continuationVariantId !== null;
        text = trimBoundaryNewlines(text);
        if (!text.trim()) throw new AppError(502, 'empty_response', message(continuation ? 'continue.empty_response' : regeneration
          ? "errors.the_model_returned_no_text_the_selected_response" : "errors.the_model_returned_no_text_the_turn_remains"));
        this.checkRevision(generation.sourceRevision, generation.chatId);
        const turn = this.db.select().from(schema.turns).where(eq(schema.turns.id, generation.turnId)).get();
        if (!turn || turn.chatId !== generation.chatId || turn.complete !== (regeneration || continuation)) {
          throw new AppError(409, 'stale_result', message("errors.the_turn_is_no_longer_awaiting_this_response"));
        }
        if (continuation && turn.selectedVariantId !== generation.continuationVariantId) throw new AppError(409, 'stale_result', message('continue.target_changed'));
        const reply = continuation ? appendContinuation(turn.assistantText, text) : text;
        if (continuation && reply.length > transcriptPartLimit) throw new AppError(422, 'continuation_too_long', message('continue.reply_too_long', { limit: transcriptPartLimit }));
        if (regeneration) {
          if (generation.request?.lore) this.assertLoreCurrent(generation.chatId, generation.request.lore);
          this.resetLoreEpoch(generation.chatId);
          if (generation.request?.lore) {
            const resolution = generation.request.lore;
            this.sqlite.prepare('INSERT INTO lore_states (chat_id, book_id, epoch, data) VALUES (?, ?, ?, ?)').run(generation.chatId, resolution.book.id, this.loreState(generation.chatId).epoch, JSON.stringify(resolution.stateDelta));
          }
        } else if (generation.request?.lore) this.commitLoreState(generation.chatId, generation.request.lore);
        const variantId = turn.selectedVariantId ? randomUUID() : `original-${turn.id}`;
        const equivalent = this.db.select({ sourceRevision: schema.responseVariants.sourceRevision })
          .from(schema.responseVariants).where(and(eq(schema.responseVariants.turnId, turn.id), eq(schema.responseVariants.text, reply))).get();
        this.db.insert(schema.responseVariants).values({ id: variantId, turnId: turn.id, text: reply, sourceRevision: equivalent?.sourceRevision ?? turn.assistantRevision + 1, generationId: id, createdAt: generation.createdAt }).run();
        this.db.update(schema.turns).set({ messageAt: new Date().toISOString(), assistantText: reply, assistantRevision: turn.assistantRevision + 1, complete: true, selectedVariantId: variantId }).where(eq(schema.turns.id, turn.id)).run();
      }
      this.db.update(schema.generations).set({ status, partialText: text, reasoningText: reasoningText ?? generation.reasoningText, error: outcome.error, errorMessage: outcome.errorMessage ?? null, usage, updatedAt: new Date().toISOString() }).where(eq(schema.generations.id, id)).run();
      this.bumpRevision(generation.chatId); return true;
    })();
  }
  recoverInterrupted() {
    this.sqlite.transaction(() => {
      const running = this.db.select().from(schema.generations).where(eq(schema.generations.status, 'running')).all();
      for (const [kind, key] of [['response', 'outcome.generationInterrupted'], ['regeneration', 'outcome.regenerationInterrupted'], ['continuation', 'continue.interrupted']] as const) {
        const diagnostic = message(key);
        this.db.update(schema.generations).set({ status: 'interrupted', error: diagnostic.fallback, errorMessage: diagnostic, updatedAt: new Date().toISOString() })
          .where(and(eq(schema.generations.status, 'running'), eq(schema.generationKind, kind))).run();
      }
      for (const id of new Set(running.map(g => g.chatId))) this.bumpRevision(id);
      this.contexts.recover();
    })();
  }
  editPart(expected: number, turnId: string, part: 'user' | 'assistant', text: string, chatId = 'main') {
    text = trimBoundaryNewlines(text);
    this.sqlite.transaction(() => {
      this.checkRevision(expected, chatId); this.ensureIdle(chatId);
      const turn = this.db.select().from(schema.turns).where(and(eq(schema.turns.id, turnId), eq(schema.turns.chatId, chatId))).get();
      if (!turn) throw new AppError(404, 'turn_not_found', message("errors.turn_not_found"));
      if (part === 'assistant' && !turn.complete) throw new AppError(409, 'pending_response', message("errors.a_pending_response_cannot_be_completed_by_editing"));
      this.db.update(schema.turns).set(part === 'user' ? { userText: text, userRevision: turn.userRevision + 1 } : { assistantText: text, assistantRevision: turn.assistantRevision + 1 }).where(eq(schema.turns.id, turnId)).run();
      if (part === 'assistant' && turn.selectedVariantId) this.db.update(schema.responseVariants).set({ text, sourceRevision: turn.assistantRevision + 1 }).where(eq(schema.responseVariants.id, turn.selectedVariantId)).run();
      this.resetLoreEpoch(chatId);
      this.bumpRevision(chatId);
    })();
  }
  private turnDeletionMemoryReview(turnId: string, chatId: string) {
    const turn = this.db.select({ id: schema.turns.id }).from(schema.turns).where(and(eq(schema.turns.id, turnId), eq(schema.turns.chatId, chatId))).get();
    if (!turn) throw new AppError(404, 'turn_not_found', message('errors.turn_not_found'));
    const latest = this.db.select({ id: schema.turns.id }).from(schema.turns).where(eq(schema.turns.chatId, chatId)).orderBy(desc(schema.turns.position)).get();
    const branches: MemoryLayoutReview[] = [];
    if (turn.id === latest?.id) {
      this.contexts.ensureLayoutReviewClosed(chatId);
      const before = this.contexts.savedState(chatId);
      if (before.summaries.length || before.archivedTurnIds.length) {
        const chat = this.chat(chatId);
        const turns = this.memoryTurnMembership(chatId);
        const minTail = this.contextPreset(chat.settings.contextPresetId)?.minTail ?? 0;
        branches.push(this.layoutReview(chat, before, shortenedMemoryLayout(before, turns, minTail)));
      }
    }
    return this.describeMemoryImpact(branches, ['delete-turn', chatId, turnId]);
  }
  turnDeletionMemoryImpact(expected: number, turnId: string, chatId = 'main') {
    return this.sqlite.transaction(() => {
      this.checkRevision(expected, chatId); this.ensureIdle(chatId);
      return this.turnDeletionMemoryReview(turnId, chatId).impact;
    })();
  }
  deleteTurn(expected: number, turnId: string, chatId = 'main', memoryImpactToken?: string) {
    this.sqlite.transaction(() => {
      this.checkRevision(expected, chatId); this.ensureIdle(chatId);
      const review = this.turnDeletionMemoryReview(turnId, chatId);
      assertMemoryImpact(review.impact, memoryImpactToken);
      this.applyMemoryLayoutReviews(review.branches);
      this.sqlite.prepare('DELETE FROM lore_operations WHERE chat_id = ? AND operation_id IN (SELECT id FROM generations WHERE chat_id = ? AND turn_id = ?)').run(chatId, chatId, turnId);
      if (!this.db.delete(schema.turns).where(and(eq(schema.turns.id, turnId), eq(schema.turns.chatId, chatId))).run().changes) throw new AppError(404, 'turn_not_found', message("errors.turn_not_found"));
      this.resetLoreEpoch(chatId);
      this.bumpRevision(chatId);
    })();
  }
  close() {
    if (!this.sqlite.open) return;
    this.sqlite.prepare('DELETE FROM runtime_owner WHERE id = 1 AND token = ?').run(this.ownerToken); this.sqlite.close();
  }
}
