import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type Database from 'better-sqlite3';
import { composerDrafts } from './schema.js';
import type * as schema from './schema.js';
import type { ComposerDraft, ComposerDraftReference, ComposerDraftSave } from '../shared/composer-draft.js';

export class ComposerDraftStore {
  constructor(private db: BetterSQLite3Database<typeof schema>, private sqlite: Database.Database, private requireBranch: (id: string) => void) {}

  read(chatId: string): ComposerDraft {
    this.requireBranch(chatId);
    const { revision, sentRevision, text, edit } = this.db.select().from(composerDrafts).where(eq(composerDrafts.chatId, chatId)).get()
      ?? { revision: 0, sentRevision: 0, text: '', edit: null };
    return { revision, sentRevision, text, edit };
  }

  save(chatId: string, input: ComposerDraftSave) {
    return this.sqlite.transaction(() => {
      const current = this.read(chatId);
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
