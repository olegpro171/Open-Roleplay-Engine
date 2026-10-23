import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { createApp } from '../src/server/app.js';
import { BackupService } from '../src/server/backups.js';
import { protectFile, unprotectBytes } from '../src/server/protected-files.js';
import { backupLimits, type BackupReview } from '../src/shared/backups.js';

let directory: string;
const applications: Awaited<ReturnType<typeof createApp>>[] = [];
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'ore-protected-backups-')); });
afterEach(async () => {
  for (const application of applications.splice(0)) await application.app.close();
  rmSync(directory, { recursive: true, force: true });
});
async function open(name: string) {
  const application = await createApp({ database: join(directory, `${name}.sqlite`) });
  applications.push(application);
  const headers = { host: 'localhost', origin: 'http://localhost', 'content-type': 'application/json' };
  const session = await application.app.inject({ url: '/api/session', headers });
  const login = await application.app.inject({ method: 'POST', url: session.json<{ setupRequired: boolean }>().setupRequired ? '/api/setup' : '/api/login', headers, payload: { password: 'synthetic-owner-password' } });
  expect(login.statusCode).toBe(200);
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  const authenticated = { ...headers, cookie };
  return {
    ...application,
    headers: authenticated,
    export: (password: string) => application.app.inject({ method: 'POST', url: '/api/data/backup', headers: authenticated, payload: { password } }),
    inspect: (bytes: Buffer, password = '') => application.app.inject({ method: 'POST', url: '/api/data/stages', headers: { ...authenticated, 'content-type': 'application/octet-stream', 'x-ore-file-password': Buffer.from(password).toString('base64') }, payload: bytes }),
    command: (url: string, payload: unknown) => application.app.inject({ method: 'POST', url, headers: authenticated, payload: JSON.stringify(payload) }),
  };
}

