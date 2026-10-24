import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server/app.js';
import { protectBytes, unprotectBytes } from '../src/server/protected-files.js';
import { connectionFileMaxBytes, connectionPlaintextMaxBytes } from '../src/shared/connection-files.js';
import type { Connection } from '../src/shared/contracts.js';

let directory: string;
const applications: Awaited<ReturnType<typeof createApp>>[] = [];
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'ore-connection-files-')); });
afterEach(async () => {
  for (const application of applications.splice(0)) await application.app.close();
  rmSync(directory, { recursive: true, force: true });
});
const connection: Connection = {
  name: 'Synthetic profile', endpoint: 'http://localhost:9999/v1', model: 'synthetic-model',
  contextWindow: 65000, maxOutputTokens: 2345, requestUsage: false,
  customParameters: { temperature: 0.7, stop: ['A', 'B'], seed: 123, reasoning_effort: 'high' },
};
const secret = 'sk-synthetic-connection-transfer-secret';
async function open(name: string) {
  const application = await createApp({ database: join(directory, `${name}.sqlite`) });
  applications.push(application);
  const headers = { host: 'localhost', origin: 'http://localhost', 'content-type': 'application/json' };
  const setup = await application.app.inject({ method: 'POST', url: '/api/setup', headers, payload: { password: 'synthetic-owner-password' } });
  const authenticated = { ...headers, cookie: String(setup.headers['set-cookie']).split(';')[0] };
  const post = (url: string, data: unknown) => application.app.inject({ method: 'POST', url, headers: authenticated, payload: JSON.stringify(data) });
  return { ...application, headers: authenticated, post,
    import: (bytes: Buffer, password = '', revision = application.store.libraryRevision()) => post('/api/library/connections/import', { base64: bytes.toString('base64'), password, revision }),
  };
}

it.each(['', '\uFEFF Пароль 🔑  '])('round trips settings across installations with optional keys and exact password %j', async password => {
  const source = await open('source'), destination = await open('destination');
  const original = source.store.saveLibrary(source.store.libraryRevision(), 'connections', connection, undefined, secret);
  for (const includeApiKey of [false, true]) {
    const download = await source.post(`/api/library/connections/${original}/export`, { password, includeApiKey });
    expect(download.statusCode, download.body).toBe(200);
    expect(download.headers['content-disposition']).toContain('.oreconnection');
    expect(download.rawPayload.includes(Buffer.from(secret))).toBe(false);
    expect(download.rawPayload.includes(Buffer.from(connection.name))).toBe(false);
    const plain = await unprotectBytes(download.rawPayload, 'connection', password, connectionPlaintextMaxBytes);
    const profile = JSON.parse(plain.toString());
    expect(profile.connection).toEqual(connection);
    expect(profile.apiKey).toBe(includeApiKey ? secret : undefined);
    expect(profile).not.toHaveProperty('id');
    const before = destination.store.libraries();
    const wrong = await destination.import(download.rawPayload, 'wrong');
    expect(wrong.statusCode).toBe(422);
    expect(wrong.json().code).toBe('protected_file_invalid');
    expect(destination.store.libraries()).toEqual(before);
    const imported = await destination.import(download.rawPayload, password);
    expect(imported.statusCode, imported.body).toBe(200);
    const id: string = imported.json().id;
    expect(id).not.toBe(original);
    expect(destination.store.connection(id)).toEqual(connection);
    expect(destination.store.connectionApiKey(id)).toBe(includeApiKey ? secret : '');
    expect((await destination.import(download.rawPayload, password, before.revision)).statusCode).toBe(409);
    expect(destination.store.libraries().connections).toHaveLength(before.connections.length + 1);
    expect(imported.body + JSON.stringify(destination.store.libraries())).not.toContain(secret);
  }
  const defaultExport = await source.post(`/api/library/connections/${original}/export`, {});
  const profile = JSON.parse((await unprotectBytes(defaultExport.rawPayload, 'connection', '', connectionPlaintextMaxBytes)).toString());
  expect(profile).not.toHaveProperty('apiKey');
  expect(source.store.connectionApiKey(original)).toBe(secret);
});

