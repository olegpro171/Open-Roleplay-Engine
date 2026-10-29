import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { createApp } from './app.js';
import { startupPaths, validateInstalledAssets } from './installation.js';

// The launcher's IPC channel can close while imports/startup are still running.
const launchedByParent = process.env.ORE_PARENT_IPC === '1' || typeof process.send === 'function';
let parentDisconnected = launchedByParent && !process.connected;
if (launchedByParent) process.once('disconnect', () => { parentDisconnected = true; });

const [major, minor] = process.versions.node.split('.').map(Number);
if (!(major === 24 || (major === 22 && minor >= 12))) throw new Error('Use Node.js 22.12+ or 24 LTS. Start portable installations with their supplied launcher.');
const paths = startupPaths();
// Vite serves source development separately; only built delivery requires UI assets.
if (import.meta.url.endsWith('.js')) validateInstalledAssets(paths);
const host = process.env.ROLEPLAY_HOST ?? '127.0.0.1';
const port = Number(process.env.ROLEPLAY_PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('ROLEPLAY_PORT must be an integer from 1 to 65535.');
const certificate = process.env.ROLEPLAY_TLS_CERT;
const key = process.env.ROLEPLAY_TLS_KEY;
if (Boolean(certificate) !== Boolean(key)) throw new Error('Set both ROLEPLAY_TLS_CERT and ROLEPLAY_TLS_KEY.');
if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !certificate) throw new Error('Keep ROLEPLAY_HOST on loopback for HTTP. Enable phone access in Application Settings after local owner setup. Legacy non-loopback startup requires ROLEPLAY_TLS_CERT and ROLEPLAY_TLS_KEY.');
let services: Awaited<ReturnType<typeof createApp>>;
if (process.connected) process.send?.({ type: 'startup-progress', stage: 'initializing-services' }, error => { if (error) parentDisconnected = true; });
try {
  services = await createApp({
    ...paths,
    ...(certificate && key ? { https: { cert: readFileSync(certificate), key: readFileSync(key) } } : {}),
  });
} catch (error) {
  if (error instanceof Error && 'code' in error && error.code === 'ORE_DATABASE_OWNED') process.send?.({ type: 'startup-error', id: 'alreadyRunning' });
  throw error;
}
const { app, lan } = services;
if (parentDisconnected) { await app.close(); process.exit(0); }
if (process.connected) process.send?.({ type: 'startup-progress', stage: 'binding-listener' }, error => { if (error) parentDisconnected = true; });
try { await app.listen({ host, port }); }
catch (error) {
  await app.close();
  if (error instanceof Error && 'code' in error && error.code === 'EADDRINUSE') {
    process.send?.({ type: 'startup-error', id: 'portConflict' });
    throw new Error(`Port ${port} is occupied. Stop the other ORE terminal or choose ROLEPLAY_PORT. No process was killed.`);
  }
  throw error;
}
if (parentDisconnected) { await app.close(); process.exit(0); }
let stopping = false;
const protocol = certificate ? 'https' : 'http';
const localHost = host === '::1' ? '[::1]' : host === '0.0.0.0' || host === '::' ? 'localhost' : host;
const url = `${protocol}://${localHost}:${port}`;
console.log(`ORE is running.\nLocal: ${url}\nStop: press Ctrl+C in this terminal.`);
process.send?.({ type: 'ready', url }, error => { if (error) stop(); });
if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) console.log(`LAN: ${protocol}://${address.address}:${port}`);
    }
  }
} else {
  const status = lan.status(true);
  if (status.runtime.state === 'listening') {
    if (status.runtime.hostname.state === 'available') console.log(`LAN: ${status.runtime.hostname.url}`);
    else console.log(status.runtime.hostname.localized.fallback);
    console.log(`LAN: ${status.runtime.ipv4Url}`);
  }
  else if (status.runtime.state === 'unavailable') console.log(`LAN: ${status.runtime.message}`);
  else console.log('LAN access is off. Enable it in Application Settings → Phone / LAN access.');
}
function stop() {
  if (stopping) return;
  stopping = true;
  void app.close().then(() => process.exit(0)).catch(() => process.exit(1));
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, stop);
// The portable launcher owns this child. Losing it must not orphan the server.
if (launchedByParent) process.once('disconnect', stop);
