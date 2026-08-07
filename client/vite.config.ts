import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    // The workspace symlink resolves on its own, but pinning it at the source entry keeps
    // Vite treating shared/ as project source (hot-reloaded, not pre-bundled).
    alias: { '@pangoguessr/shared': path.resolve(root, '../shared/src/index.ts') },
  },
  server: {
    port: 5173,
    // Same paths as production, where client and API share an origin (§2). Set up on day
    // one so dev and prod don't diverge.
    proxy: {
      '/api': 'http://localhost:3000',
      '/ws': { target: 'ws://localhost:3000', ws: true },
    },
  },
});