it('rejects tampering, wrong kinds, invalid settings, oversized and malformed files without changing data', async () => {
  const application = await open('validation');
  const before = application.store.libraries();
  const profile = { format: 'ore-connection', version: 1, connection, apiKey: secret };
  const valid = await protectBytes(Buffer.from(JSON.stringify(profile)), 'connection', '');
  const corrupted = Buffer.from(valid); corrupted[corrupted.length - 1] ^= 1;
  const badProfiles = [
    { ...profile, version: 2 }, { ...profile, connection: { ...connection, maxOutputTokens: connection.contextWindow } },
    { ...profile, connection: { ...connection, endpoint: 'http://user:password@localhost/v1' } },
    { ...profile, connection: { ...connection, customParameters: { messages: [] } } },
    { ...profile, apiKey: 'synthetic\r\ninvalid' }, { ...profile, id: 'overwrite-existing' },
  ];
  const invalid = [corrupted, valid.subarray(0, 30), Buffer.alloc(connectionFileMaxBytes + 1), Buffer.from('plain JSON'),
    await protectBytes(Buffer.from(JSON.stringify(profile)), 'backup', ''),
    await protectBytes(Buffer.from('{invalid json'), 'connection', ''),
  ];
  for (const candidate of badProfiles) invalid.push(await protectBytes(Buffer.from(JSON.stringify(candidate)), 'connection', ''));
  for (const bytes of invalid) {
    const response = await application.import(bytes);
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.body).not.toContain(secret);
    expect(application.store.libraries()).toEqual(before);
  }
  const malformed = await application.post('/api/library/connections/import', { revision: before.revision, password: '', base64: '@@@' });
  expect(malformed.statusCode).toBe(400);
});

it('rolls back the whole imported profile if saving its key fails and allows an explicit retry', async () => {
  const application = await open('rollback');
  const bytes = await protectBytes(Buffer.from(JSON.stringify({ format: 'ore-connection', version: 1, connection, apiKey: secret })), 'connection', '');
  const before = application.store.libraries();
  application.store.sqlite.exec("CREATE TRIGGER reject_import_key BEFORE INSERT ON credentials BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END");
  expect((await application.import(bytes)).statusCode).toBe(500);
  expect(application.store.libraries()).toEqual(before);
  application.store.sqlite.exec('DROP TRIGGER reject_import_key');
  expect((await application.import(bytes)).statusCode).toBe(200);
  expect(application.store.libraries().connections).toHaveLength(before.connections.length + 1);
});

it('checks the captured library revision after asynchronous decryption', async () => {
  const application = await open('stale');
  const bytes = await protectBytes(Buffer.from(JSON.stringify({ format: 'ore-connection', version: 1, connection })), 'connection', '');
  const revision = application.store.libraryRevision();
  const importing = application.import(bytes, '', revision);
  application.store.saveLibrary(revision, 'connections', { ...connection, name: 'Concurrent change' });
  expect((await importing).statusCode).toBe(409);
  expect(application.store.libraries().connections).toHaveLength(1);
});

it('requires owner authentication and same origin for both operations and validates password bounds', async () => {
  const application = await open('auth');
  const id = application.store.saveLibrary(application.store.libraryRevision(), 'connections', connection, undefined, secret);
  for (const url of [`/api/library/connections/${id}/export`, '/api/library/connections/import']) {
    const anonymous = await application.app.inject({ method: 'POST', url, headers: { host: 'localhost', origin: 'http://localhost' }, payload: {} });
    expect(anonymous.statusCode).toBe(401);
    const foreign = await application.app.inject({ method: 'POST', url, headers: { ...application.headers, origin: 'http://untrusted.invalid' }, payload: {} });
    expect(foreign.statusCode).toBe(403);
  }
  expect((await application.post(`/api/library/connections/${id}/export`, { password: 'x'.repeat(257) })).statusCode).toBe(400);
  const malformed = await application.post(`/api/library/connections/${id}/export`, { includeApiKey: 'yes' });
  expect(malformed.statusCode).toBe(400);
});
