#!/usr/bin/env node
/**
 * Deploy script for main worker to staging or prod.
 *
 * This script:
 * 1. Builds the app from the current checkout
 * 2. Copies the environment-specific wrangler config to build/server/
 * 3. Fixes paths to be relative to build/server/
 * 4. Updates the .wrangler/deploy/config.json redirect
 * 5. Applies the APP_DB D1 migrations (--remote; SKIP_D1_MIGRATIONS=1 skips)
 * 6. Runs wrangler deploy
 *
 * Workers Builds runs this for both environments (deploy command
 * `bun run deploy:main:staging` on main, `deploy:main:prod` on the
 * production branch the Deploy to Production workflow pushes).
 *
 * Usage: node scripts/deploy-main.mjs [staging|prod]
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const env = process.argv[2];
const validEnvs = ['staging', 'prod', 'dev-miguel', 'dev-illiana'];
if (!env || !validEnvs.includes(env)) {
  console.error('Usage: node scripts/deploy-main.mjs [staging|prod|dev-miguel|dev-illiana]');
  process.exit(1);
}

const sourceConfig = path.join(rootDir, `wrangler.${env}.jsonc`);
const targetConfig = path.join(rootDir, 'build/server', `wrangler.${env}.json`);
const redirectConfig = path.join(rootDir, '.wrangler/deploy/config.json');

if (process.env.SKIP_BUILD === '1') {
  console.log('Skipping build because SKIP_BUILD=1');
} else {
  console.log('Building app...');
  execSync('bun run build', {
    cwd: rootDir,
    stdio: 'inherit'
  });
}

// Check that build exists
if (!fs.existsSync(path.join(rootDir, 'build/server/index.js'))) {
  console.error('Build not found. Run "bun run build" first.');
  process.exit(1);
}

// Read the source config and fix paths for build/server context
console.log(`Reading ${sourceConfig}...`);
let configContent = fs.readFileSync(sourceConfig, 'utf8');

// Fix paths: main, assets directory, and Dockerfiles should be relative to build/server
configContent = configContent
  .replace(/"build\/server\/index\.js"/g, '"index.js"')
  .replace(/"build\/client"/g, '"../client"')
  // Fix all Dockerfile paths (./Dockerfile, ./containers/*/Dockerfile, etc.)
  .replace(/"\.\/([^"]*Dockerfile)"/g, '"../../$1"');

// Write to build/server
console.log(`Writing ${targetConfig}...`);
fs.mkdirSync(path.dirname(targetConfig), { recursive: true });
fs.writeFileSync(targetConfig, configContent);

// Update the redirect config
console.log(`Updating ${redirectConfig}...`);
fs.mkdirSync(path.dirname(redirectConfig), { recursive: true });
fs.writeFileSync(redirectConfig, JSON.stringify({
  configPath: `../../build/server/wrangler.${env}.json`,
  auxiliaryWorkers: []
}));

// Apply the app index D1 migrations (migrations/) before the worker that reads
// them ships. Every migration is idempotent (CREATE ... IF NOT EXISTS; columns
// are added by AppIndexDatabase.ensureSchema), so databases whose tables the
// runtime already created take them as no-ops. A failure stops the deploy.
if (process.env.SKIP_D1_MIGRATIONS === '1') {
  console.log('Skipping D1 migrations because SKIP_D1_MIGRATIONS=1');
} else {
  console.log(`\nApplying D1 migrations (APP_DB, ${env})...`);
  try {
    execSync(`npx wrangler d1 migrations apply APP_DB --remote -c wrangler.${env}.jsonc`, {
      cwd: rootDir,
      stdio: 'inherit',
      // Non-interactive: no confirmation prompt.
      env: { ...process.env, CI: 'true' },
    });
  } catch (error) {
    console.error('D1 migrations failed; not deploying the worker.');
    process.exit(error.status || 1);
  }
}

// Run wrangler deploy
console.log(`\nDeploying to ${env}...`);
try {
  execSync('npx wrangler deploy', {
    cwd: rootDir,
    stdio: 'inherit'
  });
} catch (error) {
  process.exit(error.status || 1);
}
