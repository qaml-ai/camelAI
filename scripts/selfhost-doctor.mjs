#!/usr/bin/env node
import net from "node:net";
import http from "node:http";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  capture,
  composeArgs,
  envFile,
  pathExists,
  readSelfhostEnv,
  repoRoot,
  scriptEnv,
  volumeName,
  volumeNamesForEnv,
} from "./selfhost-common.mjs";
import {
  selfhostTlsMode,
  usesCaddy,
} from "./selfhost-tls-mode.mjs";
import {
  caddyDirectory,
  caddySecretsDirectory,
  writeCaddyConfig,
} from "./selfhost-caddy-config.mjs";
import {
  previewContentSecurityPolicy,
  writePomeriumConfig,
} from "./selfhost-pomerium-config.mjs";

const checks = [];
const env = await readSelfhostEnv(false);
const appPort = Number(env.SELFHOST_APP_PORT || process.env.SELFHOST_APP_PORT || 3001);
const deploymentMode = (
  env.SELFHOST_DEPLOYMENT_MODE ||
  process.env.SELFHOST_DEPLOYMENT_MODE ||
  "release"
).trim();
const effectiveEnv = scriptEnv({
  ...env,
  SELFHOST_DEPLOYMENT_MODE: deploymentMode,
});
const selectedVolumeNames = volumeNamesForEnv(env);
const minimumAllocatedMemoryGiB = 8;
const minimumUsableMemoryGiB = 7.5;
let current;
const localImageKeys = new Set();

await check("env file", async () => {
  if (!(await pathExists(envFile))) {
    fail(`missing ${path.relative(repoRoot, envFile)}; run \`bun run selfhost:init\``);
  }
  for (const key of [
    "TOKEN_SIGNING_SECRET",
    "INTEGRATION_SECRET_KEY",
    "LOCAL_ARTIFACTS_SECRET",
    "ADMIN_API_KEY",
  ]) {
    if (!env[key]) {
      fail(
        key === "ADMIN_API_KEY"
          ? "missing ADMIN_API_KEY; run `bun run selfhost:migrate-secrets`"
          : `missing ${key}`,
      );
    }
    if (env[key].includes("change-me")) fail(`${key} still uses a development default`);
  }
});

await check("required CLIs", async () => {
  await requireCommand("docker", ["--version"]);
  await requireCommand("git", ["--version"]);
  await requireCommand("bun", ["--version"]);
});

await check("Docker daemon", async () => {
  const result = await capture("docker", ["info"], { env: effectiveEnv });
  if (result.code !== 0) fail(result.stderr.trim() || "docker info failed");
});

await check("deployment mode", async () => {
  if (!new Set(["release", "source"]).has(deploymentMode)) {
    fail(
      `SELFHOST_DEPLOYMENT_MODE must be "release" or "source", got ${deploymentMode}`,
    );
  }
  note(`SELFHOST_DEPLOYMENT_MODE: ${deploymentMode}`);
});

const imageKeys = [
  "SELFHOST_APP_IMAGE",
  "SELFHOST_LOCAL_ARTIFACTS_IMAGE",
  "SELFHOST_PROJECT_BUILD_IMAGE",
  "SELFHOST_ANALYSIS_IMAGE",
  "SELFHOST_DB_QUERY_IMAGE",
  "SELFHOST_CONTAINER_EGRESS_IMAGE",
  ...(usesCaddy(env) ? ["SELFHOST_CADDY_IMAGE"] : []),
];

await check("container images", async () => {
  for (const key of imageKeys) {
    const image = (effectiveEnv[key] || "").trim();
    if (!image) fail(`missing ${key}`);
    note(`${key}: ${image}`);
  }

  const unavailable = [];
  for (const key of imageKeys) {
    const image = effectiveEnv[key];
    const result = await capture("docker", ["image", "inspect", image], {
      env: effectiveEnv,
    });
    if (result.code !== 0) unavailable.push(key);
    else localImageKeys.add(key);
  }
  if (unavailable.length > 0) {
    warn(
      `${unavailable.length} configured image${
        unavailable.length === 1 ? " is" : "s are"
      } not local yet; selfhost:up will pull or build them`,
    );
    note(`not local: ${unavailable.join(", ")}`);
  }
});

