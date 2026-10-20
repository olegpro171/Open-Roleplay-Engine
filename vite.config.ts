import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react(), {
    name: 'distribute-icon-source',
    generateBundle() {
      // MPL-covered adaptations ship with their exact source, including portable builds.
      this.emitFile({ type: 'asset', fileName: 'third-party/yandex-ui-icons/Icon.tsx.txt', source: readFileSync(new URL('./src/web/Icon.tsx', import.meta.url), 'utf8') });
    },
  }],
  build: { outDir: 'dist/client' },
  server: { proxy: { '/api': 'http://127.0.0.1:3000' } },
});
