import { and, eq, inArray, sql } from 'drizzle-orm';
import { roleplayConnectionId } from '../shared/chat-defaults.js';
import { characterLabel, type LibraryKind } from '../shared/library.js';
import * as schema from './schema.js';
import type { Store } from './store.js';

export const selectionKeys = {
  connections: 'connectionId', prompts: 'promptId', contexts: 'contextPresetId',
  lorebooks: 'lorebookId', characters: 'characterId', personas: 'personaId',
} as const;

export function libraryItemLabels(db: Store['db'], kind: LibraryKind, id?: string) {
  if (kind === 'connections') {
    return db.select({
      id: schema.connections.id, revision: schema.connections.revision,
      name: sql<string>`json_extract(${schema.connections.settings}, '$.name')`,
      createdAt: schema.connections.createdAt, updatedAt: schema.connections.updatedAt,
    }).from(schema.connections).where(id === undefined ? undefined : eq(schema.connections.id, id))
      .orderBy(sql`rowid`).all();
  }
  const rows = db.select({
    id: schema.library.id, revision: schema.library.revision,
    name: sql<string>`json_extract(${schema.library.data}, '$.name')`,
    comment: sql<string | null>`json_extract(${schema.library.data}, '$.titleComment')`,
    createdAt: schema.library.createdAt, updatedAt: schema.library.updatedAt,
  }).from(schema.library).where(and(eq(schema.library.kind, kind), id === undefined ? undefined : eq(schema.library.id, id)))
    .orderBy(schema.library.id).all();
  return rows.map(({ comment, ...item }) => ({
    ...item, name: kind === 'characters' || kind === 'personas' ? characterLabel({ name: item.name, titleComment: comment ?? undefined }) : item.name,
  }));
}

export function resolveLibraryDependencies(db: Store['db'], kind: LibraryKind, id: string) {
  const linkedRecords = (recordKind: 'contexts' | 'characters', key: 'connectionId' | 'lorebookId') => db.select({
    id: schema.library.id, revision: schema.library.revision,
    name: sql<string>`json_extract(${schema.library.data}, '$.name')`,
    comment: sql<string | null>`json_extract(${schema.library.data}, '$.titleComment')`,
  }).from(schema.library).where(and(eq(schema.library.kind, recordKind),
    sql`json_extract(${schema.library.data}, ${'$.' + key}) = ${id}`)).orderBy(schema.library.id).all()
    .map(({ comment, ...item }) => ({ ...item, name: characterLabel({ name: item.name, titleComment: comment ?? undefined }) }));
  const contexts = kind === 'connections' ? linkedRecords('contexts', 'connectionId') : [];
  const characters = kind === 'lorebooks' ? linkedRecords('characters', 'lorebookId') : [];
  const contextById = new Map(contexts.map(item => [item.id, item]));
  const selected = sql<string | null>`json_extract(${schema.chatGroups.settings}, ${'$.' + selectionKeys[kind]})`;
  const contextId = sql<string | null>`json_extract(${schema.chatGroups.settings}, '$.contextPresetId')`;
  const groups = db.select({
    id: schema.chatGroups.id,
    name: sql<string>`json_extract(${schema.chatGroups.settings}, '$.title')`,
    selected, contextId,
    implicit: sql<number>`json_type(${schema.chatGroups.settings}, '$.connectionId') IS NULL`,
  }).from(schema.chatGroups).where(kind === 'connections' ? undefined : eq(selected, id))
    .orderBy(schema.chatGroups.id).all().flatMap(group => {
      const direct = (kind === 'connections' ? roleplayConnectionId(group.implicit ? undefined : group.selected) : group.selected) === id;
      const memoryPreset = kind === 'connections' && group.contextId ? contextById.get(group.contextId) ?? null : null;
      return direct || memoryPreset ? [{ id: group.id, name: group.name, direct, implicit: kind === 'connections' && Boolean(group.implicit), memoryPreset }] : [];
    });
  const branches = new Map<string, { id: string; branchName: string | null; revision: number }[]>();
  // Use a single bound JSON value even when thousands of groups are linked.
  if (groups.length) {
    const rows = db.select({
      groupId: schema.chats.groupId, id: schema.chats.id, branchName: schema.chats.branchName, revision: schema.chats.revision,
    }).from(schema.chats).where(inArray(schema.chats.groupId,
      sql`(SELECT value FROM json_each(${JSON.stringify(groups.map(group => group.id))}))`))
      .orderBy(schema.chats.id).all();
    for (const { groupId, ...branch } of rows) {
      if (groupId === null) continue;
      const siblings = branches.get(groupId);
      if (siblings) siblings.push(branch);
      else branches.set(groupId, [branch]);
    }
  }
  return { chats: groups.map(group => ({ ...group, branches: branches.get(group.id) ?? [] })), contexts, characters };
}

export function hasLibraryDependencies(dependencies: ReturnType<typeof resolveLibraryDependencies>) {
  return Boolean(dependencies.chats.length || dependencies.characters.length || dependencies.contexts.length);
}
