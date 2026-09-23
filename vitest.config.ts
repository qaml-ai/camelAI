import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      'virtual:db-query-runner-source': `${path.resolve(
        __dirname,
        './workers/main/db-query-sandbox-assets/runner/db-query-runner.mjs',
      )}?raw`,
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    globals: true,
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    exclude: ['tests/integration/**', 'tests/agent-service-adapter.test.ts'],
  },
});
