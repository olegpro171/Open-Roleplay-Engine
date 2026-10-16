import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { ChatSettings, Connection, GenerationStatus, RequestPreview } from '../shared/contracts.js';
import type { Character, Persona, PromptPreset } from '../shared/library.js';

export const chats = sqliteTable('chats', {
  id: text('id').primaryKey(), revision: integer('revision').notNull(),
  settings: text('settings', { mode: 'json' }).$type<ChatSettings>().notNull(),
});
export const connections = sqliteTable('connections', {
  id: text('id').primaryKey(), settings: text('settings', { mode: 'json' }).$type<Connection>().notNull(),
  revision: integer('revision').notNull().default(0),
});
export const library = sqliteTable('library', {
  id: text('id').primaryKey(), kind: text('kind').notNull(), revision: integer('revision').notNull(),
  data: text('data', { mode: 'json' }).$type<Character | Persona | PromptPreset>().notNull(),
});
// Server-only tables; never spread their records into an API response.
export const credentials = sqliteTable('credentials', { id: text('id').primaryKey(), apiKey: text('api_key').notNull() });
export const owners = sqliteTable('owners', {
  id: text('id').primaryKey(), salt: text('salt').notNull(), hash: text('hash').notNull(),
});
export const sessions = sqliteTable('sessions', { hash: text('hash').primaryKey(), expiresAt: integer('expires_at').notNull() });
export const turns = sqliteTable('turns', {
  chatId: text('chat_id').notNull(),
  id: text('id').primaryKey(), position: integer('position').notNull(),
  complete: integer('complete', { mode: 'boolean' }).notNull(),
  userId: text('user_id').notNull(), userRevision: integer('user_revision').notNull(), userText: text('user_text').notNull(),
  assistantId: text('assistant_id').notNull(), assistantRevision: integer('assistant_revision').notNull(), assistantText: text('assistant_text').notNull(),
});
export const generations = sqliteTable('generations', {
  chatId: text('chat_id').notNull(),
  id: text('id').primaryKey(), requestId: text('request_id').notNull(), command: text('command').notNull(),
  turnId: text('turn_id').notNull(), status: text('status').$type<GenerationStatus>().notNull(),
  sourceRevision: integer('source_revision').notNull(),
  request: text('request', { mode: 'json' }).$type<RequestPreview | null>(),
  partialText: text('partial_text').notNull(), error: text('error'),
  createdAt: text('created_at').notNull(), updatedAt: text('updated_at').notNull(),
});
