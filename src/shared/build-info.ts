import { z } from 'zod';

export const databaseSchemaVersion = 14;
export const buildInfoSchema = z.object({
  kind: z.enum(['release', 'development']),
  commit: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
  schema: z.literal(databaseSchemaVersion),
  node: z.string().min(1),
  platform: z.string().min(1),
  arch: z.string().min(1),
}).strict();
export type BuildInfo = z.infer<typeof buildInfoSchema>;
