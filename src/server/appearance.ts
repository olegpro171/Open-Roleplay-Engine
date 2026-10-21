import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { appearanceSchema, appearanceStatusSchema, defaultAppearance, type AppearanceStatus } from '../shared/appearance.js';
import { AppError } from '../core/errors.js';

const legacySavedSchema = appearanceStatusSchema.extend({
  version: z.literal(1), settings: appearanceSchema.omit({ chatTextScale: true }),
}).strict().transform(value => ({ ...value, settings: { ...value.settings, chatTextScale: defaultAppearance.chatTextScale } }));
const savedSchema = z.union([legacySavedSchema, appearanceStatusSchema.extend({ version: z.literal(2) }).strict()]);
// Older open clients can still save colors without resetting the saved text scale.
const saveSchema = appearanceStatusSchema.extend({ settings: appearanceSchema.partial({ chatTextScale: true }) });

export class AppearanceSettings {
  constructor(private file: string) {}

  status(): AppearanceStatus {
    try {
      const { revision, settings } = savedSchema.parse(JSON.parse(readFileSync(this.file, 'utf8')));
      return { revision, settings };
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { revision: 0, settings: { ...defaultAppearance } };
      const failure = new AppError(500, 'appearance_unavailable', 'Saved chat appearance settings could not be read. Check or restore the application configuration file.');
      failure.cause = error;
      throw failure;
    }
  }

  save(value: unknown): AppearanceStatus {
    const input = saveSchema.parse(value);
    const current = this.status();
    if (input.revision !== current.revision) throw new AppError(409, 'appearance_conflict', 'Chat appearance changed in another window. Reload chat appearance before saving again.');
    const next = { revision: current.revision + 1, settings: { ...input.settings, chatTextScale: input.settings.chatTextScale ?? current.settings.chatTextScale } };
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      try {
        writeFileSync(temporary, JSON.stringify({ version: 2, ...next }), { mode: 0o600, flag: 'wx' });
        renameSync(temporary, this.file);
      } finally {
        if (existsSync(temporary)) unlinkSync(temporary);
      }
    } catch (error) {
      const failure = new AppError(500, 'appearance_save_failed', 'Chat appearance could not be saved. Previous settings were retained. Try again.');
      failure.cause = error;
      throw failure;
    }
    return next;
  }
}
