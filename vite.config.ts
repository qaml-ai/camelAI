import { reactRouter } from '@react-router/dev/vite';
import { cloudflare, type WorkerConfig } from '@cloudflare/vite-plugin';
import path from 'node:path';
import { defineConfig, type DepOptimizationOptions, type Plugin } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';

const camelaiBuildId =
  process.env.CAMELAI_BUILD_ID ||
  process.env.GITHUB_SHA ||
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

// Plugin to suppress benign "terminated" errors from undici/miniflare
// These occur when WebSocket connections are aborted during HMR/navigation
function suppressUndiciTerminatedErrors(): Plugin {
  const isBenignDevFetchAbort = (value: unknown) => {
    const msg = String(value);
    return (
      msg.includes('terminated') ||
      msg.includes('ECONNRESET') ||
      msg.includes('other side closed') ||
      (msg.includes('fetch failed') &&
        (msg.includes('undici') || msg.includes('miniflare')))
    );
  };

  return {
    name: 'suppress-undici-terminated',
    configureServer() {
      // Only in development
      const originalListeners = process.listeners('uncaughtException');
      process.removeAllListeners('uncaughtException');

      process.on('uncaughtException', (err) => {
        // Suppress benign connection abort errors from undici/miniflare
        if (isBenignDevFetchAbort(err)) {
          // Silently ignore - these are expected during HMR/navigation
          return;
        }
        // Re-throw other errors to original handlers
        for (const listener of originalListeners) {
          listener(err, 'uncaughtException');
        }
      });

      process.on('unhandledRejection', (reason) => {
        if (isBenignDevFetchAbort(reason)) {
          return;
        }
        // Let other rejections propagate normally
        console.error('Unhandled rejection:', reason);
      });
    },
  };
}

function withLocalDevVars(config: WorkerConfig): Partial<WorkerConfig> | void {
  const localAgentRuntimeUrl = process.env.LOCAL_AGENT_RUNTIME_URL;
  const localAgentRuntimeToken = process.env.LOCAL_AGENT_RUNTIME_TOKEN;
  const localAgentProviderVars = localAgentRuntimeUrl ? Object.fromEntries(
    ['SELFHOST_AI_PROVIDER', 'SELFHOST_AI_API_KEY', 'SELFHOST_AI_API', 'SELFHOST_AI_BASE_URL', 'SELFHOST_AI_MODEL', 'SELFHOST_AI_NAME']
      .filter(key => process.env[key]).map(key => [key, process.env[key]!]),
  ) : {};
  const isLocalE2E = process.env.E2E_LOCAL === '1';
  const localAuthBypass = process.env.LOCAL_AUTH_BYPASS;
  const localAuthBypassHosts = process.env.LOCAL_AUTH_BYPASS_HOSTS;
  const localAuthUserEmail = process.env.LOCAL_AUTH_USER_EMAIL;
  const localAuthUserName = process.env.LOCAL_AUTH_USER_NAME;
  const tokenSigningSecret = process.env.TOKEN_SIGNING_SECRET;
  const workerBaseUrl = process.env.WORKER_BASE_URL;
  const nextjsEnv = process.env.NEXTJS_ENV;
  const cfDispatchNamespace = process.env.CF_DISPATCH_NAMESPACE;
  const cfWorkerName = process.env.CF_WORKER_NAME;
  const localAppVanityDomain = process.env.LOCAL_APP_VANITY_DOMAIN;
  const localAppIframeDomain = process.env.LOCAL_APP_IFRAME_DOMAIN;
  const sandboxProxySecret = process.env.SANDBOX_PROXY_SECRET;
  const projectRuntimeServiceUrl = process.env.PROJECT_RUNTIME_SERVICE_URL;
  const projectRuntimeDockerProxyBaseUrl =
    process.env.PROJECT_RUNTIME_DOCKER_PROXY_BASE_URL;
  const projectRuntimeProxySecret = process.env.PROJECT_RUNTIME_PROXY_SECRET;
  // E2E deterministic LLM: route model calls to the local replay stub.
  const testLlmReplayUrl = process.env.TEST_LLM_REPLAY_URL;

  if (
    !localAgentRuntimeUrl &&
    !localAuthBypass &&
    !localAuthBypassHosts &&
    !localAuthUserEmail &&
    !localAuthUserName &&
    !tokenSigningSecret &&
    !workerBaseUrl &&
    !nextjsEnv &&
    !cfDispatchNamespace &&
    !cfWorkerName &&
    !localAppVanityDomain &&
    !localAppIframeDomain &&
    !sandboxProxySecret &&
    !projectRuntimeServiceUrl &&
    !projectRuntimeDockerProxyBaseUrl &&
    !projectRuntimeProxySecret &&
    !testLlmReplayUrl
  ) {
    return;
  }

  return {
    ...(isLocalE2E
      ? { dev: { ...config.dev, enable_containers: false } }
      : {}),
    vars: {
      ...(config.vars ?? {}),
      ...localAgentProviderVars,
      ...(localAgentRuntimeUrl ? { LOCAL_AGENT_RUNTIME_URL: localAgentRuntimeUrl, LOCAL_AGENT_RUNTIME_TOKEN: localAgentRuntimeToken ?? "" } : {}),
      ...(testLlmReplayUrl ? { TEST_LLM_REPLAY_URL: testLlmReplayUrl } : {}),
      ...(localAuthBypass ? { LOCAL_AUTH_BYPASS: localAuthBypass } : {}),
      ...(localAuthBypassHosts
        ? { LOCAL_AUTH_BYPASS_HOSTS: localAuthBypassHosts }
        : {}),
      ...(localAuthUserEmail
        ? { LOCAL_AUTH_USER_EMAIL: localAuthUserEmail }
        : {}),
      ...(localAuthUserName ? { LOCAL_AUTH_USER_NAME: localAuthUserName } : {}),
      ...(tokenSigningSecret ? { TOKEN_SIGNING_SECRET: tokenSigningSecret } : {}),
      ...(workerBaseUrl ? { WORKER_BASE_URL: workerBaseUrl } : {}),
      ...(nextjsEnv ? { NEXTJS_ENV: nextjsEnv } : {}),
      ...(cfDispatchNamespace ? { CF_DISPATCH_NAMESPACE: cfDispatchNamespace } : {}),
      ...(cfWorkerName ? { CF_WORKER_NAME: cfWorkerName } : {}),
      ...(localAppVanityDomain ? { LOCAL_APP_VANITY_DOMAIN: localAppVanityDomain } : {}),
      ...(localAppIframeDomain ? { LOCAL_APP_IFRAME_DOMAIN: localAppIframeDomain } : {}),
      ...(sandboxProxySecret
        ? { SANDBOX_PROXY_SECRET: sandboxProxySecret }
        : {}),
      ...(projectRuntimeServiceUrl
        ? { PROJECT_RUNTIME_SERVICE_URL: projectRuntimeServiceUrl }
        : {}),
      ...(projectRuntimeDockerProxyBaseUrl
        ? { PROJECT_RUNTIME_DOCKER_PROXY_BASE_URL: projectRuntimeDockerProxyBaseUrl }
        : {}),
      ...(projectRuntimeProxySecret
        ? { PROJECT_RUNTIME_PROXY_SECRET: projectRuntimeProxySecret }
        : {}),
    },
  };
}

