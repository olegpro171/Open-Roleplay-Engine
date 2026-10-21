import { execFile } from 'node:child_process';
import { hostname } from 'node:os';
import { promisify } from 'node:util';
import { AppError } from '../core/errors.js';

const execute = promisify(execFile);

export function normalizeLocalHostname(value: string): string | null {
  const label = value.trim().toLowerCase().replace(/\.local\.?$/, '');
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label) ? `${label}.local` : null;
}

export async function localLanHostname(): Promise<string> {
  // macOS's Bonjour name is independent of a DHCP-supplied global hostname.
  let value: string;
  try {
    value = process.platform === 'darwin'
      ? (await execute('/usr/sbin/scutil', ['--get', 'LocalHostName'], { timeout: 1000, maxBuffer: 4096 })).stdout
      : hostname();
  } catch { throw new AppError(503, 'lan_hostname_unavailable', 'The computer’s local hostname could not be read.'); }
  const local = normalizeLocalHostname(value);
  if (!local) throw new AppError(503, 'lan_hostname_invalid', 'The computer needs a valid local hostname before LAN access can start.');
  return local;
}
