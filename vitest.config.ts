import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/**/*.test.ts'], pool: 'threads', maxWorkers: 2 } });
