import { z } from 'zod';
import { revisionSchema } from './contracts.js';
import type { LibrarySnapshot } from './library.js';

export const chatDefaultKindSchema = z.enum(['prompts', 'connections', 'contexts']);
export type ChatDefaultKind = z.infer<typeof chatDefaultKindSchema>;
const identity = z.string().min(1).max(100).nullable();
export const chatDefaultsSchema = z.object({ prompts: identity, connections: identity, contexts: identity }).strict();
export const chatDefaultsStatusSchema = z.object({ revision: revisionSchema, settings: chatDefaultsSchema }).strict();
export const chatDefaultCommandSchema = z.object({
  revision: revisionSchema, libraryRevision: revisionSchema, kind: chatDefaultKindSchema, id: identity,
}).strict();
export type ChatDefaultsStatus = z.infer<typeof chatDefaultsStatusSchema>;
export const initialChatDefaults: ChatDefaultsStatus = { revision: 0, settings: { prompts: 'default', connections: null, contexts: 'default-context' } };

/** Deleted selections fall back to the original new-chat behavior. */
export function resolveChatDefaults(settings: ChatDefaultsStatus['settings'], library: Pick<LibrarySnapshot, ChatDefaultKind>) {
  const selected = (kind: ChatDefaultKind) => library[kind].find(item => item.id === settings[kind])?.id;
  return {
    promptId: selected('prompts') ?? 'default',
    connectionId: selected('connections') ?? library.connections[0]?.id ?? null,
    contextPresetId: selected('contexts') ?? null,
  };
}
