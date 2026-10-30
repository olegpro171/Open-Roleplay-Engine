// Run with the private runtime after building; never archive the installation wholesale.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { inventory } from './stage.mjs';
import { windowsRootTools } from './windows-package-files.mjs';

// Preserve private mutable directories when the portable archive is extracted.
process.umask(0o077);
const [homeArgument, outputArgument] = process.argv.slice(2);
if (!homeArgument || !outputArgument) throw new Error('Usage: node package-portable.mjs INSTALL_DIRECTORY OUTPUT_DIRECTORY');
const home = resolve(homeArgument), output = resolve(outputArgument);
const [id, runtime] = readFileSync(join(home, 'current'), 'utf8').trim().split('\n');
if (!/^(release|dev)-[a-z0-9-]+$/.test(id) || !/^node-v[0-9.]+-(darwin|linux|win32)-(arm64|x64)$/.test(runtime)) throw new Error('Invalid installed pointer.');
const application = join(home, 'app', id);
const manifest = JSON.parse(readFileSync(join(application, 'manifest.json'), 'utf8'));
const actual = inventory(application).filter(file => file.path !== 'manifest.json');
if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) throw new Error('Installed application differs from its manifest; rebuild before packaging.');
mkdirSync(output, { recursive: true });
const temporary = mkdtempSync(join(home, 'cache', 'export-'));
const name = `ORE-${manifest.commit.slice(0,12)}-${manifest.kind}-${manifest.platform}-${manifest.arch}`;
const windows = process.platform === 'win32';
const extension = windows ? 'zip' : 'tar.gz';
const payload = join(temporary, name), archive = join(output, `${name}.${extension}`);
try {
  mkdirSync(join(payload, 'app'), { recursive: true });
  mkdirSync(join(payload, 'runtime'));
  cpSync(application, join(payload, 'app', id), { recursive: true, verbatimSymlinks: true });
  cpSync(join(home, 'runtime', runtime), join(payload, 'runtime', runtime), { recursive: true, verbatimSymlinks: true });
  for (const file of ['start.command', 'current', 'recover.command']) cpSync(join(home, file), join(payload, file));
  if (windows) for (const file of windowsRootTools) cpSync(join(home, file), join(payload, file));
  // Export only the active recovery toolkit, never saved selections/DB paths.
  const toolkitPointer = readFileSync(join(home, 'recovery/current'), 'utf8').trim().split('\n');
  if (!/^(release|dev)-[a-z0-9-]+$/u.test(toolkitPointer[0])) throw new Error('Invalid recovery toolkit pointer.');
  mkdirSync(join(payload, 'recovery'), { recursive: true });
  cpSync(join(home, 'recovery', toolkitPointer[0]), join(payload, 'recovery', toolkitPointer[0]), { recursive: true, verbatimSymlinks: true });
  writeFileSync(join(payload, 'recovery/current'), `${toolkitPointer[0]}\n${runtime}\n`);
  for (const file of ['README.md', 'LICENSE']) cpSync(join(application, file), join(payload, file));
  for (const directory of ['data', 'cache', 'logs', 'languages']) mkdirSync(join(payload, directory));
  writeFileSync(join(payload, 'checksums.json'), JSON.stringify(inventory(payload), null, 2));
  // PowerShell 5.1 targets an older Framework compatibility profile. Opt this
  // writer process into standard ZIP separators; leave machine configuration
  // and the extractor's strict rejection of backslashes unchanged.
  const result = windows
    ? spawnSync('powershell.exe', ['-NoProfile', '-Command', "$ErrorActionPreference='Stop'; [AppContext]::SetSwitch('Switch.System.IO.Compression.ZipFile.UseBackslash',$false); Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory($env:ORE_EXPORT_SOURCE, $env:ORE_EXPORT_TARGET)"], { stdio: 'inherit', env: { ...process.env, ORE_EXPORT_SOURCE: temporary, ORE_EXPORT_TARGET: `${archive}.part` } })
    : spawnSync('tar', ['-czf', `${archive}.part`, '-C', temporary, name], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('Artifact archive failed.');
  const { renameSync } = await import('node:fs');
  renameSync(`${archive}.part`, archive);
  const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
  writeFileSync(`${archive}.sha256`, `${digest}  ${name}.${extension}\n`);
  console.log(`${archive}\nSHA256 ${digest}`);
} finally { rmSync(temporary, { recursive: true, force: true }); }
