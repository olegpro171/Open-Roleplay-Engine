import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

// Stable installation-root tools accompany every Windows package. Versioned
// application/recovery files are published separately; mutable data never is.
export const windowsRootEntries = ['recover-app.bat'];
export const windowsRootHelpers = ['start-windows.ps1', 'recover-windows.ps1', 'windows-common.ps1', 'windows-snapshot.ps1', 'windows-package-lock.ps1', 'windows-package.ps1', 'windows-standalone-common.ps1'];
export const windowsRootTools = [...windowsRootEntries, ...windowsRootHelpers];
export const windowsPackageRootFiles = ['start.command', 'recover.command', ...windowsRootTools, 'README.md', 'LICENSE'];

// SHA-256 over LF text for the ORE wrappers used in release and development builds.
const retiredStartBatches = new Set([
  '73912ec9189c6696c482e037511b5ae8738ebabf358e54ae9a2e52b9e3f22f0f',
  '12c6a79193939b5434f3aefe18970dccbbf077956c6197d3202216cafd0a2e4b',
  '0a17c73653135fa79ef6c650e1572b6a956e48f354d53b01537e0433b2df67f3',
]);

export function removeRetiredStartBatch(home) {
  const path = join(home, 'start-app.bat');
  try {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.size > 1024) return;
    const digest = createHash('sha256').update(readFileSync(path, 'latin1').replaceAll('\r\n', '\n'), 'latin1').digest('hex');
    if (retiredStartBatches.has(digest)) unlinkSync(path);
  } catch (error) {
    // Activation has committed. A locked old wrapper can be retired on the next update.
    console.warn(`Could not retire start-app.bat: ${error.message}`);
  }
}
