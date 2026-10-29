import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from '../../src/server/app.js';
import { AppError } from '../../src/core/errors.js';
import { message } from '../../src/shared/localization.js';
import { changeSchema } from '../../src/shared/changes.js';
import { startMockProvider } from './mock-provider.js';

export async function startBrowserApp(port = 0) {
  const directory = mkdtempSync(join(tmpdir(), 'roleplay-browser-'));
  let application: Awaited<ReturnType<typeof createApp>> | undefined;
  let provider: Awaited<ReturnType<typeof startMockProvider>> | undefined;
  let closing: Promise<void> | undefined;
  let lanHostname: string | null = 'ore-browser.local';
  const close = () => closing ??= (async () => {
    try { await application?.app.close(); }
    finally {
      try { await provider?.close(); }
      finally { rmSync(directory, { recursive: true, force: true }); }
    }
  })();
  try {
    const mock = await startMockProvider();
    provider = mock;
    application = await createApp({ database: join(directory, 'chat.sqlite'), staticDirectory: resolve('dist/client'),
      lan: { hostname: async () => {
        if (lanHostname === null) throw new AppError(503, 'lan_hostname_unavailable', message('errors.the_computer_s_local_hostname_could_not_be'));
        return lanHostname;
      }, interfaces: () => [{ id: 'browser-fixture:127.0.0.1', name: 'browser-fixture', address: '127.0.0.1', netmask: '255.0.0.0', prefix: 8 }] },
    });
    const { app, coordinator } = application;
    // These fixture controls exist only in test processes, never in the application.
    app.get('/__test/endpoint', async () => ({ endpoint: mock.url }));
    app.post('/__test/mode', async request => { mock.setMode((request.body as { mode: Parameters<typeof mock.setMode>[0] }).mode); return {}; });
    app.post('/__test/finish', async () => { mock.finishAll(); return {}; });
    app.get('/__test/requests', async () => mock.requests);
    app.post('/__test/change', async request => { coordinator.changed(changeSchema.parse(request.body)); return {}; });
    const url = await app.listen({ host: '127.0.0.1', port });
    return { url, close, setLanHostname: (value: string | null) => { lanHostname = value; } };
  } catch (error) {
    await close();
    throw error;
  }
}
