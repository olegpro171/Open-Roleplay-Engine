import { afterEach, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ORE installation build-история-')); directories.push(root);
  mkdirSync(join(root, 'src')); mkdirSync(join(root, 'tests'));
  symlinkSync(resolve('node_modules'), join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  writeFileSync(join(root, 'index.html'), '<title>ORE</title><script type="module" src="/src/client.ts"></script>');
  writeFileSync(join(root, 'src/client.ts'), 'document.title = "Installed ORE";');
  writeFileSync(join(root, 'src/server.ts'), 'export const value: number = "synthetic runtime value";');
  writeFileSync(join(root, 'tests/development.ts'), 'const developmentOnly: number = "checked before distribution";');
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, skipLibCheck: true }, include: ['src', 'tests'] }));
  writeFileSync(join(root, 'tsconfig.server.json'), JSON.stringify({ compilerOptions: { strict: true, skipLibCheck: true, rootDir: 'src', outDir: 'dist/server', module: 'NodeNext', target: 'ES2022' }, include: ['src/server.ts'] }));
  writeFileSync(join(root, 'vite.config.ts'), 'export default { build: { outDir: "dist/client" } };');
  const build = () => spawnSync(process.execPath, [resolve('scripts/release/build-windows.mjs')], { cwd: root, encoding: 'utf8' });
  return { root, build };
}

it('builds installation artifacts without repeating developer type analysis', () => {
  const f = fixture();
  const checked = spawnSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '--noEmit'], { cwd: f.root, encoding: 'utf8' });
  expect(checked.status).not.toBe(0);
  expect(checked.stdout).toContain('not assignable');
  const result = f.build();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(readFileSync(join(f.root, 'dist/client/index.html'), 'utf8')).toContain('<title>ORE</title>');
  const server = spawnSync(process.execPath, ['--input-type=module', '-e', 'console.log((await import(process.argv[1])).value)', pathToFileURL(join(f.root, 'dist/server/server.js')).href], { encoding: 'utf8' });
  expect(server.status, server.stderr).toBe(0);
  expect(server.stdout.trim()).toBe('synthetic runtime value');
});

it('stops installation builds on bundling failures before emitting the server', () => {
  const f = fixture();
  writeFileSync(join(f.root, 'src/client.ts'), 'import "./missing-module.js";');
  const result = f.build();
  expect(result.status).not.toBe(0);
  expect(existsSync(join(f.root, 'dist/server/server.js'))).toBe(false);
});

it('removes development packages offline while retaining locked production, shared and optional files', () => {
  const root = mkdtempSync(join(tmpdir(), 'ORE production packages-история-')); directories.push(root);
  const npm = process.env.npm_execpath ?? resolve(dirname(process.execPath), process.platform === 'win32' ? 'node_modules/npm/bin/npm-cli.js' : '../lib/node_modules/npm/bin/npm-cli.js');
  const packages = {
    production: { version: '1.0.0', dependencies: { shared: '1.0.0' } },
    shared: { version: '1.0.0' },
    optional: { version: '1.0.0', optional: true },
    development: { version: '1.0.0', dev: true, dependencies: { shared: '1.0.0', 'dev-leaf': '1.0.0' } },
    'dev-leaf': { version: '1.0.0', dev: true },
  };
  const manifest = { name: 'ore-synthetic-production', version: '1.0.0', dependencies: { production: '1.0.0' }, optionalDependencies: { optional: '1.0.0' }, devDependencies: { development: '1.0.0' }, scripts: { postinstall: 'node -e "process.exit(99)"' } };
  const lock = { name: manifest.name, version: manifest.version, lockfileVersion: 3, requires: true, packages: { '': manifest, ...Object.fromEntries(Object.entries(packages).map(([name, metadata]) => [`node_modules/${name}`, metadata])) } };
  writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify(lock));
  for (const [name, metadata] of Object.entries(packages)) {
    const directory = join(root, 'node_modules', name); mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name, ...metadata, scripts: manifest.scripts }));
    writeFileSync(join(directory, 'retained.node'), 'synthetic native bytes');
  }
  const before = new Map(['production', 'shared', 'optional'].map(name => [name, statSync(join(root, 'node_modules', name, 'retained.node')).ino]));
  const result = spawnSync(process.execPath, [resolve('scripts/release/prepare-windows-dependencies.mjs'), npm], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, npm_config_cache: join(root, 'empty-cache'), npm_config_userconfig: join(root, 'missing-npmrc'), npm_config_globalconfig: join(root, 'missing-global-npmrc'), npm_config_registry: 'http://127.0.0.1:1' },
  });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  for (const name of ['production', 'shared', 'optional']) {
    const binary = join(root, 'node_modules', name, 'retained.node');
    expect(readFileSync(binary, 'utf8')).toBe('synthetic native bytes');
    expect(statSync(binary).ino).toBe(before.get(name));
  }
  for (const name of ['development', 'dev-leaf']) expect(existsSync(join(root, 'node_modules', name))).toBe(false);
  expect(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))).toEqual(manifest);
  expect(JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))).toEqual(lock);
});
