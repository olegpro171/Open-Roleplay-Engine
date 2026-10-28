import { createHash } from 'node:crypto';
import { accessSync, constants, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';

// File/runtime preflight is safe before startup and never inspects saved data.
export function verifyApplication(application) {
  const physical = realpathSync(application);
  for (const name of ['build-info.json', 'manifest.json']) {
    if (!lstatSync(resolve(application, name)).isFile()) throw new Error(`Invalid application metadata: ${name}`);
  }
  for (const file of ['dist/server/server/main.js', 'dist/server/server/picture-worker.js', 'dist/client/index.html', 'migrations/0014_library_sorting.sql', 'build-info.json']) accessSync(resolve(application, file), constants.R_OK);
  const manifest = JSON.parse(readFileSync(resolve(application, 'manifest.json'), 'utf8'));
  if (!Array.isArray(manifest.files)) throw new Error('Installation manifest is missing its file list. Rebuild the application.');
  for (const file of manifest.files) {
    if (typeof file.path !== 'string' || (!file.path.startsWith('dist/') && !file.path.startsWith('migrations/'))) continue;
    if (file.path.split('/').some(part => part === '..' || part === '' || part.includes('\\'))) throw new Error('Invalid installation manifest path.');
    const path = resolve(application, file.path);
    if (!lstatSync(path).isFile() || realpathSync(path) !== resolve(physical, file.path)) throw new Error(`Invalid application asset: ${file.path}`);
    const actual = createHash('sha256').update(readFileSync(path)).digest('hex');
    if (actual !== file.sha256) throw new Error(`Application asset differs from its manifest: ${file.path}. Rebuild before starting.`);
  }
  const info = JSON.parse(readFileSync(resolve(application, 'build-info.json'), 'utf8'));
  if (info.node !== process.versions.node || info.platform !== process.platform || info.arch !== process.arch) throw new Error('Bundled runtime/OS/CPU does not match this application. Rebuild for this machine.');
  if (typeof info.commit !== 'string' || !/^[0-9a-f]{40}$/.test(info.commit)) throw new Error('Invalid application commit metadata.');
  if (!Number.isInteger(info.schema) || info.schema < 1) throw new Error('Invalid application schema metadata.');
  return info;
}
