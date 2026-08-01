#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const repoRoot = process.cwd();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function includesAll(actual, expected, label) {
  for (const item of expected) {
    assert(actual.includes(item), `${label} is missing ${item}`);
  }
}

async function main() {
  const wranglerPath = path.join(repoRoot, 'build/server/wrangler.json');
  await fs.access(wranglerPath).catch(() => {
    throw new Error('Missing build/server/wrangler.json. Run `bun run build:cf` first.');
  });

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'camelai-workerd-config-test-'));
  const outPath = path.join(tempDir, 'camelai.capnp');
  const stateDir = path.join(tempDir, 'state');
  const agentDir = path.join(tempDir, 'agent');
  await fs.mkdir(path.join(agentDir, 'skills/acme-runbooks'), { recursive: true });
  await fs.writeFile(path.join(agentDir, 'prompt.append.md'), 'Prefer internal mirrors.');
  await fs.writeFile(
    path.join(agentDir, 'skills/acme-runbooks/SKILL.md'),
    `---
name: acme-runbooks
description: Follow ACME runbooks. Use when shipping internal tools.
---

# ACME
`,
  );
  const result = spawnSync(process.execPath, [
    'scripts/selfhost-workerd-config.mjs',
    '--out',
    outPath,
    '--state-dir',
    stateDir,
    '--socket',
    '127.0.0.1:0',
  ], {
    cwd: repoRoot,
    env: {
      ...process.env,
      SELFHOST_ENV_FILE: path.join(tempDir, 'intentionally-missing.env'),
      SELFHOST_AGENT_DIR: agentDir,
      SELFHOST_AI_PROVIDER: 'bedrock',
      SELFHOST_AI_API_KEY: 'test-bedrock-key',
      SELFHOST_AI_AWS_REGION: 'us-east-1',
      NODE_ENV: 'release-process-env',
      LOCAL_AUTH_BYPASS: '1',
      LOCAL_AUTH_BYPASS_HOSTS: 'localhost,127.0.0.1',
      LOCAL_AUTH_USER_EMAIL: 'operator@example.test',
      LOCAL_AUTH_USER_NAME: 'Self-host Operator',
      TURNSTILE_SITE_KEY: 'process-turnstile-site',
      TURNSTILE_SECRET_KEY: 'process-turnstile-secret',
    },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }

  const manifest = JSON.parse(await fs.readFile(path.join(tempDir, 'manifest.json'), 'utf8'));
  const config = await fs.readFile(outPath, 'utf8');
  const bindings = manifest.bindings;

  assert(manifest.source === 'build/server/wrangler.json', 'manifest should use the built Wrangler config');
  includesAll(bindings.vars, [
    'LOCAL_ARTIFACTS_BASE_URL',
    'LOCAL_ARTIFACTS_SECRET',
    'WORKER_BASE_URL',
    'LOCAL_APP_VANITY_DOMAIN',
    'NODE_ENV',
    'LOCAL_AUTH_BYPASS',
    'LOCAL_AUTH_BYPASS_HOSTS',
    'LOCAL_AUTH_USER_EMAIL',
    'LOCAL_AUTH_USER_NAME',
    'TURNSTILE_SITE_KEY',
    'TURNSTILE_SECRET_KEY',
  ], 'vars');
  assert(!bindings.vars.includes('PROJECT_REPO_PROVIDER'), 'PROJECT_REPO_PROVIDER must not be a self-host var');
  assert(!bindings.vars.includes('R2_PARENT_ACCESS_KEY_ID'), 'Cloudflare dev R2 credentials must not leak into self-host vars');
  assert(!bindings.vars.includes('SANDBOX_HOST_URL'), 'retired sandbox host vars must not leak into self-host vars');

  includesAll(
    bindings.durableObjects,
    [
      'ChatThreadDO',
      'WorkspaceDO',
      'WorkspaceFilesystemDO',
      'ProjectBuildSandbox',
      'AnalysisSandbox',
      'DbQuerySandbox',
    ],
    'durableObjects',
  );
  includesAll(bindings.kv, ['EMAIL_TO_USER', 'APP_KV', 'SESSIONS'], 'kv');
  includesAll(
    bindings.r2,
    [
      'R2_BUCKET',
      'R2_OUTPUTS_BUCKET',
      'BACKUP_BUCKET',
      'WAREHOUSE_EXPORT_BUCKET',
    ],
    'r2',
  );
  includesAll(bindings.d1, ['APP_DB'], 'd1');
  includesAll(bindings.queues, ['APP_SCREENSHOT_QUEUE', 'SLACK_EVENTS_QUEUE'], 'queues');
  includesAll(bindings.workflows, ['DETERMINISTIC_AUTOMATION_WORKFLOWS'], 'workflows');
  includesAll(bindings.artifacts, ['ARTIFACTS'], 'artifacts');
  includesAll(bindings.ai, ['AI'], 'ai');
  includesAll(bindings.workerLoaders, ['CODE_MODE_LOADER', 'SELFHOST_WORKER_LOADER'], 'workerLoaders');
  assert(!bindings.workerLoaders.includes('LOADER'), 'dispatcher must not include the obsolete generic local Dynamic Worker loader');
  includesAll(manifest.omittedBindings.sendEmail, ['EMAIL'], 'omitted sendEmail bindings');
  includesAll(
    bindings.containers.map((container) => container.className),
    ['ProjectBuildSandbox', 'AnalysisSandbox', 'DbQuerySandbox'],
    'container bindings',
  );
  assert(
    manifest.containerEngine?.kind === 'localDocker',
    'manifest should configure the local Docker container engine',
  );
  assert(
    manifest.containerEngine?.socketUri === 'unix:///var/run/docker.sock',
    'manifest should use the in-container Docker socket',
  );
  assert(
    manifest.containerEngine?.egressImage ===
      'camelai-selfhost-container-egress:0.12.0',
    'container engine should use the workerd bridge-bypass interceptor',
  );

  assert(manifest.dispatcherServiceName === 'dispatcher', 'manifest should include dispatcher service');
  assert(config.includes('name = "ARTIFACTS"'), 'config should contain ARTIFACTS binding');
  assert(config.includes('name = "AI"'), 'config should contain AI binding');
  for (const [name, value] of [
    ['NODE_ENV', 'release-process-env'],
    ['LOCAL_AUTH_BYPASS', '1'],
    ['LOCAL_AUTH_BYPASS_HOSTS', 'localhost,127.0.0.1'],
    ['LOCAL_AUTH_USER_EMAIL', 'operator@example.test'],
    ['LOCAL_AUTH_USER_NAME', 'Self-host Operator'],
    ['TURNSTILE_SITE_KEY', 'process-turnstile-site'],
    ['TURNSTILE_SECRET_KEY', 'process-turnstile-secret'],
  ]) {
    assert(
      config.includes(`(name = "${name}", text = "${value}")`),
      `${name} should be emitted from process env without an env file`,
    );
  }
  assert(config.includes('infra/selfhost/ai-binding.worker.js'), 'config should embed the self-host AI binding module');
  assert(config.includes('name = "dispatcher"'), 'config should contain dispatcher service');
  assert(config.includes('name = "SELFHOST_WORKER_LOADER"'), 'config should contain self-host worker loader binding');
  assert(config.includes('name = "SELFHOST_APP_RUNNER"'), 'config should contain self-host app runner binding');
  assert(config.includes('SelfhostAppRunner'), 'config should contain self-host app runner DO');
  assert(!config.includes('workerLoader = (id = "local-dynamic")'), 'config must not contain a local Dynamic Workers loader');
  assert(!config.includes('LocalDynamicAppRunner'), 'config must not contain local Dynamic Workers app runner DO');
  assert(config.includes('infra/selfhost/artifacts-binding.worker.js'), 'config should embed the local Artifacts binding module');
  assert(config.includes('workflows:local-wrapped-binding'), 'config should contain local Workflows wrapped binding');
  assert(config.includes('name = "BROWSER"'), 'config should contain BROWSER binding');
  assert(config.includes('browser-rendering:service'), 'config should contain Miniflare browser rendering service');
  assert(config.includes('name = "loopback", external = (http = ()))'), 'config should use external loopback for browser rendering');
  assert(config.includes('name = "local", network = (allow = ["local"]'), 'config should expose local outbound for Chrome');
  assert(manifest.loopback?.mode === 'external', 'manifest should request external loopback for browser rendering');
  includesAll(bindings.browser ?? [], ['BROWSER'], 'browser');
  assert(config.includes('selfhost-app-db'), 'config should contain self-host D1 database id');
  assert(
    config.split('(name = "r2:bucket:chiridion-selfhost", worker = (').length -
      1 ===
      1,
    'R2_BUCKET and R2_OUTPUTS_BUCKET should share one local bucket service',
  );
  assert(
    config.includes('r2:bucket:chiridion-selfhost-warehouse-exports'),
    'config should contain a local warehouse export bucket',
  );
  assert(config.includes('chiridion-selfhost-deterministic-automations'), 'config should contain self-host workflow names');
  assert(!config.includes('PROJECT_REPO_PROVIDER'), 'config must not contain PROJECT_REPO_PROVIDER');
  assert(!config.includes('SANDBOX_HOST'), 'config must not contain retired sandbox host bindings');
  assert(
    config.includes('containerEngine = (localDocker = ('),
    'config should contain the local Docker container engine',
  );
  assert(
    config.includes('socketPath = "unix:///var/run/docker.sock"'),
    'config should point workerd at the mounted Docker socket',
  );
  assert(
    config.includes('name = "SELFHOST_AGENT_PROMPT_APPEND"'),
    'config should contain agent prompt append binding',
  );
  assert(
    config.includes('Prefer internal mirrors.'),
    'config should embed prompt.append.md content',
  );
  assert(
    config.includes('name = "SELFHOST_AGENT_SKILLS_JSON"'),
    'config should contain agent skills JSON binding',
  );
  assert(
    config.includes('acme-runbooks/SKILL.md'),
    'config should embed custom skill markdown in skills JSON',
  );
  for (const hostOnly of [
    'SELFHOST_AGENT_DIR',
    'SELFHOST_AGENT_SKILLS_DIR',
    'SELFHOST_AGENT_HOST_DIR',
  ]) {
    assert(
      !config.includes(`name = "${hostOnly}"`),
      `host-only ${hostOnly} must not leak into Worker bindings`,
    );
  }
  for (const [containerClass, image] of [
    ['ProjectBuildSandbox', 'camelai-selfhost-project-build:0.12.0'],
    ['AnalysisSandbox', 'camelai-selfhost-analysis:0.12.0'],
    ['DbQuerySandbox', 'camelai-selfhost-db-query:0.12.0'],
  ]) {
    assert(
      config.includes(
        `className = "${containerClass}", uniqueKey = "camelai-selfhost-${containerClass}", ` +
        `enableSql = true, container = (imageName = "${image}")`,
      ),
      `config should attach ${containerClass} to ${image}`,
    );
  }

  const compileResult = spawnSync(
    path.join(repoRoot, 'node_modules/workerd/bin/workerd'),
    ['compile', '--config-only', outPath],
    {
      cwd: repoRoot,
      stdio: ['ignore', 'ignore', 'pipe'],
      encoding: 'utf8',
    },
  );
  if (compileResult.status !== 0) {
    process.stderr.write(compileResult.stderr);
    process.exit(compileResult.status ?? 1);
  }

  console.log('Self-host workerd config test passed.');
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
