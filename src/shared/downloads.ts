import { z } from 'zod';

const invalidFilenameCharacters = /[<>:"/\\|?*\p{Cc}\p{Cs}]+/gu;
const windowsDeviceName = /^(?:CON|PRN|AUX|NUL|(?:COM|LPT)[1-9¹²³])(?: *\.|$)/i;
const filenameByteLimit = 255;
const utf8 = new TextEncoder();

export function portableDownloadFilename(stem: string, extension: string): string {
  let base = stem.replace(invalidFilenameCharacters, '-').replace(/^[ .]+|[ .]+$/g, '');
  if (windowsDeviceName.test(base)) base = `_${base}`;
  const remaining = filenameByteLimit - utf8.encode(extension).length;
  let bytes = 0;
  let end = 0;
  for (const character of base) {
    bytes += utf8.encode(character).length;
    if (bytes > remaining) break;
    end += character.length;
  }
  return `${base.slice(0, end).replace(/[ .]+$/g, '') || 'download'}${extension}`;
}

export const downloadTokenSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const preparedDownloadSchema = z.object({
  url: z.string().regex(/^\/api\/downloads\/[0-9a-f]{64}$/),
  filename: z.string().min(1).max(200).refine(filename =>
    filename === filename.trim() && !filename.endsWith('.') &&
    filename.search(invalidFilenameCharacters) === -1 && utf8.encode(filename).length <= filenameByteLimit),
}).strict();
export const downloadLifetimeMs = 5 * 60_000;
export const downloadLimit = 4;
