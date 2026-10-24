import { z } from 'zod';

export const enterKeyBehaviorSchema = z.enum(['ctrl-enter', 'enter', 'button-only']);
export type EnterKeyBehavior = z.infer<typeof enterKeyBehaviorSchema>;
export const chatBehaviorSchema = z.object({
  enterKeyBehavior: enterKeyBehaviorSchema,
  allowInputOvershoot: z.boolean().default(true),
  maximumOvershootTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(100),
  autoRetryMemory: z.boolean().default(true),
  memoryMaxRetries: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(10),
}).strict();
export type ChatBehavior = z.infer<typeof chatBehaviorSchema>;
export const defaultChatBehavior: ChatBehavior = chatBehaviorSchema.parse({ enterKeyBehavior: 'ctrl-enter' });
export const chatBehaviorStatusSchema = z.object({
  revision: z.number().int().nonnegative(), settings: chatBehaviorSchema,
}).strict();
export type ChatBehaviorStatus = z.infer<typeof chatBehaviorStatusSchema>;
