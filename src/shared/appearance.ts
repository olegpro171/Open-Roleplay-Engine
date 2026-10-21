import { z } from 'zod';

export const defaultSpeechColor = '#a8c9f0';
export const speechColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a six-digit hex color.').transform(value => value.toLowerCase());
export const appearanceSchema = z.object({
  characterSpeechColor: speechColorSchema,
  personaSpeechColor: speechColorSchema,
}).strict();
export const defaultAppearance: Appearance = { characterSpeechColor: defaultSpeechColor, personaSpeechColor: defaultSpeechColor };
export const appearanceStatusSchema = z.object({ revision: z.number().int().nonnegative(), settings: appearanceSchema }).strict();
export type Appearance = z.infer<typeof appearanceSchema>;
export type AppearanceStatus = z.infer<typeof appearanceStatusSchema>;
