import { startBrowserApp } from './support/browser-app.js';

const application = await startBrowserApp(4173);
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => {
  void (async () => { await application.close(); process.exit(0); })();
});
