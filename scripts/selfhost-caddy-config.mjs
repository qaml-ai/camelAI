#!/usr/bin/env node
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  envFile,
  readSelfhostEnv,
  repoRoot,
} from "./selfhost-common.mjs";
import {
  selfhostTlsMode,
} from "./selfhost-tls-mode.mjs";

export const caddyDirectory = path.join(repoRoot, ".selfhost", "caddy");
export const caddyConfigFile = path.join(caddyDirectory, "Caddyfile");
export const caddySecretsDirectory = path.join(caddyDirectory, "secrets");

export async function writeCaddyConfig(env, { strict = true } = {}) {
  const tlsMode = selfhostTlsMode(env);
  if (!new Set(["automatic", "external", "provided"]).has(tlsMode)) {
    throw new Error(
      'SELFHOST_TLS_MODE must be "automatic", "external", or "provided"',
    );
  }

  const authMode = (env.SELFHOST_AUTH_MODE || "").trim();
  if (
    tlsMode !== "external" &&
    authMode !== "bundled-pomerium" &&
    authMode !== "local"
  ) {
    throw new Error(
      `SELFHOST_TLS_MODE=${tlsMode} requires bundled-pomerium authentication; ` +
        "external identity proxies must use SELFHOST_TLS_MODE=external",
    );
  }

  const mainHostname = requiredHostname(
    env.SELFHOST_MAIN_HOSTNAME ||
      new URL(requiredValue(env.SELFHOST_PUBLIC_BASE_URL, "SELFHOST_PUBLIC_BASE_URL"))
        .hostname,
    "SELFHOST_MAIN_HOSTNAME",
  );
  const authenticateHostname =
    authMode === "bundled-pomerium"
      ? requiredHostname(
          env.POMERIUM_AUTHENTICATE_HOSTNAME ||
            new URL(
              requiredValue(
                env.POMERIUM_AUTHENTICATE_URL,
                "POMERIUM_AUTHENTICATE_URL",
              ),
            ).hostname,
          "POMERIUM_AUTHENTICATE_HOSTNAME",
        )
      : "";
  const appDomains = uniqueDomains([
    env.LOCAL_APP_VANITY_DOMAIN,
    env.LOCAL_APP_IFRAME_DOMAIN,
  ]);
  const upstream =
    authMode === "bundled-pomerium"
      ? "http://127.0.0.1:5444"
      : `http://127.0.0.1:${validPort(env.SELFHOST_APP_PORT || "3001")}`;

  await fs.mkdir(caddySecretsDirectory, {
    recursive: true,
    mode: 0o700,
  });
  await fs.chmod(caddySecretsDirectory, 0o700);
  await removeUnusedSecrets(env, tlsMode);

  let tlsBlock = "";
  if (tlsMode === "automatic") {
    tlsBlock = await automaticTlsBlock(env, { strict });
  } else if (tlsMode === "provided") {
    await copyProvidedTls(env, { strict });
    tlsBlock = [
      "\ttls /run/camelai-secrets/tls.crt /run/camelai-secrets/tls.key",
    ].join("\n");
  }

  const globalOptions = ["{", "\tadmin 127.0.0.1:2019"];
  if ((env.SELFHOST_TLS_ACME_EMAIL || "").trim()) {
    globalOptions.push(
      `\temail ${caddyToken(env.SELFHOST_TLS_ACME_EMAIL, "SELFHOST_TLS_ACME_EMAIL")}`,
    );
  }
  globalOptions.push("}");

  let config;
  if (tlsMode === "external") {
    const bindAddress = validBindAddress(
      env.SELFHOST_TLS_EXTERNAL_BIND_ADDRESS || "127.0.0.1",
    );
    const port = validPort(env.SELFHOST_TLS_EXTERNAL_PORT || "8080");
    config = [
      ...globalOptions,
      "",
      `http://:${port} {`,
      `\tbind ${bindAddress}`,
      proxyBlock(upstream),
      "}",
    ];
  } else {
    const siteAddresses = [
      mainHostname,
      ...(authenticateHostname ? [authenticateHostname] : []),
      ...appDomains.map((domain) => `*.${domain}`),
    ].map((hostname) => `https://${hostname}`);
    config = [
      ...globalOptions,
      "",
      `${siteAddresses.join(", ")} {`,
      tlsBlock,
      proxyBlock(upstream),
      "}",
    ];
  }

  await fs.mkdir(caddyDirectory, { recursive: true, mode: 0o700 });
  await fs.chmod(caddyDirectory, 0o700);
  await fs.writeFile(caddyConfigFile, `${config.join("\n")}\n`, {
    mode: 0o600,
  });
  return caddyConfigFile;
}

