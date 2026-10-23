import { z } from 'zod';

export const filePasswordMaxLength = 256;
export const filePasswordSchema = z.string().max(filePasswordMaxLength);
export const protectedFilePasswordSchema = z.object({ password: filePasswordSchema.default('') }).strict();

export const protectedFileFormat = {
  magic: 'OREENC\r\n', version: 1, saltBytes: 16, nonceBytes: 12, tagBytes: 16,
} as const;
export const protectedFileHeaderBytes = protectedFileFormat.magic.length + 2
  + protectedFileFormat.saltBytes + protectedFileFormat.nonceBytes;
export const protectedFileOverheadBytes = protectedFileHeaderBytes + protectedFileFormat.tagBytes;