await check("Docker VM capacity", async () => {
  const result = await capture(
    "docker",
    ["info", "--format", "{{json .}}"],
    { env: effectiveEnv },
  );
  if (result.code !== 0) fail(result.stderr.trim() || "docker info failed");
  const info = JSON.parse(result.stdout);
  const warnings = [];
  const architecture = String(info.Architecture || "");
  const cpus = Number(info.NCPU || 0);
  const memoryBytes = Number(info.MemTotal || 0);

  note(`architecture: ${architecture || "unknown"}`);
  note(`CPUs: ${cpus || "unknown"}`);
  note(
    `memory: ${
      memoryBytes ? `${(memoryBytes / 1024 ** 3).toFixed(1)} GiB` : "unknown"
    }`,
  );
  if (architecture !== "x86_64" && architecture !== "amd64") {
    warnings.push(
      `${architecture || "unknown"} Docker architecture may not run the analysis sandbox reliably; use x86_64 for full notebook support`,
    );
  }
  if (cpus > 0 && cpus < 4) warnings.push("fewer than 4 Docker CPUs");
  if (memoryBytes > 0 && memoryBytes < minimumUsableMemoryGiB * 1024 ** 3) {
    warnings.push(
      `less than ${minimumUsableMemoryGiB} GiB usable Docker memory ` +
        `(allocate at least ${minimumAllocatedMemoryGiB} GiB to the VM)`,
    );
  }

  const dockerRootDir = String(info.DockerRootDir || "").trim();
  if (dockerRootDir) {
    const disk = await capture("df", ["-Pk", dockerRootDir]);
    if (disk.code === 0) {
      const fields = disk.stdout.trim().split(/\r?\n/).at(-1)?.trim().split(/\s+/);
      const freeKiB = Number(fields?.[3] || 0);
      if (freeKiB > 0) {
        const freeGiB = freeKiB / 1024 ** 2;
        note(`Docker disk free: ${freeGiB.toFixed(1)} GiB`);
        if (freeGiB < 20) warnings.push("less than 20 GiB free Docker disk");
      }
    } else {
      note(
        `Docker disk free: unavailable from host path ${dockerRootDir} (common with Docker Desktop)`,
      );
    }
  }
  if (warnings.length > 0) warn(warnings.join("; "));
});

await check("Docker socket", async () => {
  const socketPath =
    env.SELFHOST_DOCKER_SOCKET_PATH ||
    process.env.SELFHOST_DOCKER_SOCKET_PATH ||
    "/var/run/docker.sock";
  await fs.access(socketPath, fsConstants.R_OK | fsConstants.W_OK).catch(() => {
    fail(`Docker socket is not readable and writable: ${socketPath}`);
  });
  note(socketPath);
});

await check("sandbox storage synchronization", async () => {
  const required = [
    "SELFHOST_PROJECT_BUILD_IMAGE",
    "SELFHOST_CONTAINER_EGRESS_IMAGE",
  ];
  const missing = required.filter((key) => !localImageKeys.has(key));
  if (missing.length > 0) {
    warn("container images are not local yet; storage synchronization smoke skipped");
    note(`run after selfhost:up: bun run selfhost:container:smoke:mount`);
    return;
  }
  const result = await capture(
    "bun",
    ["run", "selfhost:container:smoke:mount"],
    { env: effectiveEnv },
  );
  if (result.code !== 0) {
    fail(
      result.stderr.trim() ||
        result.stdout.trim() ||
        "bidirectional sandbox storage synchronization failed",
    );
  }
  note("bidirectional R2/container synchronization passed without FUSE privileges");
});

