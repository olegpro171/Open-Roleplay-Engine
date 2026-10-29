import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readSelection, writeSelection, runtimeExecutable } from './selection.mjs';
import { resolveDatabase, selectDatabase, ownsWindowsPackageLease } from './database-location.mjs';
import { verifyStartup } from './startup-smoke.mjs';

const [homeArgument, action = '--list', ...args] = process.argv.slice(2);
if (!homeArgument) throw new Error('Expected installation directory.');
const home = resolve(homeArgument);
const tools = fileURLToPath(new URL('./', import.meta.url));
function application(id) {
  if (!/^(release|dev)-[a-z0-9-]+$/u.test(id)) throw new Error('Invalid retained application ID.');
  const path = join(home, 'app', id);
  const info = JSON.parse(readFileSync(join(path, 'build-info.json'), 'utf8'));
  const manifest = JSON.parse(readFileSync(join(path, 'manifest.json'), 'utf8'));
  if (!Number.isInteger(info.schema) || info.schema < 1 || !/^node-v[0-9.]+-(darwin|linux|win32)-(arm64|x64)$/u.test(manifest.runtime)) throw new Error('Invalid retained application metadata.');
  return { path, info, selection: { id, runtime: manifest.runtime }, node: runtimeExecutable(home, manifest.runtime) };
}
async function recover() {
  if (action === '--list') {
    if (args.length) throw new Error('--list accepts no arguments.');
    const current = readSelection(home), previous = readSelection(home, 'previous');
    for (const id of readdirSync(join(home, 'app')).sort()) {
      try {
        const app = application(id);
        console.log(`${id}  schema ${app.info.schema}${id === current?.id ? '  current' : ''}${id === previous?.id ? '  previous working' : ''}`);
      } catch (error) { console.log(`${id}  unreadable metadata: ${error.message}`); }
    }
    return;
  }
  const locks = [];
  try {
    mkdirSync(join(home, 'cache'), { recursive: true, mode: 0o700 });
    for (const name of ownsWindowsPackageLease(home) ? [] : ['update.lock', 'build.lock']) {
      const lock = join(home, 'cache', name);
      try { mkdirSync(lock); } catch (error) { if (error.code !== 'EEXIST') throw error; throw new Error(`Recovery cannot run while ${name} exists. Stop active work; remove a stale lock only after confirming its process stopped.`); }
      locks.push(lock);
    }
    if (action === '--resume-updates' && args.length === 0) {
      rmSync(join(home, 'updates-paused'), { force: true });
      console.log('Automatic update checks resumed for the next launch.');
      return;
    }
    if (action === '--database') {
      const [kind, path] = args;
      if ((kind === 'repository' || kind === 'installation') && args.length === 1) selectDatabase(home, { kind });
      else if (kind === 'external' && args.length === 2) selectDatabase(home, { kind, path });
      else throw new Error('Use --database repository, --database installation, or --database external ABSOLUTE_PATH.');
      console.log('Existing database location selected. No database was created or changed.');
      return;
    }
    let id;
    if (action === '--previous' && args.length === 0) {
      id = readSelection(home, 'previous')?.id;
      if (!id) throw new Error('No previous startup-verified selection is recorded. Use --list and --select APP_ID explicitly.');
    } else if (action === '--select' && args.length === 1) id = args[0];
    else throw new Error('Use --list, --previous, --select APP_ID, --database KIND [PATH], or --resume-updates.');
    const target = application(id);
    const database = resolveDatabase(home, process.env, false);
    if (existsSync(database.path)) {
      const checked = spawnSync(target.node, [join(tools, 'check-database.mjs'), target.path, database.path, String(target.info.schema)], { encoding: 'utf8' });
      if (checked.status !== 0) throw new Error(`Recovery refused before changing selection.\n${checked.stderr || checked.error?.message || checked.stdout}`);
    }
    const protocol = join(target.path, 'scripts/release/launcher-protocol');
    const launcher = existsSync(protocol) && readFileSync(protocol, 'utf8').trim() === '2'
      ? join(target.path, 'scripts/release/portable-launch.mjs') : join(tools, 'portable-launch.mjs');
    await verifyStartup(target.path, target.node, join(home, 'cache'), launcher);
    writeFileSync(join(home, 'updates-paused'), 'Recovery selected an older application. Use recover.command --resume-updates when ready.\n', { mode: 0o600 });
    writeSelection(home, 'current', target.selection);
    console.log(`Selected ${id}. Updates are paused. No older application was started against your saved database by this command. Keep the same ROLEPLAY_DATABASE override when launching, or persist the chosen existing copy with --database external ABSOLUTE_PATH first.`);
  } finally { for (const lock of locks.reverse()) rmSync(lock, { recursive: true }); }
}
try { await recover(); }
catch (error) { console.error(error.message); process.exitCode = 1; }
