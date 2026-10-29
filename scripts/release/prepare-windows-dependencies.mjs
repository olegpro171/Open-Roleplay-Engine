import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildPhase } from './build-timing.mjs';

const npm = process.argv[2];
if (!npm) throw new Error('Pass the private npm CLI path.');
const manifest = readFileSync('package.json');
const lockfile = readFileSync('package-lock.json');
await buildPhase('remove-build-dependencies', () => {
  // Preserve the locked installation, including native/optional packages.
  // Offline and no-save prohibit downloads and changes to source metadata.
  const result = spawnSync(process.execPath, [resolve(npm), 'prune', '--omit=dev', '--include=optional', '--ignore-scripts', '--offline', '--no-save', '--no-audit', '--no-fund'], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Production dependency preparation failed (exit ${result.status}, signal ${result.signal}).`);
  if (!manifest.equals(readFileSync('package.json')) || !lockfile.equals(readFileSync('package-lock.json'))) {
    throw new Error('Dependency preparation changed locked source metadata. Previous selection retained.');
  }
});
