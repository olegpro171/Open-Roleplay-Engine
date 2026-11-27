import { AppError } from '../core/errors.js';
import { message } from '../shared/localization.js';
import { sameComposerEdit } from '../shared/composer-draft.js';
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type Database from 'better-sqlite3';
import { composerDrafts } from './schema.js';
import type * as schema from './schema.js';
import type { ComposerDraft, ComposerDraftReference, ComposerDraftSave } from '../shared/composer-draft.js';

export class ComposerDraftStore {
  constructor(private db: BetterSQLite3Database<typeof schema>, private sqlite: Database.Database, private branchRevision: (id: string) => number) {}

  read(chatId: string): ComposerDraft {
    this.branchRevision(chatId);
    const { revision, sentRevision, text, edit } = this.db.select().from(composerDrafts).where(eq(composerDrafts.chatId, chatId)).get()
      ?? { revision: 0, sentRevision: 0, text: '', edit: null };
    return { revision, sentRevision, text, edit };
  }

  save(chatId: string, input: ComposerDraftSave) {
    return this.sqlite.transaction(() => {
      const current = this.read(chatId);
      if (input.dismissSuggestionId !== undefined || input.replaceAtBranchRevision !== undefined) {
        if (sameComposerEdit(current.edit, input.edit) && current.text === input.text) return { draft: current, changed: false };
        if (current.revision !== input.baseRevision) {
          throw new AppError(409, 'draft_changed', message('impersonate.draft_changed'));
        }
        // Retain the older revision-checked draft command for callers without a suggestion ID.
        if (input.dismissSuggestionId === undefined && this.branchRevision(chatId) !== input.replaceAtBranchRevision) {
          throw new AppError(409, 'draft_changed', message('errors.the_chat_changed_on_another_device_review_the'));
        }
      }
      if ((input.baseRevision ?? 0) < current.sentRevision
        || (current.edit?.editorId === input.edit.editorId && current.edit.sequence >= input.edit.sequence)) {
        return { draft: current, changed: false };
      }
      const draft: ComposerDraft = { ...current, revision: current.revision + 1, text: input.text, edit: input.edit };
      this.write(chatId, draft);
      return { draft, changed: true };
    })();
  }

  // The caller commits this with the pending turn. An exact Send replay exits before this step.
  submitted(chatId: string, submitted: ComposerDraftReference) {
    const current = this.read(chatId);
    const superseded = current.revision === submitted.baseRevision
      || (current.edit?.editorId === submitted.edit.editorId && current.edit.sequence <= submitted.edit.sequence);
    const revision = current.revision + 1;
    this.write(chatId, { ...current, revision, sentRevision: revision, ...(superseded ? { text: '', edit: null } : {}) });
  }

  private write(chatId: string, draft: ComposerDraft) {
    this.db.insert(composerDrafts).values({ chatId, ...draft })
      .onConflictDoUpdate({ target: composerDrafts.chatId, set: draft }).run();
  }
}
