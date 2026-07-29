#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  envFile,
  readSelfhostEnv,
  repoRoot,
} from "./selfhost-common.mjs";
import { usesCaddy } from "./selfhost-tls-mode.mjs";

export const pomeriumConfigFile = path.join(
  repoRoot,
  ".selfhost",
  "pomerium",
  "config.yaml",
);

export async function writePomeriumConfig(env, { strict = true } = {}) {
  env = { ...env };
  if ((env.SELFHOST_AUTH_MODE || "").trim() !== "bundled-pomerium") {
    return null;
  }

  const publicUrl = requiredHttpsUrl(
    env.SELFHOST_PUBLIC_BASE_URL,
    "SELFHOST_PUBLIC_BASE_URL",
  );
  const mainHostname = requiredHostname(
    env.SELFHOST_MAIN_HOSTNAME || publicUrl.hostname,
    "SELFHOST_MAIN_HOSTNAME",
  );
  if (publicUrl.hostname !== mainHostname) {
    throw new Error(
      "SELFHOST_MAIN_HOSTNAME must match SELFHOST_PUBLIC_BASE_URL",
    );
  }

  const authenticateUrl = requiredHttpsUrl(
    env.POMERIUM_AUTHENTICATE_URL,
    "POMERIUM_AUTHENTICATE_URL",
  );
  const authenticateHostname = requiredHostname(
    env.POMERIUM_AUTHENTICATE_HOSTNAME || authenticateUrl.hostname,
    "POMERIUM_AUTHENTICATE_HOSTNAME",
  );
  if (authenticateUrl.hostname !== authenticateHostname) {
    throw new Error(
      "POMERIUM_AUTHENTICATE_HOSTNAME must match POMERIUM_AUTHENTICATE_URL",
    );
  }
  if (authenticateHostname === mainHostname) {
    throw new Error(
      "POMERIUM_AUTHENTICATE_HOSTNAME must differ from SELFHOST_MAIN_HOSTNAME",
    );
  }

  const appPort = validPort(env.SELFHOST_APP_PORT || "3001");
  const tlsMode = usesCaddy(env)
    ? "upstream"
    : (env.SELFHOST_POMERIUM_TLS_MODE || "upstream").trim();
  if (!new Set(["direct", "upstream"]).has(tlsMode)) {
    throw new Error(
      'SELFHOST_POMERIUM_TLS_MODE must be "direct" or "upstream"',
    );
  }

  if (strict) {
    requireValue(env.POMERIUM_IDP_CLIENT_ID, "POMERIUM_IDP_CLIENT_ID");
    requireValue(env.POMERIUM_IDP_CLIENT_SECRET, "POMERIUM_IDP_CLIENT_SECRET");
    requireValue(env.POMERIUM_COOKIE_SECRET, "POMERIUM_COOKIE_SECRET");
    requireValue(env.POMERIUM_SHARED_SECRET, "POMERIUM_SHARED_SECRET");
    if ((env.POMERIUM_IDP_PROVIDER || "oidc").trim() === "oidc") {
      requiredHttpsUrl(
        env.POMERIUM_IDP_PROVIDER_URL,
        "POMERIUM_IDP_PROVIDER_URL",
      );
    }
  }

  const appDomains = uniqueDomains([
    env.LOCAL_APP_VANITY_DOMAIN,
    env.LOCAL_APP_IFRAME_DOMAIN,
  ]);
  for (const domain of appDomains) {
    for (const [name, hostname] of [
      ["SELFHOST_MAIN_HOSTNAME", mainHostname],
      ["POMERIUM_AUTHENTICATE_HOSTNAME", authenticateHostname],
    ]) {
      if (hostname === domain || hostname.endsWith(`.${domain}`)) {
        throw new Error(`${name} must not be inside a deployed-app wildcard`);
      }
    }
  }

  const routes = [
    protectedRoute(
      `https://${mainHostname}`,
      `http://127.0.0.1:${appPort}`,
    ),
  ];
  for (const domain of appDomains) {
    routes.push(publicAppRoute(`https://*.${domain}`, `http://127.0.0.1:${appPort}`));
  }

  const config = {
    address: tlsMode === "direct" ? ":443" : "127.0.0.1:5444",
    ...(tlsMode === "direct"
      ? {
          http_redirect_addr: ":80",
          certificate_file: "/pomerium/tls.crt",
          certificate_key_file: "/pomerium/tls.key",
        }
      : { insecure_server: true }),
    databroker_storage_type: "file",
    databroker_storage_connection_string: "file:///data/databroker",
    jwt_issuer_format: "hostOnly",
    routes,
  };

  await fs.mkdir(path.dirname(pomeriumConfigFile), {
    recursive: true,
    mode: 0o700,
  });
  await fs.writeFile(
    pomeriumConfigFile,
    `${JSON.stringify(config, null, 2)}\n`,
    { mode: 0o600 },
  );
  const secretsDir = path.join(path.dirname(pomeriumConfigFile), "secrets");
  await fs.mkdir(secretsDir, { recursive: true, mode: 0o700 });
  for (const [name, value] of [
    ["idp-client-secret", env.POMERIUM_IDP_CLIENT_SECRET],
    ["cookie-secret", env.POMERIUM_COOKIE_SECRET],
    ["shared-secret", env.POMERIUM_SHARED_SECRET],
  ]) {
    const secretPath = path.join(secretsDir, name);
    if (String(value || "").trim()) {
      await fs.writeFile(secretPath, String(value), {
        mode: 0o600,
      });
    } else {
      await fs.rm(secretPath, { force: true });
    }
  }
  return pomeriumConfigFile;
}

function protectedRoute(from, to) {
  return {
    from,
    to,
    preserve_host_header: true,
    pass_identity_headers: true,
    allow_websockets: true,
    allow_any_authenticated_user: true,
  };
}

function publicAppRoute(from, to) {
  return {
    from,
    to,
    preserve_host_header: true,
    allow_websockets: true,
    allow_public_unauthenticated_access: true,
  };
}

function uniqueDomains(values) {
  const domains = [];
  for (const value of values) {
    if (!(value || "").trim()) continue;
    const domain = requiredHostname(value, "deployed app domain");
    if (!domains.includes(domain)) domains.push(domain);
  }
  if (domains.length === 0) {
    throw new Error(
      "LOCAL_APP_VANITY_DOMAIN or LOCAL_APP_IFRAME_DOMAIN is required",
    );
  }
  return domains;
}

function requiredHttpsUrl(value, name) {
  requireValue(value, name);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  if (parsed.protocol !== "https:" || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error(`${name} must be an https origin without a path`);
  }
  return parsed;
}

function requiredHostname(value, name) {
  const hostname = String(value || "").trim().toLowerCase();
  if (
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(
      hostname,
    )
  ) {
    throw new Error(`${name} must be a DNS hostname without a scheme or path`);
  }
  return hostname;
}

function validPort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("SELFHOST_APP_PORT must be an integer from 1 to 65535");
  }
  return port;
}

function requireValue(value, name) {
  if (!String(value || "").trim()) throw new Error(`Missing ${name}`);
}

if (path.resolve(process.argv[1] || "") === path.resolve(import.meta.filename)) {
  const env = await readSelfhostEnv(true);
  const output = await writePomeriumConfig(env);
  if (output) {
    console.log(`Wrote ${path.relative(repoRoot, output)}.`);
  } else {
    console.log(
      `SELFHOST_AUTH_MODE is not bundled-pomerium; ${path.relative(
        repoRoot,
        envFile,
      )} needs no bundled Pomerium configuration.`,
    );
  }
}
