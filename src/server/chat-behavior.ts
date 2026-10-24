import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { chatBehaviorSchema, chatBehaviorStatusSchema, defaultChatBehavior, type ChatBehaviorStatus } from '../shared/chat-behavior.js';
import { message } from '../shared/localization.js';
import { AppError } from '../core/errors.js';

// Version 1 contains only the keyboard preference. Schema defaults supply the
// newly introduced preferences without rewriting the original file on read.
const savedSchema = chatBehaviorStatusSchema.extend({ version: z.union([z.literal(1), z.literal(2)]) }).strict();
const commandSchema = chatBehaviorStatusSchema.extend({
  settings: chatBehaviorSchema.pick({ enterKeyBehavior: true }).passthrough(),
});

export class ChatBehaviorSettings {
  constructor(private file: string) {}

  status(): ChatBehaviorStatus {
    try {
      const { revision, settings } = savedSchema.parse(JSON.parse(readFileSync(this.file, 'utf8')));
      return { revision, settings };
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return { revision: 0, settings: { ...defaultChatBehavior } };
      }
      const failure = new AppError(500, 'chat_behavior_unavailable', message('chat_behavior.read_failed'));
      failure.cause = error;
      throw failure;
    }
  }

  save(value: unknown): ChatBehaviorStatus {
    const command = commandSchema.parse(value);
    const current = this.status();
    // Older callers save only the keyboard preference. Validate supplied fields
    // with the full contract while retaining preferences they do not know yet.
    const input = chatBehaviorStatusSchema.parse({ ...command, settings: { ...current.settings, ...command.settings } });
    if (input.revision !== current.revision) {
      throw new AppError(409, 'chat_behavior_conflict', message('chat_behavior.conflict'));
    }
    const next = { revision: current.revision + 1, settings: input.settings };
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      try {
        writeFileSync(temporary, JSON.stringify({ version: 2, ...next }), { mode: 0o600, flag: 'wx' });
        renameSync(temporary, this.file);
      } finally {
        if (existsSync(temporary)) unlinkSync(temporary);
      }
    } catch (error) {
      const failure = new AppError(500, 'chat_behavior_save_failed', message('chat_behavior.write_failed'));
      failure.cause = error;
      throw failure;
    }
    return next;
  }
}
