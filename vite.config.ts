import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'distribute-icon-source',
      generateBundle() {
        // MPL-covered adaptations ship with their exact source, including portable builds.
        this.emitFile({ type: 'asset', fileName: 'third-party/yandex-ui-icons/Icon.tsx.txt', source: readFileSync(new URL('./src/web/Icon.tsx', import.meta.url), 'utf8') });
      },
    },
    {
      name: 'precompress-client-assets',
      generateBundle: {
        order: 'post',
        handler(_options, bundle) {
          for (const file of Object.values(bundle)) {
            if (!/\.(js|css)$/.test(file.fileName)) continue;
            const source = file.type === 'chunk' ? file.code : file.source;
            this.emitFile({ type: 'asset', fileName: `${file.fileName}.gz`, source: gzipSync(source) });
          }
        },
      },
    },
  ],
  build: { outDir: 'dist/client', chunkSizeWarningLimit: 1_300 },
  server: { proxy: { '/api': 'http://127.0.0.1:3000' } },
});
