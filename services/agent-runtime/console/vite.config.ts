import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/postcss";
import { fileURLToPath } from "node:url";

// Built into console/dist and served by the runtime at /console/.
export default defineConfig({
  root: fileURLToPath(new URL("./web", import.meta.url)),
  base: "/console/",
  plugins: [react()],
  resolve: { alias: { "@": fileURLToPath(new URL("./web", import.meta.url)) } },
  css: { postcss: { plugins: [tailwind()] } },
  build: { outDir: "../dist", emptyOutDir: true },
  server: { proxy: { "/v1": "http://127.0.0.1:8790", "/console/auth": "http://127.0.0.1:8790" } },
});