async function automaticTlsBlock(env, { strict }) {
  const provider = (env.SELFHOST_TLS_DNS_PROVIDER || "").trim().toLowerCase();
  if (!new Set(["cloudflare", "route53"]).has(provider)) {
    throw new Error(
      'SELFHOST_TLS_DNS_PROVIDER must be "cloudflare" or "route53" when SELFHOST_TLS_MODE=automatic',
    );
  }

  if (provider === "cloudflare") {
    const token = (env.SELFHOST_TLS_CLOUDFLARE_API_TOKEN || "").trim();
    if (strict && !token) {
      throw new Error(
        "SELFHOST_TLS_CLOUDFLARE_API_TOKEN is required for automatic Cloudflare DNS validation",
      );
    }
    await writeSecret("cloudflare-api-token", token);
    return [
      "\ttls {",
      "\t\tdns cloudflare {file./run/camelai-secrets/cloudflare-api-token}",
      "\t}",
    ].join("\n");
  }

  await writeAwsCredentials(env, { strict });
  const hostedZoneId = (env.SELFHOST_TLS_ROUTE53_HOSTED_ZONE_ID || "").trim();
  return [
    "\ttls {",
    "\t\tdns route53 {",
    ...(hostedZoneId
      ? [
          `\t\t\thosted_zone_id ${caddyToken(
            hostedZoneId,
            "SELFHOST_TLS_ROUTE53_HOSTED_ZONE_ID",
          )}`,
        ]
      : []),
    "\t\t}",
    "\t}",
  ].join("\n");
}

async function copyProvidedTls(env, { strict }) {
  const configuredCertificate = (
    env.SELFHOST_TLS_CERTIFICATE_FILE || ""
  ).trim();
  const configuredPrivateKey = (
    env.SELFHOST_TLS_PRIVATE_KEY_FILE || ""
  ).trim();
  const certificateSource = configuredCertificate
    ? resolveOperatorPath(configuredCertificate)
    : firstExisting([
        path.join(repoRoot, ".selfhost", "tls", "tls.crt"),
        path.join(repoRoot, ".selfhost", "pomerium", "tls.crt"),
      ]);
  const privateKeySource = configuredPrivateKey
    ? resolveOperatorPath(configuredPrivateKey)
    : firstExisting([
        path.join(repoRoot, ".selfhost", "tls", "tls.key"),
        path.join(repoRoot, ".selfhost", "pomerium", "tls.key"),
      ]);

  if (strict && (!certificateSource || !existsSync(certificateSource))) {
    throw new Error(
      "missing provided TLS certificate; set SELFHOST_TLS_CERTIFICATE_FILE or install .selfhost/tls/tls.crt",
    );
  }
  if (strict && (!privateKeySource || !existsSync(privateKeySource))) {
    throw new Error(
      "missing provided TLS private key; set SELFHOST_TLS_PRIVATE_KEY_FILE or install .selfhost/tls/tls.key",
    );
  }
  if (certificateSource && existsSync(certificateSource)) {
    await copySecret(certificateSource, "tls.crt");
  }
  if (privateKeySource && existsSync(privateKeySource)) {
    await copySecret(privateKeySource, "tls.key");
  }
}

async function removeUnusedSecrets(env, tlsMode) {
  const dnsProvider = (
    env.SELFHOST_TLS_DNS_PROVIDER || ""
  ).trim().toLowerCase();
  const retained = new Set(
    tlsMode === "provided"
      ? ["tls.crt", "tls.key"]
      : tlsMode === "automatic" && dnsProvider === "cloudflare"
        ? ["cloudflare-api-token"]
        : tlsMode === "automatic" && dnsProvider === "route53"
          ? ["aws-credentials"]
          : [],
  );
  for (const name of [
    "aws-credentials",
    "cloudflare-api-token",
    "tls.crt",
    "tls.key",
  ]) {
    if (!retained.has(name)) {
      await fs.rm(path.join(caddySecretsDirectory, name), { force: true });
    }
  }
}

