import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppError } from '../src/core/errors.js';
import { message } from '../src/shared/localization.js';
import { LanAccess } from '../src/server/lan.js';
import { normalizeLocalHostname } from '../src/server/lan-hostname.js';
import type { LanRoute, ListenLan } from '../src/server/lan-listener.js';
import type { LanInterface } from '../src/shared/lan.js';

const wifi: LanInterface = { id: 'en0:192.168.1.5', name: 'en0', address: '192.168.1.5', netmask: '255.255.255.0', prefix: 24 };
const ethernet: LanInterface = { id: 'en1:10.0.0.5', name: 'en1', address: '10.0.0.5', netmask: '255.255.255.0', prefix: 24 };
type Opened = { binding: LanInterface; port: number; route: LanRoute; failed: () => void; closed: boolean };
let directory: string;
let file: string;
let available: LanInterface[];
let opened: Opened[];
let bindError: Error | null;
let lan: LanAccess;
let bindGate: (() => Promise<void>) | null;
let hostname: () => Promise<string>;
const listen: ListenLan = async (binding, port, route, failed) => {
  if (bindGate) await bindGate();
  if (bindError) throw bindError;
  const listener = { binding: { ...binding }, port, route, failed, closed: false };
  opened.push(listener);
  return { close: async () => { listener.closed = true; } };
};
function controller() {
  return new LanAccess(file, () => {}, { interfaces: () => available, hostname: () => hostname(), listen });
}
async function enable() {
  return lan.save({ revision: lan.status(true).revision, enabled: true, automatic: true, interfaceId: 'ignored-manual-choice', port: 4567 });
}
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  directory = mkdtempSync(join(tmpdir(), 'ore-lan-auto-'));
  file = join(directory, 'lan.json');
  hostname = async () => 'ore-fixture.local';
  available = [{ ...wifi }]; opened = []; bindError = null; bindGate = null;
  lan = controller();
  await lan.start();
});
afterEach(async () => {
  await lan.close();
  vi.useRealTimers();
  rmSync(directory, { recursive: true, force: true });
});

it('defaults to automatic selection, uses port 3000, and recovers IP/subnet/interface changes without browser commands', async () => {
  expect(lan.status(true).settings).toEqual({ enabled: false, automatic: true, interfaceId: null, port: 3000 });
  expect(opened).toHaveLength(0);
  expect((await enable()).runtime).toEqual({ state: 'listening', url: 'http://ore-fixture.local:3000', ipv4Url: 'http://192.168.1.5:3000', hostname: { state: 'available', url: 'http://ore-fixture.local:3000' } });
  const saved = readFileSync(file, 'utf8');
  expect(lan.status(true).settings).toEqual({ enabled: true, automatic: true, interfaceId: null, port: 3000 });
  expect(opened[0].port).toBe(3000);
  available = [{ ...ethernet }, { ...wifi }];
  await vi.advanceTimersByTimeAsync(3000);
  expect(opened).toHaveLength(1);
  expect(lan.status(true).runtime).toMatchObject({ ipv4Url: 'http://192.168.1.5:3000' });
  available = [{ ...ethernet }, { ...wifi, id: 'en0:192.168.2.9', address: '192.168.2.9' }];
  await vi.advanceTimersByTimeAsync(3000);
  expect(opened[0].closed).toBe(true);
  expect(opened[1].binding.address).toBe('192.168.2.9');
  expect(lan.status(true).runtime).toMatchObject({ ipv4Url: 'http://192.168.2.9:3000' });
  available = [{ ...ethernet }];
  await vi.advanceTimersByTimeAsync(3000);
  expect(opened[1].closed).toBe(true);
  expect(opened[2].binding).toEqual(ethernet);
  available = [{ ...ethernet, netmask: '255.255.0.0', prefix: 16 }];
  await vi.advanceTimersByTimeAsync(3000);
  expect(opened[2].closed).toBe(true);
  expect(opened[3].binding.prefix).toBe(16);
  expect(lan.status(true).runtime).toEqual({ state: 'listening', url: 'http://ore-fixture.local:3000', ipv4Url: 'http://10.0.0.5:3000', hostname: { state: 'available', url: 'http://ore-fixture.local:3000' } });
  expect(lan.status(true).revision).toBe(1);
  expect(readFileSync(file, 'utf8')).toBe(saved);
});

