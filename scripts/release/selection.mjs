import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export function parseSelection(text) {
  const lines = text.trim().split('\n');
  if (lines.length !== 2 || !/^(release|dev)-[a-z0-9-]+$/u.test(lines[0]) || !/^node-v[0-9.]+-(darwin|linux|win32)-(arm64|x64)$/u.test(lines[1])) throw new Error('Invalid application/runtime selection.');
  return { id: lines[0], runtime: lines[1] };
}
export const selectionText = value => `${value.id}\n${value.runtime}\n`;
export const runtimeExecutable = (home, runtime) => join(home, 'runtime', runtime, runtime.includes('-win32-') ? 'node.exe' : 'bin/node');
export function publishRename(source, destination) {
  for (let attempt = 0; ; attempt++) {
    try { renameSync(source, destination); return; }
    catch (error) {
      if (process.platform !== 'win32' || attempt >= 3 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
      // Short sharing/AV contention may clear. Never delete the committed
      // destination to make replacement succeed; failed rename preserves it.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}
export function readSelection(home, name = 'current') {
  const path = join(home, name);
  return existsSync(path) ? parseSelection(readFileSync(path, 'utf8')) : null;
}
export function writeSelection(home, name, value) {
  const temporary = join(home, `${name}-${randomUUID()}.tmp`);
  writeFileSync(temporary, selectionText(value), { flag: 'wx', mode: 0o600 });
  publishRename(temporary, join(home, name));
}
export function markWorking(home, application) {
  const selected = readSelection(home);
  if (selected && resolve(home, 'app', selected.id) === resolve(application)) writeSelection(home, 'working', selected);
}
