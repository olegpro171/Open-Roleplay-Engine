import { message } from '../shared/localization.js';
import { PictureStore } from './picture-store.js';
import type { PictureImportIntent } from '../shared/pictures.js';
import type { PreparedPicture } from './picture-data.js';
import type { CharacterSaveCommand } from '../shared/library.js';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { savePreUpgradeSnapshot } from './schema-backup.js';
import { databaseSchemaVersion } from '../shared/build-info.js';
import { AppError } from '../core/errors.js';
import { MessageError, outcomeMessage, type LocalizedMessage } from '../shared/localization.js';
import { replaceNameMacros } from '../core/prompt.js';
import type { ChatSettings, ChatSnapshot, Connection, Generation, GenerationStatus, RequestPreview, ResponseVariant, TokenUsage, Turn } from '../shared/contracts.js';
import { regenerationView } from '../core/regeneration.js';
import { assertRefusalSelection } from '../core/summary-refusals.js';
import { hasPromptMarker } from '../shared/library.js';
import { readCharacterAlternateGreetings, characterLabel, characterSchema, libraryCharacterSchema, libraryPersonaSchema, personaSchema, defaultPrompt, defaultInstructions, selectionsSchema, type Character, type LibraryCharacter, type LibraryPersona, type ChatSummary, type ImportedTurn, type LibraryKind, type LibrarySnapshot, type Persona, type PromptPreset, type Saved, type UnchangedLibrary, type PromptSources } from '../shared/library.js';
import { lorebookSchema, loreDiagnosticSchema, type Lorebook, type LoreImportPreview, type LoreResolution, type LoreState } from '../shared/lorebook.js';
import { importLorebook, loreCompatibility, markLoreEdits } from '../core/lorebook-formats.js';
import { importCharacter } from '../core/cards.js';
import { semanticFingerprint, unchangedLoreEntries } from '../core/lorebook.js';
import * as schema from './schema.js';
import * as legacyLibrarySchema from './legacy-library-schema.js';
import { trimBoundaryNewlines } from '../shared/text.js';
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

function parseImport<T>(parse: () => T): T {
  try { return parse(); }
  catch (error) {
    if (error instanceof z.ZodError || error instanceof AppError) throw error;
    throw new AppError(400, 'invalid_lorebook', error instanceof MessageError ? error.localized : error instanceof Error ? error.message : message("errors.the_imported_lorebook_could_not_be_read"));
  }
}

const initialSettings: ChatSettings = {
  title: 'A new story', instructions: defaultInstructions,
  character: '', persona: '', targetInputTokens: 32_000,
  connectionId: null, promptId: 'default', characterId: null, personaId: null,
  contextPresetId: null,
  lorebookId: null,
};

export class Store {
  readonly sqlite: Database.Database;
  readonly db;
  readonly contexts: ContextStore;
  readonly tags: TagStore;
  readonly pictures: PictureStore;
  private readonly ownerToken = randomUUID();

