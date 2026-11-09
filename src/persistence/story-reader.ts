import { message } from '../shared/localization.js';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { AppError } from '../core/errors.js';
import { promptDiagnostics } from '../core/prompt-diagnostics.js';
import { staleSummarySources } from '../core/context.js';
import { refKey } from '../shared/context.js';
import { refusalAffected, refusalFindings } from '../core/summary-refusals.js';
import { transcriptQuerySchema, type PinList, type StoryGeneration, type StoryPreparation, type StorySnapshot, type TranscriptQuery } from '../shared/transcript.js';
import { pinnedExcerpts } from '../core/pinned-turns.js';
import { hasPromptMarker } from '../shared/library.js';
import type { Store } from './store.js';
import * as schema from './schema.js';

// Bounded presentation queries; context reads may cache refusal-check metadata.
// Engine/coordinator callers use Store.engineSnapshot.
export class StoryReader {
  constructor(private readonly store: Store) {}

  read(chatId: string, query: TranscriptQuery): StorySnapshot {
    const input = transcriptQuerySchema.parse(query);
    return this.store.sqlite.transaction(() => {
      const header = this.store.chatHeader(chatId);
      if (input.revision !== undefined) this.store.checkRevision(input.revision, chatId);
      const count = (position?: number) => this.store.db.select({ value: sql<number>`count(*)` }).from(schema.turns)
        .where(and(eq(schema.turns.chatId, chatId), position === undefined ? undefined : sql`${schema.turns.position} < ${position}`)).get()?.value ?? 0;
      const totalTurns = count();
      const pinCount = this.store.pinCount(chatId);
      let start = Math.max(0, totalTurns - input.limit);
      if (input.anchor) {
        const anchor = this.store.db.select({ position: schema.turns.position }).from(schema.turns)
          .where(and(eq(schema.turns.chatId, chatId), eq(schema.turns.id, input.anchor))).get();
        if (!anchor) throw new AppError(409, 'transcript_changed', message("errors.the_displayed_history_changed_reload_the_transcript_to"));
        start = Math.min(Math.max(0, count(anchor.position) + input.shift), Math.max(0, totalTurns - input.limit));
      }
      const positions = this.store.db.select({ position: schema.turns.position }).from(schema.turns)
        .where(eq(schema.turns.chatId, chatId)).orderBy(asc(schema.turns.position)).limit(input.limit).offset(start).all();
      const first = positions[0], last = positions.at(-1);
      const turns = first && last ? this.store.readTurns(chatId, { first: first.position, last: last.position }) : [];
      const latestTurn = this.store.db.select({ id: schema.turns.id, complete: schema.turns.complete }).from(schema.turns)
        .where(eq(schema.turns.chatId, chatId)).orderBy(desc(schema.turns.position)).limit(1).get() ?? null;
      const latestGeneration = this.generations(chatId, undefined)[0] ?? null;
      const context = this.store.contexts.snapshot(chatId, header.settings.contextPresetId ?? null);
      const archived = new Set(context.archivedTurnIds);
      // Freshness needs provenance for all turns, never their prose or variants.
      const sources = this.store.db.select({ turnId: schema.turns.id, userRevision: schema.turns.userRevision,
        assistantRevision: sql<number>`coalesce(${schema.responseVariants.sourceRevision}, ${schema.turns.assistantRevision})`, complete: schema.turns.complete,
      }).from(schema.turns).leftJoin(schema.responseVariants, eq(schema.responseVariants.id, schema.turns.selectedVariantId))
        .where(eq(schema.turns.chatId, chatId)).all();
      const stale = staleSummarySources(sources, context);
      const refused = refusalAffected(context);
      const activePreparation = context.jobs.find(job => job.status === 'running');
      const latestPreparation = activePreparation ?? context.jobs[0];
      let preparation: StoryPreparation | null = null;
      if (latestPreparation && (activePreparation || latestPreparation.sourceRevision === header.revision)) {
        const { id, generationId, mode, status, error, errorMessage, working } = latestPreparation;
        preparation = {
          id, generationId, mode, status, error, errorMessage,
          completedSteps: (latestPreparation.reusedCount ?? 0) + (latestPreparation.generatedCount ?? 0),
          ...(working ? { working: { inputTokens: working.inputTokens, targetInputTokens: working.targetInputTokens, level: working.operation?.level ?? null } } : {}),
        };
      }
      return {
        ...header, promptDiagnostics: promptDiagnostics(header.sources, header.settings.authorNote, pinCount > 0), sources: { ...header.sources, lorebook: undefined }, totalTurns, pinCount, latestTurn, latestGeneration,
        preparing: Boolean(activePreparation), preparation,
        memory: { revision: context.revision, selectedCount: context.selected.length, awaitingReview: context.jobs.some(job => job.status === 'awaiting_review'), refusalCount: refusalFindings(context).length, refusalBlocked: context.selected.some(ref => refused.has(refKey(ref))),
          archivedCount: sources.filter(source => archived.has(source.turnId)).length, stale: context.selected.some(ref => stale.has(refKey(ref))) },
        page: { turns: turns.map((turn, index) => ({ ...turn, ordinal: start + index + 1, archived: archived.has(turn.id) })),
          generations: turns.length ? this.generations(chatId, turns.map(turn => turn.id)) : [],
          hasOlder: start > 0, hasNewer: start + turns.length < totalTurns },
      };
    })();
  }

