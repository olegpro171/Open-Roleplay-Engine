import { z } from 'zod';

export const downloadTokenSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const preparedDownloadSchema = z.object({
  url: z.string().regex(/^\/api\/downloads\/[0-9a-f]{64}$/),
  filename: z.string().min(1).max(200).regex(/^[a-zA-Z0-9_.-]+$/),
}).strict();
export const downloadLifetimeMs = 5 * 60_000;
export const downloadLimit = 4;
