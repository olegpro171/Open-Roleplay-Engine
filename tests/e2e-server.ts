import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from '../src/server/app.js';
import { startMockProvider } from './support/mock-provider.js';

const directory = mkdtempSync(join(tmpdir(), 'roleplay-browser-'));
const mock = await startMockProvider();
const { app } = await createApp({ database: join(directory, 'chat.sqlite'), staticDirectory: resolve('dist/client') });
// These fixture controls exist only in this test process, never in the application.
app.get('/__test/endpoint', async () => ({ endpoint: mock.url }));
app.post('/__test/mode', async (request) => { mock.setMode((request.body as { mode: 'normal' | 'hold' }).mode); return {}; });
app.post('/__test/finish', async () => { mock.finishAll(); return {}; });
app.get('/__test/requests', async () => mock.requests);
await app.listen({ host: '127.0.0.1', port: 4173 });
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => {
  void (async () => { await app.close(); await mock.close(); rmSync(directory, { recursive: true, force: true }); process.exit(0); })();
});
