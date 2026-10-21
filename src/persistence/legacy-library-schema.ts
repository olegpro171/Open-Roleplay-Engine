import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { ChatSettings, Connection } from '../shared/contracts.js';
import type { LibraryCharacter, Persona, PromptPreset } from '../shared/library.js';
import type { ContextPreset } from '../shared/context.js';
import type { Lorebook } from '../shared/lorebook.js';

// Frozen definitions for migrations that run before timestamp columns exist.
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
  data: text('data', { mode: 'json' }).$type<LibraryCharacter | Persona | PromptPreset | ContextPreset | Lorebook>().notNull(),
});
