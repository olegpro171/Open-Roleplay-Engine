import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Downloads } from '../src/server/downloads.js';
import { createApp } from '../src/server/app.js';
import { unprotectBytes } from '../src/server/protected-files.js';
import { downloadLifetimeMs, downloadLimit, preparedDownloadSchema } from '../src/shared/downloads.js';
import { backupLimits } from '../src/shared/backups.js';
import { connectionPlaintextMaxBytes } from '../src/shared/connection-files.js';

let directory: string;
const services: Downloads[] = [];
const applications: Awaited<ReturnType<typeof createApp>>[] = [];
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'ore-native-downloads-')); });
afterEach(async () => {
  vi.useRealTimers();
  for (const service of services.splice(0)) service.close();
  for (const application of applications.splice(0)) await application.app.close();
  rmSync(directory, { recursive: true, force: true });
});
function service() {
  const downloads = new Downloads(); services.push(downloads); return downloads;
}
function token(url: string) { return url.slice(url.lastIndexOf('/') + 1); }
function file(name: string) {
  const path = join(directory, name);
  writeFileSync(path, 'synthetic completed ciphertext');
  return { path, cleanup: vi.fn(() => rmSync(path, { force: true })) };
}

it('keeps interrupted downloads retryable, prevents cross-session access and consumes completed transfers', () => {
  const downloads = service(), source = file('retry');
  const prepared = downloads.add('owner', 'profile.oreconnection', source);
  expect(preparedDownloadSchema.safeParse(prepared).success).toBe(true);
  expect(() => downloads.open(token(prepared.url), 'other')).toThrow('no longer available');
  const interrupted = downloads.open(token(prepared.url), 'owner');
  interrupted.release(); interrupted.release();
  expect(source.cleanup).not.toHaveBeenCalled();
  const retried = downloads.open(token(prepared.url), 'owner');
  expect(retried.length).toBe(30);
  retried.release(true);
  expect(source.cleanup).toHaveBeenCalledTimes(1);
  expect(() => downloads.open(token(prepared.url), 'owner')).toThrow('no longer available');
});

it('bounds pending downloads, cleans rejected sources and makes room after completion', () => {
  const downloads = service();
  const prepared = Array.from({ length: downloadLimit }, (_, index) => downloads.add('owner', `file-${index}`, { bytes: Buffer.from('ciphertext') }));
  const overflow = file('overflow');
  expect(() => downloads.add('owner', 'overflow', overflow)).toThrow('Several downloads');
  expect(overflow.cleanup).toHaveBeenCalledTimes(1);
  downloads.open(token(prepared[0].url), 'owner').release(true);
  expect(() => downloads.add('owner', 'replacement', { bytes: Buffer.from('ciphertext') })).not.toThrow();
});

it('expires abandoned files but lets an existing reader finish before cleanup', () => {
  vi.useFakeTimers();
  const downloads = service(), abandoned = file('abandoned'), active = file('active');
  const first = downloads.add('owner', 'abandoned', abandoned), second = downloads.add('owner', 'active', active);
  const reading = downloads.open(token(second.url), 'owner');
  vi.advanceTimersByTime(downloadLifetimeMs);
  expect(abandoned.cleanup).toHaveBeenCalledTimes(1);
  expect(() => downloads.open(token(first.url), 'owner')).toThrow('no longer available');
  expect(() => downloads.open(token(second.url), 'owner')).toThrow('no longer available');
  expect(active.cleanup).not.toHaveBeenCalled();
  reading.release();
  expect(active.cleanup).toHaveBeenCalledTimes(1);
});

it('cleans completed sources on shutdown and rejects late preparation without retaining files', () => {
  const downloads = service(), source = file('shutdown'), late = file('late');
  const prepared = downloads.add('owner', 'shutdown', source);
  downloads.close();
  expect(existsSync(source.path)).toBe(false);
  expect(() => downloads.open(token(prepared.url), 'owner')).toThrow('no longer available');
  expect(() => downloads.add('owner', 'late', late)).toThrow('server is stopping');
  expect(existsSync(late.path)).toBe(false);
});

