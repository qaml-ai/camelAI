#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  defaultProjectName,
  envFile,
  repoRoot,
  volumeName,
  writeEnvValue,
} from "./selfhost-common.mjs";
import { existingDockerVolumes } from "./selfhost-secret-migrations.mjs";
import { writeCaddyConfig } from "./selfhost-caddy-config.mjs";
import { writePomeriumConfig } from "./selfhost-pomerium-config.mjs";
import {
  AGENT_RUNTIME_ENV_DEFAULTS,
  AGENT_RUNTIME_PRIVATE_KEYS,
  AGENT_RUNTIME_VOLUMES,
  DEFAULT_AGENT_RUNTIME_PORT,
  DEFAULT_AGENT_RUNTIME_POSTGRES_PORT,
  refuseStatefulSecretRegeneration,
} from "./selfhost-agent-runtime.mjs";

const force = process.argv.includes("--force");

if (existsSync(envFile) && !force) {
  console.error(`${path.relative(repoRoot, envFile)} already exists.`);
  console.error("Use `bun run selfhost:init -- --force` to regenerate it.");
  process.exit(1);
}

const values = {
  COMPOSE_PROJECT_NAME: defaultProjectName,
  // A cloned repository defaults to the explicit source-build override. Cloud
  // templates set this to "release" and replace every image below with an
  // immutable tag or digest.
  SELFHOST_DEPLOYMENT_MODE: "source",
  SELFHOST_APP_IMAGE: "camelai-selfhost-app:source",
  SELFHOST_LOCAL_ARTIFACTS_IMAGE: "camelai-selfhost-local-artifacts:source",
  SELFHOST_PROJECT_BUILD_IMAGE: "camelai-selfhost-project-build:1.0.0",
  SELFHOST_ANALYSIS_IMAGE: "camelai-selfhost-analysis:1.0.0",
  SELFHOST_DB_QUERY_IMAGE: "camelai-selfhost-db-query:1.0.0",
  SELFHOST_CONTAINER_EGRESS_IMAGE:
    "camelai-selfhost-container-egress:0.12.0",
  SELFHOST_CADDY_IMAGE: "camelai-selfhost-caddy:source",
  SELFHOST_BIND_ADDRESS: "127.0.0.1",
  SELFHOST_APP_PORT: "3001",
  SELFHOST_PUBLIC_BASE_URL: "https://camel.example.com",
  SELFHOST_INTERNAL_APP_URL: "http://127.0.0.1:3001",
  SELFHOST_AUTH_MODE: "bundled-pomerium",
  SELFHOST_MAIN_HOSTNAME: "camel.example.com",
  SELFHOST_TLS_MODE: "automatic",
  SELFHOST_TLS_DNS_PROVIDER: "cloudflare",
  SELFHOST_TLS_ACME_EMAIL: "",
  SELFHOST_TLS_CLOUDFLARE_API_TOKEN: "",
  SELFHOST_TLS_ROUTE53_HOSTED_ZONE_ID: "",
  SELFHOST_TLS_AWS_REGION: "us-east-1",
  SELFHOST_TLS_AWS_PROFILE: "default",
  SELFHOST_TLS_AWS_ACCESS_KEY_ID: "",
  SELFHOST_TLS_AWS_SECRET_ACCESS_KEY: "",
  SELFHOST_TLS_AWS_SESSION_TOKEN: "",
  SELFHOST_TLS_CERTIFICATE_FILE: "",
  SELFHOST_TLS_PRIVATE_KEY_FILE: "",
  SELFHOST_TLS_EXTERNAL_BIND_ADDRESS: "127.0.0.1",
  SELFHOST_TLS_EXTERNAL_PORT: "8080",
  SELFHOST_POMERIUM_IMAGE:
    "pomerium/pomerium@sha256:aae6010af6ba4c864bbd3f748cf37843a140b1ddef74d7d2ac1aa87660f8da1f",
  LOCAL_APP_VANITY_DOMAIN: "apps.example.com",
  LOCAL_APP_IFRAME_DOMAIN: "apps.example.com",
  TURNSTILE_SITE_KEY: "",
  TURNSTILE_SECRET_KEY: "",
  LOCAL_AUTH_BYPASS: "",
  LOCAL_AUTH_BYPASS_HOSTS: "",
  LOCAL_AUTH_USER_EMAIL: "",
  LOCAL_AUTH_USER_NAME: "",
  CLOUDFLARE_ACCESS_TEAM_DOMAIN: "",
  CLOUDFLARE_ACCESS_AUD: "",
  CLOUDFLARE_ACCESS_AUDS: "",
  CLOUDFLARE_ACCESS_ORG_MAP: "",
  CLOUDFLARE_ACCESS_ORG_CLAIMS: "",
  CLOUDFLARE_ACCESS_ORG_GROUP_PREFIX: "",
  CLOUDFLARE_ACCESS_ADMIN_GROUP_PREFIX: "",
  CLOUDFLARE_ACCESS_DEFAULT_ORG_NAME: "",
  CLOUDFLARE_ACCESS_REQUIRED_EMAIL_DOMAIN: "",
  POMERIUM_JWKS_URL: "",
  POMERIUM_AUTHENTICATE_URL: "https://authenticate.example.com",
  POMERIUM_AUTHENTICATE_HOSTNAME: "authenticate.example.com",
  POMERIUM_ISSUER: "camel.example.com",
  POMERIUM_AUDIENCE: "camel.example.com",
  POMERIUM_IDP_PROVIDER: "oidc",
  POMERIUM_IDP_PROVIDER_URL: "",
  POMERIUM_IDP_CLIENT_ID: "",
  POMERIUM_IDP_CLIENT_SECRET: "",
  POMERIUM_COOKIE_SECRET: secretBase64(),
  POMERIUM_SHARED_SECRET: secretBase64(),
  POMERIUM_ORG_MAP: "",
  POMERIUM_ORG_CLAIMS: "",
  POMERIUM_ORG_GROUP_PREFIX: "",
  POMERIUM_ADMIN_GROUP_PREFIX: "",
  POMERIUM_DEFAULT_ORG_NAME: "",
  POMERIUM_REQUIRED_EMAIL_DOMAIN: "",
  CF_ACCOUNT_ID: "selfhost",
  CF_GATEWAY_NAME: "",
  AI_GATEWAY_AUTH_TOKEN: "",
  CF_GATEWAY_TOKEN: "",
  CF_GATEWAY_BASE_URL: "",
  SELFHOST_AI_PROVIDER: "",
  SELFHOST_AI_API_KEY: "",
  SELFHOST_AI_BASE_URL: "",
  SELFHOST_AI_MODEL: "",
  SELFHOST_AI_NAME: "",
  SELFHOST_AI_AUTH_TYPE: "bearer",
  SELFHOST_AI_API: "openai-completions",
  SELFHOST_AI_AWS_REGION: "us-east-1",
  // Optional agent customization (also loadable from .selfhost/agent/).
  SELFHOST_AGENT_HOST_DIR: "./.selfhost/agent",
  SELFHOST_AGENT_DIR: ".selfhost/agent",
  SELFHOST_AGENT_SKILLS_DIR: "",
  SELFHOST_AGENT_PROMPT_APPEND: "",
  SELFHOST_AGENT_PROMPT_PREPEND: "",
  SELFHOST_AGENT_SKILLS_JSON: "",
  TOKEN_SIGNING_SECRET: secret(),
  INTEGRATION_SECRET_KEY: secret(),
  LOCAL_ARTIFACTS_SECRET: secret(),
  ADMIN_API_KEY: secret(),
  // Deployed apps get a CONNECTIONS service binding that can list/invoke
  // workspace connections. Set to false for on-prem installs that must keep
  // connection-backed data out of published apps. Chat/agent connections stay
  // available either way.
  CONNECTIONS_BINDING_ENABLED: "true",
  // The bundled agent runtime chat threads run on: its image, tenant,
  // operator token (AGENT_RUNTIME_API_TOKEN), session secret, secrets key and
  // database password. See SELF_HOSTING.md, "Upgrading to the runtime".
  ...Object.fromEntries(AGENT_RUNTIME_ENV_DEFAULTS.map(([key, generate]) => [key, generate()])),
  SELFHOST_AGENT_RUNTIME_PORT: DEFAULT_AGENT_RUNTIME_PORT,
  SELFHOST_AGENT_RUNTIME_POSTGRES_PORT: DEFAULT_AGENT_RUNTIME_POSTGRES_PORT,
  // Private model endpoints the runtime may call, as exact origins
  // (scheme://host:port, comma-separated), e.g. http://10.1.2.3:8000.
  SELFHOST_AGENT_RUNTIME_OUTBOUND_ALLOW_ORIGINS: "",
};