await check("self-host app domains", async () => {
  const publicBaseUrl = env.SELFHOST_PUBLIC_BASE_URL || process.env.SELFHOST_PUBLIC_BASE_URL || "";
  if (!publicBaseUrl.trim()) fail("missing SELFHOST_PUBLIC_BASE_URL");
  const parsed = new URL(publicBaseUrl);
  if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
    warn("SELFHOST_PUBLIC_BASE_URL points at localhost; published apps require configured DNS/tunnel domains");
  }
  for (const key of ["LOCAL_APP_VANITY_DOMAIN", "LOCAL_APP_IFRAME_DOMAIN"]) {
    const value = env[key] || process.env[key] || "";
    if (!value.trim()) fail(`missing ${key}`);
    const hostname = new URL(value.includes("://") ? value : `https://${value}`).hostname;
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname.endsWith(".localhost")) {
      fail(`${key} must be a real DNS/tunnel wildcard domain, not localhost`);
    }
    note(`${key}: ${hostname}`);
  }
});

await check("AI provider", async () => {
  const configured = (name) => String(env[name] ?? process.env[name] ?? "").trim();
  const provider = configured("SELFHOST_AI_PROVIDER").toLowerCase();
  const providerApiKey = configured("SELFHOST_AI_API_KEY");
  const supported = new Set([
    "anthropic",
    "bedrock",
    "custom",
    "openai",
    "openrouter",
    "requesty",
  ]);
  if (provider) {
    if (!supported.has(provider)) {
      fail(`unsupported SELFHOST_AI_PROVIDER=${provider}`);
    }
    if (!providerApiKey) {
      fail("missing SELFHOST_AI_API_KEY");
    }
    if (provider === "custom") {
      if (!configured("SELFHOST_AI_BASE_URL")) {
        fail("missing SELFHOST_AI_BASE_URL for custom provider");
      }
      if (!configured("SELFHOST_AI_MODEL")) {
        fail("missing SELFHOST_AI_MODEL for custom provider");
      }
    }
    note(`SELFHOST_AI_PROVIDER: ${provider}`);
    return;
  }

  const hasPartialProviderConfig = [
    providerApiKey,
    configured("SELFHOST_AI_BASE_URL"),
    configured("SELFHOST_AI_MODEL"),
    configured("SELFHOST_AI_NAME"),
  ].some(Boolean);
  if (hasPartialProviderConfig) {
    fail("SELFHOST_AI_PROVIDER is required when SELFHOST_AI_* values are set");
  }

  const gatewayAccountId = configured("CF_ACCOUNT_ID");
  const gatewayName = configured("CF_GATEWAY_NAME");
  const gatewayToken =
    configured("AI_GATEWAY_AUTH_TOKEN") || configured("CF_GATEWAY_TOKEN");
  if (
    !gatewayAccountId ||
    gatewayAccountId === "selfhost" ||
    !gatewayName ||
    !gatewayToken
  ) {
    fail(
      "chat requires SELFHOST_AI_PROVIDER and SELFHOST_AI_API_KEY, or CF_ACCOUNT_ID, CF_GATEWAY_NAME, and AI_GATEWAY_AUTH_TOKEN",
    );
  }
  note(`Cloudflare AI Gateway: ${gatewayName}`);
});

await check("agent pack", async () => {
  const { loadSelfhostAgentPack, ensureSelfhostAgentPackSkeleton } = await import(
    "./selfhost-agent-pack.mjs"
  );
  await ensureSelfhostAgentPackSkeleton(repoRoot, env);
  const pack = await loadSelfhostAgentPack(repoRoot, env);
  note(`agent dir: ${path.relative(repoRoot, pack.agentDir)}`);
  if (pack.skillNames.length > 0) {
    note(`custom skills: ${pack.skillNames.join(", ")}`);
  } else {
    note("custom skills: none (bundled skills only)");
  }
  if (pack.promptPrepend) note("prompt.prepend loaded");
  if (pack.promptAppend) note("prompt.append loaded");
});

