import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { AppError } from '../core/errors.js';
import { replaceNameMacros } from '../core/prompt.js';
import type { ChatSettings, ChatSnapshot, Connection, Generation, GenerationStatus, RequestPreview, TokenUsage, Turn } from '../shared/contracts.js';
import { defaultPrompt, promptSchema, selectionsSchema, type Character, type ImportedTurn, type LibraryKind, type LibrarySnapshot, type Persona, type PromptPreset, type Saved } from '../shared/library.js';
import * as schema from './schema.js';
import { trimBoundaryNewlines } from '../shared/text.js';
import { defaultContextPreset, type ContextPreset } from '../shared/context.js';
import { ContextStore } from './context-store.js';

const initialSettings: ChatSettings = {
  title: 'A new story', instructions: defaultPrompt.blocks[0].kind === 'text' ? defaultPrompt.blocks[0].text : '',
  character: '', persona: '', targetInputTokens: 32_000,
  connectionId: null, promptId: 'default', characterId: null, personaId: null,
  contextPresetId: null,
};

export class Store {
  readonly sqlite: Database.Database;
  readonly db;
  readonly contexts: ContextStore;
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
          const previousDefault = { ...defaultPrompt, blocks: defaultPrompt.blocks.filter(block => block.id !== 'summary') };
          // Upgrade only the exact old factory preset. Edited defaults and all
          // user presets keep their deliberate marker choices.
          if (builtIn && JSON.stringify(promptSchema.parse(builtIn.data)) === JSON.stringify(promptSchema.parse(previousDefault))) {
            this.db.update(schema.library).set({ data: defaultPrompt, revision: builtIn.revision + 1 }).where(eq(schema.library.id, 'default')).run();
            for (const chat of this.db.select().from(schema.chats).all()) if (chat.settings.promptId === 'default') this.bumpRevision(chat.id);
            this.sqlite.prepare('UPDATE library_state SET revision = revision + 1 WHERE id = 1').run();
          }
          this.sqlite.pragma('user_version = 5');
        })();
      } else if (version !== 5) throw new Error('Unsupported database schema version.');
      this.contexts = new ContextStore(this);
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
    return { ...row.data, id: row.id, revision: row.revision } as unknown as Saved<T>;
  }
  snapshot(chatId = 'main'): ChatSnapshot {
    const chat = this.chat(chatId);
    const connectionId = chat.settings.connectionId === undefined ? 'main' : chat.settings.connectionId;
    const connection = connectionId ? this.db.select().from(schema.connections).where(eq(schema.connections.id, connectionId)).get()?.settings ?? null : null;
    const hasApiKey = Boolean(connectionId && this.db.select().from(schema.credentials).where(eq(schema.credentials.id, connectionId)).get()?.apiKey);
    const turns: Turn[] = this.db.select().from(schema.turns).where(eq(schema.turns.chatId, chatId)).orderBy(asc(schema.turns.position)).all().map(row => ({
      id: row.id, position: row.position, complete: row.complete,
      user: { id: row.userId, revision: row.userRevision, text: row.userText },
      assistant: { id: row.assistantId, revision: row.assistantRevision, text: row.assistantText },
    }));
    const generations: Generation[] = this.db.select().from(schema.generations).where(eq(schema.generations.chatId, chatId)).orderBy(desc(sql`rowid`)).all().map(row => ({
      id: row.id, turnId: row.turnId, status: row.status, sourceRevision: row.sourceRevision,
      request: row.request, usage: row.usage, partialText: row.partialText, error: row.error, createdAt: row.createdAt, updatedAt: row.updatedAt,
    }));
    return { id: chatId, revision: chat.revision, settings: chat.settings, connection, hasApiKey, turns, generations, context: this.contexts.snapshot(chatId, chat.settings.contextPresetId ?? null), sources: {
      prompt: this.selected<PromptPreset>(chat.settings.promptId, 'prompts'),
      character: this.selected<Character>(chat.settings.characterId, 'characters'), persona: this.selected<Persona>(chat.settings.personaId, 'personas'),
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
  private libraryRevision() { return (this.sqlite.prepare('SELECT revision FROM library_state WHERE id = 1').get() as { revision: number }).revision; }
  private checkLibrary(expected: number) {
    if (this.libraryRevision() !== expected) throw new AppError(409, 'revision_conflict', 'The library changed on another device. Reopen the editor before saving.');
    this.ensureIdle();
  }
  private bumpLibrary() { this.sqlite.prepare('UPDATE library_state SET revision = revision + 1 WHERE id = 1').run(); }
  private bumpAffected(kind: LibraryKind, id: string) {
    const key = kind === 'personas' ? 'personaId' : kind === 'characters' ? 'characterId' : kind === 'prompts' ? 'promptId' : kind === 'contexts' ? 'contextPresetId' : 'connectionId';
    for (const chat of this.db.select().from(schema.chats).all()) if (chat.settings[key] === id || (kind === 'connections' && (id === 'main' && chat.settings.connectionId === undefined || this.contextPreset(chat.settings.contextPresetId)?.connectionId === id))) this.bumpRevision(chat.id);
  }
  libraries(): LibrarySnapshot {
    const rows = this.db.select().from(schema.library).all();
    const list = <T>(kind: string) => rows.filter(r => r.kind === kind).map(r => ({ ...r.data, id: r.id, revision: r.revision })) as unknown as Saved<T>[];
    return {
      revision: this.libraryRevision(), personas: list<Persona>('personas'), characters: list<Character>('characters'), prompts: list<PromptPreset>('prompts'),
      contexts: list<ContextPreset>('contexts').map(preset => ({ ...preset, repairPrompt: preset.repairPrompt ?? defaultContextPreset.repairPrompt })),
      connections: this.db.select().from(schema.connections).all().map(r => ({ ...r.settings, id: r.id, revision: r.revision, hasApiKey: Boolean(this.db.select().from(schema.credentials).where(eq(schema.credentials.id, r.id)).get()?.apiKey) })),
      chats: this.db.select().from(schema.chats).all().map(c => ({ id: c.id, title: c.settings.title, revision: c.revision,
        turnCount: (this.sqlite.prepare('SELECT count(*) AS n FROM turns WHERE chat_id = ?').get(c.id) as { n: number }).n,
        running: Boolean(this.db.select().from(schema.generations).where(and(eq(schema.generations.chatId, c.id), eq(schema.generations.status, 'running'))).get()) || this.contexts.running(c.id),
      })),
    };
  }
  saveLibrary(expected: number, kind: LibraryKind, data: Character | Persona | PromptPreset | ContextPreset | Connection, id?: string, apiKey?: string) {
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
        this.db.insert(schema.library).values({ id: identity, kind, revision: (old?.revision ?? -1) + 1, data: data as Character | Persona | PromptPreset | ContextPreset }).onConflictDoUpdate({ target: schema.library.id, set: { data: data as Character | Persona | PromptPreset | ContextPreset, revision: (old?.revision ?? -1) + 1 } }).run();
      }
      this.bumpLibrary(); this.bumpAffected(kind, identity); return identity;
    })();
  }
  importLibrary(expected: number, kind: 'characters' | 'personas', items: (Character | Persona)[]) {
    return this.sqlite.transaction(() => {
      this.checkLibrary(expected);
      return items.map(data => this.saveLibrary(this.libraryRevision(), kind, data));
    })();
  }
  deleteLibrary(expected: number, kind: LibraryKind, id: string) {
    this.sqlite.transaction(() => {
      this.checkLibrary(expected);
      if (kind === 'prompts' && id === 'default') throw new AppError(409, 'default_prompt', 'The default prompt can be edited or restored, but cannot be deleted.');
      const key = kind === 'personas' ? 'personaId' : kind === 'characters' ? 'characterId' : kind === 'prompts' ? 'promptId' : kind === 'contexts' ? 'contextPresetId' : 'connectionId';
      if (this.db.select().from(schema.chats).all().some(c => c.settings[key] === id || (kind === 'connections' && id === 'main' && c.settings.connectionId === undefined))) throw new AppError(409, 'item_in_use', 'Select a different item in the chats using this one before deleting it.');
      if (kind === 'connections') {
        if (this.libraries().contexts.some(preset => preset.connectionId === id)) throw new AppError(409, 'item_in_use', 'A context preset uses this summarization Connection. Change that preset first.');
        this.db.delete(schema.credentials).where(eq(schema.credentials.id, id)).run();
        if (!this.db.delete(schema.connections).where(eq(schema.connections.id, id)).run().changes) throw new AppError(404, 'item_not_found', 'Connection not found.');
      } else if (!this.db.delete(schema.library).where(and(eq(schema.library.id, id), eq(schema.library.kind, kind))).run().changes) throw new AppError(404, 'item_not_found', 'Library item not found.');
      this.bumpLibrary();
    })();
  }
  private validateSelections(settings: ReturnType<typeof selectionsSchema.parse>) {
    if (settings.connectionId && !this.db.select().from(schema.connections).where(eq(schema.connections.id, settings.connectionId)).get()) throw new AppError(422, 'missing_connection', 'Selected Connection not found.');
    this.selected(settings.promptId, 'prompts'); this.selected(settings.characterId, 'characters'); this.selected(settings.personaId, 'personas');
    this.contextPreset(settings.contextPresetId);
  }
  createChat(input: ReturnType<typeof selectionsSchema.parse>) {
    return this.sqlite.transaction(() => {
      this.validateSelections(input);
      const id = randomUUID();
      this.db.insert(schema.chats).values({ id, revision: 0, settings: { ...initialSettings, ...input } }).run();
      const card = this.selected<Character>(input.characterId, 'characters');
      const persona = this.selected<Persona>(input.personaId, 'personas');
      const greeting = trimBoundaryNewlines(replaceNameMacros(card?.first_mes ?? '', persona?.name ?? 'You', card?.name ?? 'Character'));
      if (greeting) this.insertTurn(id, 1, { user: '', assistant: greeting, complete: true });
      this.bumpLibrary(); return id;
    })();
  }
  updateChat(expected: number, chatId: string, input: ReturnType<typeof selectionsSchema.parse>) {
    this.sqlite.transaction(() => {
      this.checkRevision(expected, chatId); this.ensureIdle(chatId); this.validateSelections(input);
      if (input.contextPresetId === null && this.contexts.snapshot(chatId, null).archivedTurnIds.length) throw new AppError(409, 'restore_context_first', 'Clear memory in Memory before disabling the context preset.');
      this.db.update(schema.chats).set({ settings: { ...this.chat(chatId).settings, ...input, instructions: '', character: '', persona: '' } }).where(eq(schema.chats.id, chatId)).run();
      this.bumpRevision(chatId);
    })();
  }
  deleteChat(expected: number, chatId: string) {
    this.sqlite.transaction(() => {
      this.checkRevision(expected, chatId); this.ensureIdle(chatId);
      this.db.delete(schema.chats).where(eq(schema.chats.id, chatId)).run(); this.bumpLibrary();
    })();
  }
  private insertTurn(chatId: string, position: number, turn: ImportedTurn) {
    this.db.insert(schema.turns).values({ id: randomUUID(), chatId, position, complete: turn.complete,
      userId: randomUUID(), userRevision: 0, userText: turn.user, assistantId: randomUUID(), assistantRevision: 0, assistantText: turn.assistant }).run();
  }
  replaceHistory(expected: number, chatId: string, turns: ImportedTurn[]) {
    this.sqlite.transaction(() => {
      this.checkRevision(expected, chatId); this.ensureIdle(chatId);
      this.contexts.clear(chatId);
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
      if (settings.contextPresetId === null && this.contexts.snapshot(chatId, null).archivedTurnIds.length) throw new AppError(409, 'restore_context_first', 'Clear memory in Memory before disabling the context preset.');
      const connectionId = settings.connectionId ?? 'main';
      const old = this.db.select().from(schema.connections).where(eq(schema.connections.id, connectionId)).get();
      this.db.insert(schema.connections).values({ id: connectionId, settings: connection, revision: (old?.revision ?? -1) + 1 }).onConflictDoUpdate({ target: schema.connections.id, set: { settings: connection, revision: (old?.revision ?? -1) + 1 } }).run();
      if (apiKey !== undefined) this.db.insert(schema.credentials).values({ id: connectionId, apiKey }).onConflictDoUpdate({ target: schema.credentials.id, set: { apiKey } }).run();
      this.db.update(schema.chats).set({ settings: { ...settings, connectionId, contextPresetId: settings.contextPresetId === undefined ? this.chat(chatId).settings.contextPresetId ?? null : settings.contextPresetId } }).where(eq(schema.chats.id, chatId)).run();
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
      this.db.update(schema.generations).set({ request }).where(eq(schema.generations.id, id)).run();
    })();
  }
  checkpoint(id: string, partialText: string) {
    if (this.generation(id)?.status !== 'running') return false;
    this.db.update(schema.generations).set({ partialText, updatedAt: new Date().toISOString() }).where(eq(schema.generations.id, id)).run(); return true;
  }
  finish(id: string, status: Exclude<GenerationStatus, 'running' | 'interrupted'>, text: string, error: string | null = null, usage: TokenUsage | null = null) {
    return this.sqlite.transaction(() => {
      const generation = this.generation(id);
      if (!generation || generation.status !== 'running') return false;
      if (status === 'succeeded') {
        text = trimBoundaryNewlines(text);
        if (!text.trim()) throw new AppError(502, 'empty_response', 'The model returned no text. The turn remains pending; retry or delete it.');
        this.checkRevision(generation.sourceRevision, generation.chatId);
        const turn = this.db.select().from(schema.turns).where(eq(schema.turns.id, generation.turnId)).get();
        if (!turn || turn.complete) throw new AppError(409, 'stale_result', 'The turn is no longer awaiting this response.');
        this.db.update(schema.turns).set({ assistantText: text, assistantRevision: turn.assistantRevision + 1, complete: true }).where(eq(schema.turns.id, turn.id)).run();
      }
      this.db.update(schema.generations).set({ status, partialText: text, error, usage, updatedAt: new Date().toISOString() }).where(eq(schema.generations.id, id)).run();
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
      this.bumpRevision(chatId);
    })();
  }
  deleteTurn(expected: number, turnId: string, chatId = 'main') {
    this.sqlite.transaction(() => {
      this.checkRevision(expected, chatId); this.ensureIdle(chatId);
      if (!this.db.delete(schema.turns).where(and(eq(schema.turns.id, turnId), eq(schema.turns.chatId, chatId))).run().changes) throw new AppError(404, 'turn_not_found', 'Turn not found.');
      this.bumpRevision(chatId);
    })();
  }
  close() {
    if (!this.sqlite.open) return;
    this.sqlite.prepare('DELETE FROM runtime_owner WHERE id = 1 AND token = ?').run(this.ownerToken); this.sqlite.close();
  }
}