// New runtime secrets over the runtime's existing volumes would lock the
// install out of their data (--force included): refuse, and say how to recover.
{
  const previousProject = existsSync(envFile)
    ? /^\s*COMPOSE_PROJECT_NAME\s*=\s*"?([^"\s]+)"?\s*$/m.exec(await fs.readFile(envFile, "utf8"))?.[1]
    : undefined;
  const projects = [...new Set([values.COMPOSE_PROJECT_NAME, previousProject].filter(Boolean))];
  const volumes = await existingDockerVolumes(
    projects.flatMap((project) => AGENT_RUNTIME_VOLUMES.map((name) => volumeName(name, { COMPOSE_PROJECT_NAME: project }))),
  );
  try {
    refuseStatefulSecretRegeneration(AGENT_RUNTIME_PRIVATE_KEYS, volumes);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

const content = `# camelAI self-host configuration.
# Generated by \`bun run selfhost:init\`.
# Keep this file private; it contains authentication and token-signing secrets.

${Object.entries(values)
  .map(([key, value]) => `${key}=${writeEnvValue(value)}`)
  .join("\n")}
`;

await fs.writeFile(envFile, content, { mode: 0o600 });
await writePomeriumConfig(values, { strict: false });
await writeCaddyConfig(values, { strict: false });
const { ensureSelfhostAgentPackSkeleton } = await import("./selfhost-agent-pack.mjs");
const agentSkeleton = await ensureSelfhostAgentPackSkeleton(repoRoot, values);
console.log(`Wrote ${path.relative(repoRoot, envFile)}.`);
console.log(`Wrote ${path.relative(repoRoot, agentSkeleton.agentDir)}/ (agent customization pack).`);
console.log("Next steps:");
console.log("  Configure identity, automatic TLS, DNS, and AI settings in .env.selfhost");
console.log("  Optionally add skills/prompt under .selfhost/agent/");
console.log("  bun run selfhost:configure");
console.log("  bun run selfhost:doctor");
console.log("  bun run selfhost:up");

function secret() {
  return randomBytes(32).toString("base64url");
}

function secretBase64() {
  return randomBytes(32).toString("base64");
}
