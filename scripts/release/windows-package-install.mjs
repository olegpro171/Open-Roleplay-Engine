// Package activation changes code selection only; saved data is owned by application-start.
import { existsSync, lstatSync, readFileSync, readdirSync, renameSync, mkdirSync, copyFileSync, cpSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { inventory } from './stage.mjs';
import { parseSelection, readSelection, writeSelection, publishRename } from './selection.mjs';
import { verifyApplication } from './application-assets.mjs';
import { windowsPackageRootFiles as rootFiles } from './windows-package-files.mjs';
import { isLauncherVersion } from './windows-launcher-version.mjs';

const minimumVersionFile = 'minimum-launcher-version';

function parseLauncherVersion(text) {
  const version = Number(text);
  if (!isLauncherVersion(version) || String(version) !== text) throw new Error('Invalid Windows launcher version.');
  return version;
}

export function verifyWindowsPackage(directory, commit) {
  if (!/^[a-f0-9]{40}$/u.test(commit)) throw new Error('Invalid package commit.');
  const selected = parseSelection(readFileSync(join(directory, 'current'), 'utf8'));
  if (!/^node-v[0-9.]+-win32-x64$/u.test(selected.runtime)) throw new Error('Expected Windows x64 runtime.');
  const allowed = new Set([...rootFiles, 'current', 'checksums.json', 'app', 'runtime', 'recovery', 'data', 'cache', 'logs', 'languages']);
  for (const name of readdirSync(directory)) {
    if (!allowed.has(name)) throw new Error('Unexpected package root entry.');
  }
  for (const name of ['data', 'cache', 'logs', 'languages']) {
    if (!lstatSync(join(directory, name)).isDirectory() || readdirSync(join(directory, name)).length) throw new Error('Package contains mutable user data.');
  }
  for (const [name, expected] of [['app', [selected.id]], ['runtime', [selected.runtime]], ['recovery', [selected.id, 'current']]]) {
    if (readdirSync(join(directory, name)).sort().join('\n') !== expected.sort().join('\n')) throw new Error('Unexpected package payload selection.');
  }
  const checksums = JSON.parse(readFileSync(join(directory, 'checksums.json'), 'utf8'));
  const actual = inventory(directory).filter(file => file.path !== 'checksums.json');
  if (actual.some(file => 'link' in file) || JSON.stringify(actual) !== JSON.stringify(checksums)) throw new Error('Package contents differ from checksums.');
  for (const name of rootFiles) {
    if (!lstatSync(join(directory, name)).isFile()) throw new Error('Missing package entry.');
  }
  const application = join(directory, 'app', selected.id);
  const info = JSON.parse(readFileSync(join(application, 'build-info.json'), 'utf8'));
  if (info.commit !== commit || info.kind !== 'release' || info.platform !== 'win32' || info.arch !== 'x64') throw new Error('Package identity does not match release.');
  const recovery = parseSelection(readFileSync(join(directory, 'recovery/current'), 'utf8'));
  if (recovery.id !== selected.id || recovery.runtime !== selected.runtime) throw new Error('Package recovery selection differs.');
  for (const tools of [join(application, 'scripts/release'), join(directory, 'recovery', selected.id)]) {
    if (readFileSync(join(tools, 'windows-package-protocol'), 'utf8').trim() !== '2' || !lstatSync(join(tools, 'windows-package-launcher.ps1')).isFile()) throw new Error('Unsupported package launcher.');
  }
  return selected;
}

function publishDirectory(source, destination, copy = false) {
  if (existsSync(destination)) {
    if (!lstatSync(destination).isDirectory() || JSON.stringify(inventory(source)) !== JSON.stringify(inventory(destination))) throw new Error('Existing immutable payload differs from package.');
    return;
  }
  if (!copy) { renameSync(source, destination); return; }
  // The installer runs with the extracted Node executable. Windows must not
  // rename that running executable's directory; publish a complete copy instead.
  const temporary = `${destination}-${randomUUID()}.tmp`;
  try {
    cpSync(source, temporary, { recursive: true });
    if (JSON.stringify(inventory(source)) !== JSON.stringify(inventory(temporary))) throw new Error('Runtime copy verification failed.');
    renameSync(temporary, destination);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

function publishPayload(directory, home, selected) {
  for (const name of ['app', 'runtime', 'recovery']) mkdirSync(join(home, name), { recursive: true });
  publishDirectory(join(directory, 'app', selected.id), join(home, 'app', selected.id));
  publishDirectory(join(directory, 'runtime', selected.runtime), join(home, 'runtime', selected.runtime), true);
  publishDirectory(join(directory, 'recovery', selected.id), join(home, 'recovery', selected.id));
}

function activateSelection(directory, home, selected) {
  const previous = readSelection(home, 'working');
  for (const name of rootFiles) {
    const temporary = join(home, `${name}-${randomUUID()}.tmp`);
    copyFileSync(join(directory, name), temporary);
    publishRename(temporary, join(home, name));
  }
  writeSelection(join(home, 'recovery'), 'current', selected);
  if (previous && previous.id !== selected.id) writeSelection(home, 'previous', previous);
  // The committed selection changes last. Interrupted publication leaves the
  // previous app usable and immutable orphan payloads reusable by a later run.
  writeSelection(home, 'current', selected);
  return selected;
}

export function installWindowsPackage(directory, home, commit) {
  const selected = verifyWindowsPackage(directory, commit);
  publishPayload(directory, home, selected);
  return activateSelection(directory, home, selected);
}

const preparedDirectory = home => join(home, 'cache', 'prepared-update');
const equalSelection = (a, b) => a?.id === b?.id && a?.runtime === b?.runtime;

function prepareSelection(directory, home, selected, minimumLauncherVersion) {
  if (!isLauncherVersion(minimumLauncherVersion)) throw new Error('Invalid minimum launcher version.');
  const current = readSelection(home);
  if (!current || current.id === selected.id) throw new Error('Prepared update requires a different installed version.');
  const prepared = preparedDirectory(home);
  const staging = join(directory, '..', 'prepared-update');
  if (existsSync(prepared)) throw new Error('A prepared update already exists.');
  mkdirSync(join(home, 'cache'), { recursive: true });
  mkdirSync(staging);
  for (const name of rootFiles) copyFileSync(join(directory, name), join(staging, name));
  writeSelection(staging, 'base', current);
  writeSelection(staging, 'current', selected);
  writeFileSync(join(staging, minimumVersionFile), String(minimumLauncherVersion), { flag: 'wx' });
  writeFileSync(join(staging, 'checksums.json'), JSON.stringify(inventory(staging)), { flag: 'wx' });
  publishPayload(directory, home, selected);
  // The running app and its recovery pointers retain their previous selection.
  // Publish the receipt only once every immutable payload is in place.
  publishRename(staging, prepared);
}

export function prepareWindowsPackage(directory, home, commit, minimumLauncherVersion) {
  const selected = verifyWindowsPackage(directory, commit);
  prepareSelection(directory, home, selected, minimumLauncherVersion);
  return selected;
}

export function activatePreparedWindowsPackage(home, expected, launcherVersion) {
  if (!isLauncherVersion(launcherVersion)) throw new Error('Invalid Windows launcher version.');
  const directory = preparedDirectory(home);
  const checksumsPath = join(directory, 'checksums.json');
  const checksumFile = lstatSync(checksumsPath);
  if (!checksumFile.isFile() || checksumFile.size > 16 * 1024) throw new Error('Invalid prepared update inventory.');
  const checksums = JSON.parse(readFileSync(checksumsPath, 'utf8'));
  const files = inventory(directory).filter(file => file.path !== 'checksums.json');
  if (files.some(file => 'link' in file) || JSON.stringify(files) !== JSON.stringify(checksums) ||
      files.map(file => file.path).join('\n') !== [...rootFiles, 'base', 'current', minimumVersionFile].sort().join('\n')) {
    throw new Error('Prepared update metadata differs from its inventory.');
  }
  const base = readSelection(directory, 'base');
  const selected = readSelection(directory);
  if (!base || !selected || !equalSelection(base, readSelection(home)) || !equalSelection(selected, expected) || base.id === selected.id) {
    throw new Error('Prepared update no longer matches the installed selection.');
  }
  const minimum = parseLauncherVersion(readFileSync(join(directory, minimumVersionFile), 'utf8'));
  if (launcherVersion < minimum) throw new Error('Prepared update requires a newer Windows launcher.');
  return activateSelection(directory, home, selected);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === '--activate-prepared') {
    const [, home, id, runtime, launcherVersion] = args;
    if (!home || !id || !runtime) throw new Error('Expected installation and prepared selection.');
    activatePreparedWindowsPackage(resolve(home), { id, runtime }, parseLauncherVersion(launcherVersion));
  } else {
    const prepare = args[0] === '--prepare';
    const [directory, home, commit, minimumLauncherVersion] = prepare ? args.slice(1) : args;
    if (!directory || !home || !commit) throw new Error('Expected package directory, installation and commit.');
    // Runtime-dependent preflight belongs at the executable boundary. The file
    // publication routines are platform-independent and execute no payload code.
    const selected = verifyWindowsPackage(resolve(directory), commit);
    verifyApplication(join(resolve(directory), 'app', selected.id));
    if (prepare) prepareSelection(resolve(directory), resolve(home), selected, parseLauncherVersion(minimumLauncherVersion));
    else {
      publishPayload(resolve(directory), resolve(home), selected);
      activateSelection(resolve(directory), resolve(home), selected);
    }
  }
}
