import { test as base } from '@playwright/test';
import { startBrowserApp } from '../support/browser-app';

export const test = base.extend<{ browserApp: Awaited<ReturnType<typeof startBrowserApp>> }>({
  browserApp: async ({}, use) => {
    const application = await startBrowserApp();
    try { await use(application); }
    finally { await application.close(); }
  },
  baseURL: async ({ browserApp }, use) => { await use(browserApp.url); },
});