async function open() {
  const application = await createApp({ database: join(directory, 'application.sqlite') });
  applications.push(application);
  const headers = { host: 'localhost', origin: 'http://localhost', 'content-type': 'application/json', accept: 'application/json' };
  const setup = await application.app.inject({ method: 'POST', url: '/api/setup', headers, payload: { password: 'synthetic-owner-password' } });
  const authenticated = { ...headers, cookie: String(setup.headers['set-cookie']).split(';')[0] };
  const login = await application.app.inject({ method: 'POST', url: '/api/login', headers, payload: { password: 'synthetic-owner-password' } });
  const other = { ...headers, cookie: String(login.headers['set-cookie']).split(';')[0] };
  const post = (url: string, payload: unknown) => application.app.inject({ method: 'POST', url, headers: authenticated, payload: JSON.stringify(payload) });
  return { ...application, headers: authenticated, other, post };
}

it('hands encrypted profiles to authenticated native HTTP downloads with exact names, lengths and no URL password', async () => {
  const application = await open();
  const id = application.store.saveLibrary(application.store.libraryRevision(), 'connections', {
    name: 'OR cheap / synthetic', endpoint: 'http://localhost:9999/v1', model: 'synthetic', contextWindow: 64000, maxOutputTokens: 1000, customParameters: {},
  }, undefined, 'sk-synthetic-native-download-key');
  for (let index = 0; index < downloadLimit + 1; index++) {
    const prepared = await application.post(`/api/library/connections/${id}/export`, { password: 'private passphrase', includeApiKey: true });
    expect(prepared.statusCode, prepared.body).toBe(200);
    const ticket = preparedDownloadSchema.parse(prepared.json());
    expect(ticket.filename).toBe('OR_cheap___synthetic.oreconnection');
    expect(prepared.body).not.toContain('private passphrase');
    expect(prepared.body).not.toContain('sk-synthetic-native-download-key');
    const anonymous = await application.app.inject({ url: ticket.url, headers: { host: 'localhost' } });
    expect(anonymous.statusCode).toBe(401);
    const other = await application.app.inject({ url: ticket.url, headers: application.other });
    expect(other.statusCode).toBe(404);
    const head = await application.app.inject({ method: 'HEAD', url: ticket.url, headers: application.headers });
    expect(head.statusCode).toBe(200);
    const download = await application.app.inject({ url: ticket.url, headers: application.headers });
    expect(download.statusCode, download.body).toBe(200);
    expect(download.headers['content-length']).toBe(String(download.rawPayload.length));
    expect(download.headers['content-disposition']).toBe(`attachment; filename="${ticket.filename}"`);
    expect(download.headers['cache-control']).toBe('no-store');
    const plaintext = await unprotectBytes(download.rawPayload, 'connection', 'private passphrase', connectionPlaintextMaxBytes);
    expect(JSON.parse(plaintext.toString()).apiKey).toBe('sk-synthetic-native-download-key');
    const consumed = await application.app.inject({ url: ticket.url, headers: application.headers });
    expect(consumed.statusCode).toBe(404);
  }
});

it('streams a prepared encrypted backup and removes its temporary directory after transfer', async () => {
  const application = await open();
  const before = application.store.libraries();
  const prepared = await application.post('/api/data/backup', { password: 'backup passphrase' });
  expect(prepared.statusCode, prepared.body).toBe(200);
  const ticket = preparedDownloadSchema.parse(prepared.json());
  expect(ticket.filename).toMatch(/^ORE-backup-.*\.orebackup$/);
  expect(readdirSync(join(directory, '.ore-backups-application.sqlite'))).toHaveLength(1);
  const head = await application.app.inject({ method: 'HEAD', url: ticket.url, headers: application.headers });
  expect(head.statusCode).toBe(200);
  const download = await application.app.inject({ url: ticket.url, headers: application.headers });
  expect(download.statusCode, download.body).toBe(200);
  expect(download.headers['content-length']).toBe(String(download.rawPayload.length));
  expect((await unprotectBytes(download.rawPayload, 'backup', 'backup passphrase', backupLimits.bytes)).subarray(0, 16).toString()).toBe('SQLite format 3\0');
  await expect.poll(() => readdirSync(join(directory, '.ore-backups-application.sqlite'))).toEqual([]);
  expect(application.store.libraries()).toEqual(before);
});