it('keeps checking through offline startup, occupied ports, listener failure and reconnect, then stops on disable', async () => {
  available = [];
  expect((await enable()).runtime.state).toBe('unavailable');
  expect(lan.status(true).runtime).not.toHaveProperty('ipv4Url');
  await lan.close();
  lan = controller();
  await lan.start();
  expect(vi.getTimerCount()).toBe(1);
  available = [{ ...wifi }];
  bindError = Object.assign(new Error('Occupied fixture port'), { code: 'EADDRINUSE' });
  await vi.advanceTimersByTimeAsync(3000);
  const busy = lan.status(true).runtime;
  expect(busy.state).toBe('unavailable');
  if (busy.state !== 'unavailable') throw new Error('Expected occupied port status.');
  expect(busy.message).toContain('retry automatically');
  bindError = null;
  await vi.advanceTimersByTimeAsync(3000);
  expect(lan.status(true).runtime.state).toBe('listening');
  opened[0].failed();
  expect(opened[0].closed).toBe(true);
  await vi.advanceTimersByTimeAsync(3000);
  expect(opened).toHaveLength(2);
  available = [];
  await vi.advanceTimersByTimeAsync(3000);
  expect(opened[1].closed).toBe(true);
  available = [{ ...ethernet }];
  await vi.advanceTimersByTimeAsync(3000);
  expect(opened[2].binding).toEqual(ethernet);
  await lan.save({ revision: 1, enabled: false, automatic: true, interfaceId: null, port: 3000 });
  expect(opened[2].closed).toBe(true);
  expect(lan.status(true).runtime).toEqual({ state: 'off' });
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(9000);
  expect(opened).toHaveLength(3);
});

it('serializes disable after an in-flight rebind and rejects stale settings without reviving a listener', async () => {
  available = [];
  await enable();
  available = [{ ...wifi }];
  let entered: () => void = () => {};
  const binding = new Promise<void>(resolve => { entered = resolve; });
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  bindGate = async () => { entered(); await gate; };
  const recovery = lan.refresh();
  await binding;
  const stop = lan.save({ revision: 1, enabled: false, automatic: true, interfaceId: null, port: 3000 });
  release();
  await recovery;
  expect((await stop).runtime.state).toBe('off');
  expect(opened).toHaveLength(1);
  expect(opened[0].closed).toBe(true);
  await expect(lan.save({ revision: 1, enabled: true, automatic: true, interfaceId: null, port: 3000 })).rejects.toThrow('changed');
  expect(vi.getTimerCount()).toBe(0);
});

