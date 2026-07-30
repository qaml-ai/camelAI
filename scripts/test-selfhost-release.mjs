#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import {
  caddyComposeFile,
  caddySourceComposeFile,
  composeArgs,
  pomeriumComposeFile,
  pomeriumLoopbackComposeFile,
  sourceComposeFile,
  volumeNamesForEnv,
} from "./selfhost-common.mjs";
import { selfhostTlsMode } from "./selfhost-tls-mode.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

const read = (file) => fs.readFile(path.join(repoRoot, file), "utf8");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function includesAll(text, values, context) {
  for (const value of values) {
    assert(text.includes(value), `${context} must include ${value}`);
  }
}

const [
  compose,
  sourceOverride,
  pomeriumOverride,
  pomeriumLoopbackOverride,
  pomeriumConfig,
  caddyOverride,
  caddySourceOverride,
  caddyConfig,
  caddyDockerfile,
  tlsModeScript,
  commonScript,
  bundledDockerfile,
  imageWorkflow,
  upgradeScript,
  upgradeBootstrapScript,
  backupScript,
  restoreScript,
  doctorScript,
  cloudFormation,
  terraformMain,
  terraformCloudInit,
] = await Promise.all([
  read("docker-compose.selfhost.yml"),
  read("docker-compose.selfhost.source.yml"),
  read("docker-compose.selfhost.pomerium.yml"),
  read("docker-compose.selfhost.pomerium-loopback.yml"),
  read("scripts/selfhost-pomerium-config.mjs"),
  read("docker-compose.selfhost.caddy.yml"),
  read("docker-compose.selfhost.caddy-source.yml"),
  read("scripts/selfhost-caddy-config.mjs"),
  read("infra/selfhost/caddy.Dockerfile"),
  read("scripts/selfhost-tls-mode.mjs"),
  read("scripts/selfhost-common.mjs"),
  read("infra/selfhost/app-bundled.Dockerfile"),
  read(".github/workflows/selfhost-images.yml"),
  read("scripts/selfhost-upgrade.mjs"),
  read("scripts/selfhost-upgrade-bootstrap.mjs"),
  read("scripts/selfhost-backup.mjs"),
  read("scripts/selfhost-restore.mjs"),
  read("scripts/selfhost-doctor.mjs"),
  read("infra/selfhost/cloudformation/aws-single-node.yaml"),
  read("infra/selfhost/terraform/main.tf"),
  read("infra/selfhost/terraform/cloud-init.sh.tpl"),
]);

includesAll(
  compose,
  [
    "SELFHOST_APP_IMAGE",
    "SELFHOST_LOCAL_ARTIFACTS_IMAGE",
    "SELFHOST_PROJECT_BUILD_IMAGE",
    "SELFHOST_ANALYSIS_IMAGE",
    "SELFHOST_DB_QUERY_IMAGE",
    "SELFHOST_CONTAINER_EGRESS_IMAGE",
    "network_mode: host",
    "SELFHOST_WORKERD_SOCKET:",
    "LOCAL_ARTIFACTS_BASE_URL: http://127.0.0.1:7001",
    "LOCAL_ARTIFACTS_PUBLIC_BASE_URL: http://127.0.0.1:7001",
    "/var/run/docker.sock",
  ],
  "production self-host Compose",
);
assert(
  !compose.includes("LOCAL_ARTIFACTS_BASE_URL: http://local-artifacts:7001"),
  "host-networked app must reach local-artifacts through the VM loopback",
);
assert(
  !/^\s+build:\s*$/m.test(compose),
  "production self-host Compose must consume release images, not build from source",
);
assert(
  !compose.includes("- .:/workspace"),
  "production self-host Compose must not mount a mutable source checkout",
);

includesAll(
  sourceOverride,
  [
    "infra/selfhost/app.Dockerfile",
    "infra/selfhost/local-artifacts.Dockerfile",
    "project-build-sandbox.Dockerfile",
    "analysis-sandbox.Dockerfile",
    "db-query-sandbox.Dockerfile",
    "workers/main/eval-egress-fix",
  ],
  "source-build Compose override",
);

