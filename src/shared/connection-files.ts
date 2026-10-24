import { z } from 'zod';
import { revisionSchema } from './contracts.js';
import { filePasswordSchema, protectedFileOverheadBytes } from './protected-files.js';

export const connectionPlaintextMaxBytes = 128 * 1024;
export const connectionFileMaxBytes = connectionPlaintextMaxBytes + protectedFileOverheadBytes;
export const connectionExportSchema = z.object({
  password: filePasswordSchema.default(''),
  includeApiKey: z.boolean().default(false),
}).strict();
export const connectionImportSchema = z.object({
  revision: revisionSchema,
  password: filePasswordSchema.default(''),
  base64: z.string().min(1).max(4 * Math.ceil(connectionFileMaxBytes / 3))
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
}).strict();