await check("network binding", async () => {
  const bindAddress = (env.SELFHOST_BIND_ADDRESS || "127.0.0.1").trim();
  if (bindAddress !== "127.0.0.1" && bindAddress !== "::1") {
    fail(
      "SELFHOST_BIND_ADDRESS must remain loopback; expose camelAI only through the configured reverse proxy",
    );
  }
  note(`SELFHOST_BIND_ADDRESS: ${bindAddress}`);
});

await check("authentication", async () => {
  const mode = (env.SELFHOST_AUTH_MODE || "").trim();
  if (
    !new Set([
      "bundled-pomerium",
      "external-pomerium",
      "cloudflare-access",
      "local",
    ]).has(mode)
  ) {
    fail(
      "SELFHOST_AUTH_MODE must be bundled-pomerium, external-pomerium, cloudflare-access, or local",
    );
  }

  if (mode === "bundled-pomerium") {
    if ((env.LOCAL_AUTH_BYPASS || "").trim()) {
      fail("bundled Pomerium cannot be combined with LOCAL_AUTH_BYPASS");
    }
    if (!/@sha256:[0-9a-f]{64}$/i.test(env.SELFHOST_POMERIUM_IMAGE || "")) {
      fail("SELFHOST_POMERIUM_IMAGE must be pinned by sha256 digest");
    }
    for (const key of [
      "POMERIUM_ISSUER",
      "POMERIUM_AUDIENCE",
      "POMERIUM_DEFAULT_ORG_NAME",
    ]) {
      if (!(env[key] || "").trim()) fail(`missing ${key}`);
    }
    await writePomeriumConfig(env);
    note("bundled Pomerium configuration rendered");
    return;
  }
  if (mode === "external-pomerium") {
    for (const key of [
      "POMERIUM_ISSUER",
      "POMERIUM_AUDIENCE",
      "POMERIUM_DEFAULT_ORG_NAME",
    ]) {
      if (!(env[key] || "").trim()) fail(`missing ${key}`);
    }
    if (
      !(env.POMERIUM_JWKS_URL || "").trim() &&
      !(env.POMERIUM_AUTHENTICATE_URL || "").trim()
    ) {
      fail("missing POMERIUM_JWKS_URL or POMERIUM_AUTHENTICATE_URL");
    }
    note("external Pomerium");
    return;
  }
  if (mode === "cloudflare-access") {
    for (const key of [
      "CLOUDFLARE_ACCESS_TEAM_DOMAIN",
      "CLOUDFLARE_ACCESS_AUD",
      "CLOUDFLARE_ACCESS_DEFAULT_ORG_NAME",
    ]) {
      if (!(env[key] || "").trim()) fail(`missing ${key}`);
    }
    note("external Cloudflare Access");
    return;
  }

  if (env.LOCAL_AUTH_BYPASS !== "1") {
    fail("SELFHOST_AUTH_MODE=local requires LOCAL_AUTH_BYPASS=1");
  }
  warn("local authentication bypass is for smoke tests only");
});

