import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { buildInfoSchema, databaseSchemaVersion, type BuildInfo } from '../shared/build-info.js';

// Both source and tsc output have a stable path to their application root.
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
export const applicationRoot = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../../' : '../../../', import.meta.url));
export const migrationsDirectory = resolve(applicationRoot, 'migrations');
export function buildInfo(): BuildInfo {
  const metadata = resolve(applicationRoot, 'build-info.json');
  if (existsSync(metadata)) return buildInfoSchema.parse(JSON.parse(readFileSync(metadata, 'utf8')));
  const { version } = z.object({ version: z.string() }).parse(JSON.parse(readFileSync(resolve(applicationRoot, 'package.json'), 'utf8')));
  return { kind: 'development', version, commit: null, schema: databaseSchemaVersion, node: process.versions.node, platform: process.platform, arch: process.arch };
}
export function startupPaths(env: NodeJS.ProcessEnv = process.env) {
  const root = env.ORE_HOME ? resolve(env.ORE_HOME) : applicationRoot;
  if (env.ROLEPLAY_DATABASE !== undefined && !env.ROLEPLAY_DATABASE.trim()) throw new Error('ROLEPLAY_DATABASE must name a database file. Unset it to use the installation default.');
  if (env.ORE_DATABASE_MUST_EXIST !== undefined && !['0', '1'].includes(env.ORE_DATABASE_MUST_EXIST)) throw new Error('Invalid internal database existence requirement.');
  return {
    root,
    database: env.ROLEPLAY_DATABASE ? resolve(env.ROLEPLAY_DATABASE) : resolve(root, 'data/roleplay.sqlite'),
    databaseMustExist: env.ORE_DATABASE_MUST_EXIST === '1',
    staticDirectory: resolve(applicationRoot, 'dist/client'),
    migrationsDirectory,
  };
}
export function validateInstalledAssets(paths: ReturnType<typeof startupPaths>) {
  for (const path of [resolve(paths.staticDirectory, 'index.html'), resolve(paths.migrationsDirectory, '0001_initial.sql'), resolve(paths.migrationsDirectory, '0014_library_sorting.sql'), resolve(moduleDirectory, 'picture-worker.js')]) {
    if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`ORE installation is incomplete: missing ${path}. Build or reinstall the application before starting.`);
  }
  const info = buildInfo();
  if (info.kind === 'release' && (info.node !== process.versions.node || info.platform !== process.platform || info.arch !== process.arch)) throw new Error('This ORE release requires its bundled Node runtime and matching OS/CPU. Use the supplied launcher.');
}
