import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { createApp } from '../src/server/app.js';

it('serves the built scripts and styles as gzip or plain bytes at the same URL', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ore-static-assets-'));
  const staticDirectory = join(directory, 'client');
  try {
    execFileSync(process.execPath, [resolve('node_modules/vite/bin/vite.js'), 'build', '--outDir', staticDirectory, '--emptyOutDir'], {
      env: { ...process.env, NODE_ENV: 'production' },
    });
    const assets = join(staticDirectory, 'assets');
    const files = readdirSync(assets).filter(name => /\.(js|css)$/.test(name));
    expect(new Set(files.map(name => extname(name)))).toEqual(new Set(['.js', '.css']));
    const { app } = await createApp({ staticDirectory, database: join(directory, 'test.sqlite') });
    try {
      for (const name of files) {
        const original = readFileSync(join(assets, name));
        const url = `/assets/${name}`;
        const gzip = await app.inject({ url, headers: { 'accept-encoding': 'br, gzip' } });
        expect(gzip.statusCode).toBe(200);
        expect(gzip.headers['content-encoding']).toBe('gzip');
        expect(gzip.headers.vary).toMatch(/accept-encoding/i);
        expect(gzip.headers['content-type']).toContain(name.endsWith('.css') ? 'text/css' : 'javascript');
        expect(gunzipSync(gzip.rawPayload).equals(original)).toBe(true);

        const plain = await app.inject({ url, headers: { 'accept-encoding': 'identity' } });
        expect(plain.statusCode).toBe(200);
        expect(plain.headers['content-encoding']).toBeUndefined();
        expect(plain.headers.vary).toMatch(/accept-encoding/i);
        expect(plain.rawPayload.equals(original)).toBe(true);
      }
    } finally { await app.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
