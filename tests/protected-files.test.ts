import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { filePasswordFromHeader, isProtectedFile, protectFile, unprotectBytes } from '../src/server/protected-files.js';
import { protectedFileHeaderBytes, protectedFileOverheadBytes } from '../src/shared/protected-files.js';

let directory: string;
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) };
});
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'ore-protected-files-')); });
afterEach(() => { vi.clearAllMocks(); rmSync(directory, { recursive: true, force: true }); });
async function protect(plaintext: Buffer, password: string, name = 'file') {
  const source = join(directory, `${name}.source`), destination = join(directory, `${name}.ore`);
  writeFileSync(source, plaintext);
  await protectFile(source, destination, 'backup', password);
  if (process.platform !== 'win32') expect(statSync(destination).mode & 0o777).toBe(0o600);
  expect(readFileSync(source).equals(plaintext)).toBe(true);
  return readFileSync(destination);
}

it.each(['', 'a deliberate passphrase', '\uFEFF Пароль 🔑 with spaces  '])('round trips exact bytes with password %j and a fresh salt and nonce', async password => {
  const plaintext = Buffer.concat([Buffer.from('sk-synthetic-secret-1234\0private story\n'), Buffer.from([0, 255, 128])]);
  const first = await protect(plaintext, password, 'first'), second = await protect(plaintext, password, 'second');
  expect(isProtectedFile(first)).toBe(true);
  expect(first.length).toBe(plaintext.length + protectedFileOverheadBytes);
  expect(first.includes(Buffer.from('sk-synthetic-secret-1234'))).toBe(false);
  expect(first.equals(second)).toBe(false);
  expect(first.subarray(10, 26).equals(second.subarray(10, 26))).toBe(false);
  expect(first.subarray(26, 38).equals(second.subarray(26, 38))).toBe(false);
  expect(await unprotectBytes(first, 'backup', password, plaintext.length)).toEqual(plaintext);
  const transported = filePasswordFromHeader(Buffer.from(password, 'utf8').toString('base64'));
  expect(transported).toBe(password);
  expect(await unprotectBytes(second, 'backup', transported, plaintext.length)).toEqual(plaintext);
});

it('opens a fixed v1 artifact independently of current export code', async () => {
  const fixture = Buffer.from('T1JFRU5DDQoBAQABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhthz0apSc6+zE4x++558TUvAaajH1VOZoEV1tVaKpM/V6tmIkO5dWsop0PhOS9XWSrUGGce', 'base64');
  expect((await unprotectBytes(fixture, 'backup', 'fixture-password', 100)).toString()).toBe('ORE version 1 compatibility fixture.');
});

it('streams a multichunk binary artifact and enforces the exact decoded-size boundary', async () => {
  const plaintext = randomBytes(2 * 1024 * 1024), bytes = await protect(plaintext, 'password');
  expect((await unprotectBytes(bytes, 'backup', 'password', plaintext.length)).equals(plaintext)).toBe(true);
  await expect(unprotectBytes(bytes, 'backup', 'password', plaintext.length - 1)).rejects.toMatchObject({ code: 'protected_file_invalid' });
});

it('rejects wrong, blank and whitespace-changed passwords without exposing passwords or content', async () => {
  const bytes = await protect(Buffer.from('synthetic private key'), ' exact password ');
  for (const password of ['', 'wrong password', 'exact password']) {
    await expect(unprotectBytes(bytes, 'backup', password, 100)).rejects.toMatchObject({ code: 'protected_file_invalid' });
  }
});

it('rejects changes to every envelope component, truncation, appended bytes and oversized plaintext', async () => {
  const bytes = await protect(Buffer.from('synthetic private key'), 'password');
  for (const offset of [0, 8, 9, 10, 26, protectedFileHeaderBytes, bytes.length - 1]) {
    const changed = Buffer.from(bytes); changed[offset] ^= 1;
    await expect(unprotectBytes(changed, 'backup', 'password', 100)).rejects.toMatchObject({ code: 'protected_file_invalid' });
  }
  for (const changed of [bytes.subarray(0, 20), bytes.subarray(0, bytes.length - 1), Buffer.concat([bytes, Buffer.from([0])])]) {
    await expect(unprotectBytes(changed, 'backup', 'password', 100)).rejects.toMatchObject({ code: 'protected_file_invalid' });
  }
  await expect(unprotectBytes(bytes, 'backup', 'password', 1)).rejects.toMatchObject({ code: 'protected_file_invalid' });
});

it('bounds password input, preserves exact UTF-8 and rejects malformed header encodings', async () => {
  expect(filePasswordFromHeader(undefined)).toBe('');
  expect(filePasswordFromHeader('')).toBe('');
  for (const input of ['@@@', 'YQ=', 'YR==', '/w==', Buffer.from('x'.repeat(257)).toString('base64'), ['YQ==']]) {
    expect(() => filePasswordFromHeader(input)).toThrow('at most 256');
  }
  await expect(protect(Buffer.from('data'), 'x'.repeat(257))).rejects.toMatchObject({ code: 'invalid_file_password' });
  const maximum = '🔑'.repeat(128);
  expect(await unprotectBytes(await protect(Buffer.alloc(0), maximum), 'backup', maximum, 0)).toEqual(Buffer.alloc(0));
});

it('bounds concurrent expensive work and releases capacity after a failure', async () => {
  const first = protect(Buffer.from('first'), '', 'first');
  const second = protect(Buffer.from('second'), '', 'second');
  await expect(protect(Buffer.from('third'), '', 'third')).rejects.toMatchObject({ code: 'protected_file_busy' });
  const bytes = await first; await second;
  await expect(unprotectBytes(bytes, 'backup', 'wrong', 100)).rejects.toMatchObject({ code: 'protected_file_invalid' });
  expect(await unprotectBytes(bytes, 'backup', '', 100)).toEqual(Buffer.from('first'));
});

it('removes partial encrypted output on read failure and never overwrites an existing destination', async () => {
  const source = join(directory, 'missing'), destination = join(directory, 'protected');
  await expect(protectFile(source, destination, 'backup', '')).rejects.toThrow();
  expect(readdirSync(directory)).toEqual([]);
  writeFileSync(source, 'source'); writeFileSync(destination, 'existing file');
  await expect(protectFile(source, destination, 'backup', '')).rejects.toThrow();
  expect(readFileSync(destination, 'utf8')).toBe('existing file');
});

it('removes a newly created output when the first header write runs out of disk space', async () => {
  const source = join(directory, 'source'), destination = join(directory, 'protected');
  writeFileSync(source, 'source');
  vi.mocked(writeFileSync).mockImplementationOnce((file, _data, options) => {
    writeFileSync(file, 'ORE', options);
    throw Object.assign(new Error('Synthetic full disk'), { code: 'ENOSPC' });
  });
  await expect(protectFile(source, destination, 'backup', '')).rejects.toMatchObject({ code: 'ENOSPC' });
  expect(readdirSync(directory)).toEqual(['source']);
  expect(readFileSync(source, 'utf8')).toBe('source');
});