includesAll(
  pomeriumOverride,
  [
    "pomerium/pomerium@sha256:",
    "network_mode: host",
    "IDP_CLIENT_SECRET_FILE",
    "COOKIE_SECRET_FILE",
    "SHARED_SECRET_FILE",
    "pomerium-data",
    'test: ["CMD", "pomerium", "health"]',
    "DAC_OVERRIDE",
    "no-new-privileges:true",
  ],
  "bundled Pomerium Compose override",
);
includesAll(
  pomeriumLoopbackOverride,
  [
    "SELFHOST_MAIN_HOSTNAME",
    "POMERIUM_AUTHENTICATE_HOSTNAME",
    "127.0.0.1",
  ],
  "bundled Pomerium loopback Compose override",
);
assert(
  !pomeriumOverride.includes("IDP_CLIENT_SECRET:"),
  "bundled Pomerium secrets must not be exposed through container environment values",
);
assert(
  !pomeriumOverride.includes("NET_BIND_SERVICE"),
  "bundled Pomerium must not retain the capability to bind public TLS ports",
);
includesAll(
  pomeriumConfig,
  [
    'SELFHOST_POMERIUM_TLS_MODE must be "direct" or "upstream"',
    'address: tlsMode === "direct" ? ":443" : "127.0.0.1:5444"',
    'insecure_server: true',
    'jwt_issuer_format: "hostOnly"',
    "pass_identity_headers: true",
    "preserve_host_header: true",
    "allow_websockets: true",
    "allow_public_unauthenticated_access: true",
    "POMERIUM_AUTHENTICATE_HOSTNAME must differ",
  ],
  "bundled Pomerium configuration generator",
);
assert(
  !pomeriumConfig.includes("...process.env"),
  ".env.selfhost must be the single source of truth for generated Pomerium configuration",
);
includesAll(
  caddyOverride,
  [
    "SELFHOST_CADDY_IMAGE",
    "network_mode: host",
    "./.selfhost/caddy:/etc/caddy:ro",
    "./.selfhost/caddy/secrets:/run/camelai-secrets:ro",
    "caddy-data",
    "caddy-config",
    "NET_BIND_SERVICE",
    "no-new-privileges:true",
  ],
  "Caddy TLS front-door Compose override",
);
includesAll(
  caddySourceOverride,
  ["infra/selfhost/caddy.Dockerfile", "camelai-selfhost-caddy:source"],
  "source-build Caddy override",
);
includesAll(
  caddyDockerfile,
  [
    "ARG CADDY_VERSION=2.11.4",
    "caddy:${CADDY_VERSION}-builder-alpine",
    "caddy-dns/cloudflare@v0.2.4",
    "caddy-dns/route53@v1.6.2",
    "caddy:${CADDY_VERSION}-alpine",
  ],
  "Caddy release image",
);
includesAll(
  caddyConfig,
  [
    "SELFHOST_TLS_MODE",
    "SELFHOST_TLS_DNS_PROVIDER",
    "dns cloudflare",
    "dns route53",
    "hosted_zone_id",
    "/run/camelai-secrets/tls.crt",
    "SELFHOST_TLS_EXTERNAL_BIND_ADDRESS",
    "http://127.0.0.1:5444",
  ],
  "Caddy configuration generator",
);
includesAll(
  tlsModeScript,
  [
    '"automatic"',
    '"external"',
    '"provided"',
    "SELFHOST_POMERIUM_TLS_MODE",
  ],
  "legacy TLS-mode migration",
);
assert(
  selfhostTlsMode({
    SELFHOST_AUTH_MODE: "bundled-pomerium",
    SELFHOST_POMERIUM_TLS_MODE: "direct",
  }) === "provided",
  "legacy direct-Pomerium installs must migrate to provided Caddy TLS",
);
assert(
  selfhostTlsMode({
    SELFHOST_AUTH_MODE: "bundled-pomerium",
    SELFHOST_POMERIUM_TLS_MODE: "upstream",
  }) === "external",
  "legacy upstream-Pomerium installs must preserve external TLS termination",
);
includesAll(
  commonScript,
  [
    "docker-compose.selfhost.pomerium.yml",
    "docker-compose.selfhost.pomerium-loopback.yml",
    "docker-compose.selfhost.caddy.yml",
    "docker-compose.selfhost.caddy-source.yml",
    "tlsTerminatesOnVm",
    '"bundled-pomerium"',
    '"pomerium-data"',
    '"caddy-data"',
    '"caddy-config"',
  ],
  "self-host Compose selection",
);
for (const [name, env, expectedFiles] of [
  [
    "release/external-proxy",
    {
      SELFHOST_DEPLOYMENT_MODE: "release",
      SELFHOST_TLS_MODE: "external",
    },
    [caddyComposeFile],
  ],
  [
    "release/bundled/automatic",
    {
      SELFHOST_DEPLOYMENT_MODE: "release",
      SELFHOST_AUTH_MODE: "bundled-pomerium",
      SELFHOST_TLS_MODE: "automatic",
    },
    [pomeriumComposeFile, caddyComposeFile, pomeriumLoopbackComposeFile],
  ],
  [
    "source/external-proxy",
    {
      SELFHOST_DEPLOYMENT_MODE: "source",
      SELFHOST_TLS_MODE: "external",
    },
    [sourceComposeFile, caddyComposeFile, caddySourceComposeFile],
  ],
  [
    "source/bundled/provided",
    {
      SELFHOST_DEPLOYMENT_MODE: "source",
      SELFHOST_AUTH_MODE: "bundled-pomerium",
      SELFHOST_TLS_MODE: "provided",
    },
    [
      sourceComposeFile,
      pomeriumComposeFile,
      caddyComposeFile,
      caddySourceComposeFile,
      pomeriumLoopbackComposeFile,
    ],
  ],
  [
    "release/bundled/external-tls",
    {
      SELFHOST_DEPLOYMENT_MODE: "release",
      SELFHOST_AUTH_MODE: "bundled-pomerium",
      SELFHOST_TLS_MODE: "external",
    },
    [pomeriumComposeFile, caddyComposeFile],
  ],
  [
    "release/legacy-direct-pomerium-migration",
    {
      SELFHOST_DEPLOYMENT_MODE: "release",
      SELFHOST_AUTH_MODE: "bundled-pomerium",
      SELFHOST_POMERIUM_TLS_MODE: "direct",
    },
    [pomeriumComposeFile, caddyComposeFile, pomeriumLoopbackComposeFile],
  ],
]) {
  const args = composeArgs(env, ["config"]);
  for (const file of [
    sourceComposeFile,
    pomeriumComposeFile,
    pomeriumLoopbackComposeFile,
    caddyComposeFile,
    caddySourceComposeFile,
  ]) {
    assert(
      args.includes(file) === expectedFiles.includes(file),
      `${name} Compose selection is incorrect for ${path.basename(file)}`,
    );
  }
}
assert(
  ["pomerium-data", "caddy-data", "caddy-config"].every((name) =>
    volumeNamesForEnv({
      SELFHOST_AUTH_MODE: "bundled-pomerium",
      SELFHOST_TLS_MODE: "automatic",
    }).includes(name),
  ),
  "bundled automatic-TLS backups must include Pomerium and Caddy state",
);

