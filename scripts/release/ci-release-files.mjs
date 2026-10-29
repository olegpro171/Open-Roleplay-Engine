import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const windowsReleaseAssets = ['ORE-launcher.bat', 'ORE-windows-x64.json', 'ORE-windows-x64.zip', 'ORE-windows-x64.zip.sha256'];
export const releaseRepository = 'olegpro171/Open-Roleplay-Engine';

export function validateCommit(commit) {
  if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/u.test(commit)) throw new Error('Expected a full commit SHA.');
}

export function readWindowsRelease(directory, commit) {
  validateCommit(commit);
  if (JSON.stringify(readdirSync(directory).sort()) !== JSON.stringify(windowsReleaseAssets)) throw new Error('Release directory must contain exactly the Windows release assets.');
  for (const name of windowsReleaseAssets) {
    const stat = lstatSync(join(directory, name));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1) throw new Error(`Invalid release asset: ${name}`);
  }
  const descriptor = JSON.parse(readFileSync(join(directory, 'ORE-windows-x64.json'), 'utf8'));
  if (descriptor.formatVersion !== 1 || descriptor.platform !== 'win32' || descriptor.arch !== 'x64' || descriptor.commit !== commit || descriptor.archive !== 'ORE-windows-x64.zip' || descriptor.launcherProtocol !== 2 || !Number.isSafeInteger(descriptor.bytes) || descriptor.bytes < 1 || descriptor.bytes > 512 * 1024 * 1024 || typeof descriptor.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(descriptor.sha256)) throw new Error('Invalid Windows release descriptor.');
  const archive = readFileSync(join(directory, descriptor.archive));
  if (archive.length !== descriptor.bytes || createHash('sha256').update(archive).digest('hex') !== descriptor.sha256) throw new Error('Release archive differs from its descriptor.');
  if (readFileSync(join(directory, 'ORE-windows-x64.zip.sha256'), 'utf8') !== `${descriptor.sha256}  ${descriptor.archive}\n`) throw new Error('Release checksum differs from its descriptor.');
  return descriptor;
}
