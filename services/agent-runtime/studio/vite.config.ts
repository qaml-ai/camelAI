import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/postcss';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  root: fileURLToPath(new URL('./web', import.meta.url)),
  plugins: [react()],
  resolve: { alias: { '@': fileURLToPath(new URL('./web', import.meta.url)) } },
  css: { postcss: { plugins: [tailwind()] } },
  build: { outDir: '../dist', emptyOutDir: true },
});
