import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { networkInterfaces } from 'node:os';
import { createApp } from './app.js';

const [major, minor] = process.versions.node.split('.').map(Number);
if (!(major === 24 || (major === 22 && minor >= 12))) {
  console.error('Use Node.js 22.12+ or 24 LTS. The local launcher selects a working LTS runtime.');
  process.exit(1);
}
const host = process.env.ROLEPLAY_HOST ?? '127.0.0.1';
const port = Number(process.env.ROLEPLAY_PORT ?? 3000);
const certificate = process.env.ROLEPLAY_TLS_CERT;
const key = process.env.ROLEPLAY_TLS_KEY;
if (Boolean(certificate) !== Boolean(key)) throw new Error('Set both ROLEPLAY_TLS_CERT and ROLEPLAY_TLS_KEY.');
if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !certificate) throw new Error('LAN access requires ROLEPLAY_TLS_CERT and ROLEPLAY_TLS_KEY. Start locally to set up the owner login first.');
const { app } = await createApp({
  database: resolve(process.env.ROLEPLAY_DATABASE ?? 'data/roleplay.sqlite'),
  staticDirectory: resolve('dist/client'),
  ...(certificate && key ? { https: { cert: readFileSync(certificate), key: readFileSync(key) } } : {}),
});
await app.listen({ host, port });
const protocol = certificate ? 'https' : 'http';
console.log(`ORE is running.\nLocal: ${protocol}://localhost:${port}`);
if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) console.log(`LAN: ${protocol}://${address.address}:${port}`);
    }
  }
} else console.log('LAN access is off. Configure HTTPS to connect a phone.');
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  void app.close().then(() => process.exit(0)).catch(() => process.exit(1));
});