it.each(['', '\uFEFF  Личный пароль 🔑  '])('imports protected credentials and exact history into another installation with password %j', async password => {
  const source = await open('source');
  const connectionId = source.store.saveLibrary(source.store.libraryRevision(), 'connections', {
    name: 'Synthetic model', endpoint: 'http://localhost:9999/v1', model: 'synthetic', contextWindow: 32000, maxOutputTokens: 1000, customParameters: {},
  }, undefined, 'sk-synthetic-private-key-for-export');
  source.store.replaceHistory(source.store.snapshot().revision, 'main', [
    { user: 'A private synthetic story.\nSecond line.', assistant: 'A saved response.', complete: true },
    { user: 'A pending turn.', assistant: '', complete: false },
  ]);
  const turns = source.store.snapshot().turns;
  const download = await source.export(password);
  expect(download.statusCode, download.body).toBe(200);
  expect(download.headers['content-disposition']).toMatch(/\.orebackup"$/);
  expect(download.rawPayload.subarray(0, 8).toString()).toBe('OREENC\r\n');
  for (const text of ['sk-synthetic-private-key-for-export', 'A private synthetic story.', password].filter(Boolean)) {
    expect(download.rawPayload.includes(Buffer.from(text))).toBe(false);
  }
  await expect.poll(() => readdirSync(join(directory, '.ore-backups-source.sqlite'))).toEqual([]);
  const destination = await open('destination'), before = destination.store.snapshot();
  const wrong = await destination.inspect(download.rawPayload, 'wrong password');
  expect(wrong.statusCode).toBe(422);
  expect(wrong.json().code).toBe('protected_file_invalid');
  expect(JSON.stringify(wrong.json())).not.toContain('sk-synthetic');
  expect(destination.store.snapshot()).toEqual(before);
  expect(readdirSync(join(directory, '.ore-backups-destination.sqlite'))).toEqual([]);
  const inspection = await destination.inspect(download.rawPayload, password);
  expect(inspection.statusCode, inspection.body).toBe(200);
  const review = inspection.json<BackupReview>();
  expect(review.blockers).toEqual([]);
  expect(review.digest).toBe(createHash('sha256').update(download.rawPayload).digest('hex'));
  expect(JSON.stringify(review)).not.toContain('sk-synthetic-private-key-for-export');
  expect(destination.store.snapshot()).toEqual(before);
  const command = { requestId: randomUUID(), digest: review.digest, token: review.token, overwrite: true };
  const result = await destination.command(`/api/data/stages/${review.stageId}/import`, command);
  expect(result.statusCode, result.body).toBe(200);
  expect(destination.store.connectionApiKey(connectionId)).toBe('sk-synthetic-private-key-for-export');
  expect(destination.store.snapshot().turns).toEqual(turns);
  expect((await destination.command(`/api/data/stages/${review.stageId}/import`, command)).json()).toEqual(result.json());
  await destination.app.close();
  const restarted = await open('destination');
  expect(restarted.store.connectionApiKey(connectionId)).toBe('sk-synthetic-private-key-for-export');
  expect(restarted.store.snapshot().turns).toEqual(turns);
  expect((await restarted.command(`/api/data/stages/${review.stageId}/import`, command)).json()).toEqual(result.json());
});

it('accepts older plaintext SQLite uploads and still rejects protected content with an invalid inner database', async () => {
  const application = await open('legacy');
  const encrypted = await application.export('secret');
  const plaintext = await unprotectBytes(encrypted.rawPayload, 'backup', 'secret', backupLimits.bytes);
  const legacy = await application.inspect(plaintext);
  expect(legacy.statusCode, legacy.body).toBe(200);
  const review = legacy.json<BackupReview>();
  const cancelled = await application.app.inject({ method: 'DELETE', url: `/api/data/stages/${review.stageId}`, headers: application.headers, payload: {} });
  expect(cancelled.statusCode).toBe(200);
  const before = application.store.snapshot();
  const path = join(directory, 'invalid.source'), protectedPath = join(directory, 'invalid.orebackup');
  writeFileSync(path, Buffer.from('Not a SQLite backup.'));
  await protectFile(path, protectedPath, 'backup', 'secret');
  const invalid = await application.inspect(readFileSync(protectedPath), 'secret');
  expect(invalid.statusCode).toBe(422);
  expect(invalid.json().code).toBe('invalid_backup');
  expect(application.store.snapshot()).toEqual(before);
  expect(readdirSync(join(directory, '.ore-backups-legacy.sqlite'))).toEqual([]);
});

it('retains saved state and creates no staging for corrupt, truncated, wrong-kind or future protected files', async () => {
  const application = await open('invalid'), download = await application.export('secret');
  const before = application.store.snapshot();
  for (const offset of [8, 9, 10, download.rawPayload.length - 1]) {
    const changed = Buffer.from(download.rawPayload); changed[offset] ^= 1;
    const response = await application.inspect(changed, 'secret');
    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe('protected_file_invalid');
  }
  const truncated = await application.inspect(download.rawPayload.subarray(0, 40), 'secret');
  expect(truncated.statusCode).toBe(422);
  expect(application.store.snapshot()).toEqual(before);
  expect(readdirSync(join(directory, '.ore-backups-invalid.sqlite'))).toEqual([]);
});

it('requires owner authentication and same origin for password-bearing exports and validates passwords safely', async () => {
  const application = await open('auth');
  const anonymous = await application.app.inject({ method: 'POST', url: '/api/data/backup', headers: { host: 'localhost', origin: 'http://localhost' }, payload: { password: 'private-input' } });
  expect(anonymous.statusCode).toBe(401);
  const foreign = await application.app.inject({ method: 'POST', url: '/api/data/backup', headers: { host: 'localhost', origin: 'http://untrusted.invalid' }, payload: { password: 'private-input' } });
  expect(foreign.statusCode).toBe(403);
  const invalid = await application.export('private-input'.repeat(30));
  expect(invalid.statusCode).toBe(400);
  expect(invalid.body).not.toContain('private-input');
  const malformed = await application.app.inject({ method: 'POST', url: '/api/data/stages', headers: { ...application.headers, 'content-type': 'application/octet-stream', 'x-ore-file-password': '@@@' }, payload: Buffer.alloc(100) });
  expect(malformed.statusCode).toBe(400);
  expect(malformed.json().code).toBe('invalid_file_password');
});

it('rejects late decrypted results after shutdown without recreating staging', async () => {
  const application = await open('shutdown'), service = new BackupService(application.store, join(directory, 'shutdown-separate.sqlite'));
  const encrypted = await application.export('secret');
  const pending = service.inspect(encrypted.rawPayload, 'owner', 'secret');
  service.close();
  await expect(pending).rejects.toMatchObject({ code: 'server_stopping' });
  expect(readdirSync(directory)).not.toContain('.ore-backups-shutdown-separate.sqlite');
});