await check("in-chat app preview framing", async () => {
  const mode = (env.SELFHOST_AUTH_MODE || "").trim();
  if (mode !== "bundled-pomerium") {
    note("external ingress must allow the camelAI origin in CSP frame-ancestors");
    return;
  }

  const publicUrl = new URL(env.SELFHOST_PUBLIC_BASE_URL);
  const expectedPolicy = previewContentSecurityPolicy(publicUrl.origin);
  const appDomain = (
    env.LOCAL_APP_IFRAME_DOMAIN || env.LOCAL_APP_VANITY_DOMAIN || ""
  ).trim();
  if (!appDomain) fail("missing deployed-app domain for preview framing check");
  note(`required policy: ${expectedPolicy}`);

  if (!(await canConnect("127.0.0.1", 5444))) {
    warn("stack is not running; live Pomerium framing check skipped");
    return;
  }

  let response;
  let contentSecurityPolicy;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      response = await requestPomeriumAppRoute(
        `camelai-preview-doctor.${appDomain}`,
      );
      contentSecurityPolicy = response.headers["content-security-policy"];
      if (hasFrameAncestorsPolicy(contentSecurityPolicy, expectedPolicy)) break;
    } catch (error) {
      if (attempt === 11) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!response) fail("Pomerium app-route check returned no response");
  const policies = Array.isArray(contentSecurityPolicy)
    ? contentSecurityPolicy
    : [contentSecurityPolicy || ""];
  if (!hasFrameAncestorsPolicy(contentSecurityPolicy, expectedPolicy)) {
    fail(
      `Pomerium app route is not framable by ${publicUrl.origin}; ` +
        `expected ${JSON.stringify(expectedPolicy)}, got ${JSON.stringify(
          contentSecurityPolicy || "no Content-Security-Policy header",
        )}`,
    );
  }
  note(`Pomerium app route: HTTP ${response.statusCode}`);
  note(`Content-Security-Policy: ${policies.join(", ")}`);
});

await check("TLS front door", async () => {
  const mode = selfhostTlsMode(env);
  if (!new Set(["automatic", "external", "provided"]).has(mode)) {
    fail(
      `SELFHOST_TLS_MODE must be automatic, external, or provided; got ${mode}`,
    );
  }
  if (!/@sha256:[0-9a-f]{64}$/i.test(env.SELFHOST_CADDY_IMAGE || "") &&
      deploymentMode === "release") {
    fail("SELFHOST_CADDY_IMAGE must be pinned by sha256 digest in release mode");
  }
  await writeCaddyConfig(env);
  note(`SELFHOST_TLS_MODE: ${mode}`);
  if (mode === "automatic") {
    note(`DNS provider: ${env.SELFHOST_TLS_DNS_PROVIDER}`);
    if ((env.SELFHOST_TLS_DNS_PROVIDER || "").trim() === "route53") {
      note(
        (env.SELFHOST_TLS_AWS_ACCESS_KEY_ID || "").trim()
          ? "Route 53 credentials: protected generated credentials file"
          : "Route 53 credentials: AWS instance role or ambient SDK credentials",
      );
    }
  } else if (mode === "external") {
    const bindAddress = (
      env.SELFHOST_TLS_EXTERNAL_BIND_ADDRESS || "127.0.0.1"
    ).trim();
    if (bindAddress === "0.0.0.0" || bindAddress === "::") {
      warn(
        "external TLS origin listens on all interfaces; restrict ingress to the trusted TLS proxy",
      );
    }
    note(
      `HTTP origin: ${bindAddress}:${env.SELFHOST_TLS_EXTERNAL_PORT || "8080"}`,
    );
  } else {
    note("operator-provided certificate copied into the protected Caddy mount");
  }
  note("Caddy configuration rendered");

  const caddyImage = effectiveEnv.SELFHOST_CADDY_IMAGE;
  const inspect = await capture("docker", ["image", "inspect", caddyImage], {
    env: effectiveEnv,
  });
  if (inspect.code === 0) {
    const validation = await capture(
      "docker",
      [
        "run",
        "--rm",
        "--volume",
        `${caddyDirectory}:/etc/caddy:ro`,
        "--volume",
        `${caddySecretsDirectory}:/run/camelai-secrets:ro`,
        "--env",
        `AWS_REGION=${env.SELFHOST_TLS_AWS_REGION || "us-east-1"}`,
        caddyImage,
        "caddy",
        "validate",
        "--config",
        "/etc/caddy/Caddyfile",
      ],
      { env: effectiveEnv },
    );
    if (validation.code !== 0) {
      fail(validation.stderr.trim() || "Caddy configuration validation failed");
    }
    note("Caddy configuration validated with the configured image");
  } else {
    note(
      "Caddy image is not local yet; image-level validation deferred until pull/build",
    );
  }
});

