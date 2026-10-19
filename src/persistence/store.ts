import { PictureStore } from './picture-store.js';
import type { PictureImportIntent } from '../shared/pictures.js';
import type { PreparedPicture } from './picture-data.js';
import type { CharacterSaveCommand } from '../shared/library.js';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { AppError } from '../core/errors.js';
import { replaceNameMacros } from '../core/prompt.js';
import type { ChatSettings, ChatSnapshot, Connection, Generation, GenerationStatus, RequestPreview, ResponseVariant, TokenUsage, Turn } from '../shared/contracts.js';
import { regenerationView } from '../core/regeneration.js';
import { readCharacterAlternateGreetings, characterLabel, characterSchema, libraryCharacterSchema, defaultPrompt, selectionsSchema, type Character, type LibraryCharacter, type ChatSummary, type ImportedTurn, type LibraryKind, type LibrarySnapshot, type Persona, type PromptPreset, type Saved, type UnchangedLibrary } from '../shared/library.js';
import { lorebookSchema, type Lorebook, type LoreImportPreview, type LoreResolution, type LoreState } from '../shared/lorebook.js';
import { importLorebook, loreCompatibility, markLoreEdits } from '../core/lorebook-formats.js';
import { importCharacter } from '../core/cards.js';
import { semanticFingerprint } from '../core/lorebook.js';
import * as schema from './schema.js';
import { trimBoundaryNewlines } from '../shared/text.js';
import { contextPresetSchema, defaultContextPreset, type ContextPreset } from '../shared/context.js';
import { upgradedContextPrompts } from './context-prompt-upgrade.js';
import { ContextStore } from './context-store.js';
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { legacyLorePrompt } from './legacy-prompt.js';
import { TagStore } from './tag-store.js';
import { readEmbeddedTags } from '../core/tags.js';
import { characterImportResultSchema, tagPolicySchema, type TagPolicy, type CharacterImportReview } from '../shared/tags.js';
import { upgradePrompt } from '../core/prompt-upgrade.js';

function parseImport<T>(parse: () => T): T {
  try { return parse(); }
  catch (error) {
    if (error instanceof z.ZodError || error instanceof AppError) throw error;
    throw new AppError(400, 'invalid_lorebook', error instanceof Error ? error.message : 'The imported lorebook could not be read.');
  }
}

