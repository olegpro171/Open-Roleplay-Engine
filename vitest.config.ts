import { defineConfig } from 'vitest/config';
export default defineConfig({ test: {
  include: ['tests/**/*.test.ts'], pool: 'threads', maxWorkers: 2,
  // Native Windows qualification includes real SQLite flushes/migrations and
  // PowerShell 5.1 startup. Product timing assertions retain their own bounds.
  testTimeout: process.platform === 'win32' ? 30_000 : 5_000,
} });
