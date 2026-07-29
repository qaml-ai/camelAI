import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  tlsTerminatesOnVm,
  usesCaddy,
} from "./selfhost-tls-mode.mjs";

export const repoRoot = path.resolve(import.meta.dirname, "..");
export const composeFile = path.join(repoRoot, "docker-compose.selfhost.yml");
export const sourceComposeFile = path.join(
  repoRoot,
  "docker-compose.selfhost.source.yml",
);
export const pomeriumComposeFile = path.join(
  repoRoot,
  "docker-compose.selfhost.pomerium.yml",
);
export const pomeriumLoopbackComposeFile = path.join(
  repoRoot,
  "docker-compose.selfhost.pomerium-loopback.yml",
);
export const caddyComposeFile = path.join(
  repoRoot,
  "docker-compose.selfhost.caddy.yml",
);
export const caddySourceComposeFile = path.join(
  repoRoot,
  "docker-compose.selfhost.caddy-source.yml",
);
export const envFile = path.resolve(
  repoRoot,
  process.env.SELFHOST_ENV_FILE || ".env.selfhost",
);
export const defaultProjectName = "camelai-selfhost";
export const volumeNames = ["app-state", "local-artifacts-repos"];

export function volumeNamesForEnv(env = {}) {
  const names =
    (env.SELFHOST_AUTH_MODE || process.env.SELFHOST_AUTH_MODE) ===
    "bundled-pomerium"
    ? [...volumeNames, "pomerium-data"]
    : volumeNames;
  return usesCaddy(env) ? [...names, "caddy-data", "caddy-config"] : names;
}

export async function readSelfhostEnv(required = false) {
  if (!existsSync(envFile)) {
    if (required) {
      throw new Error(`Missing ${path.relative(repoRoot, envFile)}. Run \`bun run selfhost:init\` first.`);
    }
    return {};
  }

  const text = await fs.readFile(envFile, "utf8");
  const entries = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    entries[key] = value;
  }
  return entries;
}

export function writeEnvValue(value) {
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

export function projectName(env = {}) {
  return env.COMPOSE_PROJECT_NAME || process.env.COMPOSE_PROJECT_NAME || defaultProjectName;
}

export function volumeName(name, env = {}) {
  return `${projectName(env)}_${name}`;
}

export function composeArgs(env, args) {
  const sourceMode =
    (env.SELFHOST_DEPLOYMENT_MODE || process.env.SELFHOST_DEPLOYMENT_MODE) ===
    "source";
  const bundledPomerium =
    (env.SELFHOST_AUTH_MODE || process.env.SELFHOST_AUTH_MODE) ===
    "bundled-pomerium";
  const pomeriumLoopbackHttps =
    bundledPomerium && tlsTerminatesOnVm(env);
  const caddy = usesCaddy(env);
  return [
    "compose",
    "--env-file",
    envFile,
    "-f",
    composeFile,
    ...(sourceMode ? ["-f", sourceComposeFile] : []),
    ...(bundledPomerium ? ["-f", pomeriumComposeFile] : []),
    ...(caddy ? ["-f", caddyComposeFile] : []),
    ...(sourceMode && caddy ? ["-f", caddySourceComposeFile] : []),
    ...(pomeriumLoopbackHttps ? ["-f", pomeriumLoopbackComposeFile] : []),
    ...args,
  ];
}

export function scriptEnv(env = {}, extra = {}) {
  const sourceMode =
    (env.SELFHOST_DEPLOYMENT_MODE || process.env.SELFHOST_DEPLOYMENT_MODE) ===
    "source";
  const sourceImages = sourceMode
    ? {
        SELFHOST_APP_IMAGE:
          env.SELFHOST_APP_IMAGE ||
          process.env.SELFHOST_APP_IMAGE ||
          "camelai-selfhost-app:source",
        SELFHOST_LOCAL_ARTIFACTS_IMAGE:
          env.SELFHOST_LOCAL_ARTIFACTS_IMAGE ||
          process.env.SELFHOST_LOCAL_ARTIFACTS_IMAGE ||
          "camelai-selfhost-local-artifacts:source",
        SELFHOST_PROJECT_BUILD_IMAGE:
          env.SELFHOST_PROJECT_BUILD_IMAGE ||
          process.env.SELFHOST_PROJECT_BUILD_IMAGE ||
          "camelai-selfhost-project-build:0.12.0",
        SELFHOST_ANALYSIS_IMAGE:
          env.SELFHOST_ANALYSIS_IMAGE ||
          process.env.SELFHOST_ANALYSIS_IMAGE ||
          "camelai-selfhost-analysis:0.12.0",
        SELFHOST_DB_QUERY_IMAGE:
          env.SELFHOST_DB_QUERY_IMAGE ||
          process.env.SELFHOST_DB_QUERY_IMAGE ||
          "camelai-selfhost-db-query:0.12.0",
        SELFHOST_CONTAINER_EGRESS_IMAGE:
          env.SELFHOST_CONTAINER_EGRESS_IMAGE ||
          process.env.SELFHOST_CONTAINER_EGRESS_IMAGE ||
          "camelai-selfhost-container-egress:0.12.0",
        SELFHOST_CADDY_IMAGE:
          env.SELFHOST_CADDY_IMAGE ||
          process.env.SELFHOST_CADDY_IMAGE ||
          "camelai-selfhost-caddy:source",
      }
    : {};
  return {
    ...process.env,
    ...env,
    ...sourceImages,
    ...extra,
  };
}

export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: "inherit",
      ...options,
      env: {
        ...process.env,
        ...options.env,
      },
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
  });
}

export async function capture(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
    env: {
      ...process.env,
      ...options.env,
    },
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", resolve);
  });
  return {
    code,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}

export async function pathExists(filePath) {
  return fs.access(filePath).then(() => true, () => false);
}
