import { z } from 'zod';
import { AppError } from '../core/errors.js';
import { connectionSchema, saveSettingsSchema, type Connection } from '../shared/contracts.js';
import { connectionFileMaxBytes, connectionPlaintextMaxBytes } from '../shared/connection-files.js';
import { message } from '../shared/localization.js';
import { protectBytes, unprotectBytes } from './protected-files.js';

const profileSchema = z.object({
  format: z.literal('ore-connection'),
  version: z.literal(1),
  connection: connectionSchema,
  apiKey: saveSettingsSchema.shape.apiKey,
}).strict();

export async function exportConnection(connection: Connection, apiKey: string | undefined, password: string): Promise<Buffer> {
  const profile = profileSchema.parse({ format: 'ore-connection', version: 1, connection, ...(apiKey === undefined ? {} : { apiKey }) });
  const plaintext = Buffer.from(JSON.stringify(profile), 'utf8');
  try {
    return await protectBytes(plaintext, 'connection', password);
  } finally { plaintext.fill(0); }
}

export async function importConnection(base64: string, password: string) {
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length > connectionFileMaxBytes || bytes.toString('base64') !== base64) {
    throw new AppError(422, 'invalid_connection_file', message('errors.invalid_connection_file'));
  }
  const plaintext = await unprotectBytes(bytes, 'connection', password, connectionPlaintextMaxBytes);
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
    const profile = profileSchema.safeParse(JSON.parse(text));
    if (profile.success) return profile.data;
  } catch { /* Invalid JSON/UTF-8 receives an authored error without uploaded values. */ }
  finally { plaintext.fill(0); }
  throw new AppError(422, 'invalid_connection_file', message('errors.invalid_connection_file'));
}
