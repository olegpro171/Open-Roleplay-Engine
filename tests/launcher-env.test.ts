import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it('reads literal settings, CRLF, quotes and empty values without executing commands', () => {
  const root = mkdtempSync(join(tmpdir(), 'ore-env-')); roots.push(root);
  const file = join(root, '.env');
  writeFileSync(file, '# comment\r\n\r\nORE_OPEN_BROWSER=0\r\nENV_TEST_VALUE="literal $(exit 42) $HOME"\r\nENV_TEST_EMPTY=\r\n');
  const result = spawnSync('/bin/bash', ['-c', '. "$1"; ore_load_env "$2"; printf "%s\\n" "$ORE_OPEN_BROWSER" "$ENV_TEST_VALUE" "$ENV_TEST_EMPTY"', 'test', resolve('scripts/release/load-env.sh'), file], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  expect(result.status).toBe(0);
  expect(result.stdout).toBe('0\nliteral $(exit 42) $HOME\n\n');
});
it('reports malformed assignments without leaking their contents', () => {
  const root = mkdtempSync(join(tmpdir(), 'ore-env-')); roots.push(root);
  const file = join(root, '.env'); writeFileSync(file, '# comment\nsecret invalid contents\n');
  const result = spawnSync('/bin/bash', ['-c', '. "$1"; ore_load_env "$2"', 'test', resolve('scripts/release/load-env.sh'), file], { encoding: 'utf8' });
  expect(result.status).toBe(1); expect(result.stderr).toContain(`${file}:2`); expect(result.stderr).not.toContain('secret invalid');
});
