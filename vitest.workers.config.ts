import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import fs from 'node:fs';
import os from 'node:os';
import path from 'path';
import { defineConfig } from 'vitest/config';

const smithyCoreConfigNodeEntry = path.resolve(
  'node_modules/@smithy/core/dist-es/submodules/config/index.js',
);

const bedrockDevVarNames = new Set([
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_DEFAULT_REGION',
  'AWS_REGION',
  'BEDROCK_API_KEY',
  'BEDROCK_AWS_REGION',
  'BEDROCK_PI_TEST_MODEL',
  'BEDROCK_TEST_MODEL',
  'BEDROCK_TEST_REGION',
  'AI_GATEWAY_AUTH_TOKEN',
  'CF_ACCOUNT_ID',
  'CF_API_TOKEN',
  // NOTE: CF_DISPATCH_NAMESPACE, CF_WORKER_NAME, WORKER_BASE_URL and the LOCAL_APP_*
  // hosts are intentionally NOT whitelisted. They are pinned in wrangler.test.jsonc so a
  // developer's ambient .dev.vars/env (e.g. CF_DISPATCH_NAMESPACE=chiridion-platform-staging)
  // can't redirect real eval deploys out of the dedicated chiridion-platform-evals
  // testing-grounds namespace or change the app host they are served on.
  'CF_GATEWAY_NAME',
  'CF_GATEWAY_TOKEN',
  'CUSTOM_EVAL_PROMPT',
  'CUSTOM_EVAL_PROJECT',
  'CUSTOM_EVAL_REQUIRED_TRANSCRIPT_SUBSTRINGS',
  'EVAL_REAL_DEPLOY',
  'EVAL_CUSTOM_API',
  'EVAL_CUSTOM_API_KEY',
  'EVAL_CUSTOM_BASE_URL',
  'EVAL_CUSTOM_MODEL_ID',
  'EVAL_ENFORCE_SIGNAL',
  'EVAL_MAX_ASSISTANT_TURNS',
  'EVAL_MAX_BAD_TOOL_CALLS',
  'EVAL_MAX_SDK_TURNS',
  'EVAL_MODEL',
  'EVAL_TIMEOUT_MS',
  'EXA_API_KEY',
  'FIRECRAWL_API_KEY',
  'PARALLEL_API_KEY',
  'RUN_AGENT_EVALS',
  'RUN_PROJECT_BUILD_SANDBOX_REPRO',
  'RUN_SANDBOX_EVAL_PROTOTYPE',
]);

function parseDevVars(source: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    let value = rawValue.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }

  return result;
}

function loadBedrockDevVars(): Record<string, string> {
  const devVarPaths = [
    process.env.CHIRIDION_DEV_VARS_PATH,
    path.resolve('.dev.vars'),
    path.join(os.homedir(), 'chiridion/chiridion-2/.dev.vars'),
  ].filter((candidate): candidate is string => Boolean(candidate));

  const bindings: Record<string, string> = {};
  for (const devVarPath of devVarPaths) {
    if (!fs.existsSync(devVarPath)) continue;

    const parsed = parseDevVars(fs.readFileSync(devVarPath, 'utf8'));
    for (const [key, value] of Object.entries(parsed)) {
      if (bedrockDevVarNames.has(key) && value) {
        bindings[key] = value;
      }
    }
  }

  for (const key of bedrockDevVarNames) {
    const value = process.env[key];
    if (value) {
      bindings[key] = value;
    }
  }

  return bindings;
}

// Live agent evals run their threads on a local agent runtime
// (scripts/runtime-eval-harness.mjs); scripts/run-agent-eval.mjs puts its
// address, tenant, token, definition and the eval relay in the environment.
// Taken from the process environment only, and only for eval runs: never from
// .dev.vars, which may name a deployed runtime tenant.
const runtimeEvalBindingNames = [
  'AGENT_RUNTIME_URL',
  'AGENT_RUNTIME_TENANT',
  'AGENT_RUNTIME_API_TOKEN',
  'AGENT_RUNTIME_DEFINITION',
  'EVAL_RUNTIME_RELAY_URL',
];

function loadRuntimeEvalBindings(): Record<string, string> {
  if (process.env.RUN_AGENT_EVALS !== '1') return {};
  return Object.fromEntries(
    runtimeEvalBindingNames.flatMap((name) => (process.env[name] ? [[name, process.env[name] as string]] : [])),
  );
}

export default defineConfig({
  plugins: [
    cloudflareTest({
      remoteBindings: false,
      wrangler: { configPath: './wrangler.test.jsonc' },
      miniflare: {
        bindings: {
          ...loadBedrockDevVars(),
          ...loadRuntimeEvalBindings(),
        },
        compatibilityDate: '2026-03-24',
        compatibilityFlags: ['nodejs_compat'],
        durableObjects: {
          // Never get a container here: ProjectBuildContainer and
          // AnalysisContainer start named images from ctx.container.images, and
          // this pool's miniflare/workerd (4.20260721) predates named images and
          // container exec. Evals and the repro that build or analyze for real
          // need a pool upgrade first.
          PROJECT_BUILD_SANDBOX: { className: 'ProjectBuildContainer', useSQLite: true },
          ANALYSIS_SANDBOX: { className: 'AnalysisContainer', useSQLite: true },
        },
        cachePersist: false,
        d1Persist: false,
        durableObjectsPersist: false,
        kvPersist: false,
        r2Persist: false,
        workflowsPersist: false,
      },
    }),
  ],
  resolve: {
    alias: [
      { find: '@', replacement: path.resolve(__dirname, './src') },
      {
        find: 'virtual:db-query-runner-source',
        replacement: `${path.resolve(__dirname, 'workers/main/db-query-sandbox-assets/runner/db-query-runner.mjs')}?raw`,
      },
      {
        find: '@smithy/core/config',
        replacement: smithyCoreConfigNodeEntry,
      },
    ],
  },
  test: {
    include: ['workers/main/tests/**/*.test.ts'],
    testTimeout: 20_000,
    // Agent-eval runs only: don't let vitest's exit code flip to 1 on unhandled
    // errors. The vitest-pool-workers handler-context shim re-reports tool throws
    // that callToolEnvelope already caught and delivered to the agent as
    // { ok: false } values, which otherwise fails runs whose every criterion
    // passed. The errors still print, and scripts/run-agent-eval.mjs still parses
    // them into signal violations (filtering only the enveloped duplicates), so
    // real harness errors keep failing eval runs through the signal. Regular
    // worker test runs keep vitest's strict default.
    dangerouslyIgnoreUnhandledErrors: process.env.RUN_AGENT_EVALS === '1',
  },
});