  constructor(filename: string, migrationsDirectory = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../../migrations/' : '../../../migrations/', import.meta.url)), options: { mustExist?: boolean } = {}) {
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
          if (alive) throw new Error('Another server is already using this database. Stop it before starting another.');
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
      if (version !== 15) throw new Error('Unsupported database schema version.');
      this.pictures = new PictureStore(this.sqlite, () => this.bumpLibrary());
      this.contexts = new ContextStore(this);
      this.tags = new TagStore(this.sqlite, expected => this.checkLibrary(expected), () => this.bumpLibrary());
      if (newDatabase) this.db.update(schema.library).set({ createdAt: new Date().toISOString() }).run();
      if (newDatabase) this.db.insert(schema.chats).values({ id: 'main', revision: 0, settings: initialSettings }).onConflictDoNothing().run();
    } catch (error) {
      this.sqlite.prepare('DELETE FROM runtime_owner WHERE token = ?').run(this.ownerToken);
      this.sqlite.close(); throw error;
    }
  }

  private chat(chatId: string) {
    const row = this.db.select({ id: schema.chats.id, revision: schema.chats.revision, settings: schema.chats.settings }).from(schema.chats).where(eq(schema.chats.id, chatId)).get();
    if (!row) throw new AppError(404, 'chat_not_found', message("errors.chat_not_found"));
    return row;
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
    const connectionId = chat.settings.connectionId === undefined ? 'main' : chat.settings.connectionId;
    const connection = connectionId ? this.db.select().from(schema.connections).where(eq(schema.connections.id, connectionId)).get()?.settings ?? null : null;
    const hasApiKey = Boolean(connectionId && this.db.select().from(schema.credentials).where(eq(schema.credentials.id, connectionId)).get()?.apiKey);
    return {
      id: chatId, revision: chat.revision,
      settings: { ...chat.settings, lorebookId: chat.settings.lorebookId ?? null }, connection, hasApiKey,
      sources: {
        prompt: this.selected<PromptPreset>(chat.settings.promptId, 'prompts'),
        character: this.selected<Character>(chat.settings.characterId, 'characters'),
        persona: this.selected<Persona>(chat.settings.personaId, 'personas'),
        lorebook: this.selected<Lorebook>(chat.settings.lorebookId, 'lorebooks'),
      },
    };
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
        user: { id: row.userId, revision: row.userRevision, text: row.userText },
        assistant: { id: row.assistantId, revision: row.assistantRevision, text: row.assistantText,
          ...(selected ? { variantId: selected.id, sourceRevision: selected.sourceRevision } : {}) },
        variants: responses,
      };
    });
  }
  snapshot(chatId = 'main'): ChatSnapshot {
    const header = this.chatHeader(chatId);
    const turns = this.readTurns(chatId);
    const generations: Generation[] = this.db.select({
      id: schema.generations.id, turnId: schema.generations.turnId, status: schema.generations.status,
      sourceRevision: schema.generations.sourceRevision, kind: schema.generations.kind,
      request: schema.generations.request, usage: schema.generations.usage, partialText: schema.generations.partialText,
      reasoningText: sql<string>`substr(${schema.generations.reasoningText}, -2000)`,
      error: schema.generations.error, errorMessage: schema.generations.errorMessage, createdAt: schema.generations.createdAt, updatedAt: schema.generations.updatedAt,
    }).from(schema.generations).where(eq(schema.generations.chatId, chatId)).orderBy(desc(sql`rowid`)).all().map(row => ({
      id: row.id, turnId: row.turnId, status: row.status, sourceRevision: row.sourceRevision, kind: row.kind,
      request: row.request, usage: row.usage, partialText: row.partialText, reasoningText: row.reasoningText, error: row.error, errorMessage: row.errorMessage, createdAt: row.createdAt, updatedAt: row.updatedAt,
    }));
    return { ...header, turns, generations, loreState: this.loreState(chatId, header.settings.lorebookId), context: this.contexts.snapshot(chatId, header.settings.contextPresetId ?? null) };
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
  ensureIdle(chatId?: string) {
    const condition = chatId ? and(eq(schema.generations.status, 'running'), eq(schema.generations.chatId, chatId)) : eq(schema.generations.status, 'running');
    if (this.db.select().from(schema.generations).where(condition).get()) throw new AppError(409, 'generation_running', message("errors.cancel_or_wait_for_the_current_response_before"));
    if (this.contexts.running(chatId)) throw new AppError(409, 'context_running', message("errors.stop_or_wait_for_memory_preparation_before_editing"));
  }
  bumpRevision(chatId = 'main') {
    const revision = this.chat(chatId).revision + 1;
    this.db.update(schema.chats).set({ revision }).where(eq(schema.chats.id, chatId)).run();
    return revision;
  }
  libraryRevision() { return (this.sqlite.prepare('SELECT revision FROM library_state WHERE id = 1').get() as { revision: number }).revision; }
  private checkLibrary(expected: number) {
    if (this.libraryRevision() !== expected) throw new AppError(409, 'revision_conflict', message("errors.the_library_changed_on_another_device_reopen_the"));
    this.ensureIdle();
  }
  private bumpLibrary() { this.sqlite.prepare('UPDATE library_state SET revision = revision + 1 WHERE id = 1').run(); }
  private bumpAffected(kind: LibraryKind, id: string) {
    const key = kind === 'personas' ? 'personaId' : kind === 'characters' ? 'characterId' : kind === 'prompts' ? 'promptId' : kind === 'contexts' ? 'contextPresetId' : kind === 'lorebooks' ? 'lorebookId' : 'connectionId';
    for (const chat of this.db.select().from(schema.chats).all()) if (chat.settings[key] === id || (kind === 'connections' && (id === 'main' && chat.settings.connectionId === undefined || this.contextPreset(chat.settings.contextPresetId)?.connectionId === id))) this.bumpRevision(chat.id);
  }
  private chatSummaries(): ChatSummary[] {
    return this.db.select().from(schema.chats).all().map(chat => ({ id: chat.id, title: chat.settings.title, characterId: chat.settings.characterId ?? null, revision: chat.revision,
      createdAt: chat.createdAt, updatedAt: chat.updatedAt,
      lastMessageAt: this.db.select({ date: sql<string | null>`max(${schema.turns.messageAt})` }).from(schema.turns).where(eq(schema.turns.chatId, chat.id)).get()?.date ?? null,
      turnCount: (this.sqlite.prepare('SELECT count(*) AS n FROM turns WHERE chat_id = ?').get(chat.id) as { n: number }).n,
      running: Boolean(this.db.select().from(schema.generations).where(and(eq(schema.generations.chatId, chat.id), eq(schema.generations.status, 'running'))).get()) || this.contexts.running(chat.id),
    }));
  }
  libraryUpdate(knownRevision?: number): LibrarySnapshot | UnchangedLibrary {
    const revision = this.libraryRevision();
    return knownRevision === revision ? { unchanged: true, revision, chats: this.chatSummaries() } : this.libraries();
  }
  libraries(): LibrarySnapshot {
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
      lorebookUses: list<Lorebook>('lorebooks').map(book => ({ bookId: book.id,
        characters: list<LibraryCharacter>('characters').filter(card => card.lorebookId === book.id).map(card => ({ id: card.id, name: card.name, ...(card.titleComment ? { titleComment: card.titleComment } : {}) })),
        chats: this.db.select().from(schema.chats).all().filter(chat => chat.settings.lorebookId === book.id).map(chat => ({ id: chat.id, title: chat.settings.title })),
      })),
      connections: this.db.select().from(schema.connections).all().map(r => ({ ...r.settings, id: r.id, revision: r.revision, hasApiKey: Boolean(this.db.select().from(schema.credentials).where(eq(schema.credentials.id, r.id)).get()?.apiKey) })),
      chats: this.chatSummaries(),
    };
  }
  saveLibrary(expected: number, kind: LibraryKind, data: LibraryCharacter | LibraryPersona | PromptPreset | ContextPreset | Connection | Lorebook, id?: string, apiKey?: string, tagIds?: string[]) {
    if (kind === 'prompts') data = upgradePrompt(data);
    return this.sqlite.transaction(() => {
      this.checkLibrary(expected);
      const identity = id ?? randomUUID();
      if (kind === 'contexts' && (data as ContextPreset).connectionId) this.connection((data as ContextPreset).connectionId!);
      if (kind === 'connections') {
        const old = this.db.select().from(schema.connections).where(eq(schema.connections.id, identity)).get();
        if (id && !old) throw new AppError(404, 'item_not_found', message("errors.connection_not_found"));
        this.db.insert(schema.connections).values({ id: identity, settings: data as Connection, revision: (old?.revision ?? -1) + 1 }).onConflictDoUpdate({ target: schema.connections.id, set: { updatedAt: new Date().toISOString(), settings: data as Connection, revision: (old?.revision ?? -1) + 1 } }).run();
        if (apiKey !== undefined) this.db.insert(schema.credentials).values({ id: identity, apiKey }).onConflictDoUpdate({ target: schema.credentials.id, set: { apiKey } }).run();
      } else {
        const old = this.db.select().from(schema.library).where(and(eq(schema.library.id, identity), eq(schema.library.kind, kind))).get();
        if (id && !old) throw new AppError(404, 'item_not_found', message("errors.library_item_not_found"));
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
          data = updated;
          if (previous && previous.name !== card.name) for (const chat of this.db.select().from(schema.chats).all()) if (chat.settings.characterId === identity) this.resetLoreEpoch(chat.id);
          if (old && previous && isDeepStrictEqual(this.comparableCharacter(previous), this.comparableCharacter(updated))) {
            const metadataChanged = !isDeepStrictEqual(old.data, data);
            if (metadataChanged) this.db.update(schema.library).set({ data }).where(eq(schema.library.id, identity)).run();
            const tagsChanged = tagIds !== undefined && this.tags.replaceInTransaction(identity, tagIds);
            if (metadataChanged || tagsChanged) {
              this.db.update(schema.library).set({ updatedAt: new Date().toISOString() }).where(eq(schema.library.id, identity)).run();
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
          if (previous && previous.name !== updated.name) for (const chat of this.db.select().from(schema.chats).all()) if (chat.settings.personaId === identity) this.resetLoreEpoch(chat.id);
          if (old && previous && isDeepStrictEqual(this.promptPersona(previous), this.promptPersona(updated))) {
            if (!isDeepStrictEqual(old.data, updated)) {
              this.db.update(schema.library).set({ data: updated, updatedAt: new Date().toISOString() }).where(eq(schema.library.id, identity)).run();
              this.bumpLibrary();
            }
            return identity;
          }
        }
        const saved = data as LibraryCharacter | LibraryPersona | PromptPreset | ContextPreset | Lorebook;
        this.db.insert(schema.library).values({ id: identity, kind, revision: (old?.revision ?? -1) + 1, data: saved }).onConflictDoUpdate({ target: schema.library.id, set: { updatedAt: new Date().toISOString(), data: saved, revision: (old?.revision ?? -1) + 1 } }).run();
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
  private recordedLibraryCommand<T>(requestId: string, fingerprint: string, parse: (value: unknown) => T, legacyFingerprint?: string | string[]): { found: false } | { found: true; result: T } {
    const existing = this.sqlite.prepare('SELECT command, result FROM lore_commands WHERE request_id = ?').get(requestId) as { command: string; result: string } | undefined;
    if (!existing) return { found: false };
    if (existing.command !== fingerprint && !(Array.isArray(legacyFingerprint) ? legacyFingerprint : [legacyFingerprint]).includes(existing.command)) throw new AppError(409, 'request_id_conflict', message("errors.this_import_identity_was_already_used_for_a"));
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
    const card = parseImport(() => importCharacter(value));
    const raw = z.record(z.string(), z.unknown()).parse(value);
    const data = raw.spec === 'chara_card_v2' || raw.spec === 'chara_card_v3' ? z.record(z.string(), z.unknown()).parse(raw.data) : raw;
    const book = data.character_book == null ? null : parseImport(() => importLorebook(data.character_book, randomUUID, raw.spec === 'chara_card_v3' ? 'v3' : 'v2'));
    return { card, book, tags: readEmbeddedTags(raw) };
  }
  previewCard(value: unknown): CharacterImportReview {
    const { card, book, tags } = this.analyzeCard(value);
    return { revision: this.libraryRevision(), name: card.name, description: card.description,
      book: book ? { name: book.book.name, entries: book.book.entries.length } : null,
      diagnostics: book?.diagnostics ?? [], tags: this.tags.review(tags) };
  }
  replayCard(requestId: string, value: unknown, policy: TagPolicy, artwork?: PictureImportIntent) {
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
      const preview = parseImport(() => importLorebook(data.character_book, randomUUID, raw.spec === 'chara_card_v3' ? 'v3' : 'v2'));
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
  deleteLibrary(expected: number, kind: LibraryKind, id: string) {
    this.sqlite.transaction(() => {
      this.checkLibrary(expected);
      if (kind === 'prompts' && id === 'default') throw new AppError(409, 'default_prompt', message("errors.the_default_prompt_can_be_edited_or_restored"));
      if (kind === 'contexts' && id === 'default-context') throw new AppError(409, 'default_context', message("errors.default_context_cannot_be_deleted"));
      const key = kind === 'personas' ? 'personaId' : kind === 'characters' ? 'characterId' : kind === 'prompts' ? 'promptId' : kind === 'contexts' ? 'contextPresetId' : kind === 'lorebooks' ? 'lorebookId' : 'connectionId';
      if (kind === 'lorebooks') {
        const uses = this.libraries().lorebookUses.find(use => use.bookId === id);
        if (uses && (uses.characters.length || uses.chats.length)) throw new AppError(409, 'item_in_use', message("errors.this_lorebook_is_used_by_choose_none_or", { value: String([...uses.characters.map(card => `character “${characterLabel(card)}”`), ...uses.chats.map(chat => `chat “${chat.title}”`)].join(', ')) }));
      }
      if (this.db.select().from(schema.chats).all().some(c => c.settings[key] === id || (kind === 'connections' && id === 'main' && c.settings.connectionId === undefined))) throw new AppError(409, 'item_in_use', message("errors.select_a_different_item_in_the_chats_using"));
      if (kind === 'connections') {
        if (this.libraries().contexts.some(preset => preset.connectionId === id)) throw new AppError(409, 'item_in_use', message("errors.a_context_preset_uses_this_summarization_connection_change"));
        this.db.delete(schema.credentials).where(eq(schema.credentials.id, id)).run();
        if (!this.db.delete(schema.connections).where(eq(schema.connections.id, id)).run().changes) throw new AppError(404, 'item_not_found', message("errors.connection_not_found"));
      } else if (!this.db.delete(schema.library).where(and(eq(schema.library.id, id), eq(schema.library.kind, kind))).run().changes) throw new AppError(404, 'item_not_found', message("errors.library_item_not_found"));
      this.pictures.cleanup();
      this.bumpLibrary();
    })();
  }
  private validateSelections(settings: ReturnType<typeof selectionsSchema.parse>) {
    if (settings.connectionId && !this.db.select().from(schema.connections).where(eq(schema.connections.id, settings.connectionId)).get()) throw new AppError(422, 'missing_connection', message("errors.selected_connection_not_found"));
    this.selected(settings.promptId, 'prompts'); this.selected(settings.characterId, 'characters'); this.selected(settings.personaId, 'personas');
    this.contextPreset(settings.contextPresetId);
    this.selected(settings.lorebookId, 'lorebooks');
  }
  createChat(input: ReturnType<typeof selectionsSchema.parse>) {
    return this.sqlite.transaction(() => {
      this.validateSelections(input);
      const id = randomUUID();
      const card = this.selected<Character>(input.characterId, 'characters');
      const lorebookId = input.lorebookId === undefined ? card?.lorebookId ?? null : input.lorebookId;
      this.selected(lorebookId, 'lorebooks');
      this.db.insert(schema.chats).values({ id, revision: 0, settings: { ...initialSettings, ...input, lorebookId } }).run();
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
  updateChat(expected: number, chatId: string, input: ReturnType<typeof selectionsSchema.parse>) {
    this.sqlite.transaction(() => {
      this.checkRevision(expected, chatId); this.ensureIdle(chatId); this.validateSelections(input);
      if (input.contextPresetId === null && this.contexts.snapshot(chatId, null).archivedTurnIds.length) throw new AppError(409, 'restore_context_first', message("errors.clear_memory_in_memory_before_disabling_the_context"));
      const previous = this.chat(chatId).settings;
      if (input.characterId !== previous.characterId || input.personaId !== previous.personaId) this.resetLoreEpoch(chatId);
      const settings = { ...previous, ...input, instructions: '', character: '', persona: '' };
      this.db.update(schema.chats).set({ settings, updatedAt: new Date().toISOString() }).where(eq(schema.chats.id, chatId)).run();
      this.bumpRevision(chatId);
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
      this.db.update(schema.chats).set({ settings: { ...chat.settings, authorNote: note }, updatedAt: new Date().toISOString() })
        .where(eq(schema.chats.id, chatId)).run();
      this.bumpRevision(chatId);
      return this.authorNote(chatId);
    })();
  }
  deleteChat(expected: number, chatId: string) {
    this.sqlite.transaction(() => {
      this.checkRevision(expected, chatId); this.ensureIdle(chatId);
      this.db.delete(schema.chats).where(eq(schema.chats.id, chatId)).run(); this.bumpLibrary();
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
  replaceHistory(expected: number, chatId: string, turns: ImportedTurn[]) {
    return this.sqlite.transaction(() => {
      this.checkRevision(expected, chatId); this.ensureIdle(chatId);
      this.contexts.clear(chatId);
      this.resetLoreEpoch(chatId);
      this.sqlite.prepare('DELETE FROM lore_operations WHERE chat_id = ?').run(chatId);
      this.db.delete(schema.turns).where(eq(schema.turns.chatId, chatId)).run();
      turns.forEach((turn, i) => this.insertTurn(chatId, i + 1, turn));
      return this.bumpRevision(chatId);
    })();
  }
  saveSettings(expected: number, connection: Connection, settings: ChatSettings, apiKey?: string, chatId = 'main') {
    this.sqlite.transaction(() => {
      this.checkRevision(expected, chatId); this.ensureIdle();
      this.selected(settings.promptId, 'prompts'); this.selected(settings.characterId, 'characters'); this.selected(settings.personaId, 'personas');
      this.contextPreset(settings.contextPresetId);
      this.selected(settings.lorebookId, 'lorebooks');
      const previous = this.chat(chatId).settings;
      if (settings.characterId !== previous.characterId || settings.personaId !== previous.personaId) this.resetLoreEpoch(chatId);
      if (settings.contextPresetId === null && this.contexts.snapshot(chatId, null).archivedTurnIds.length) throw new AppError(409, 'restore_context_first', message("errors.clear_memory_in_memory_before_disabling_the_context"));
      const connectionId = settings.connectionId ?? 'main';
      const old = this.db.select().from(schema.connections).where(eq(schema.connections.id, connectionId)).get();
      this.db.insert(schema.connections).values({ id: connectionId, settings: connection, revision: (old?.revision ?? -1) + 1 }).onConflictDoUpdate({ target: schema.connections.id, set: { updatedAt: new Date().toISOString(), settings: connection, revision: (old?.revision ?? -1) + 1 } }).run();
      if (apiKey !== undefined) this.db.insert(schema.credentials).values({ id: connectionId, apiKey }).onConflictDoUpdate({ target: schema.credentials.id, set: { apiKey } }).run();
      this.db.update(schema.chats).set({ updatedAt: new Date().toISOString(), settings: { ...settings, authorNote: settings.authorNote ?? previous.authorNote, connectionId, lorebookId: settings.lorebookId === undefined ? previous.lorebookId ?? null : settings.lorebookId, contextPresetId: settings.contextPresetId === undefined ? previous.contextPresetId ?? null : settings.contextPresetId } }).where(eq(schema.chats.id, chatId)).run();
      this.bumpAffected('connections', connectionId); this.bumpLibrary();
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
      const snapshot = this.snapshot(chatId);
      if (!snapshot.connection) throw new AppError(422, 'connection_required', message("errors.save_a_connection_before_sending_a_turn"));
      if (hasPromptMarker(snapshot.sources.prompt, 'summary')) assertRefusalSelection(snapshot.context);
      let turn = snapshot.turns.at(-1);
      if (text !== undefined) {
        if (turn && !turn.complete) throw new AppError(409, 'pending_turn', message("errors.resolve_or_delete_the_pending_turn_before_submitting"));
        this.insertTurn(chatId, (turn?.position ?? 0) + 1, { user: text, assistant: '', complete: false });
        turn = this.snapshot(chatId).turns.at(-1);
      } else if (!turn || turn.complete) throw new AppError(409, 'no_pending_turn', message("errors.there_is_no_pending_turn_to_retry"));
      const id = randomUUID(), now = new Date().toISOString();
      this.db.insert(schema.generations).values({ id, chatId, requestId, command, turnId: turn!.id, status: 'running', sourceRevision: this.bumpRevision(chatId), request: null, partialText: '', error: null, createdAt: now, updatedAt: now }).run();
      return { id, fresh: true };
    })();
  }
  generation(id: string) { return this.db.select().from(schema.generations).where(eq(schema.generations.id, id)).get(); }
  beginRegeneration(expected: number, requestId: string, turnId: string, chatId: string) {
    return this.sqlite.transaction(() => {
      const command = JSON.stringify({ kind: 'regenerate', turnId });
      const existing = this.db.select().from(schema.generations).where(eq(schema.generations.requestId, requestId)).get();
      if (existing) {
        if (existing.command !== command || existing.chatId !== chatId) throw new AppError(409, 'request_id_conflict', message("errors.that_request_identity_was_already_used_for_a"));
        return { id: existing.id, fresh: false };
      }
      this.checkRevision(expected, chatId);
      this.ensureIdle(chatId);
      const snapshot = this.snapshot(chatId), target = snapshot.turns.at(-1);
      if (hasPromptMarker(snapshot.sources.prompt, 'summary')) assertRefusalSelection(snapshot.context);
      if (!target?.complete || target.id !== turnId) throw new AppError(409, 'latest_turn_only', message("errors.only_the_latest_completed_turn_can_be_regenerated"));
      if (!snapshot.connection) throw new AppError(422, 'connection_required', message("errors.select_a_connection_before_regenerating_a_response"));
      const { context } = regenerationView(snapshot);
      const id = randomUUID(), now = new Date().toISOString();
      this.db.insert(schema.generations).values({ id, chatId, requestId, command, turnId, kind: 'regeneration', status: 'running',
        sourceRevision: this.bumpRevision(chatId), contextSelection: { revision: context.revision, selected: context.selected, archivedTurnIds: context.archivedTurnIds },
        request: null, partialText: '', error: null, createdAt: now, updatedAt: now }).run();
      return { id, fresh: true };
    })();
  }
  generationSnapshot(id: string): ChatSnapshot {
    const generation = this.generation(id);
    if (!generation) throw new AppError(404, 'generation_not_found', message("errors.response_attempt_not_found"));
    const snapshot = this.snapshot(generation.chatId);
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
        text = trimBoundaryNewlines(text);
        if (!text.trim()) throw new AppError(502, 'empty_response', generation.kind === 'regeneration' ? message("errors.the_model_returned_no_text_the_selected_response") : message("errors.the_model_returned_no_text_the_turn_remains"));
        this.checkRevision(generation.sourceRevision, generation.chatId);
        const turn = this.db.select().from(schema.turns).where(eq(schema.turns.id, generation.turnId)).get();
        const regeneration = generation.kind === 'regeneration';
        if (!turn || turn.complete !== regeneration) throw new AppError(409, 'stale_result', message("errors.the_turn_is_no_longer_awaiting_this_response"));
        if (regeneration) {
          if (generation.request?.lore) this.assertLoreCurrent(generation.chatId, generation.request.lore);
          this.resetLoreEpoch(generation.chatId);
          if (generation.request?.lore) {
            const resolution = generation.request.lore;
            this.sqlite.prepare('INSERT INTO lore_states (chat_id, book_id, epoch, data) VALUES (?, ?, ?, ?)').run(generation.chatId, resolution.book.id, this.loreState(generation.chatId).epoch, JSON.stringify(resolution.stateDelta));
          }
        } else if (generation.request?.lore) this.commitLoreState(generation.chatId, generation.request.lore);
        const variantId = turn.selectedVariantId ? randomUUID() : `original-${turn.id}`;
        const equivalent = this.db.select().from(schema.responseVariants).where(and(eq(schema.responseVariants.turnId, turn.id), eq(schema.responseVariants.text, text))).get();
        this.db.insert(schema.responseVariants).values({ id: variantId, turnId: turn.id, text, sourceRevision: equivalent?.sourceRevision ?? turn.assistantRevision + 1, generationId: id, createdAt: generation.createdAt }).run();
        this.db.update(schema.turns).set({ messageAt: new Date().toISOString(), assistantText: text, assistantRevision: turn.assistantRevision + 1, complete: true, selectedVariantId: variantId }).where(eq(schema.turns.id, turn.id)).run();
      }
      this.db.update(schema.generations).set({ status, partialText: text, reasoningText: reasoningText ?? generation.reasoningText, error: outcome.error, errorMessage: outcome.errorMessage ?? null, usage, updatedAt: new Date().toISOString() }).where(eq(schema.generations.id, id)).run();
      this.bumpRevision(generation.chatId); return true;
    })();
  }
  recoverInterrupted() {
    this.sqlite.transaction(() => {
      const running = this.db.select().from(schema.generations).where(eq(schema.generations.status, 'running')).all();
      this.db.update(schema.generations).set({ status: 'interrupted', error: message('outcome.generationInterrupted').fallback, errorMessage: message('outcome.generationInterrupted'), updatedAt: new Date().toISOString() }).where(eq(schema.generations.status, 'running')).run();
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
  deleteTurn(expected: number, turnId: string, chatId = 'main') {
    this.sqlite.transaction(() => {
      this.checkRevision(expected, chatId); this.ensureIdle(chatId);
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
