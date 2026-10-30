// CI only: package an exact, clean Windows build, then verify the extracted bytes.
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { inventory } from './stage.mjs';
import { parseSelection, runtimeExecutable } from './selection.mjs';
import { verifyStartup } from './startup-smoke.mjs';
import { readWindowsRelease, validateCommit } from './ci-release-files.mjs';

const [homeArgument, outputArgument, commit] = process.argv.slice(2);
validateCommit(commit);
if (process.platform !== 'win32' || process.arch !== 'x64' || !homeArgument || !outputArgument) throw new Error('Use Windows x64: ci-package-windows.mjs INSTALL_DIRECTORY OUTPUT_DIRECTORY FULL_COMMIT');
const home = resolve(homeArgument), output = resolve(outputArgument);
const selected = parseSelection(readFileSync(join(home, 'current'), 'utf8'));
const application = join(home, 'app', selected.id);
const info = JSON.parse(readFileSync(join(application, 'build-info.json'), 'utf8'));
if (info.commit !== commit || info.kind !== 'release' || info.platform !== 'win32' || info.arch !== 'x64') throw new Error('Installed application does not match the Windows release commit.');
mkdirSync(output);
const temporary = mkdtempSync(join(tmpdir(), 'ORE-release-verification-'));
function run(executable, args, env = process.env) {
  const result = spawnSync(executable, args, { stdio: 'inherit', env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Release command failed (${result.status}): ${executable}`);
}
try {
  const packed = join(temporary, 'packed');
  run(runtimeExecutable(home, selected.runtime), [join(application, 'scripts/release/package-portable.mjs'), home, packed]);
  const name = `ORE-${commit.slice(0, 12)}-release-win32-x64`;
  renameSync(join(packed, `${name}.zip`), join(output, 'ORE-windows-x64.zip'));
  const extracted = join(temporary, 'extracted');
  const payload = join(extracted, name);
  mkdirSync(extracted);
  run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'RemoteSigned', '-Command', "$ErrorActionPreference='Stop'; . $env:ORE_CI_TOOLS; Expand-OreZip $env:ORE_CI_ARCHIVE $env:ORE_CI_ROOT $env:ORE_CI_EXTRACTED -LongPaths"], { ...process.env, ORE_CI_TOOLS: resolve('scripts/release/windows-snapshot.ps1'), ORE_CI_ARCHIVE: join(output, 'ORE-windows-x64.zip'), ORE_CI_ROOT: name, ORE_CI_EXTRACTED: payload });
  if (JSON.stringify(readdirSync(extracted)) !== JSON.stringify([name])) throw new Error('Unexpected archive root.');
  const checksums = JSON.parse(readFileSync(join(payload, 'checksums.json'), 'utf8'));
  const actual = inventory(payload).filter(file => file.path !== 'checksums.json');
  if (JSON.stringify(checksums) !== JSON.stringify(actual)) throw new Error('Extracted package differs from its complete inventory.');
  for (const directory of ['data', 'cache', 'logs', 'languages']) if (readdirSync(join(payload, directory)).length !== 0) throw new Error(`Release contains mutable data: ${directory}`);
  const extractedSelection = parseSelection(readFileSync(join(payload, 'current'), 'utf8'));
  if (JSON.stringify(extractedSelection) !== JSON.stringify(selected)) throw new Error('Extracted selection changed.');
  const extractedApp = join(payload, 'app', selected.id);
  const extractedNode = runtimeExecutable(payload, selected.runtime);
  run(extractedNode, [join(extractedApp, 'scripts/release/native-smoke.mjs')]);
  await verifyStartup(extractedApp, extractedNode, join(payload, 'cache'));
  const archive = readFileSync(join(output, 'ORE-windows-x64.zip'));
  const sha256 = createHash('sha256').update(archive).digest('hex');
  const descriptor = { formatVersion: 1, platform: 'win32', arch: 'x64', commit, archive: 'ORE-windows-x64.zip', sha256, bytes: archive.length, launcherProtocol: 2 };
  writeFileSync(join(output, 'ORE-windows-x64.json'), JSON.stringify(descriptor, null, 2)+'\n');
  writeFileSync(join(output, 'ORE-windows-x64.zip.sha256'), `${sha256}  ORE-windows-x64.zip\n`);
  cpSync(resolve('ORE-launcher.bat'), join(output, 'ORE-launcher.bat'));
  readWindowsRelease(output, commit);
  console.log(`Verified Windows x64 release package for ${commit}.`);
} finally { rmSync(temporary, { recursive: true, force: true }); }
