import { lstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readSelection } from './selection.mjs';

const buildId = /^(release|dev)-[a-f0-9]{12}-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const runtimeId = /^node-v[0-9]+\.[0-9]+\.[0-9]+-(darwin|linux|win32)-(arm64|x64)$/u;
const dependencyId = /^[a-f0-9]{64}-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;

function entry(path) {
  try { return lstatSync(path); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function isManagedDirectory(path) {
  const stat = entry(path);
  if (stat && !stat.isDirectory()) throw new Error(`Invalid build directory: ${path}`);
  return Boolean(stat);
}

function selection(home, name) {
  const stat = entry(join(home, name));
  if (!stat) return null;
  if (!stat.isFile() || stat.size > 512) throw new Error(`Invalid build selection: ${name}`);
  return readSelection(home, name);
}

function prune(directory, pattern, keep) {
  if (!isManagedDirectory(directory)) return;
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    if (item.isDirectory() && pattern.test(item.name) && !keep.has(item.name)) {
      rmSync(join(directory, item.name), { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
    }
  }
}

function prunePayloads(home, applications, toolkits) {
  prune(join(home, 'app'), buildId, new Set(applications.map(build => build.id)));
  prune(join(home, 'recovery'), buildId, new Set(toolkits.map(build => build.id)));
  prune(join(home, 'runtime'), runtimeId, new Set([...applications, ...toolkits].map(build => build.runtime)));
}

// Called by the installed helper under its package lease, after owned readiness.
export function pruneWindowsBuilds(home) {
  const current = selection(home, 'current');
  const working = selection(home, 'working');
  if (!current || current.id !== working?.id || current.runtime !== working.runtime) return;
  const previous = selection(home, 'previous');
  const recovery = isManagedDirectory(join(home, 'recovery')) && selection(home, 'recovery/current');
  const prepared = join(home, 'cache/prepared-update');
  const applications = [current, previous].filter(Boolean);
  if (isManagedDirectory(join(home, 'cache')) && isManagedDirectory(prepared)) {
    const base = selection(prepared, 'base');
    const candidate = selection(prepared, 'current');
    if (!base || !candidate) throw new Error('Incomplete prepared Windows update.');
    if (base.id === current.id && base.runtime === current.runtime) applications.push(candidate);
  }
  prunePayloads(home, applications, [...applications, recovery].filter(Boolean));
}

// The development builder holds the installation lock and has committed current.
export function pruneDevelopmentBuilds(home, current, dependencies) {
  for (const name of ['previous', 'working']) {
    if (selection(home, name)?.id !== current.id) rmSync(join(home, name), { force: true });
  }
  prunePayloads(home, [current], [current]);
  if (dependencies) {
    prune(join(home, 'cache/development-dependencies'), dependencyId, new Set([dependencies]));
  }
}
