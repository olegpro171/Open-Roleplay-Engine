import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { asc, desc, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { AppError } from '../core/errors.js';
import type { ChatSettings, ChatSnapshot, Connection, Generation, GenerationStatus, RequestPreview, Turn } from '../shared/contracts.js';
import * as schema from './schema.js';

const initialSettings: ChatSettings = {
  title: 'A new story', instructions: 'Write the next response in this roleplay. Stay consistent with the established story.',
  character: '', persona: '', targetInputTokens: 32_000,
};

export class Store {
  readonly sqlite: Database.Database;
  readonly db;
  private readonly ownerToken = randomUUID();

  constructor(filename: string, migrationsDirectory = resolve('migrations')) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.sqlite = new Database(filename);
    if (filename !== ':memory:') chmodSync(filename, 0o600);
    this.sqlite.pragma('journal_mode = WAL');
    this.sqlite.pragma('foreign_keys = ON');
    this.sqlite.pragma('busy_timeout = 5000');
    const version = this.sqlite.pragma('user_version', { simple: true });
    if (version === 0) {
      this.sqlite.transaction(() => {
        this.sqlite.exec(readFileSync(resolve(migrationsDirectory, '0001_initial.sql'), 'utf8'));
        this.sqlite.pragma('user_version = 1');
      })();
    } else if (version !== 1) throw new Error('Unsupported database schema version.');
    this.db = drizzle(this.sqlite, { schema });
    try {
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
    } catch (error) { this.sqlite.close(); throw error; }
    this.db.insert(schema.chats).values({ id: 'main', revision: 0, settings: initialSettings }).onConflictDoNothing().run();
  }

  snapshot(): ChatSnapshot {
    const chat = this.db.select().from(schema.chats).get()!;
    const connection = this.db.select().from(schema.connections).get()?.settings ?? null;
    const hasApiKey = Boolean(this.db.select().from(schema.credentials).get()?.apiKey);
    const turns: Turn[] = this.db.select().from(schema.turns).orderBy(asc(schema.turns.position)).all().map((row) => ({
      id: row.id, position: row.position, complete: row.complete,
      user: { id: row.userId, revision: row.userRevision, text: row.userText },
      assistant: { id: row.assistantId, revision: row.assistantRevision, text: row.assistantText },
    }));
    const generations: Generation[] = this.db.select().from(schema.generations).orderBy(desc(sql`rowid`)).all().map((row) => ({
      id: row.id, turnId: row.turnId, status: row.status, sourceRevision: row.sourceRevision,
      request: row.request, partialText: row.partialText, error: row.error, createdAt: row.createdAt, updatedAt: row.updatedAt,
    }));
    return { revision: chat.revision, settings: chat.settings, connection, hasApiKey, turns, generations };
  }

  private checkRevision(expected: number) {
    if (this.snapshot().revision !== expected) throw new AppError(409, 'revision_conflict', 'The chat changed on another device. Review the latest state and try again.');
  }
  private ensureIdle() {
    if (this.db.select().from(schema.generations).where(eq(schema.generations.status, 'running')).get()) {
      throw new AppError(409, 'generation_running', 'Cancel or wait for the current response before editing or retrying.');
    }
  }
  private bumpRevision() {
    const revision = this.db.select().from(schema.chats).get()!.revision + 1;
    this.db.update(schema.chats).set({ revision }).where(eq(schema.chats.id, 'main')).run();
    return revision;
  }

  saveSettings(expected: number, connection: Connection, settings: ChatSettings, apiKey?: string) {
    this.sqlite.transaction(() => {
      this.checkRevision(expected); this.ensureIdle();
      this.db.insert(schema.connections).values({ id: 'main', settings: connection }).onConflictDoUpdate({ target: schema.connections.id, set: { settings: connection } }).run();
      if (apiKey !== undefined) this.db.insert(schema.credentials).values({ id: 'main', apiKey }).onConflictDoUpdate({ target: schema.credentials.id, set: { apiKey } }).run();
      this.db.update(schema.chats).set({ settings }).where(eq(schema.chats.id, 'main')).run();
      this.bumpRevision();
    })();
  }

  begin(expected: number, requestId: string, text?: string): { id: string; fresh: boolean } {
    return this.sqlite.transaction(() => {
      const command = JSON.stringify({ kind: text === undefined ? 'retry' : 'submit', text });
      const existing = this.db.select().from(schema.generations).where(eq(schema.generations.requestId, requestId)).get();
      if (existing) {
        if (existing.command !== command) throw new AppError(409, 'request_id_conflict', 'That request identity was already used for a different command.');
        return { id: existing.id, fresh: false };
      }
      this.checkRevision(expected); this.ensureIdle();
      const snapshot = this.snapshot();
      if (!snapshot.connection) throw new AppError(422, 'connection_required', 'Save a Connection before sending a turn.');
      let turn = snapshot.turns.at(-1);
      if (text !== undefined) {
        if (turn && !turn.complete) throw new AppError(409, 'pending_turn', 'Resolve or delete the pending turn before submitting another.');
        const row = {
          id: randomUUID(), position: (turn?.position ?? 0) + 1, complete: false,
          userId: randomUUID(), userRevision: 0, userText: text,
          assistantId: randomUUID(), assistantRevision: 0, assistantText: '',
        };
        this.db.insert(schema.turns).values(row).run();
        turn = { id: row.id, position: row.position, complete: false, user: { id: row.userId, revision: 0, text }, assistant: { id: row.assistantId, revision: 0, text: '' } };
      } else if (!turn || turn.complete) throw new AppError(409, 'no_pending_turn', 'There is no pending turn to retry.');
      const id = randomUUID();
      const now = new Date().toISOString();
      this.db.insert(schema.generations).values({
        id, requestId, command, turnId: turn!.id, status: 'running', sourceRevision: this.bumpRevision(),
        request: null, partialText: '', error: null, createdAt: now, updatedAt: now,
      }).run();
      return { id, fresh: true };
    })();
  }

  generation(id: string) { return this.db.select().from(schema.generations).where(eq(schema.generations.id, id)).get(); }
  apiKey(): string { return this.db.select().from(schema.credentials).get()?.apiKey ?? ''; }

  saveRequest(id: string, request: RequestPreview) {
    this.sqlite.transaction(() => {
      const generation = this.generation(id);
      if (!generation || generation.status !== 'running') throw new AppError(409, 'inactive_generation', 'The response is no longer active.');
      this.checkRevision(generation.sourceRevision);
      this.db.update(schema.generations).set({ request }).where(eq(schema.generations.id, id)).run();
    })();
  }
  checkpoint(id: string, partialText: string) {
    const generation = this.generation(id);
    if (generation?.status !== 'running') return false;
    this.db.update(schema.generations).set({ partialText, updatedAt: new Date().toISOString() }).where(eq(schema.generations.id, id)).run();
    return true;
  }

  finish(id: string, status: Exclude<GenerationStatus, 'running' | 'interrupted'>, text: string, error: string | null = null) {
    return this.sqlite.transaction(() => {
      const generation = this.generation(id);
      if (!generation || generation.status !== 'running') return false;
      if (status === 'succeeded') {
        this.checkRevision(generation.sourceRevision);
        const turn = this.db.select().from(schema.turns).where(eq(schema.turns.id, generation.turnId)).get();
        if (!turn || turn.complete) throw new AppError(409, 'stale_result', 'The turn is no longer awaiting this response.');
        this.db.update(schema.turns).set({ assistantText: text, assistantRevision: turn.assistantRevision + 1, complete: true }).where(eq(schema.turns.id, turn.id)).run();
      }
      this.db.update(schema.generations).set({ status, partialText: text, error, updatedAt: new Date().toISOString() }).where(eq(schema.generations.id, id)).run();
      this.bumpRevision();
      return true;
    })();
  }

  recoverInterrupted() {
    this.sqlite.transaction(() => {
      if (!this.db.select().from(schema.generations).where(eq(schema.generations.status, 'running')).get()) return;
      this.db.update(schema.generations).set({ status: 'interrupted', error: 'The server stopped during this response. Retry explicitly to start a new model request.', updatedAt: new Date().toISOString() }).where(eq(schema.generations.status, 'running')).run();
      this.bumpRevision();
    })();
  }

  editPart(expected: number, turnId: string, part: 'user' | 'assistant', text: string) {
    this.sqlite.transaction(() => {
      this.checkRevision(expected); this.ensureIdle();
      const turn = this.db.select().from(schema.turns).where(eq(schema.turns.id, turnId)).get();
      if (!turn) throw new AppError(404, 'turn_not_found', 'Turn not found.');
      if (part === 'assistant' && !turn.complete) throw new AppError(409, 'pending_response', 'A pending response cannot be completed by editing. Retry or delete its turn.');
      this.db.update(schema.turns).set(part === 'user' ? { userText: text, userRevision: turn.userRevision + 1 } : { assistantText: text, assistantRevision: turn.assistantRevision + 1 }).where(eq(schema.turns.id, turnId)).run();
      this.bumpRevision();
    })();
  }
  deleteTurn(expected: number, turnId: string) {
    this.sqlite.transaction(() => {
      this.checkRevision(expected); this.ensureIdle();
      if (!this.db.delete(schema.turns).where(eq(schema.turns.id, turnId)).run().changes) throw new AppError(404, 'turn_not_found', 'Turn not found.');
      this.bumpRevision();
    })();
  }
  close() {
    if (!this.sqlite.open) return;
    this.sqlite.prepare('DELETE FROM runtime_owner WHERE id = 1 AND token = ?').run(this.ownerToken);
    this.sqlite.close();
  }
}