  pins(chatId: string): PinList {
    const view = this.store.sqlite.transaction(() => {
      const { revision, sources, connection } = this.store.chatHeader(chatId);
      // Number surviving turns in Story order, then read prose only for pins.
      const ordinals = this.store.db.$with('ordinals').as(this.store.db.select({
        id: schema.turns.id,
        ordinal: sql<number>`row_number() OVER (ORDER BY ${schema.turns.position})`.as('ordinal'),
      }).from(schema.turns).where(eq(schema.turns.chatId, chatId)));
      const turns = this.store.db.with(ordinals).select({
        id: schema.turns.id, ordinal: ordinals.ordinal, user: schema.turns.userText, assistant: schema.turns.assistantText,
      }).from(schema.turns).innerJoin(ordinals, eq(ordinals.id, schema.turns.id))
        .where(and(eq(schema.turns.chatId, chatId), sql`${schema.turns.pinned} = 1`))
        .orderBy(asc(schema.turns.position)).all();
      return {
        revision, markerEnabled: Boolean(sources.prompt && hasPromptMarker(sources.prompt, 'pinned_messages')),
        hasConnection: Boolean(connection), turns,
      };
    })();
    return { ...view, turns: view.turns.map(turn => {
      const excerpts = pinnedExcerpts(turn.user, turn.assistant);
      return { ...turn, hasModelText: Boolean(excerpts.user || excerpts.assistant) };
    }) };
  }

  private generations(chatId: string, turnIds: string[] | undefined): StoryGeneration[] {
    const selection = this.store.db.select({
      id: schema.generations.id, turnId: schema.generations.turnId, status: schema.generations.status,
      sourceRevision: schema.generations.sourceRevision, kind: schema.generations.kind,
      requestAvailable: sql<number>`${schema.generations.request} IS NOT NULL`, usage: schema.generations.usage,
      partialText: sql<string>`CASE WHEN ${schema.generations.status} = 'succeeded' THEN '' ELSE ${schema.generations.partialText} END`,
      reasoningText: sql<string>`substr(${schema.generations.reasoningText}, -2000)`,
      error: schema.generations.error, errorMessage: schema.generations.errorMessage, createdAt: schema.generations.createdAt, updatedAt: schema.generations.updatedAt,
    }).from(schema.generations).where(and(eq(schema.generations.chatId, chatId), turnIds ? inArray(schema.generations.turnId, turnIds) : undefined))
      .orderBy(desc(sql`${schema.generations}.rowid`));
    const rows = turnIds ? selection.all() : selection.limit(1).all();
    return rows.map(row => ({ ...row, requestAvailable: Boolean(row.requestAvailable) }));
  }
}
