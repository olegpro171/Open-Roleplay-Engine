// npm's Windows script shims use CALL and re-expand metacharacters in the
// installation path. Run the same checked-in build tools directly with Node.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { buildPhase } from './build-timing.mjs';

// Developer validation remains in npm run check before distribution. The
// installation only needs browser assets and emitted server JavaScript.
for (const [phase, tool, ...args] of [
  ['bundle-interface', 'vite/bin/vite.js', 'build'],
  ['emit-server', 'typescript/bin/tsc', '-p', 'tsconfig.server.json', '--noCheck'],
]) {
  await buildPhase(phase, () => {
    const result = spawnSync(process.execPath, [resolve('node_modules', tool), ...args], { stdio: 'inherit', env: process.env });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${phase} failed (exit ${result.status}, signal ${result.signal}).`);
  });
}
