import { lstatSync, readFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';

// A surviving controller may release only its dead parent's exact ownership
// record. Ordinary launches never guess that an existing lock is stale.
export function releaseLostControllerLock(home, parent, token) {
  if (!token || process.ppid === parent) return;
  const lock = join(home, 'cache/update.lock');
  const owner = join(lock, 'owner');
  try {
    if (!lstatSync(lock).isDirectory() || !lstatSync(owner).isFile()) throw new Error('Invalid installation lock ownership.');
    if (readFileSync(owner, 'utf8') !== `${parent}\n${token}\n`) throw new Error('Installation lock owner changed; it was preserved.');
    unlinkSync(owner);
    rmdirSync(lock);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