it('discards a late bind result after shutdown and cleans its timers and transport', async () => {
  available = [];
  await enable();
  available = [{ ...wifi }];
  let entered: () => void = () => {};
  const binding = new Promise<void>(resolve => { entered = resolve; });
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  bindGate = async () => { entered(); await gate; };
  const recovery = lan.refresh();
  await binding;
  const stopping = lan.close();
  release();
  await Promise.all([recovery, stopping]);
  expect(opened[0].closed).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it.each([true, false])('upgrades version-1 settings to automatic mode while preserving enabled=%s and the saved revision', async enabled => {
  await lan.close();
  writeFileSync(file, JSON.stringify({ version: 1, revision: 7, settings: { enabled, interfaceId: wifi.id, port: 4567 }, binding: wifi }));
  lan = controller();
  await lan.start();
  expect(lan.status(true).revision).toBe(7);
  expect(lan.status(true).settings).toEqual({ enabled, automatic: true, interfaceId: null, port: 3000 });
  expect(JSON.parse(readFileSync(file, 'utf8')).version).toBe(2);
  expect(opened).toHaveLength(enabled ? 1 : 0);
  if (enabled) expect(opened[0].port).toBe(3000);
  await lan.close();
  lan = controller();
  await lan.start();
  expect(lan.status(true).settings.automatic).toBe(true);
});

it('keeps manual mode explicit and preserves it across a version-2 restart', async () => {
  await lan.save({ revision: 0, enabled: true, automatic: false, interfaceId: wifi.id, port: 4567 });
  expect(opened[0].port).toBe(4567);
  await lan.close();
  lan = controller();
  await lan.start();
  expect(lan.status(true).settings.automatic).toBe(false);
  expect(opened[1].port).toBe(4567);
  available = [{ ...ethernet }];
  await vi.advanceTimersByTimeAsync(3000);
  expect(lan.status(true).runtime).toMatchObject({ state: 'unavailable' });
  expect(lan.status(true).runtime).not.toHaveProperty('ipv4Url');
  expect(opened).toHaveLength(2);
});

it('normalizes only valid local hostnames for the exact host allowlist', () => {
  expect(normalizeLocalHostname('MacBook-Pro-Oleg\n')).toBe('macbook-pro-oleg.local');
  expect(normalizeLocalHostname('ORE.local.')).toBe('ore.local');
  for (const value of ['ore.local.attacker.example', 'localhost:3000', '-bad', 'ore/name', '', 'a'.repeat(64)]) expect(normalizeLocalHostname(value)).toBeNull();
});

it.each(['discovery', 'invalid'])('starts IPv4 independently of %s hostname failure and preserves it across restart', async failure => {
  hostname = failure === 'discovery'
    ? async () => { throw new AppError(503, 'lan_hostname_unavailable', message('errors.the_computer_s_local_hostname_could_not_be')); }
    : async () => 'ore.local.attacker.example';
  const expected = {
    state: 'listening', url: 'http://192.168.1.5:3000', ipv4Url: 'http://192.168.1.5:3000',
    hostname: { state: 'unavailable', localized: { key: failure === 'discovery' ? 'errors.the_computer_s_local_hostname_could_not_be' : 'errors.the_computer_needs_a_valid_local_hostname_before' } },
  };
  expect((await enable()).runtime).toMatchObject(expected);
  expect(opened).toHaveLength(1);
  const saved = readFileSync(file, 'utf8');
  await lan.close();
  lan = controller();
  await lan.start();
  expect(lan.status(true).runtime).toMatchObject(expected);
  expect(lan.status(true).revision).toBe(1);
  expect(readFileSync(file, 'utf8')).toBe(saved);
});

it('keeps unexpected hostname errors visible as transport failure', async () => {
  hostname = async () => { throw new Error('Unexpected fixture defect'); };
  expect((await enable()).runtime.state).toBe('unavailable');
  expect(lan.status(true).runtime).not.toHaveProperty('ipv4Url');
  expect(opened).toHaveLength(0);
});

it('advertises the preferred adapter rather than the first available adapter after an address change', async () => {
  available = [{ ...ethernet }];
  await enable();
  available = [{ ...wifi }, { ...ethernet, id: 'en1:10.0.0.9', address: '10.0.0.9' }];
  expect(lan.status(true).runtime.state).toBe('unavailable');
  expect(lan.status(true).runtime).not.toHaveProperty('ipv4Url');
  await lan.refresh();
  expect(opened[1].binding.address).toBe('10.0.0.9');
  expect(lan.status(true).runtime).toMatchObject({ ipv4Url: 'http://10.0.0.9:3000', hostname: { state: 'available', url: 'http://ore-fixture.local:3000' } });
  expect(lan.status(true).revision).toBe(1);
});

it('revokes stale numeric-address authority on network changes and disable, including IP-only service', async () => {
  hostname = async () => '';
  await enable();
  const probe = (listener: Opened, host: string) => {
    const socket = new Socket();
    Object.defineProperties(socket, { localAddress: { value: listener.binding.address }, remoteAddress: { value: '192.168.1.20' } });
    const request = new IncomingMessage(socket);
    request.headers.host = host;
    const response = new ServerResponse(request);
    listener.route(request, response);
    return lan.isLanRequest(request);
  };
  expect(probe(opened[0], '192.168.1.5:3000')).toBe(true);
  available = [{ ...wifi, id: 'en0:192.168.1.9', address: '192.168.1.9' }];
  expect(probe(opened[0], '192.168.1.5:3000')).toBe(false);
  await lan.refresh();
  expect(probe(opened[0], '192.168.1.5:3000')).toBe(false);
  expect(probe(opened[1], '192.168.1.5:3000')).toBe(false);
  expect(probe(opened[1], 'ore-fixture.local:3000')).toBe(false);
  expect(probe(opened[1], '192.168.1.9:3000')).toBe(true);
  await lan.save({ revision: 1, enabled: false, automatic: true, interfaceId: null, port: 3000 });
  expect(probe(opened[1], '192.168.1.9:3000')).toBe(false);
});

it.each(['shutdown', 'network'])('does not bind after hostname discovery outlives %s authority', async invalidation => {
  let entered: () => void = () => {};
  const reading = new Promise<void>(resolve => { entered = resolve; });
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  hostname = async () => { entered(); await gate; return ''; };
  const enabling = enable();
  await reading;
  const stopping = invalidation === 'shutdown' ? lan.close() : Promise.resolve();
  if (invalidation === 'network') available = [];
  release();
  await Promise.all([enabling, stopping]);
  expect(opened).toHaveLength(0);
  expect(lan.status(true).runtime).not.toHaveProperty('ipv4Url');
});

it.each([true, false])('keeps bind failure distinct from hostname metadata failure in automatic=%s mode', async automatic => {
  hostname = async () => '';
  bindError = Object.assign(new Error('Occupied fixture port'), { code: 'EADDRINUSE' });
  if (automatic) {
    const result = await enable();
    expect(result.runtime).toMatchObject({ state: 'unavailable', message: expect.stringContaining('occupied') });
    expect(result.runtime).not.toHaveProperty('ipv4Url');
    expect(result.revision).toBe(1);
  } else {
    await expect(lan.save({ revision: 0, enabled: true, automatic: false, interfaceId: wifi.id, port: 4567 })).rejects.toThrow('occupied');
    expect(lan.status(true).runtime).toEqual({ state: 'off' });
    expect(lan.status(true).revision).toBe(0);
  }
  expect(opened).toHaveLength(0);
});
