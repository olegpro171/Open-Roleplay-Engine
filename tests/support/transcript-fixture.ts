import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Store } from '../../src/persistence/store.js';
import { responseVariants, turns } from '../../src/persistence/schema.js';
import { importedTurnsSchema, type ImportedTurn } from '../../src/shared/library.js';

/** Seed a disposable fixture branch whose only possible content is its initial greeting. */
export function seedTranscript(store: Store, revision: number, chatId: string, input: ImportedTurn[]) {
  const transcript = importedTurnsSchema.parse(input);
  return store.sqlite.transaction(() => {
    store.checkRevision(revision, chatId);
    store.ensureIdle(chatId);
    const existing = store.readTurns(chatId);
    if (existing.length > 1 || existing.some(turn => !turn.complete || turn.user.text !== '') ||
        store.generationPage(chatId, { limit: 1 }).items.length) {
      throw new Error('Transcript fixtures require a fresh branch.');
    }
    store.db.delete(turns).where(eq(turns.chatId, chatId)).run();
    for (const [index, turn] of transcript.entries()) {
      const id = randomUUID();
      const variantId = turn.complete ? `original-${id}` : null;
      store.db.insert(turns).values({
        id, chatId, position: index + 1, complete: turn.complete,
        userId: randomUUID(), userRevision: 0, userText: turn.user,
        assistantId: randomUUID(), assistantRevision: 0, assistantText: turn.assistant, selectedVariantId: variantId,
      }).run();
      if (variantId) store.db.insert(responseVariants).values({ id: variantId, turnId: id, text: turn.assistant, sourceRevision: 0, generationId: null, createdAt: '' }).run();
    }
    return store.bumpRevision(chatId);
  })();
}
