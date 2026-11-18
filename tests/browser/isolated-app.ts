import { test as base } from '@playwright/test';
import { startBrowserApp } from '../support/browser-app';

export const test = base.extend<{ browserApp: Awaited<ReturnType<typeof startBrowserApp>>; starterChat: boolean }>({
  starterChat: [true, { option: true }],
  browserApp: async ({ starterChat }, use) => {
    const application = await startBrowserApp(0, { starterChat });
    try { await use(application); }
    finally { await application.close(); }
  },
  baseURL: async ({ browserApp }, use) => { await use(browserApp.url); },
});
