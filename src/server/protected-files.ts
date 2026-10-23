import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import { appendFileSync, closeSync, createReadStream, createWriteStream, openSync, rmSync, writeFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { AppError } from '../core/errors.js';
import { message } from '../shared/localization.js';
import { filePasswordMaxLength, filePasswordSchema, protectedFileFormat as format, protectedFileHeaderBytes, protectedFileOverheadBytes } from '../shared/protected-files.js';

// Kind is authenticated so a future Connection file cannot be interpreted as a backup.
const kinds = { backup: 1 } as const;
type ProtectedFileKind = keyof typeof kinds;
const magic = Buffer.from(format.magic, 'ascii');
const maxPasswordHeaderLength = 4 * Math.ceil(filePasswordMaxLength * 4 / 3);
let activeOperations = 0;

function invalidFile() {
  return new AppError(422, 'protected_file_invalid', message('errors.protected_file_invalid'));
}
function invalidPassword() {
  return new AppError(400, 'invalid_file_password', message('errors.invalid_file_password'));
}

export function validateFilePassword(value: unknown): string {
  const parsed = filePasswordSchema.safeParse(value);
  if (!parsed.success) throw invalidPassword();
  return parsed.data;
}

// Uploads remain binary; the ASCII header transports an exact UTF-8 password,
// including spaces and non-Latin text, without putting it in a URL or saved state.
export function filePasswordFromHeader(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > maxPasswordHeaderLength || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw invalidPassword();
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw invalidPassword();
  let password: string;
  try { password = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw invalidPassword(); }
  return validateFilePassword(password);
}

async function withKey<T>(password: string, salt: Buffer, action: (key: Buffer) => Promise<T> | T): Promise<T> {
  validateFilePassword(password);
  // Bound authenticated concurrent requests as well as the memory cost of scrypt.
  // Work factors are format constants, never attacker-controlled file parameters.
  if (activeOperations >= 2) throw new AppError(429, 'protected_file_busy', message('errors.protected_file_busy'));
  activeOperations++;
  let key: Buffer | undefined;
  try {
    key = await new Promise<Buffer>((resolve, reject) => {
      scrypt(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, result) => {
        if (error) reject(error); else resolve(result);
      });
    });
    return await action(key);
  } finally {
    key?.fill(0);
    activeOperations--;
  }
}

export function isProtectedFile(bytes: Buffer): boolean {
  return bytes.subarray(0, magic.length).equals(magic);
}

export async function protectFile(source: string, destination: string, kind: ProtectedFileKind, password: string): Promise<void> {
  const salt = randomBytes(format.saltBytes), nonce = randomBytes(format.nonceBytes);
  const header = Buffer.concat([magic, Buffer.from([format.version, kinds[kind]]), salt, nonce]);
  await withKey(password, salt, async key => {
    const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: format.tagBytes });
    cipher.setAAD(header);
    // Never expose a partially protected file to the download route.
    // Acquire ownership before the cleanup guard: an existing destination must
    // survive, but a failed first write may leave a newly created partial file.
    const descriptor = openSync(destination, 'wx', 0o600);
    try {
      try { writeFileSync(descriptor, header); }
      finally { closeSync(descriptor); }
      await pipeline(createReadStream(source), cipher, createWriteStream(destination, { flags: 'a', mode: 0o600 }));
      appendFileSync(destination, cipher.getAuthTag());
    } catch (error) {
      rmSync(destination, { force: true });
      throw error;
    }
  });
}

export async function unprotectBytes(bytes: Buffer, kind: ProtectedFileKind, password: string, maxPlaintextBytes: number): Promise<Buffer> {
  if (!isProtectedFile(bytes) || bytes.length < protectedFileOverheadBytes
    || bytes.length - protectedFileOverheadBytes > maxPlaintextBytes
    || bytes[magic.length] !== format.version || bytes[magic.length + 1] !== kinds[kind]) throw invalidFile();
  const saltStart = magic.length + 2, nonceStart = saltStart + format.saltBytes;
  const salt = bytes.subarray(saltStart, nonceStart), nonce = bytes.subarray(nonceStart, protectedFileHeaderBytes);
  return withKey(password, salt, key => {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: format.tagBytes });
    decipher.setAAD(bytes.subarray(0, protectedFileHeaderBytes));
    decipher.setAuthTag(bytes.subarray(bytes.length - format.tagBytes));
    const plaintext = decipher.update(bytes.subarray(protectedFileHeaderBytes, bytes.length - format.tagBytes));
    try {
      const final = decipher.final();
      return final.length ? Buffer.concat([plaintext, final]) : plaintext;
    } catch {
      // Unauthenticated bytes must never reach SQLite validation or staging.
      plaintext.fill(0);
      throw invalidFile();
    }
  });
}