await check("compose config", async () => {
  const result = await capture("docker", composeArgs(env, ["config", "--quiet"]), {
    env: scriptEnv(env),
  });
  if (result.code !== 0) fail(result.stderr.trim() || "docker compose config failed");
});

await check("volume names", async () => {
  for (const name of selectedVolumeNames) {
    note(`${name}: ${volumeName(name, env)}`);
  }
});

await check("local services", async () => {
  await optionalHttp(`http://127.0.0.1:${appPort}/api/selfhost/health`, "app self-host health");
  await optionalHttp("http://127.0.0.1:7001/health", "local Artifacts");
});

for (const item of checks) {
  const prefix = item.status === "pass" ? "PASS" : item.status === "warn" ? "WARN" : "FAIL";
  console.log(`[${prefix}] ${item.name}${item.message ? `: ${item.message}` : ""}`);
  for (const detail of item.details) console.log(`      ${detail}`);
}

const failed = checks.filter((item) => item.status === "fail").length;
if (failed > 0) {
  console.error(`selfhost:doctor found ${failed} blocking issue${failed === 1 ? "" : "s"}.`);
  process.exit(1);
}
console.log("selfhost:doctor passed.");

async function check(name, fn) {
  const item = { name, status: "pass", message: "", details: [] };
  checks.push(item);
  const previous = current;
  current = item;
  try {
    await fn();
  } catch (error) {
    if (item.status !== "fail") {
      item.status = "fail";
      item.message = error instanceof Error ? error.message : String(error);
    }
  } finally {
    current = previous;
  }
}

function fail(message) {
  current.status = "fail";
  current.message = message;
  throw new Error(message);
}

function warn(message) {
  if (current.status === "pass") current.status = "warn";
  current.message = message;
}

function note(message) {
  current.details.push(message);
}

async function requireCommand(command, args) {
  const result = await capture(command, args, { env: scriptEnv(env) });
  if (result.code !== 0) fail(`${command} is not available`);
  note(result.stdout.trim().split(/\r?\n/, 1)[0] || command);
}

async function optionalHttp(url, label) {
  const parsed = new URL(url);
  if (!(await canConnect(parsed.hostname, Number(parsed.port)))) {
    warn("stack is not running; live service checks skipped");
    note(`${label}: not listening at ${url}`);
    return;
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(2000) }).catch((error) => {
    fail(`${label} request failed: ${error.message}`);
  });
  if (!response.ok) {
    warn("stack is not fully healthy; live service checks are diagnostic only");
    note(`${label}: HTTP ${response.status}`);
    return;
  }
  note(`${label}: HTTP ${response.status}`);
}

function canConnect(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: 500 });
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => resolve(false));
  });
}

function requestPomeriumAppRoute(hostname) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port: 5444,
        path: "/",
        method: "GET",
        headers: {
          Host: hostname,
          "X-Forwarded-Proto": "https",
        },
        timeout: 2000,
      },
      (response) => {
        response.resume();
        response.on("end", () =>
          resolve({
            headers: response.headers,
            statusCode: response.statusCode || 0,
          }),
        );
      },
    );
    request.on("timeout", () =>
      request.destroy(new Error("Pomerium app-route request timed out")),
    );
    request.on("error", reject);
    request.end();
  });
}

function hasFrameAncestorsPolicy(contentSecurityPolicy, expectedPolicy) {
  const policies = Array.isArray(contentSecurityPolicy)
    ? contentSecurityPolicy
    : [contentSecurityPolicy || ""];
  return policies.some((policy) =>
    policy
      .split(";")
      .some((directive) => directive.trim() === expectedPolicy),
  );
}
