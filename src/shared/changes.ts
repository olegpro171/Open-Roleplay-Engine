import { z } from 'zod';

export const changeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all') }).strict(),
  z.object({ kind: z.literal('library') }).strict(),
  z.object({ kind: z.literal('settings'), setting: z.enum(['appearance', 'chat-defaults', 'chat-behavior']) }).strict(),
  z.object({ kind: z.literal('chat'), chatId: z.string().min(1).max(100), detail: z.enum(['state', 'stream']) }).strict(),
]);
export type Change = z.infer<typeof changeSchema>;
