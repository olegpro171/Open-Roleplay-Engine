import { message } from '../shared/localization.js';
import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { appearanceSchema, appearanceStatusSchema, defaultAppearance, type AppearanceStatus } from '../shared/appearance.js';
import { AppError } from '../core/errors.js';

const legacySavedSchema = appearanceStatusSchema.extend({
  version: z.literal(1), settings: appearanceSchema.omit({ chatTextScale: true, displayCharacterPicture: true }),
}).strict().transform(value => ({ ...value, settings: { ...defaultAppearance, ...value.settings } }));
const version2SavedSchema = appearanceStatusSchema.extend({
  version: z.literal(2), settings: appearanceSchema.omit({ displayCharacterPicture: true }),
}).strict().transform(value => ({ ...value, settings: { ...value.settings, displayCharacterPicture: defaultAppearance.displayCharacterPicture } }));
const savedSchema = z.union([legacySavedSchema, version2SavedSchema, appearanceStatusSchema.extend({ version: z.literal(3) }).strict()]);
// Older open clients preserve newer appearance preferences when saving.
const saveSchema = appearanceStatusSchema.extend({ settings: appearanceSchema.partial({ chatTextScale: true, displayCharacterPicture: true }) });

export class AppearanceSettings {
  constructor(private file: string) {}

  status(): AppearanceStatus {
    try {
      const { revision, settings } = savedSchema.parse(JSON.parse(readFileSync(this.file, 'utf8')));
      return { revision, settings };
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { revision: 0, settings: { ...defaultAppearance } };
      const failure = new AppError(500, 'appearance_unavailable', message("errors.saved_chat_appearance_settings_could_not_be_read"));
      failure.cause = error;
      throw failure;
    }
  }

  save(value: unknown): AppearanceStatus {
    const input = saveSchema.parse(value);
    const current = this.status();
    if (input.revision !== current.revision) throw new AppError(409, 'appearance_conflict', message("errors.chat_appearance_changed_in_another_window_reload_chat"));
    const next = { revision: current.revision + 1, settings: {
      ...input.settings,
      chatTextScale: input.settings.chatTextScale ?? current.settings.chatTextScale,
      displayCharacterPicture: input.settings.displayCharacterPicture ?? current.settings.displayCharacterPicture,
    } };
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      try {
        writeFileSync(temporary, JSON.stringify({ version: 3, ...next }), { mode: 0o600, flag: 'wx' });
        renameSync(temporary, this.file);
      } finally {
        if (existsSync(temporary)) unlinkSync(temporary);
      }
    } catch (error) {
      const failure = new AppError(500, 'appearance_save_failed', message("errors.chat_appearance_could_not_be_saved_previous_settings"));
      failure.cause = error;
      throw failure;
    }
    return next;
  }
}