assert(
  bundledDockerfile.includes("RUN bun run build:cf"),
  "bundled app image must build the application at image-build time",
);
assert(
  bundledDockerfile.includes(
    "COPY package.json bun.lock ./\nCOPY patches ./patches\nRUN bun install --frozen-lockfile",
  ),
  "bundled app build must copy patched dependencies before installing",
);
assert(
  bundledDockerfile.includes(
    "COPY package.json bun.lock ./\nCOPY patches ./patches\nRUN bun install --frozen-lockfile --production",
  ),
  "bundled app runtime must copy patched dependencies before installing",
);
const bundledCommand =
  bundledDockerfile.match(/^CMD\s+(.+)$/m)?.[1] ?? "";
assert(
  bundledCommand && !bundledCommand.includes("selfhost:workerd:build"),
  "bundled app image must not rebuild the application at container startup",
);
assert(
  !bundledCommand.includes("SELFHOST_WORKERD_SOCKET=0.0.0.0"),
  "bundled app must honor the operator-configured host-network listen address",
);
includesAll(
  bundledDockerfile,
  ["libgbm1", "libgtk-3-0", "fonts-liberation"],
  "bundled app browser runtime",
);

includesAll(
  imageWorkflow,
  [
    "image: app",
    "image: local-artifacts",
    "image: project-build",
    "image: analysis",
    "image: db-query",
    "image: container-egress",
    "image: caddy",
    "platforms: linux/amd64",
    "provenance: mode=max",
    "sbom: true",
    "attest-build-provenance",
    "selfhost-release.json",
    "scripts/selfhost-upgrade-bootstrap.mjs",
    "Resolve immutable image digests",
    "validate-contract:",
    "validate-bundled-images:",
    "validate-runtimes:",
    "Smoke project build runtime",
    "Smoke analysis notebook runtime",
    "Smoke DB query drivers",
    "Smoke release app nested-Docker topology",
    "Validate Caddy DNS providers",
    "dns.providers.cloudflare",
    "dns.providers.route53",
    "--network host",
    "- validate-contract",
    "- validate-bundled-images",
    "- validate-runtimes",
  ],
  "self-host image release workflow",
);

