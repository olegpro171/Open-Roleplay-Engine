import type Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { AppError } from '../core/errors.js';
import { readEmbeddedTags } from '../core/tags.js';
import { canonicalTagName, tagIdsSchema, tagLimits, tagNameSchema, tagPolicySchema, type TagCandidates, type TagPolicy, type TagReview } from '../shared/tags.js';
import { libraryCharacterSchema } from '../shared/library.js';
import * as schema from './schema.js';

/** Organization never changes prompt-bearing data or source/chat revisions. */
export class TagStore {
  private readonly db;
  constructor(private readonly sqlite: Database.Database, private readonly check: (revision: number) => void, private readonly bump: () => void) {
    this.db = drizzle(sqlite, { schema });
  }
  catalog() {
    return this.db.select({ id: schema.tags.id, name: schema.tags.name, revision: schema.tags.revision, usageCount: sql<number>`count(${schema.characterTags.characterId})` })
      .from(schema.tags).leftJoin(schema.characterTags, eq(schema.tags.id, schema.characterTags.tagId)).groupBy(schema.tags.id).all();
  }
  links() { return this.db.select().from(schema.characterTags).all(); }
  assigned(characterId: string) {
    return this.db.select({ id: schema.characterTags.tagId }).from(schema.characterTags).where(eq(schema.characterTags.characterId, characterId)).all().map(row => row.id);
  }
  private character(id: string) {
    const row = this.db.select().from(schema.library).where(eq(schema.library.id, id)).get();
    if (!row || row.kind !== 'characters') throw new AppError(404, 'character_not_found', 'Character not found.');
    return libraryCharacterSchema.parse(row.data);
  }
  private byName() { return new Map(this.db.select().from(schema.tags).all().map(tag => [tag.canonicalKey, tag])); }
  private collision(key: string, ownId?: string) {
    const match = this.db.select().from(schema.tags).where(eq(schema.tags.canonicalKey, key)).get();
    if (match && match.id !== ownId) throw new AppError(409, 'tag_name_conflict', `A tag named “${match.name}” already exists. Choose another name.`);
  }
  create(expected: number, input: string) {
    const name = tagNameSchema.parse(input), key = canonicalTagName(name);
    return this.sqlite.transaction(() => {
      this.check(expected); this.collision(key);
      if ((this.db.select({ count: sql<number>`count(*)` }).from(schema.tags).get()?.count ?? 0) >= tagLimits.catalog) throw new AppError(422, 'tag_catalog_limit', `The catalog is limited to ${tagLimits.catalog} tags. Delete an unused tag first.`);
      const id = randomUUID();
      this.db.insert(schema.tags).values({ id, name, canonicalKey: key }).run(); this.bump();
      return id;
    })();
  }
  rename(expected: number, id: string, input: string) {
    const name = tagNameSchema.parse(input), key = canonicalTagName(name);
    this.sqlite.transaction(() => {
      this.check(expected);
      const old = this.db.select().from(schema.tags).where(eq(schema.tags.id, id)).get();
      if (!old) throw new AppError(404, 'tag_not_found', 'Tag not found.');
      this.collision(key, id);
      if (old.name === name) return;
      this.db.update(schema.tags).set({ name, canonicalKey: key, revision: old.revision + 1 }).where(eq(schema.tags.id, id)).run(); this.bump();
    })();
  }
  delete(expected: number, id: string) {
    this.sqlite.transaction(() => {
      this.check(expected);
      if (!this.db.delete(schema.tags).where(eq(schema.tags.id, id)).run().changes) throw new AppError(404, 'tag_not_found', 'Tag not found.');
      this.bump();
    })();
  }
  /** Caller owns the encompassing character/import transaction and revision bump. */
  replaceInTransaction(characterId: string, input: string[]): boolean {
    if (!this.sqlite.inTransaction) throw new Error('Assignment writes require a checked transaction.');
    this.character(characterId);
    const ids = tagIdsSchema.parse(input), catalog = new Set(this.db.select({ id: schema.tags.id }).from(schema.tags).all().map(tag => tag.id));
    for (const id of ids) if (!catalog.has(id)) throw new AppError(422, 'missing_tag', 'A selected tag no longer exists. Refresh the catalog and review your selection.');
    const previous = new Set(this.assigned(characterId));
    if (previous.size === ids.length && ids.every(id => previous.has(id))) return false;
    this.db.delete(schema.characterTags).where(eq(schema.characterTags.characterId, characterId)).run();
    for (const tagId of ids) this.db.insert(schema.characterTags).values({ characterId, tagId }).run();
    return true;
  }
  setAssignments(expected: number, characterId: string, ids: string[]) {
    this.sqlite.transaction(() => {
      this.check(expected);
      if (this.replaceInTransaction(characterId, ids)) {
        this.db.update(schema.library).set({ updatedAt: new Date().toISOString() }).where(eq(schema.library.id, characterId)).run();
        this.bump();
      }
    })();
  }
  review(parsed: TagCandidates, assigned: string[] = []): TagReview {
    const catalog = this.byName();
    const existing: TagReview['existing'] = [], newTags: TagReview['newTags'] = [];
    for (const candidate of parsed.candidates) {
      const match = catalog.get(candidate.key);
      if (match) existing.push({ id: match.id, name: match.name, sourceIndexes: candidate.sourceIndexes });
      else newTags.push({ name: candidate.name, eligible: candidate.eligible, sourceIndexes: candidate.sourceIndexes });
    }
    const unionSize = new Set([...assigned, ...existing.map(tag => tag.id)]).size;
    const existingAssignments = unionSize - assigned.length;
    const assignmentError = `A character can have at most ${tagLimits.assignments} local tags. Remove assignments first or select Import none.`;
    let allBlocked: string | null = null;
    if (newTags.some(tag => !tag.eligible)) {
      allBlocked = `Import all requires every tag name to fit the ${tagLimits.name}-character local limit. Choose Existing or None.`;
    } else if (catalog.size + newTags.length > tagLimits.catalog) {
      allBlocked = `Import all would exceed the ${tagLimits.catalog}-tag catalog limit.`;
    } else if (unionSize + newTags.length > tagLimits.assignments) {
      allBlocked = assignmentError;
    }
    return {
      existing, newTags, notices: parsed.notices, omittedNotices: parsed.omittedNotices,
      modes: {
        none: { assign: 0, create: 0, blocked: null },
        existing: { assign: existingAssignments, create: 0, blocked: unionSize > tagLimits.assignments ? assignmentError : null },
        all: { assign: existingAssignments + newTags.length, create: newTags.length, blocked: allBlocked },
      },
    };
  }
  /** Called only inside a checked transaction. Returns unique links, creating all or none. */
  resolveInTransaction(parsed: TagCandidates, policyInput: TagPolicy, assigned: string[] = []) {
    if (!this.sqlite.inTransaction) throw new Error('Tag imports require a checked transaction.');
    const policy = tagPolicySchema.parse(policyInput), review = this.review(parsed, assigned);
    const effect = review.modes[policy];
    if (effect.blocked) throw new AppError(422, 'tag_import_limit', effect.blocked);
    const ids = new Set(assigned);
    if (policy !== 'none') for (const tag of review.existing) ids.add(tag.id);
    const catalog = this.byName();
    if (policy === 'all') for (const candidate of parsed.candidates) {
      if (catalog.has(candidate.key)) continue;
      const id = randomUUID();
      this.db.insert(schema.tags).values({ id, name: candidate.name, canonicalKey: candidate.key }).run(); ids.add(id);
    }
    return { ids: [...ids], report: { policy, assigned: effect.assign, created: effect.create } };
  }
  embeddedReview(characterId: string) { return this.review(readEmbeddedTags(this.character(characterId).source ?? {}), this.assigned(characterId)); }
  applyEmbedded(expected: number, characterId: string, policy: TagPolicy) {
    return this.sqlite.transaction(() => {
      this.check(expected);
      const parsed = readEmbeddedTags(this.character(characterId).source ?? {});
      const result = this.resolveInTransaction(parsed, policy, this.assigned(characterId));
      const changed = this.replaceInTransaction(characterId, result.ids);
      if (changed) this.db.update(schema.library).set({ updatedAt: new Date().toISOString() }).where(eq(schema.library.id, characterId)).run();
      if (changed || result.report.created) this.bump();
      return result.report;
    })();
  }
}
