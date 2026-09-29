import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Builds the standalone notebook/file renderer SPA into the main app's static
// assets (public/notebook-renderer/). The deploy path reads these files through
// the worker's ASSETS binding to synthesize static "published notebook" workers
// (workers/main/src/notebook-worker-bundle.ts), replacing the retired sandbox VM
// image that used to carry the bundle at /usr/local/lib/create-worker.
export default defineConfig({
  root: 'sandbox/create-worker/renderer',
  plugins: [react()],
  resolve: { tsconfigPaths: true },
  build: {
    outDir: '../../../public/notebook-renderer',
    emptyOutDir: true,
  },
  css: {
    postcss: __dirname,
  },
});
