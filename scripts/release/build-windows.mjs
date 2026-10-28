// npm's Windows script shims use CALL and re-expand metacharacters in the
// installation path. Run the same checked-in build tools directly with Node.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

for (const [tool, ...args] of [
  ['typescript/bin/tsc', '--noEmit'],
  ['typescript/bin/tsc', '-p', 'tsconfig.server.json', '--noEmit'],
  ['vite/bin/vite.js', 'build'],
  ['typescript/bin/tsc', '-p', 'tsconfig.server.json'],
]) {
  const result = spawnSync(process.execPath, [resolve('node_modules', tool), ...args], { stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