const initialSettings: ChatSettings = {
  title: 'A new story', instructions: defaultPrompt.blocks[0].kind === 'text' ? defaultPrompt.blocks[0].text : '',
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

  constructor(filename: string, migrationsDirectory = resolve('migrations')) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.sqlite = new Database(filename);
    if (filename !== ':memory:') chmodSync(filename, 0o600);
    this.sqlite.pragma('journal_mode = WAL');
    this.sqlite.pragma('foreign_keys = ON');
    this.sqlite.pragma('busy_timeout = 5000');
    let version = this.sqlite.pragma('user_version', { simple: true }) as number;
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
      if (version === 1) {
        this.sqlite.transaction(() => {
          this.sqlite.exec(readFileSync(resolve(migrationsDirectory, '0002_libraries.sql'), 'utf8'));
          this.db.insert(schema.library).values({ id: 'default', kind: 'prompts', revision: 0, data: defaultPrompt }).run();
          const chat = this.db.select().from(schema.chats).where(eq(schema.chats.id, 'main')).get();
          if (chat) {
            const settings = { ...chat.settings, connectionId: this.db.select().from(schema.connections).get()?.id ?? null, promptId: 'migrated-prompt', characterId: null as string | null, personaId: null as string | null };
            this.db.insert(schema.library).values({ id: settings.promptId, kind: 'prompts', revision: 0, data: { name: 'Saved prompt', blocks: defaultPrompt.blocks.map(b => b.kind === 'text' ? { ...b, text: chat.settings.instructions } : b) } }).run();
            if (settings.character !== '') {
              settings.characterId = 'migrated-character';
              this.db.insert(schema.library).values({ id: settings.characterId, kind: 'characters', revision: 0, data: { name: 'Character', description: settings.character, personality: '', scenario: '', first_mes: '', mes_example: '' } }).run();
            }
            if (settings.persona !== '') {
              settings.personaId = 'migrated-persona';
              this.db.insert(schema.library).values({ id: settings.personaId, kind: 'personas', revision: 0, data: { name: 'You', description: settings.persona } }).run();
            }
            this.db.update(schema.chats).set({ settings }).where(eq(schema.chats.id, 'main')).run();
          }
          this.sqlite.pragma('user_version = 2');
        })();
        version = 2;
      }
      if (version === 2) {
        this.sqlite.transaction(() => {
          this.sqlite.exec(readFileSync(resolve(migrationsDirectory, '0003_context.sql'), 'utf8'));
          this.db.insert(schema.library).values({ id: 'default-context', kind: 'contexts', revision: 0, data: defaultContextPreset }).run();
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
          const builtIn = this.db.select().from(schema.library).where(and(eq(schema.library.id, 'default'), eq(schema.library.kind, 'prompts'))).get();
          const previousDefault = { ...legacyLorePrompt, blocks: legacyLorePrompt.blocks.filter(block => block.id !== 'summary' && !block.marker?.startsWith('lore_')) };
          // Upgrade only the exact old factory preset. Edited defaults and all
          // user presets keep their deliberate marker choices.
          if (builtIn && isDeepStrictEqual(builtIn.data, previousDefault)) {
            this.sqlite.prepare('UPDATE library SET data = ?, revision = revision + 1 WHERE id = ?').run(JSON.stringify({ ...legacyLorePrompt, blocks: legacyLorePrompt.blocks.filter(block => !block.marker?.startsWith('lore_')) }), 'default');
            for (const chat of this.db.select().from(schema.chats).all()) if (chat.settings.promptId === 'default') this.bumpRevision(chat.id);
            this.sqlite.prepare('UPDATE library_state SET revision = revision + 1 WHERE id = 1').run();
          }
          this.sqlite.pragma('user_version = 5');
        })();
        version = 5;
      }
      if (version === 5) {
        this.sqlite.transaction(() => {
          const changedIds = new Set<string>();
          for (const preset of this.db.select().from(schema.library).where(eq(schema.library.kind, 'contexts')).all()) {
            const changes = upgradedContextPrompts(contextPresetSchema.parse(preset.data));
            if (!Object.keys(changes).length) continue;
            this.db.update(schema.library).set({ data: { ...preset.data, ...changes }, revision: preset.revision + 1 }).where(eq(schema.library.id, preset.id)).run();
            changedIds.add(preset.id);
          }
          if (changedIds.size) {
            for (const chat of this.db.select().from(schema.chats).all()) {
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
          const builtIn = this.db.select().from(schema.library).where(and(eq(schema.library.id, 'default'), eq(schema.library.kind, 'prompts'))).get();
          const previousDefault = { ...legacyLorePrompt, blocks: legacyLorePrompt.blocks.filter(block => !block.marker?.startsWith('lore_')) };
          if (builtIn && isDeepStrictEqual(builtIn.data, previousDefault)) {
            this.sqlite.prepare('UPDATE library SET data = ?, revision = revision + 1 WHERE id = ?').run(JSON.stringify(legacyLorePrompt), 'default');
            for (const chat of this.db.select().from(schema.chats).all()) if (chat.settings.promptId === 'default') this.bumpRevision(chat.id);
            this.bumpLibrary();
          }
          this.sqlite.pragma('user_version = 7');
        })();
        version = 7;
      }
      if (version === 7) {
        this.sqlite.transaction(() => {
          const changedIds = new Set<string>();
          for (const preset of this.db.select().from(schema.library).where(eq(schema.library.kind, 'prompts')).all()) {
            const data = upgradePrompt(preset.data);
            if (isDeepStrictEqual(data, preset.data)) continue;
            this.db.update(schema.library).set({ data, revision: preset.revision + 1 }).where(eq(schema.library.id, preset.id)).run();
            changedIds.add(preset.id);
          }
          for (const chat of this.db.select().from(schema.chats).all()) {
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
      } else if (version !== 12) throw new Error('Unsupported database schema version.');
      this.pictures = new PictureStore(this.sqlite, () => this.bumpLibrary());
      this.contexts = new ContextStore(this);
      this.tags = new TagStore(this.sqlite, expected => this.checkLibrary(expected), () => this.bumpLibrary());
      if (newDatabase) this.db.insert(schema.chats).values({ id: 'main', revision: 0, settings: initialSettings }).onConflictDoNothing().run();
    } catch (error) {
      this.sqlite.prepare('DELETE FROM runtime_owner WHERE token = ?').run(this.ownerToken);
      this.sqlite.close(); throw error;
    }
  }

  private chat(chatId: string) {
    const row = this.db.select().from(schema.chats).where(eq(schema.chats.id, chatId)).get();
    if (!row) throw new AppError(404, 'chat_not_found', 'Chat not found.');
    return row;
  }
  private selected<T>(id: string | null | undefined, kind: LibraryKind): Saved<T> | null {
    if (!id) return null;
    const row = this.db.select().from(schema.library).where(and(eq(schema.library.id, id), eq(schema.library.kind, kind))).get();
    if (!row) throw new AppError(422, 'missing_selection', 'A selected library item no longer exists.');
    // Organizational metadata must never enter PromptSources or source revisions.
    const data = kind === 'characters' ? this.promptCharacter(libraryCharacterSchema.parse(row.data)) : row.data;
    return { ...data, id: row.id, revision: row.revision } as unknown as Saved<T>;
  }
  private promptCharacter(card: LibraryCharacter): Character {
    const { titleComment: _titleComment, ...fields } = card;
    return characterSchema.parse(fields);
  }
  private comparableCharacter(card: LibraryCharacter): Character {
    const fields = this.promptCharacter(card);
    const greetings = readCharacterAlternateGreetings(fields);
    // Exposing preserved greetings in the editor does not itself change content.
    return greetings.success ? { ...fields, alternate_greetings: greetings.data } : fields;
  }
  snapshot(chatId = 'main'): ChatSnapshot {
    const chat = this.chat(chatId);
    const connectionId = chat.settings.connectionId === undefined ? 'main' : chat.settings.connectionId;
    const connection = connectionId ? this.db.select().from(schema.connections).where(eq(schema.connections.id, connectionId)).get()?.settings ?? null : null;
    const hasApiKey = Boolean(connectionId && this.db.select().from(schema.credentials).where(eq(schema.credentials.id, connectionId)).get()?.apiKey);
    const variants = new Map<string, ResponseVariant[]>();
    const savedVariants = this.db.select({ id: schema.responseVariants.id, turnId: schema.responseVariants.turnId, text: schema.responseVariants.text,
      sourceRevision: schema.responseVariants.sourceRevision, generationId: schema.responseVariants.generationId, createdAt: schema.responseVariants.createdAt })
      .from(schema.responseVariants).innerJoin(schema.turns, eq(schema.turns.id, schema.responseVariants.turnId)).where(eq(schema.turns.chatId, chatId)).orderBy(asc(sql`${schema.responseVariants}.rowid`)).all();
    for (const { turnId, ...variant } of savedVariants) {
      const group = variants.get(turnId);
      if (group) group.push(variant);
      else variants.set(turnId, [variant]);
    }
    const turns: Turn[] = this.db.select().from(schema.turns).where(eq(schema.turns.chatId, chatId)).orderBy(asc(schema.turns.position)).all().map(row => {
      const responses = variants.get(row.id) ?? [];
      const selected = responses.find(variant => variant.id === row.selectedVariantId);
      if (row.complete && (!selected || selected.text !== row.assistantText)) throw new AppError(500, 'invalid_response_variant', 'The saved response selection is inconsistent. The transcript has been preserved; inspect the database before continuing.');
      return {
        id: row.id, position: row.position, complete: row.complete,
        user: { id: row.userId, revision: row.userRevision, text: row.userText },
        assistant: { id: row.assistantId, revision: row.assistantRevision, text: row.assistantText,
          ...(selected ? { variantId: selected.id, sourceRevision: selected.sourceRevision } : {}) },
        variants: responses,
      };
    });
    const generations: Generation[] = this.db.select({
      id: schema.generations.id, turnId: schema.generations.turnId, status: schema.generations.status,
      sourceRevision: schema.generations.sourceRevision, kind: schema.generations.kind,
      request: schema.generations.request, usage: schema.generations.usage, partialText: schema.generations.partialText,
      reasoningText: sql<string>`substr(${schema.generations.reasoningText}, -2000)`,
      error: schema.generations.error, createdAt: schema.generations.createdAt, updatedAt: schema.generations.updatedAt,
    }).from(schema.generations).where(eq(schema.generations.chatId, chatId)).orderBy(desc(sql`rowid`)).all().map(row => ({
      id: row.id, turnId: row.turnId, status: row.status, sourceRevision: row.sourceRevision, kind: row.kind,
      request: row.request, usage: row.usage, partialText: row.partialText, reasoningText: row.reasoningText, error: row.error, createdAt: row.createdAt, updatedAt: row.updatedAt,
    }));
    return { id: chatId, revision: chat.revision, settings: { ...chat.settings, lorebookId: chat.settings.lorebookId ?? null }, connection, hasApiKey, turns, generations, loreState: this.loreState(chatId, chat.settings.lorebookId), context: this.contexts.snapshot(chatId, chat.settings.contextPresetId ?? null), sources: {
      prompt: this.selected<PromptPreset>(chat.settings.promptId, 'prompts'),
      character: this.selected<Character>(chat.settings.characterId, 'characters'), persona: this.selected<Persona>(chat.settings.personaId, 'personas'),
      lorebook: this.selected<Lorebook>(chat.settings.lorebookId, 'lorebooks'),
    } };
  }
  checkRevision(expected: number, chatId = 'main') {
    if (this.chat(chatId).revision !== expected) throw new AppError(409, 'revision_conflict', 'The chat changed on another device. Review the latest state and try again.');
  }
  ensureIdle(chatId?: string) {
    const condition = chatId ? and(eq(schema.generations.status, 'running'), eq(schema.generations.chatId, chatId)) : eq(schema.generations.status, 'running');
    if (this.db.select().from(schema.generations).where(condition).get()) throw new AppError(409, 'generation_running', 'Cancel or wait for the current response before editing shared items or this chat.');
    if (this.contexts.running(chatId)) throw new AppError(409, 'context_running', 'Stop or wait for memory preparation before editing shared items or this chat.');
  }
  bumpRevision(chatId = 'main') {
    const revision = this.chat(chatId).revision + 1;
    this.db.update(schema.chats).set({ revision }).where(eq(schema.chats.id, chatId)).run();
    return revision;
  }
  libraryRevision() { return (this.sqlite.prepare('SELECT revision FROM library_state WHERE id = 1').get() as { revision: number }).revision; }
  private checkLibrary(expected: number) {
    if (this.libraryRevision() !== expected) throw new AppError(409, 'revision_conflict', 'The library changed on another device. Reopen the editor before saving.');
    this.ensureIdle();
  }
  private bumpLibrary() { this.sqlite.prepare('UPDATE library_state SET revision = revision + 1 WHERE id = 1').run(); }
  private bumpAffected(kind: LibraryKind, id: string) {
    const key = kind === 'personas' ? 'personaId' : kind === 'characters' ? 'characterId' : kind === 'prompts' ? 'promptId' : kind === 'contexts' ? 'contextPresetId' : kind === 'lorebooks' ? 'lorebookId' : 'connectionId';
    for (const chat of this.db.select().from(schema.chats).all()) if (chat.settings[key] === id || (kind === 'connections' && (id === 'main' && chat.settings.connectionId === undefined || this.contextPreset(chat.settings.contextPresetId)?.connectionId === id))) this.bumpRevision(chat.id);
  }
  private chatSummaries(): ChatSummary[] {
    return this.db.select().from(schema.chats).all().map(chat => ({ id: chat.id, title: chat.settings.title, revision: chat.revision,
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
      revision: this.libraryRevision(), personas: list<Persona>('personas'), characters: list<LibraryCharacter>('characters'), prompts: list<PromptPreset>('prompts'),
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
  saveLibrary(expected: number, kind: LibraryKind, data: LibraryCharacter | Persona | PromptPreset | ContextPreset | Connection | Lorebook, id?: string, apiKey?: string, tagIds?: string[]) {
    if (kind === 'prompts') data = upgradePrompt(data);
    return this.sqlite.transaction(() => {
      this.checkLibrary(expected);
      const identity = id ?? randomUUID();
      if (kind === 'contexts' && (data as ContextPreset).connectionId) this.connection((data as ContextPreset).connectionId!);
      if (kind === 'connections') {
        const old = this.db.select().from(schema.connections).where(eq(schema.connections.id, identity)).get();
        if (id && !old) throw new AppError(404, 'item_not_found', 'Connection not found.');
        this.db.insert(schema.connections).values({ id: identity, settings: data as Connection, revision: (old?.revision ?? -1) + 1 }).onConflictDoUpdate({ target: schema.connections.id, set: { settings: data as Connection, revision: (old?.revision ?? -1) + 1 } }).run();
        if (apiKey !== undefined) this.db.insert(schema.credentials).values({ id: identity, apiKey }).onConflictDoUpdate({ target: schema.credentials.id, set: { apiKey } }).run();
      } else {
        const old = this.db.select().from(schema.library).where(and(eq(schema.library.id, identity), eq(schema.library.kind, kind))).get();
        if (id && !old) throw new AppError(404, 'item_not_found', 'Library item not found.');
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
            const retained = new Set(data.entries.filter(entry => {
              const before = previousEntries.get(entry.id);
              return before && previous && semanticFingerprint(previous, before) === semanticFingerprint(data as Lorebook, entry);
            }).map(entry => entry.id));
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
          const alternate_greetings = card.alternate_greetings ?? previous?.alternate_greetings;
          const updated: LibraryCharacter = { ...this.promptCharacter(card), ...(alternate_greetings !== undefined ? { alternate_greetings } : {}), ...(lorebookId !== undefined ? { lorebookId } : {}), ...(titleComment ? { titleComment } : {}) };
          data = updated;
          if (previous && previous.name !== card.name) for (const chat of this.db.select().from(schema.chats).all()) if (chat.settings.characterId === identity) this.resetLoreEpoch(chat.id);
          if (old && previous && isDeepStrictEqual(this.comparableCharacter(previous), this.comparableCharacter(updated))) {
            const metadataChanged = !isDeepStrictEqual(old.data, data);
            if (metadataChanged) this.db.update(schema.library).set({ data }).where(eq(schema.library.id, identity)).run();
            const tagsChanged = tagIds !== undefined && this.tags.replaceInTransaction(identity, tagIds);
            if (metadataChanged || tagsChanged) this.bumpLibrary();
            return identity;
          }
        }
        if (kind === 'personas' && old && 'name' in data && old.data.name !== data.name) for (const chat of this.db.select().from(schema.chats).all()) if (chat.settings.personaId === identity) this.resetLoreEpoch(chat.id);
        const saved = data as LibraryCharacter | Persona | PromptPreset | ContextPreset | Lorebook;
        this.db.insert(schema.library).values({ id: identity, kind, revision: (old?.revision ?? -1) + 1, data: saved }).onConflictDoUpdate({ target: schema.library.id, set: { data: saved, revision: (old?.revision ?? -1) + 1 } }).run();
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
      if (input.picture) throw new AppError(400, 'missing_command', 'Picture saves require a command identity.');
      return { found: false as const };
    }
    return this.recordedLibraryCommand(input.requestId, this.libraryCommandFingerprint(this.characterSaveFingerprint(input, id)), value => z.object({ id: z.string() }).parse(value));
  }
  checkCharacterSave(input: CharacterSaveCommand, id?: string) {
    this.checkLibrary(input.revision);
    if (id) this.selected<Character>(id, 'characters');
    if (input.picture) {
      if (input.expectedPicture === undefined) throw new AppError(400, 'missing_picture_precondition', 'Picture saves require the reviewed picture identity.');
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
      this.pictures.apply(identity, input.picture, prepared);
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
    if (existing.command !== fingerprint && !(Array.isArray(legacyFingerprint) ? legacyFingerprint : [legacyFingerprint]).includes(existing.command)) throw new AppError(409, 'request_id_conflict', 'This import identity was already used for a different command.');
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
    const resultSchema = z.object({ id: z.string(), diagnostics: z.array(z.object({ code: z.string(), message: z.string(), entryId: z.string().optional(), field: z.string().optional() })) });
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
  duplicateCharacter(expected: number, characterId: string) {
    return this.sqlite.transaction(() => {
      this.checkLibrary(expected);
      const original = this.db.select().from(schema.library).where(and(eq(schema.library.id, characterId), eq(schema.library.kind, 'characters'))).get();
      if (!original) throw new AppError(404, 'character_not_found', 'Character not found.');
      const data = libraryCharacterSchema.parse(original.data);
      const id = this.saveLibrary(expected, 'characters', { ...data, name: `${data.name.slice(0, 90)} copy` }, undefined, undefined, this.tags.assigned(characterId));
      this.pictures.duplicate(characterId, id);
      return id;
    })();
  }
  extractBook(expected: number, requestId: string, characterId: string) {
    const resultSchema = z.object({ bookId: z.string(), diagnostics: z.array(z.object({ code: z.string(), message: z.string(), entryId: z.string().optional(), field: z.string().optional() })) });
    return this.loreCommand(expected, requestId, { kind: 'extract', characterId }, value => resultSchema.parse(value), () => {
      const card = this.selected<Character>(characterId, 'characters');
      if (!card) throw new AppError(404, 'item_not_found', 'Character not found.');
      if (card.lorebookId) {
        const book = this.selected<Lorebook>(card.lorebookId, 'lorebooks');
        return { bookId: card.lorebookId, diagnostics: book ? loreCompatibility(book) : [] };
      }
      const raw = card.source ?? {}, data = raw.spec === 'chara_card_v2' || raw.spec === 'chara_card_v3' ? z.record(z.string(), z.unknown()).parse(raw.data) : raw;
      if (data.character_book == null) throw new AppError(422, 'no_embedded_book', 'This character has no preserved embedded lorebook.');
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
    if (!book || book.id !== resolution.book.id || book.revision !== resolution.book.revision || this.loreState(chatId, book.id).epoch !== resolution.epoch) throw new AppError(409, 'stale_lore', 'The lorebook, selection or activation state changed. Retry from current saved state.');
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
    if (JSON.stringify(state.entries) !== JSON.stringify(resolution.stateBefore)) throw new AppError(409, 'stale_lore_state', 'Lore activation state changed before the response completed. Retry from the current state.');
    this.sqlite.prepare('INSERT INTO lore_states (chat_id, book_id, epoch, data) VALUES (?, ?, ?, ?) ON CONFLICT(chat_id, book_id) DO UPDATE SET epoch = excluded.epoch, data = excluded.data').run(chatId, resolution.book.id, resolution.epoch, JSON.stringify({ ...state.entries, ...resolution.stateDelta }));
  }
  deleteLibrary(expected: number, kind: LibraryKind, id: string) {
    this.sqlite.transaction(() => {
      this.checkLibrary(expected);
      if (kind === 'prompts' && id === 'default') throw new AppError(409, 'default_prompt', 'The default prompt can be edited or restored, but cannot be deleted.');
      const key = kind === 'personas' ? 'personaId' : kind === 'characters' ? 'characterId' : kind === 'prompts' ? 'promptId' : kind === 'contexts' ? 'contextPresetId' : kind === 'lorebooks' ? 'lorebookId' : 'connectionId';
      if (kind === 'lorebooks') {
        const uses = this.libraries().lorebookUses.find(use => use.bookId === id);
        if (uses && (uses.characters.length || uses.chats.length)) throw new AppError(409, 'item_in_use', `This lorebook is used by ${[...uses.characters.map(card => `character “${characterLabel(card)}”`), ...uses.chats.map(chat => `chat “${chat.title}”`)].join(', ')}. Choose None or another book there first.`);
      }
      if (this.db.select().from(schema.chats).all().some(c => c.settings[key] === id || (kind === 'connections' && id === 'main' && c.settings.connectionId === undefined))) throw new AppError(409, 'item_in_use', 'Select a different item in the chats using this one before deleting it.');
      if (kind === 'connections') {
        if (this.libraries().contexts.some(preset => preset.connectionId === id)) throw new AppError(409, 'item_in_use', 'A context preset uses this summarization Connection. Change that preset first.');
        this.db.delete(schema.credentials).where(eq(schema.credentials.id, id)).run();
        if (!this.db.delete(schema.connections).where(eq(schema.connections.id, id)).run().changes) throw new AppError(404, 'item_not_found', 'Connection not found.');
      } else if (!this.db.delete(schema.library).where(and(eq(schema.library.id, id), eq(schema.library.kind, kind))).run().changes) throw new AppError(404, 'item_not_found', 'Library item not found.');
      this.pictures.cleanup();
      this.bumpLibrary();
    })();
  }
  private validateSelections(settings: ReturnType<typeof selectionsSchema.parse>) {
    if (settings.connectionId && !this.db.select().from(schema.connections).where(eq(schema.connections.id, settings.connectionId)).get()) throw new AppError(422, 'missing_connection', 'Selected Connection not found.');
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
      if (!alternateGreetings.success) throw new AppError(422, 'invalid_alternate_greetings', 'This character has invalid preserved alternate greetings. Open the character editor to clear or replace them before starting a chat.');
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
      if (input.contextPresetId === null && this.contexts.snapshot(chatId, null).archivedTurnIds.length) throw new AppError(409, 'restore_context_first', 'Clear memory in Memory before disabling the context preset.');
      const previous = this.chat(chatId).settings;
      if (input.characterId !== previous.characterId || input.personaId !== previous.personaId) this.resetLoreEpoch(chatId);
      const settings = { ...previous, ...input, instructions: '', character: '', persona: '' };
      this.db.update(schema.chats).set({ settings }).where(eq(schema.chats.id, chatId)).run();
      this.bumpRevision(chatId);
      // Lorebook usage labels and links are cached with the library revision.
      if (settings.title !== previous.title || settings.lorebookId !== previous.lorebookId) this.bumpLibrary();
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
    this.sqlite.transaction(() => {
      this.checkRevision(expected, chatId); this.ensureIdle(chatId);
      this.contexts.clear(chatId);
      this.resetLoreEpoch(chatId);
      this.sqlite.prepare('DELETE FROM lore_operations WHERE chat_id = ?').run(chatId);
      this.db.delete(schema.turns).where(eq(schema.turns.chatId, chatId)).run();
      turns.forEach((turn, i) => this.insertTurn(chatId, i + 1, turn));
      this.bumpRevision(chatId);
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
      if (settings.contextPresetId === null && this.contexts.snapshot(chatId, null).archivedTurnIds.length) throw new AppError(409, 'restore_context_first', 'Clear memory in Memory before disabling the context preset.');
      const connectionId = settings.connectionId ?? 'main';
      const old = this.db.select().from(schema.connections).where(eq(schema.connections.id, connectionId)).get();
      this.db.insert(schema.connections).values({ id: connectionId, settings: connection, revision: (old?.revision ?? -1) + 1 }).onConflictDoUpdate({ target: schema.connections.id, set: { settings: connection, revision: (old?.revision ?? -1) + 1 } }).run();
      if (apiKey !== undefined) this.db.insert(schema.credentials).values({ id: connectionId, apiKey }).onConflictDoUpdate({ target: schema.credentials.id, set: { apiKey } }).run();
      this.db.update(schema.chats).set({ settings: { ...settings, connectionId, lorebookId: settings.lorebookId === undefined ? previous.lorebookId ?? null : settings.lorebookId, contextPresetId: settings.contextPresetId === undefined ? previous.contextPresetId ?? null : settings.contextPresetId } }).where(eq(schema.chats.id, chatId)).run();
      this.bumpAffected('connections', connectionId); this.bumpLibrary();
    })();
  }
  begin(expected: number, requestId: string, text?: string, chatId = 'main'): { id: string; fresh: boolean } {
    if (text !== undefined) {
      text = trimBoundaryNewlines(text);
      if (!text.trim()) throw new AppError(400, 'blank_input', 'Write a turn before sending it.');
    }
    return this.sqlite.transaction(() => {
      const command = JSON.stringify({ kind: text === undefined ? 'retry' : 'submit', text });
      const existing = this.db.select().from(schema.generations).where(eq(schema.generations.requestId, requestId)).get();
      if (existing) {
        if (existing.command !== command || existing.chatId !== chatId) throw new AppError(409, 'request_id_conflict', 'That request identity was already used for a different command.');
        return { id: existing.id, fresh: false };
      }
      this.checkRevision(expected, chatId); this.ensureIdle(chatId);
      const snapshot = this.snapshot(chatId);
      if (!snapshot.connection) throw new AppError(422, 'connection_required', 'Save a Connection before sending a turn.');
      let turn = snapshot.turns.at(-1);
      if (text !== undefined) {
        if (turn && !turn.complete) throw new AppError(409, 'pending_turn', 'Resolve or delete the pending turn before submitting another.');
        this.insertTurn(chatId, (turn?.position ?? 0) + 1, { user: text, assistant: '', complete: false });
        turn = this.snapshot(chatId).turns.at(-1);
      } else if (!turn || turn.complete) throw new AppError(409, 'no_pending_turn', 'There is no pending turn to retry.');
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
        if (existing.command !== command || existing.chatId !== chatId) throw new AppError(409, 'request_id_conflict', 'That request identity was already used for a different command.');
        return { id: existing.id, fresh: false };
      }
      this.checkRevision(expected, chatId);
      this.ensureIdle(chatId);
      const snapshot = this.snapshot(chatId), target = snapshot.turns.at(-1);
      if (!target?.complete || target.id !== turnId) throw new AppError(409, 'latest_turn_only', 'Only the latest completed turn can be regenerated.');
      if (!snapshot.connection) throw new AppError(422, 'connection_required', 'Select a Connection before regenerating a response.');
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
    if (!generation) throw new AppError(404, 'generation_not_found', 'Response attempt not found.');
    const snapshot = this.snapshot(generation.chatId);
    if (generation.kind !== 'regeneration') return snapshot;
    if (snapshot.turns.at(-1)?.id !== generation.turnId || !generation.contextSelection) throw new AppError(409, 'stale_result', 'The regeneration endpoint is no longer available.');
    return regenerationView({ ...snapshot, context: { ...snapshot.context, ...generation.contextSelection } });
  }
  saveGenerationContext(id: string, state: Pick<ChatSnapshot['context'], 'revision' | 'selected' | 'archivedTurnIds'>) {
    const generation = this.generation(id);
    if (!generation || generation.kind !== 'regeneration' || generation.status !== 'running') throw new AppError(409, 'inactive_generation', 'This regeneration is no longer active.');
    this.checkRevision(generation.sourceRevision, generation.chatId);
    this.db.update(schema.generations).set({ contextSelection: { revision: state.revision, selected: state.selected, archivedTurnIds: state.archivedTurnIds } }).where(eq(schema.generations.id, id)).run();
  }
  selectVariant(expected: number, turnId: string, variantId: string, chatId: string) {
    this.sqlite.transaction(() => {
      this.checkRevision(expected, chatId);
      this.ensureIdle(chatId);
      const turn = this.db.select().from(schema.turns).where(and(eq(schema.turns.id, turnId), eq(schema.turns.chatId, chatId))).get();
      const variant = this.db.select().from(schema.responseVariants).where(and(eq(schema.responseVariants.id, variantId), eq(schema.responseVariants.turnId, turnId))).get();
      if (!turn?.complete || !variant) throw new AppError(404, 'variant_not_found', 'This saved response is not available for the selected turn.');
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
    if (!this.db.select().from(schema.connections).where(eq(schema.connections.id, id)).get()) throw new AppError(404, 'connection_not_found', 'Connection not found.');
    return this.db.select().from(schema.credentials).where(eq(schema.credentials.id, id)).get()?.apiKey ?? '';
  }
  connection(id: string): Connection {
    const row = this.db.select().from(schema.connections).where(eq(schema.connections.id, id)).get();
    if (!row) throw new AppError(422, 'missing_connection', 'The summarization Connection is missing.');
    return row.settings;
  }
  contextPreset(id: string | null | undefined) {
    const preset = this.selected<ContextPreset>(id, 'contexts');
    return preset ? { ...preset, repairPrompt: preset.repairPrompt ?? defaultContextPreset.repairPrompt } : null;
  }
  saveRequest(id: string, request: RequestPreview) {
    this.sqlite.transaction(() => {
      const generation = this.generation(id);
      if (!generation || generation.status !== 'running') throw new AppError(409, 'inactive_generation', 'The response is no longer active.');
      this.checkRevision(generation.sourceRevision, generation.chatId);
      if (request.lore) this.assertLoreCurrent(generation.chatId, request.lore);
      this.db.update(schema.generations).set({ request }).where(eq(schema.generations.id, id)).run();
    })();
  }
  checkpoint(id: string, partialText: string, reasoningText?: string) {
    if (this.generation(id)?.status !== 'running') return false;
    this.db.update(schema.generations).set({ partialText, ...(reasoningText !== undefined ? { reasoningText } : {}), updatedAt: new Date().toISOString() }).where(eq(schema.generations.id, id)).run(); return true;
  }
  finish(id: string, status: Exclude<GenerationStatus, 'running' | 'interrupted'>, text: string, error: string | null = null, usage: TokenUsage | null = null, reasoningText?: string) {
    return this.sqlite.transaction(() => {
      const generation = this.generation(id);
      if (!generation || generation.status !== 'running') return false;
      if (status === 'succeeded') {
        text = trimBoundaryNewlines(text);
        if (!text.trim()) throw new AppError(502, 'empty_response', generation.kind === 'regeneration'
          ? 'The model returned no text. The selected response was kept; regenerate explicitly to try again.'
          : 'The model returned no text. The turn remains pending; retry or delete it.');
        this.checkRevision(generation.sourceRevision, generation.chatId);
        const turn = this.db.select().from(schema.turns).where(eq(schema.turns.id, generation.turnId)).get();
        const regeneration = generation.kind === 'regeneration';
        if (!turn || turn.complete !== regeneration) throw new AppError(409, 'stale_result', 'The turn is no longer awaiting this response.');
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
        this.db.update(schema.turns).set({ assistantText: text, assistantRevision: turn.assistantRevision + 1, complete: true, selectedVariantId: variantId }).where(eq(schema.turns.id, turn.id)).run();
      }
      this.db.update(schema.generations).set({ status, partialText: text, reasoningText: reasoningText ?? generation.reasoningText, error, usage, updatedAt: new Date().toISOString() }).where(eq(schema.generations.id, id)).run();
      this.bumpRevision(generation.chatId); return true;
    })();
  }
  recoverInterrupted() {
    this.sqlite.transaction(() => {
      const running = this.db.select().from(schema.generations).where(eq(schema.generations.status, 'running')).all();
      this.db.update(schema.generations).set({ status: 'interrupted', error: 'The server stopped during this response. Retry explicitly to start a new model request.', updatedAt: new Date().toISOString() }).where(eq(schema.generations.status, 'running')).run();
      for (const id of new Set(running.map(g => g.chatId))) this.bumpRevision(id);
      this.contexts.recover();
    })();
  }
  editPart(expected: number, turnId: string, part: 'user' | 'assistant', text: string, chatId = 'main') {
    text = trimBoundaryNewlines(text);
    this.sqlite.transaction(() => {
      this.checkRevision(expected, chatId); this.ensureIdle(chatId);
      const turn = this.db.select().from(schema.turns).where(and(eq(schema.turns.id, turnId), eq(schema.turns.chatId, chatId))).get();
      if (!turn) throw new AppError(404, 'turn_not_found', 'Turn not found.');
      if (part === 'assistant' && !turn.complete) throw new AppError(409, 'pending_response', 'A pending response cannot be completed by editing. Retry or delete its turn.');
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
      if (!this.db.delete(schema.turns).where(and(eq(schema.turns.id, turnId), eq(schema.turns.chatId, chatId))).run().changes) throw new AppError(404, 'turn_not_found', 'Turn not found.');
      this.resetLoreEpoch(chatId);
      this.bumpRevision(chatId);
    })();
  }
  close() {
    if (!this.sqlite.open) return;
    this.sqlite.prepare('DELETE FROM runtime_owner WHERE id = 1 AND token = ?').run(this.ownerToken); this.sqlite.close();
  }
}
