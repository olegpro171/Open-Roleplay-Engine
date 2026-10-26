import { z } from 'zod';

export const chatTextScales = [90, 100, 110, 120] as const;
export const chatTextScaleSchema = z.union(chatTextScales.map(scale => z.literal(scale)));
export type ChatTextScale = z.infer<typeof chatTextScaleSchema>;
export const speechColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a six-digit hex color.').transform(value => value.toLowerCase());
export const themeSchema = z.enum(['dark', 'light', 'midnight-black']);
export type Theme = z.infer<typeof themeSchema>;
export const appearanceSchema = z.object({
  characterSpeechColor: speechColorSchema.nullable(),
  personaSpeechColor: speechColorSchema.nullable(),
  theme: themeSchema,
  chatTextScale: chatTextScaleSchema,
  displayCharacterPicture: z.boolean(),
  showReasoningDuringGeneration: z.boolean(),
}).strict();
export const defaultAppearance: Appearance = { theme: 'dark', characterSpeechColor: null, personaSpeechColor: null, chatTextScale: 100, displayCharacterPicture: true, showReasoningDuringGeneration: false };
export const appearanceStatusSchema = z.object({ revision: z.number().int().nonnegative(), settings: appearanceSchema }).strict();
export type Appearance = z.infer<typeof appearanceSchema>;
export type AppearanceStatus = z.infer<typeof appearanceStatusSchema>;
