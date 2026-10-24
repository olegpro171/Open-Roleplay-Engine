import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { chatBehaviorStatusSchema, defaultChatBehavior, type ChatBehaviorStatus } from '../shared/chat-behavior.js';
import { message } from '../shared/localization.js';
import { AppError } from '../core/errors.js';

const savedSchema = chatBehaviorStatusSchema.extend({ version: z.literal(1) }).strict();

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
    const input = chatBehaviorStatusSchema.parse(value);
    const current = this.status();
    if (input.revision !== current.revision) {
      throw new AppError(409, 'chat_behavior_conflict', message('chat_behavior.conflict'));
    }
    const next = { revision: current.revision + 1, settings: input.settings };
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      try {
        writeFileSync(temporary, JSON.stringify({ version: 1, ...next }), { mode: 0o600, flag: 'wx' });
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