includesAll(
  upgradeScript,
  [
    "--release",
    "--manifest",
    "--rollback",
    "SELFHOST_APP_IMAGE",
    "SELFHOST_LOCAL_ARTIFACTS_IMAGE",
    "SELFHOST_PROJECT_BUILD_IMAGE",
    "SELFHOST_ANALYSIS_IMAGE",
    "SELFHOST_DB_QUERY_IMAGE",
    "SELFHOST_CONTAINER_EGRESS_IMAGE",
    "SELFHOST_CADDY_IMAGE",
    "SELFHOST_POMERIUM_IMAGE",
    "@sha256:",
    "snapshotReleaseState",
    "restoreReleaseState",
    "runtimeMayHaveMigrated",
    "--resume-upgrade",
    "writeUpgradeHandoff",
    "Automatic code rollback is disabled",
    "runDeepSmokes",
    "selfhost:container:smoke:",
  ],
  "self-host release upgrade helper",
);
includesAll(
  upgradeBootstrapScript,
  [
    "target-manifest.json",
    "upgrade-handoff.json",
    "scripts/selfhost-backup.mjs",
    "declared backup archive",
    "scripts/selfhost-upgrade.mjs",
    "--resume-upgrade",
  ],
  "legacy self-host release upgrade bootstrap",
);
includesAll(
  imageWorkflow,
  [
    "pomerium/pomerium@sha256:aae6010af6ba4c864bbd3f748cf37843a140b1ddef74d7d2ac1aa87660f8da1f",
    ".images.pomerium = $ref",
  ],
  "Pomerium release dependency contract",
);
includesAll(
  backupScript,
  [
    "Required volume",
    "No successful backup manifest was written",
  ],
  "fail-closed self-host backup",
);
includesAll(
  restoreScript,
  ["Missing declared backup archive", "new Set(selectedVolumeNames)"],
  "fail-closed self-host restore",
);
includesAll(
  doctorScript,
  [
    'await check("network binding"',
    "SELFHOST_BIND_ADDRESS must remain loopback",
    'await check("TLS front door"',
    "SELFHOST_CADDY_IMAGE",
    "SELFHOST_TLS_DNS_PROVIDER",
    '"caddy",',
    '"validate",',
    "Caddy configuration validated with the configured image",
  ],
  "self-host network and TLS validation",
);

for (const [name, template] of [
  ["CloudFormation", cloudFormation],
  ["Terraform cloud-init", terraformCloudInit],
]) {
  assert(
    !template.includes("project-runtime") &&
      !template.includes("PROJECT_RUNTIME_"),
    `${name} must not reintroduce the retired project runtime`,
  );
}

includesAll(
  cloudFormation,
  [
    "bundled-pomerium",
    "PomeriumIdpClientSecretArn",
    "PomeriumAuthenticateDnsRecord",
    "Default: automatic",
    "route53:ChangeResourceRecordSets",
    "SELFHOST_CADDY_IMAGE",
    "SELFHOST_TLS_MODE",
    "SELFHOST_TLS_DNS_PROVIDER",
    "docker-compose.selfhost.caddy.yml",
    "docker-compose.selfhost.pomerium.yml",
    "docker-compose.selfhost.pomerium-loopback.yml",
  ],
  "CloudFormation bundled Pomerium deployment",
);
includesAll(
  terraformMain,
  [
    'var.auth_provider == "bundled-pomerium"',
    "pomerium_idp_client_secret_arn",
    "aws_route53_record\" \"pomerium_authenticate",
    'var.tls_mode == "automatic"',
    "ManageCamelAITlsDnsChallenge",
    "caddy_image_b64",
    "route53_zone_id_b64",
    "user_data_base64",
    "base64gzip(local.cloud_init)",
  ],
  "Terraform bundled Pomerium deployment",
);
includesAll(
  terraformCloudInit,
  [
    "POMERIUM_IDP_CLIENT_SECRET_ARN",
    'CFG_SELFHOST_AUTH_MODE="external-pomerium"',
    'CFG_SELFHOST_TLS_DNS_PROVIDER="route53"',
    "CFG_SELFHOST_CADDY_IMAGE",
    "docker-compose.selfhost.caddy.yml",
    "docker-compose.selfhost.pomerium.yml",
    "docker-compose.selfhost.pomerium-loopback.yml",
  ],
  "Terraform bundled Pomerium bootstrap",
);

console.log("Self-host release contract passed.");