async function writeAwsCredentials(env, { strict }) {
  const accessKeyId = (env.SELFHOST_TLS_AWS_ACCESS_KEY_ID || "").trim();
  const secretAccessKey = (
    env.SELFHOST_TLS_AWS_SECRET_ACCESS_KEY || ""
  ).trim();
  const sessionToken = (env.SELFHOST_TLS_AWS_SESSION_TOKEN || "").trim();
  for (const [name, value] of [
    ["SELFHOST_TLS_AWS_ACCESS_KEY_ID", accessKeyId],
    ["SELFHOST_TLS_AWS_SECRET_ACCESS_KEY", secretAccessKey],
    ["SELFHOST_TLS_AWS_SESSION_TOKEN", sessionToken],
  ]) {
    if (/[\r\n]/.test(value)) {
      throw new Error(`${name} must be a single line`);
    }
  }
  if (Boolean(accessKeyId) !== Boolean(secretAccessKey)) {
    throw new Error(
      "SELFHOST_TLS_AWS_ACCESS_KEY_ID and SELFHOST_TLS_AWS_SECRET_ACCESS_KEY must be set together",
    );
  }
  if (strict && sessionToken && !accessKeyId) {
    throw new Error(
      "SELFHOST_TLS_AWS_SESSION_TOKEN requires explicit AWS access-key credentials",
    );
  }
  if (!accessKeyId) {
    await fs.rm(path.join(caddySecretsDirectory, "aws-credentials"), {
      force: true,
    });
    return;
  }
  const profile =
    (env.SELFHOST_TLS_AWS_PROFILE || "default").trim() || "default";
  if (!/^[A-Za-z0-9_.-]+$/.test(profile)) {
    throw new Error(
      "SELFHOST_TLS_AWS_PROFILE contains unsupported characters",
    );
  }
  const lines = [
    `[${profile}]`,
    `aws_access_key_id=${accessKeyId}`,
    `aws_secret_access_key=${secretAccessKey}`,
    ...(sessionToken ? [`aws_session_token=${sessionToken}`] : []),
  ];
  await writeSecret("aws-credentials", `${lines.join("\n")}\n`);
}

function proxyBlock(upstream) {
  return [
    `\treverse_proxy ${upstream} {`,
    "\t\theader_up X-Forwarded-Proto https",
    "\t}",
  ].join("\n");
}

async function writeSecret(name, value) {
  const destination = path.join(caddySecretsDirectory, name);
  if (!value) {
    await fs.rm(destination, { force: true });
    return;
  }
  await fs.writeFile(destination, value, { mode: 0o600 });
  await fs.chmod(destination, 0o600);
}

async function copySecret(source, name) {
  const destination = path.join(caddySecretsDirectory, name);
  await fs.copyFile(source, destination);
  await fs.chmod(destination, 0o600);
}

function firstExisting(paths) {
  return paths.find((candidate) => existsSync(candidate)) || paths[0];
}

function resolveOperatorPath(value) {
  return path.isAbsolute(value) ? value : path.resolve(repoRoot, value);
}

function uniqueDomains(values) {
  return [
    ...new Set(
      values
        .filter((value) => (value || "").trim())
        .map((value) => requiredHostname(value, "deployed app domain")),
    ),
  ];
}

function requiredValue(value, name) {
  const result = String(value || "").trim();
  if (!result) throw new Error(`${name} is required`);
  return result;
}

function requiredHostname(value, name) {
  const hostname = requiredValue(value, name).toLowerCase();
  if (
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(
      hostname,
    )
  ) {
    throw new Error(`${name} must be a DNS hostname`);
  }
  return hostname;
}

function validPort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid TCP port: ${value}`);
  }
  return port;
}

function validBindAddress(value) {
  const address = String(value || "").trim();
  if (!new Set(["127.0.0.1", "0.0.0.0", "::1", "::"]).has(address)) {
    throw new Error(
      "SELFHOST_TLS_EXTERNAL_BIND_ADDRESS must be a loopback or wildcard IP address",
    );
  }
  return address;
}

function caddyToken(value, name) {
  const token = requiredValue(value, name);
  if (!/^[A-Za-z0-9_.:+@/-]+$/.test(token)) {
    throw new Error(`${name} contains unsupported Caddyfile characters`);
  }
  return token;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const env = await readSelfhostEnv(true);
  await writeCaddyConfig(env);
  console.log(`Wrote ${path.relative(repoRoot, caddyConfigFile)}.`);
  console.log(`Using ${path.relative(repoRoot, envFile)}.`);
}
