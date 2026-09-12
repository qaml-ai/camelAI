import type { Config } from '@react-router/dev/config';

export default {
  // Enable SSR for Cloudflare Workers
  ssr: true,

  // App directory contains routes
  appDirectory: 'src',

  // Avoid a route-discovery round trip before opening a new thread.
  routeDiscovery: { mode: 'initial' },

  // Enable Vite environment API for proper Cloudflare Workers SSR
  future: {
    v8_viteEnvironmentApi: true,
  },
} satisfies Config;
