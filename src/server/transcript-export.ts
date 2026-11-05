import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Store } from '../persistence/store.js';
import { portableDownloadFilename } from '../shared/downloads.js';

const transcriptRow = z.object({ user: z.string(), assistant: z.string(), complete: z.union([z.literal(0), z.literal(1)]), date: z.string().nullable() });

export function prepareTranscriptExport(store: Store, staging: string, chatId: string, revision: number) {
  const directory = mkdtempSync(join(staging, 'transcript-'));
  const path = join(directory, 'chat.jsonl');
  const cleanup = () => rmSync(directory, { recursive: true, force: true });
  try {
    const filename = store.sqlite.transaction(() => {
      store.checkRevision(revision, chatId);
      const { sources, branchName } = store.chatHeader(chatId);
      const user = sources.persona?.name || 'You';
      const character = sources.character?.name || 'Character';
      const fd = openSync(path, 'wx', 0o600);
      try {
        const write = (record: object) => writeFileSync(fd, `${JSON.stringify(record)}\n`);
        write({ user_name: user, character_name: character, chat_metadata: {} });
        const saved = store.sqlite.prepare(`SELECT user_text AS user, assistant_text AS assistant, complete, message_at AS date
          FROM turns WHERE chat_id = ? ORDER BY position`);
        const line = (mes: string, is_user: boolean, date: string | null) =>
          write({ name: is_user ? user : character, is_user, is_system: false, ...(date ? { send_date: date } : {}), mes, extra: {} });
        for (const row of saved.iterate(chatId)) {
          const turn = transcriptRow.parse(row);
          // ORE represents single-speaker turns using an empty opposite part.
          if (turn.user !== '' || !turn.complete) line(turn.user, true, turn.date);
          if (turn.complete && (turn.assistant !== '' || turn.user === '')) line(turn.assistant, false, turn.date);
        }
      } finally { closeSync(fd); }
      return portableDownloadFilename(branchName ?? 'Main', '.jsonl');
    })();
    return { filename, source: { path, cleanup } };
  } catch (error) {
    cleanup();
    throw error;
  }
}
