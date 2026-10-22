import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { message } from '../shared/localization.js';
import { chatDefaultCommandSchema, chatDefaultsStatusSchema, initialChatDefaults, type ChatDefaultsStatus } from '../shared/chat-defaults.js';
import type { Store } from '../persistence/store.js';

const savedSchema = chatDefaultsStatusSchema.extend({ version: z.literal(1) }).strict();

export class ChatDefaultsSettings {
  constructor(private file: string) {}

  status(): ChatDefaultsStatus {
    try {
      const { revision, settings } = savedSchema.parse(JSON.parse(readFileSync(this.file, 'utf8')));
      return { revision, settings };
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return structuredClone(initialChatDefaults);
      const failure = new AppError(500, 'chat_defaults_unavailable', message('errors.chat_defaults_unavailable'));
      failure.cause = error;
      throw failure;
    }
  }

  save(value: unknown, store: Store): ChatDefaultsStatus {
    const input = chatDefaultCommandSchema.parse(value);
    const current = this.status();
    if (input.revision !== current.revision || input.libraryRevision !== store.libraryRevision()) {
      throw new AppError(409, 'chat_defaults_conflict', message('errors.chat_defaults_conflict'));
    }
    if (input.id !== null && !store.libraries()[input.kind].some(item => item.id === input.id)) {
      throw new AppError(404, 'item_not_found', message('errors.library_item_not_found'));
    }
    if (current.settings[input.kind] === input.id) return current;
    const next = { revision: current.revision + 1, settings: { ...current.settings, [input.kind]: input.id } };
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      try {
        writeFileSync(temporary, JSON.stringify({ version: 1, ...next }), { mode: 0o600, flag: 'wx' });
        renameSync(temporary, this.file);
      } finally {
        if (existsSync(temporary)) unlinkSync(temporary);
      }
    } catch (error) {
      const failure = new AppError(500, 'chat_defaults_save_failed', message('errors.chat_defaults_save_failed'));
      failure.cause = error;
      throw failure;
    }
    return next;
  }
}
