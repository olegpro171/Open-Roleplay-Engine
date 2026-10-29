import { message } from '../shared/localization.js';
import { execFile } from 'node:child_process';
import { hostname } from 'node:os';
import { promisify } from 'node:util';
import { AppError } from '../core/errors.js';

const execute = promisify(execFile);

function isDiscoveryFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if ('killed' in error && error.killed === true) return true;
  if (!('code' in error)) return false;
  return typeof error.code === 'number' || (typeof error.code === 'string'
    && ['ENOENT', 'EACCES', 'EPERM', 'ETIMEDOUT', 'EIO', 'EAGAIN', 'ENOMEM', 'EMFILE', 'ENFILE', 'E2BIG', 'ENOEXEC',
      'ERR_SYSTEM_ERROR', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'].includes(error.code));
}

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
  } catch (error) {
    if (!isDiscoveryFailure(error)) throw error;
    throw new AppError(503, 'lan_hostname_unavailable', message('errors.the_computer_s_local_hostname_could_not_be'));
  }
  const local = normalizeLocalHostname(value);
  if (!local) throw new AppError(503, 'lan_hostname_invalid', message("errors.the_computer_needs_a_valid_local_hostname_before"));
  return local;
}
