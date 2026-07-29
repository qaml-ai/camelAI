import process from "node:process";

export function selfhostTlsMode(env = {}) {
  const configured = (
    env.SELFHOST_TLS_MODE ||
    process.env.SELFHOST_TLS_MODE ||
    ""
  ).trim();
  if (configured) return configured;

  // Migrate installations created before SELFHOST_TLS_MODE existed. Their
  // operator-provided PEM files can move from direct Pomerium TLS to Caddy
  // without requiring a new certificate.
  if (
    (env.SELFHOST_AUTH_MODE || process.env.SELFHOST_AUTH_MODE) ===
      "bundled-pomerium" &&
    (env.SELFHOST_POMERIUM_TLS_MODE ||
      process.env.SELFHOST_POMERIUM_TLS_MODE ||
      "direct") === "direct"
  ) {
    return "provided";
  }
  return "external";
}

export function usesCaddy(env = {}) {
  return new Set(["automatic", "external", "provided"]).has(
    selfhostTlsMode(env),
  );
}

export function tlsTerminatesOnVm(env = {}) {
  return new Set(["automatic", "provided"]).has(selfhostTlsMode(env));
}
