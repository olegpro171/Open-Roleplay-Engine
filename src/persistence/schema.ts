import { blob, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { ChatSettings, Connection, GenerationStatus, RequestPreview, TokenUsage } from '../shared/contracts.js';
import type { Character, Persona, PromptPreset } from '../shared/library.js';
import type { ContextPreset } from '../shared/context.js';
import type { Lorebook } from '../shared/lorebook.js';

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
  data: text('data', { mode: 'json' }).$type<Character | Persona | PromptPreset | ContextPreset | Lorebook>().notNull(),
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
  usage: text('usage', { mode: 'json' }).$type<TokenUsage | null>(),
  partialText: text('partial_text').notNull(), error: text('error'),
  createdAt: text('created_at').notNull(), updatedAt: text('updated_at').notNull(),
});

export const tags = sqliteTable('tags', {
  id: text('id').primaryKey(), name: text('name').notNull(),
  canonicalKey: text('canonical_key').notNull(), revision: integer('revision').notNull().default(0),
}, table => [uniqueIndex('tags_canonical_key').on(table.canonicalKey)]);
export const characterTags = sqliteTable('character_tags', {
  characterId: text('character_id').notNull().references(() => library.id, { onDelete: 'cascade' }),
  tagId: text('tag_id').notNull().references(() => tags.id, { onDelete: 'cascade' }),
}, table => [primaryKey({ columns: [table.characterId, table.tagId] }), index('character_tags_by_tag').on(table.tagId, table.characterId)]);

export const pictureAssets = sqliteTable('picture_assets', {
  id: text('id').primaryKey(), digest: text('digest').notNull(), mime: text('mime').notNull(),
  width: integer('width').notNull(), height: integer('height').notNull(), orientation: integer('orientation').notNull(), firstFrame: integer('first_frame', { mode: 'boolean' }).notNull(),
  original: blob('original', { mode: 'buffer' }).notNull(), preview: blob('preview', { mode: 'buffer' }).notNull(), renditionVersion: integer('rendition_version').notNull(),
});
export const characterPictures = sqliteTable('character_pictures', {
  characterId: text('character_id').primaryKey().references(() => library.id, { onDelete: 'cascade' }),
  assetId: text('asset_id').notNull().references(() => pictureAssets.id), key: text('key').notNull(), revision: integer('revision').notNull(),
  crop: text('crop', { mode: 'json' }).$type<import('../shared/pictures.js').PictureCrop>().notNull(), thumbnail: blob('thumbnail', { mode: 'buffer' }).notNull(),
}, table => [index('character_pictures_asset').on(table.assetId), uniqueIndex('character_picture_key').on(table.key)]);
