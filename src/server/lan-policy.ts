import { networkInterfaces } from 'node:os';
import { isIPv4 } from 'node:net';
import type { LanInterface } from '../shared/lan.js';

export function isLoopback(address: string | undefined) {
  return address === '::1' || address === '127.0.0.1' || address === '::ffff:127.0.0.1';
}
function ipv4Number(address: string) {
  return address.split('.').reduce((value, part) => (value * 256) + Number(part), 0);
}
export function isPrivateIPv4(address: string) {
  if (!isIPv4(address)) return false;
  const value = ipv4Number(address);
  return (value >= 0x0a000000 && value <= 0x0affffff)
    || (value >= 0xac100000 && value <= 0xac1fffff)
    || (value >= 0xc0a80000 && value <= 0xc0a8ffff);
}
export function lanInterfaces(interfaces = networkInterfaces()): LanInterface[] {
  const result: LanInterface[] = [];
  for (const [name, addresses] of Object.entries(interfaces)) {
    // Common tunnel/virtual adapters are not phone-facing LAN interfaces.
    if (/^(utun|tun|tap|tailscale|wg|zt|docker|veth|br-|virbr|vmnet|vboxnet|awdl|llw)/i.test(name)) continue;
    for (const address of addresses ?? []) {
      if (address.internal || address.family !== 'IPv4' || !isPrivateIPv4(address.address) || !isIPv4(address.netmask)) continue;
      const bits = ipv4Number(address.netmask).toString(2).padStart(32, '0');
      if (!/^1{8,30}0+$/.test(bits)) continue;
      result.push({ id: `${name}:${address.address}`, name, address: address.address, netmask: address.netmask, prefix: bits.indexOf('0') });
    }
  }
  return result.sort((left, right) => left.id.localeCompare(right.id));
}
export function sameInterface(left: LanInterface, right: LanInterface) {
  return left.id === right.id && left.name === right.name && left.address === right.address && left.netmask === right.netmask && left.prefix === right.prefix;
}
export function allowedLanPeer(address: string | undefined, selected: LanInterface) {
  if (isLoopback(address)) return true;
  const peer = address?.replace(/^::ffff:/, '');
  return peer !== undefined && isPrivateIPv4(peer)
    && (ipv4Number(peer) & ipv4Number(selected.netmask)) === (ipv4Number(selected.address) & ipv4Number(selected.netmask));
}
export function allowedLanHost(host: string | undefined, selected: LanInterface, port: number, hostname: string | null) {
  return (hostname !== null && host?.toLowerCase() === `${hostname}:${port}`) || host === `${selected.address}:${port}`;
}
