import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createServer, request } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server/app.js';
import { allowedLanHost, allowedLanPeer, isPrivateIPv4, lanInterfaces } from '../src/server/lan-policy.js';
import { lanStatusSchema, type LanInterface, type LanSettings } from '../src/shared/lan.js';
import { startMockProvider } from './support/mock-provider.js';

const syntheticInterface: LanInterface = { id: 'fixture:127.0.0.1', name: 'fixture', address: '127.0.0.1', netmask: '255.0.0.0', prefix: 8 };
let directory: string;
let instance: Awaited<ReturnType<typeof createApp>>;
let available: LanInterface[];
let cookie: string;
let mock: Awaited<ReturnType<typeof startMockProvider>>;
let port: number;
let hostname: () => Promise<string>;

async function unusedPort() {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port.');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}
async function start() {
  instance = await createApp({ database: join(directory, 'chat.sqlite'), lan: { interfaces: () => available, hostname: () => hostname() } });
  await instance.app.listen({ host: '127.0.0.1', port: 0 });
}
function command(url: string, payload: unknown, method: 'PUT' | 'POST' = 'PUT') {
  return instance.app.inject({ method, url, headers: { host: 'localhost', origin: 'http://localhost', cookie, 'content-type': 'application/json' }, payload: JSON.stringify(payload) });
}
async function status() {
  const response = await instance.app.inject({ method: 'GET', url: '/api/application/lan', headers: { host: 'localhost', cookie } });
  expect(response.statusCode).toBe(200);
  return lanStatusSchema.parse(response.json());
}
async function save(settings: Partial<LanSettings> = {}) {
  const before = await status();
  return command('/api/application/lan', { revision: before.revision, ...before.settings, enabled: true, automatic: false, interfaceId: syntheticInterface.id, port, ...settings });
}
function phone(path = '/api/session', options: { host?: string; peer?: string; method?: string; body?: unknown; origin?: string; authenticated?: boolean; token?: string; forwarded?: string } = {}) {
  return new Promise<{ status: number; body: string; headers: import('node:http').IncomingHttpHeaders }>((resolve, reject) => {
    const outgoing = request({ hostname: syntheticInterface.address, port, path, method: options.method ?? 'GET', localAddress: options.peer ?? '127.0.0.1', agent: false,
      headers: { host: options.host ?? `${syntheticInterface.address}:${port}`, ...(options.token || options.authenticated ? { cookie: options.token ?? cookie } : {}), ...(options.origin ? { origin: options.origin } : {}), ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.forwarded ? { 'x-forwarded-for': options.forwarded } : {}) } }, response => {
      let body = '';
      response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body, headers: response.headers }));
    });
    outgoing.on('error', reject);
    outgoing.setTimeout(1500, () => outgoing.destroy(new Error('Fixture connection timed out.')));
    outgoing.end(options.body ? JSON.stringify(options.body) : undefined);
  });
}
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'ore-lan-'));
  available = [{ ...syntheticInterface }];
  mock = await startMockProvider();
  port = await unusedPort();
  cookie = '';
  hostname = async () => 'ore-fixture.local';
  await start();
  const setup = await command('/api/setup', { password: 'synthetic-lan-password' }, 'POST');
  expect(setup.statusCode).toBe(200);
  cookie = setup.cookies.map(value => `${value.name}=${value.value}`).join('; ');
});
afterEach(async () => {
  await instance.app.close();
  await mock.close();
  rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

it('starts off, requires owner authentication, and applies saved LAN settings without restarting the local listener', async () => {
  expect((await status()).runtime.state).toBe('off');
  expect((await status()).settings.automatic).toBe(true);
  await expect(phone()).rejects.toThrow();
  expect((await instance.app.inject({ url: '/api/application/lan' })).statusCode).toBe(401);
  const localAddress = instance.app.server.address();
  const enabled = await save();
  expect(enabled.statusCode).toBe(200);
  expect(lanStatusSchema.parse(enabled.json()).runtime).toEqual({ state: 'listening', url: `http://ore-fixture.local:${port}` });
  expect(instance.app.server.address()).toEqual(localAddress);
  expect((await phone('/api/chat')).status).toBe(401);
  expect((await phone('/api/session', { host: `ORE-FIXTURE.LOCAL:${port}` })).status).toBe(200);
  const login = await phone('/api/login', { method: 'POST', host: `ore-fixture.local:${port}`, origin: `http://ore-fixture.local:${port}`, body: { password: 'synthetic-lan-password' } });
  expect(login.status).toBe(200);
  expect(login.headers['set-cookie']?.join(';')).toContain('HttpOnly');
  expect(login.headers['set-cookie']?.join(';')).toContain('SameSite=Strict');
  expect(login.headers['set-cookie']?.join(';')).not.toContain('Secure');
  const phoneCookie = login.headers['set-cookie']?.[0]?.split(';')[0];
  expect(phoneCookie).toBeTruthy();
  const snapshot = await phone('/api/chat', { token: phoneCookie });
  expect(snapshot.status).toBe(200);
  expect(JSON.parse(snapshot.body).id).toBe('main');
  const remoteStatus = await phone('/api/application/lan', { authenticated: true });
  expect(lanStatusSchema.parse(JSON.parse(remoteStatus.body)).canConfigure).toBe(false);
  expect((await save({ enabled: false })).statusCode).toBe(200);
  await expect(phone()).rejects.toThrow();
  expect((await status()).runtime.state).toBe('off');
  expect(instance.app.server.address()).toEqual(localAddress);
});

it('rejects foreign hosts, origins, peers, forwarded addresses, remote setup and remote configuration', async () => {
  expect((await save()).statusCode).toBe(200);
  for (const host of ['attacker.example', `localhost:${port}`, `127.0.0.1.attacker.example:${port}`, '127.0.0.1', `ore-fixture.local.attacker.example:${port}`, `ore-fixture.local:${port + 1}`]) expect((await phone('/api/session', { host })).status).toBe(403);
  expect((await phone('/api/session', { host: 'attacker.example', forwarded: '127.0.0.1' })).status).toBe(403);
  expect((await phone('/api/login', { method: 'POST', origin: 'http://attacker.example', body: { password: 'synthetic-lan-password' } })).status).toBe(403);
  expect((await phone('/api/setup', { method: 'POST', origin: `http://127.0.0.1:${port}`, body: { password: 'synthetic-lan-password' } })).status).toBe(403);
  expect((await phone('/api/application/lan', { method: 'PUT', origin: `http://127.0.0.1:${port}`, authenticated: true, body: { revision: 1, enabled: false, automatic: false, interfaceId: null, port } })).status).toBe(403);
  const forged = await instance.app.inject({ url: '/api/session', headers: { host: '192.168.1.20:3000', 'x-forwarded-for': '127.0.0.1' } });
  expect(forged.statusCode).toBe(403);
});

it('retains the last committed listener and settings on bind/write failure and rejects stale concurrent saves', async () => {
  expect((await save()).statusCode).toBe(200);
  const before = await status();
  const occupied = createServer();
  await new Promise<void>(resolve => occupied.listen(0, '127.0.0.1', resolve));
  const address = occupied.address();
  if (!address || typeof address === 'string') throw new Error('Missing occupied port.');
  try {
    const failed = await save({ port: address.port });
    expect(failed.statusCode).toBe(503);
    expect(failed.json().message).toContain('occupied');
    expect(await status()).toEqual(before);
    expect((await phone()).status).toBe(200);
  } finally { await new Promise<void>(resolve => occupied.close(() => resolve())); }
  const savedText = readFileSync(join(directory, 'chat.sqlite.lan.json'), 'utf8');
  const stale = await command('/api/application/lan', { ...before.settings, revision: 0 });
  expect(stale.statusCode).toBe(409);
  expect(readFileSync(join(directory, 'chat.sqlite.lan.json'), 'utf8')).toBe(savedText);

  // A directory at the atomic-rename target reliably fails, including as root.
  const blockedFile = join(directory, 'blocked');
  const other = await createApp({ database: join(directory, 'other.sqlite'), lan: { interfaces: () => available, settingsFile: blockedFile, hostname: async () => 'ore-fixture.local' } });
  await other.app.listen({ host: '127.0.0.1', port: 0 });
  const previousPort = await unusedPort();
  const newPort = await unusedPort();
  try {
    await other.lan.save({ revision: 0, enabled: true, automatic: false, interfaceId: syntheticInterface.id, port: previousPort });
    const committed = other.lan.status(true);
    renameSync(blockedFile, `${blockedFile}.retained`);
    mkdirSync(blockedFile);
    await expect(other.lan.save({ revision: 1, enabled: true, automatic: false, interfaceId: syntheticInterface.id, port: newPort })).rejects.toThrow();
    expect(other.lan.status(true)).toEqual(committed);
    expect((await fetch(`http://127.0.0.1:${previousPort}/api/session`)).status).toBe(200);
    await expect(fetch(`http://127.0.0.1:${newPort}/api/session`)).rejects.toThrow();
  } finally { await other.app.close(); }
  const simultaneous = await Promise.all([save({ enabled: false }), save({ enabled: false })]);
  expect(simultaneous.map(response => response.statusCode).sort()).toEqual([200, 409]);
});

it('validates settings and rejects a changed network before committing a prepared listener', async () => {
  for (const changes of [{ port: 80 }, { port: 65536 }, { enabled: 'yes' }, { revision: -1 }, { extra: true }]) {
    const invalid = await command('/api/application/lan', { revision: 0, enabled: true, automatic: false, interfaceId: syntheticInterface.id, port, ...changes });
    expect(invalid.statusCode).toBe(400);
  }
  expect((await save({ interfaceId: null })).statusCode).toBe(409);
  let entered: () => void = () => {};
  const readingHostname = new Promise<void>(resolve => { entered = resolve; });
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  hostname = async () => { entered(); await gate; return 'ore-fixture.local'; };
  const pending = instance.lan.save({ revision: 0, enabled: true, automatic: false, interfaceId: syntheticInterface.id, port });
  await readingHostname;
  available = [];
  release();
  await expect(pending).rejects.toThrow('network changed');
  expect((await status()).revision).toBe(0);
  expect((await status()).settings.enabled).toBe(false);
  await expect(phone()).rejects.toThrow();
});

it('restores enabled settings on restart, fails closed on network change, and allows recovery from local settings', async () => {
  expect((await save()).statusCode).toBe(200);
  if (process.platform !== 'win32') expect(statSync(join(directory, 'chat.sqlite.lan.json')).mode & 0o777).toBe(0o600);
  await instance.app.close();
  await start();
  expect((await status()).runtime.state).toBe('listening');
  expect((await phone()).status).toBe(200);
  available = [{ ...syntheticInterface, netmask: '255.255.255.0', prefix: 24 }];
  expect((await status()).runtime.state).toBe('unavailable');
  await expect(phone()).rejects.toThrow();
  expect((await status()).settings.enabled).toBe(true);
  await instance.app.close();
  await start();
  expect((await status()).runtime.state).toBe('unavailable');
  expect((await save()).statusCode).toBe(200);
  expect((await phone()).status).toBe(200);
  await save({ enabled: false });
  await instance.app.close();
  await start();
  expect((await status()).runtime.state).toBe('off');
});

it('fails closed for invalid saved settings and supports explicit replacement without changing chats', async () => {
  await instance.app.close();
  writeFileSync(join(directory, 'chat.sqlite.lan.json'), 'not valid JSON');
  await start();
  expect((await status()).runtime).toMatchObject({ state: 'unavailable', localized: { key: 'lan_settings.saved_settings_unreadable' } });
  expect((await instance.app.inject({ url: '/api/chat', headers: { cookie } })).statusCode).toBe(200);
  expect((await save({ enabled: false })).statusCode).toBe(200);
  expect((await status()).runtime.state).toBe('off');
});

it('keeps local recovery available when the saved LAN port is occupied on restart and can switch ports', async () => {
  expect((await save()).statusCode).toBe(200);
  await instance.app.close();
  const occupied = createServer();
  await new Promise<void>(resolve => occupied.listen(port, '127.0.0.1', resolve));
  try {
    await start();
    const current = await status();
    expect(current.runtime.state).toBe('unavailable');
    if (current.runtime.state !== 'unavailable') throw new Error('Missing bind error.');
    expect(current.runtime.message).toContain('occupied');
    expect(current.settings.enabled).toBe(true);
    expect((await instance.app.inject({ url: '/api/chat', headers: { cookie } })).statusCode).toBe(200);
  } finally { await new Promise<void>(resolve => occupied.close(() => resolve())); }
  expect((await save()).statusCode).toBe(200);
  const previousPort = port;
  const newPort = await unusedPort();
  expect((await save({ port: newPort })).statusCode).toBe(200);
  port = newPort;
  expect((await phone()).status).toBe(200);
  await expect(fetch(`http://127.0.0.1:${previousPort}/api/session`)).rejects.toThrow();
});

it('disconnects LAN observers on disable while preserving server-owned generation', async () => {
  expect((await save()).statusCode).toBe(200);
  const snapshot = instance.store.snapshot();
  instance.store.saveSettings(snapshot.revision, { name: 'Mock', endpoint: mock.url, model: 'mock', contextWindow: 32000, maxOutputTokens: 1000, customParameters: {} }, snapshot.settings, 'synthetic-key');
  mock.setMode('hold');
  const sent = await command('/api/turns', { revision: instance.store.snapshot().revision, requestId: crypto.randomUUID(), text: 'Wait at the gate.' }, 'POST');
  expect(sent.statusCode).toBe(202);
  await expect.poll(() => mock.requests.length).toBe(1);
  const stream = await fetch(`http://127.0.0.1:${port}/api/events`, { headers: { cookie } });
  const reader = stream.body?.getReader();
  if (!reader) throw new Error('Missing observer.');
  await reader.read();
  const ended = reader.read().then(value => value.done, () => true);
  expect((await save({ enabled: false })).statusCode).toBe(200);
  expect(await ended).toBe(true);
  expect(instance.store.snapshot().generations[0].status).toBe('running');
  mock.finishAll();
  await expect.poll(() => instance.store.snapshot().generations[0].status).toBe('succeeded');
});

it('limits peers to private addresses in the selected subnet and offers only eligible interface addresses', () => {
  const selected = { ...syntheticInterface, address: '192.168.5.10', netmask: '255.255.255.0', prefix: 24 };
  for (const peer of ['192.168.5.20', '::ffff:192.168.5.20', '127.0.0.1', '::1']) expect(allowedLanPeer(peer, selected)).toBe(true);
  for (const peer of ['192.168.6.20', '10.0.0.2', '8.8.8.8', 'fe80::1', '::ffff:8.8.8.8', undefined]) expect(allowedLanPeer(peer, selected)).toBe(false);
  expect(allowedLanHost('192.168.5.10:3000', selected, 3000, 'ore-fixture.local')).toBe(true);
  expect(allowedLanHost('192.168.5.10:3000.evil', selected, 3000, 'ore-fixture.local')).toBe(false);
  const adapter = (address: string, netmask = '255.255.255.0') => ({ address, netmask, family: 'IPv4' as const, mac: '02:00:00:00:00:01', internal: false, cidr: null });
  expect(lanInterfaces({
    en0: [adapter('192.168.5.10')], ethernet: [adapter('10.1.2.3', '255.255.0.0')],
    utun0: [adapter('10.9.8.7')], docker0: [adapter('172.17.0.1')],
    public: [adapter('8.8.8.8')], pointToPoint: [adapter('10.0.0.2', '255.255.255.255')],
    invalidMask: [adapter('192.168.1.3', '255.0.255.0')], loopback: [{ ...adapter('127.0.0.1'), internal: true }],
  }).map(item => ({ name: item.name, address: item.address, prefix: item.prefix }))).toEqual([
    { name: 'en0', address: '192.168.5.10', prefix: 24 }, { name: 'ethernet', address: '10.1.2.3', prefix: 16 },
  ]);
  expect(isPrivateIPv4('172.16.0.1')).toBe(true);
  expect(isPrivateIPv4('172.31.255.254')).toBe(true);
  expect(isPrivateIPv4('172.32.0.1')).toBe(false);
});