export default defineConfig(({ command }) => {
  const smithyCoreConfigNodeEntry = path.resolve(
    'node_modules/@smithy/core/dist-es/submodules/config/index.js',
  );
  const clientOptimizeDepsInclude = [
    'react',
    'react-dom',
    'react-dom/client',
    'react-router',
    'react/jsx-runtime',
    'react/jsx-dev-runtime',
  ];

  // SSR startup was repeatedly discovering and re-hashing deps, which left the
  // module runner requesting stale files from node_modules/.vite/deps_ssr.
  // Keep SSR dep optimization deterministic and only prebundle the small set of
  // interop-sensitive deps that actually need it.
  const ssrOptimizeDeps: DepOptimizationOptions = {
    include: [
      'cookie',
      'react',
      'react/jsx-runtime',
      'react/jsx-dev-runtime',
      'react-dom/server',
      'unenv/mock/proxy-cjs',
    ],
    noDiscovery: true,
    holdUntilCrawlEnd: true,
    ignoreOutdatedRequests: true,
  };

  // Allow common tunnel/proxy hosts for local development.
  // Additional hosts can be provided via VITE_ALLOWED_HOSTS=host1,host2.
  // Leading dot entries allow subdomains (e.g. ".ngrok-free.app").
  const extraAllowedHosts = (process.env.VITE_ALLOWED_HOSTS || '')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean);
  const allowedHosts = Array.from(new Set([
    'host.docker.internal',
    '.ngrok-free.app',
    '.ngrok-free.dev',
    '.ngrok.app',
    '.ngrok.io',
    ...extraAllowedHosts,
  ]));

  return {
    plugins: [
    suppressUndiciTerminatedErrors(),
    cloudflare({
      configPath: './wrangler.jsonc',
      config: command === 'serve' ? withLocalDevVars : undefined,
      viteEnvironment: { name: 'ssr' },
      // E2E (E2E_LOCAL=1) runs fully local: disable remote bindings so wrangler
      // dev doesn't open a remote proxy session (which needs a Cloudflare login
      // the CI runner doesn't have). Everything resolves in local miniflare.
      ...(process.env.E2E_LOCAL === '1' ? { remoteBindings: false } : {}),
    }),
    reactRouter(),
    tsconfigPaths({ ignoreConfigErrors: true }),
    ],
    // Configure SSR environment to use Cloudflare's worker entry as the rollup input
    // This ensures Durable Object exports are included in the bundle
    environments: {
      ssr: {
        optimizeDeps: ssrOptimizeDeps,
        build: {
          rollupOptions: {
            input: 'virtual:cloudflare/worker-entry',
          },
        },
      },
    },
    ssr: {
      optimizeDeps: ssrOptimizeDeps,
    },
    resolve: {
      dedupe: ['react', 'react-dom'],
      alias: [
        {
          find: 'virtual:db-query-runner-source',
          replacement: `${path.resolve(
            'workers/main/db-query-sandbox-assets/runner/db-query-runner.mjs',
          )}?raw`,
        },
        {
          find: '@smithy/core/config',
          replacement: smithyCoreConfigNodeEntry,
        },
      ],
    },
    build: {
      target: 'esnext',
      // Only enable source maps in development to avoid exposing server code in production
      sourcemap: command !== 'build',
    },
    define: {
      'import.meta.env.VITE_CAMELAI_BUILD_ID': JSON.stringify(camelaiBuildId),
    },
    optimizeDeps: {
      include: clientOptimizeDepsInclude,
    },
    server: {
      port: 3001,
      strictPort: false,
      host: true,
      allowedHosts,
      watch: {
        ignored: ['**/.sandbox-host/**'],
      },
    },
  };
});
