import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ORE dev-история-')); roots.push(root);
  cpSync(resolve('start-dev.command'), join(root, 'start-dev.command'));
  mkdirSync(join(root, 'scripts/release'), { recursive: true });
  cpSync(resolve('scripts/release/load-env.sh'), join(root, 'scripts/release/load-env.sh'));
  writeFileSync(join(root, 'local-edit'), 'Uncommitted working tree');
  writeFileSync(join(root, 'build-portable.sh'), `#!/bin/bash
set -euo pipefail
[ "$1" = --development ]
source=$(dirname -- "$0")
[ "$2" = "$source/ore-development" ]
[ ! -f "$source/fail-build" ] || exit 42
mkdir -p "$2"
cp "$source/local-edit" "$2/built-edit"
cat > "$2/start.command" <<'LAUNCH'
#!/bin/bash
set -euo pipefail
home=$(dirname -- "$0")
printf '%s\\n' "\${ORE_OPEN_BROWSER-unset}" > "$home/browser-setting"
printf '%s\\n' "$ORE_SKIP_UPDATE" "$ORE_DATABASE_DEFAULT" "\${ROLEPLAY_DATABASE-unset}" > "$home/launched"
LAUNCH
`);
  const run = (args: string[] = [], overrides: NodeJS.ProcessEnv = {}) => {
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', ...overrides }; delete env.ROLEPLAY_DATABASE;
    return spawnSync('/bin/bash', [join(root, 'start-dev.command'), ...args], { cwd: '/', env: { ...env, ...overrides }, encoding: 'utf8' });
  };
  return { root, home: join(root, 'ore-development'), run };
}

describe.skipIf(process.platform === 'win32')('current-checkout development launcher', () => {
  it('rebuilds local edits on every launch from another directory and disables repository updates', () => {
    const f = fixture(); expect(f.run().status).toBe(0);
    expect(readFileSync(join(f.home, 'built-edit'), 'utf8')).toBe('Uncommitted working tree');
    expect(readFileSync(join(f.home, 'launched'), 'utf8')).toBe('1\nrepository\nunset\n');
    writeFileSync(join(f.root, 'local-edit'), 'Next local edit');
    expect(f.run([], { ROLEPLAY_DATABASE: '/synthetic/explicit.sqlite' }).status).toBe(0);
    expect(readFileSync(join(f.home, 'built-edit'), 'utf8')).toBe('Next local edit');
    expect(readFileSync(join(f.home, 'launched'), 'utf8')).toBe('1\nrepository\n/synthetic/explicit.sqlite\n');
    expect(existsSync(join(f.root, 'ore-portable'))).toBe(false);
  });
  it('loads repository .env before building, while preserving explicit overrides', () => {
    const f = fixture();
    writeFileSync(join(f.root, '.env'), 'ROLEPLAY_DATABASE="/synthetic/from file.sqlite"\nORE_OPEN_BROWSER=0\n');
    expect(f.run().status).toBe(0);
    expect(readFileSync(join(f.home, 'launched'), 'utf8')).toContain('/synthetic/from file.sqlite');
    expect(readFileSync(join(f.home, 'browser-setting'), 'utf8')).toBe('0\n');
    expect(f.run([], { ROLEPLAY_DATABASE: '/synthetic/override.sqlite', ORE_OPEN_BROWSER: '1' }).status).toBe(0);
    expect(readFileSync(join(f.home, 'launched'), 'utf8')).toContain('/synthetic/override.sqlite');
    expect(readFileSync(join(f.home, 'browser-setting'), 'utf8')).toBe('1\n');
  });
  it('does not launch a stale build after compilation fails', () => {
    const f = fixture(); expect(f.run().status).toBe(0); rmSync(join(f.home, 'launched'));
    writeFileSync(join(f.root, 'fail-build'), '');
    expect(f.run().status).toBe(42); expect(existsSync(join(f.home, 'launched'))).toBe(false);
    expect(readFileSync(join(f.home, 'built-edit'), 'utf8')).toBe('Uncommitted working tree');
  });
  it('rejects destination arguments and a linked installation before building', () => {
    const f = fixture(); expect(f.run(['somewhere']).status).toBe(1); expect(existsSync(f.home)).toBe(false);
    const outside = join(f.root, 'outside'); mkdirSync(outside); symlinkSync(outside, f.home);
    const result = f.run(); expect(result.status).toBe(1); expect(result.stderr).toContain('not a symbolic link');
    expect(existsSync(join(outside, 'built-edit'))).toBe(false);
  });
});
