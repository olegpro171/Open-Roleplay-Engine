import { z } from 'zod';

export const enterKeyBehaviorSchema = z.enum(['ctrl-enter', 'enter', 'button-only']);
export type EnterKeyBehavior = z.infer<typeof enterKeyBehaviorSchema>;
export const chatBehaviorSchema = z.object({ enterKeyBehavior: enterKeyBehaviorSchema }).strict();
export const defaultChatBehavior = { enterKeyBehavior: 'ctrl-enter' } as const;
export const chatBehaviorStatusSchema = z.object({
  revision: z.number().int().nonnegative(), settings: chatBehaviorSchema,
}).strict();
export type ChatBehaviorStatus = z.infer<typeof chatBehaviorStatusSchema>;
