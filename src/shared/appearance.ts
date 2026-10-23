import { z } from 'zod';

export const defaultSpeechColor = '#a8c9f0';
export const chatTextScales = [90, 100, 110, 120] as const;
export const chatTextScaleSchema = z.union(chatTextScales.map(scale => z.literal(scale)));
export type ChatTextScale = z.infer<typeof chatTextScaleSchema>;
export const speechColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a six-digit hex color.').transform(value => value.toLowerCase());
export const appearanceSchema = z.object({
  characterSpeechColor: speechColorSchema,
  personaSpeechColor: speechColorSchema,
  chatTextScale: chatTextScaleSchema,
  displayCharacterPicture: z.boolean(),
}).strict();
export const defaultAppearance: Appearance = { characterSpeechColor: defaultSpeechColor, personaSpeechColor: defaultSpeechColor, chatTextScale: 100, displayCharacterPicture: true };
export const appearanceStatusSchema = z.object({ revision: z.number().int().nonnegative(), settings: appearanceSchema }).strict();
export type Appearance = z.infer<typeof appearanceSchema>;
export type AppearanceStatus = z.infer<typeof appearanceStatusSchema>;
