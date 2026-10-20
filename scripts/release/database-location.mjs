import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const filename = home => resolve(home, 'database-location.json');
function location(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid database location.');
  if (value.kind === 'repository' || value.kind === 'installation') {
    if (Object.keys(value).length !== 1) throw new Error('Invalid relative database location.');
    return { kind: value.kind };
  }
  if (value.kind === 'external' && Object.keys(value).length === 2 && typeof value.path === 'string' && isAbsolute(value.path) && !/[\r\n\0]/u.test(value.path)) return { kind: 'external', path: resolve(value.path) };
  throw new Error('Invalid database location; external paths must be absolute.');
}
const key = value => JSON.stringify(value);
export function databasePath(home, selected) {
  if (selected.kind === 'repository') return resolve(home, '../data/roleplay.sqlite');
  if (selected.kind === 'installation') return resolve(home, 'data/roleplay.sqlite');
  return selected.path;
}
export function loadDatabaseState(home, hint = 'installation') {
  const file = filename(home);
  if (existsSync(file)) {
    const state = JSON.parse(readFileSync(file, 'utf8'));
    if (!state || state.version !== 1 || !Array.isArray(state.established) || Object.keys(state).sort().join(',') !== 'default,established,version') throw new Error('Invalid database-location.json; restore its metadata before starting.');
    return { version: 1, default: location(state.default), established: state.established.map(location) };
  }
  const legacy = resolve(home, 'database-path.txt');
  if (existsSync(legacy)) {
    const previous = readFileSync(legacy, 'utf8').trim();
    if (!isAbsolute(previous) || /[\r\n\0]/u.test(previous)) throw new Error('Invalid legacy database path. Use recover-app.command --database repository or recover.command --database external ABSOLUTE_PATH.');
    if (resolve(previous) !== databasePath(home, { kind: 'repository' })) throw new Error('Legacy database path is ambiguous after relocation or an external selection. No replacement database was created. Choose recover-app.command --database repository for the moved repository database, or recover.command --database external ABSOLUTE_PATH for an existing external database.');
    return { version: 1, default: { kind: 'repository' }, established: [{ kind: 'repository' }] };
  }
  if (!['repository', 'installation'].includes(hint)) throw new Error('Invalid default database location.');
  return { version: 1, default: { kind: hint }, established: [] };
}
function saveDatabaseState(home, state) {
  const temporary = `${filename(home)}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(state, null, 2)+'\n', { flag: 'wx', mode: 0o600 });
  renameSync(temporary, filename(home));
}
function resolveDatabaseState(home, env, persist) {
  const state = loadDatabaseState(home, env.ORE_DATABASE_DEFAULT ?? 'installation');
  let selected = state.default;
  if (env.ROLEPLAY_DATABASE !== undefined) {
    if (!env.ROLEPLAY_DATABASE.trim() || /[\r\n\0]/u.test(env.ROLEPLAY_DATABASE)) throw new Error('ROLEPLAY_DATABASE must name a database file.');
    const explicit = resolve(env.ROLEPLAY_DATABASE);
    // A bootstrap may forward the resolved default to an older launcher. Keep
    // the relative identity rather than recording an absolute duplicate.
    selected = explicit === databasePath(home, state.default) ? state.default : { kind: 'external', path: explicit };
  }
  const path = databasePath(home, selected);
  const established = state.established.some(value => key(value) === key(selected));
  const present = existsSync(path);
  if (present && !statSync(path).isFile()) throw new Error('The selected database path is not a file.');
  if (established && !present) throw new Error(`Established database is missing: ${path}. Restore it, or explicitly select its existing new location with recover.command --database external ABSOLUTE_PATH (recover-app.command --database repository for a moved source database). No empty replacement was created.`);
  if (present && !established) state.established.push(selected);
  if (persist) saveDatabaseState(home, state);
  return { path, mustExist: established || present, selected, state };
}
function recordReady(home, selection) {
  const state = loadDatabaseState(home);
  if (!state.established.some(value => key(value) === key(selection.selected))) state.established.push(selection.selected);
  saveDatabaseState(home, state);
}
function chooseDatabase(home, selected) {
  selected = location(selected);
  const path = databasePath(home, selected);
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`Recovery requires an existing database at ${path}. Restore it first; this command never creates a database.`);
  // Explicit selection also resolves an ambiguous legacy absolute path.
  const state = existsSync(filename(home)) ? loadDatabaseState(home) : { version: 1, default: selected, established: [] };
  state.default = selected;
  if (!state.established.some(value => key(value) === key(selected))) state.established.push(selected);
  saveDatabaseState(home, state);
  return path;
}

function withLocationLock(home, action) {
  mkdirSync(resolve(home, 'cache'), { recursive: true, mode: 0o700 });
  const lock = resolve(home, 'cache/database-location.lock');
  try { mkdirSync(lock); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new Error('Another launcher owns database-location.lock. Retry after it finishes; remove a stale lock only after confirming its process stopped.');
  }
  try { return action(); } finally { rmdirSync(lock); }
}
export function resolveDatabase(home, env = process.env, persist = true) {
  return persist ? withLocationLock(home, () => resolveDatabaseState(home, env, true)) : resolveDatabaseState(home, env, false);
}
export function recordDatabaseReady(home, selection) {
  return withLocationLock(home, () => recordReady(home, selection));
}
export function selectDatabase(home, selected) {
  return withLocationLock(home, () => chooseDatabase(home, selected));
}
