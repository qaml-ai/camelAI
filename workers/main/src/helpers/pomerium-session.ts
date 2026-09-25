/**
 * Pomerium provider adapter.
 *
 * Implements the {@link ProxyAuthProvider} contract on top of the shared
 * reverse-proxy identity engine in `proxy-auth-core.ts`, for self-hosted
 * installs that put Pomerium in front of the app. Pomerium forwards an
 * ES256-signed attestation JWT in the `X-Pomerium-Jwt-Assertion` header with
 * the user's email, name, and groups inline, so there is no separate identity
 * round-trip (unlike Cloudflare Access). The JWKS is served from the
 * authenticate service at `/.well-known/pomerium/jwks.json`. All org-mapping,
 * session-minting, and revalidation logic is provider-independent and lives in
 * the core.
 */

import {
  normalizeHttpsUrl,
  normalizedOptional,
  parseList,
  parseOrgMap,
  type ProxyAuthConfig,
  type ProxyAuthProvider,
  type ProxyIdentity,
} from "./proxy-auth-core.js";
import { POMERIUM_AUTH_SOURCE } from "../signed-session.js";

export { POMERIUM_AUTH_SOURCE } from "../signed-session.js";

export const POMERIUM_JWT_HEADER = "X-Pomerium-Jwt-Assertion";
// KV namespaces for the org mapping. These literals are persisted in APP_KV and
// the lock DO; do not change them or existing mappings orphan.
export const POMERIUM_ORG_KV_PREFIX = "pomerium:org:";
export const POMERIUM_ORG_LOCK_PREFIX = "pomerium:org_lock:";

const POMERIUM_JWKS_PATH = "/.well-known/pomerium/jwks.json";

export interface PomeriumEnv {
  APP_KV: KVNamespace;
  /** Full JWKS URL. Takes precedence over POMERIUM_AUTHENTICATE_URL. */
  POMERIUM_JWKS_URL?: string;
  /** Authenticate service origin; the JWKS path is derived from it. */
  POMERIUM_AUTHENTICATE_URL?: string;
  /** Expected `iss` claim — the route host Pomerium fronts (no scheme). */
  POMERIUM_ISSUER?: string;
  /** Accepted `aud` claim values (comma-separated), the route host(s). */
  POMERIUM_AUDIENCE?: string;
  POMERIUM_ORG_MAP?: string;
  POMERIUM_ORG_CLAIMS?: string;
  POMERIUM_ORG_GROUP_PREFIX?: string;
  POMERIUM_ADMIN_GROUP_PREFIX?: string;
  POMERIUM_DEFAULT_ORG_NAME?: string;
  POMERIUM_REQUIRED_EMAIL_DOMAIN?: string;
}

function resolveJwksUrl(env: PomeriumEnv): string | null {
  // The explicit override is a full JWKS URL and is the trust root for accepting
  // assertions, so enforce https here too (not just on the derived authenticate
  // origin) — never fetch signing keys over plaintext.
  const explicit = normalizeHttpsUrl(env.POMERIUM_JWKS_URL);
  if (explicit) return explicit;
  const authenticate = normalizeHttpsUrl(env.POMERIUM_AUTHENTICATE_URL);
  if (!authenticate) return null;
  return new URL(POMERIUM_JWKS_PATH, authenticate).toString();
}

/**
 * Resolve Pomerium configuration from env. Returns null (feature disabled)
 * unless a JWKS source, an issuer, and at least one audience are configured.
 */
export function getPomeriumConfig(env: PomeriumEnv): ProxyAuthConfig | null {
  const jwksUrl = resolveJwksUrl(env);
  const issuer = normalizedOptional(env.POMERIUM_ISSUER);
  const audiences = parseList(env.POMERIUM_AUDIENCE);
  if (!jwksUrl || !issuer || audiences.length === 0) return null;

  return {
    namespace: issuer,
    kvPrefix: POMERIUM_ORG_KV_PREFIX,
    lockPrefix: POMERIUM_ORG_LOCK_PREFIX,
    jwksUrl,
    allowedAlgs: ["ES256"],
    issuer,
    audiences,
    orgClaimPaths: parseList(env.POMERIUM_ORG_CLAIMS),
    orgMap: parseOrgMap(env.POMERIUM_ORG_MAP),
    orgGroupPrefix: normalizedOptional(env.POMERIUM_ORG_GROUP_PREFIX),
    adminGroupPrefix: normalizedOptional(env.POMERIUM_ADMIN_GROUP_PREFIX),
    defaultOrgName: normalizedOptional(env.POMERIUM_DEFAULT_ORG_NAME),
    requiredEmailDomain:
      normalizedOptional(env.POMERIUM_REQUIRED_EMAIL_DOMAIN)?.toLowerCase() ??
      null,
  };
}

export function isPomeriumConfigured(env: PomeriumEnv): boolean {
  return Boolean(getPomeriumConfig(env));
}

export function getPomeriumLogoutUrl(
  request: Request,
  env: PomeriumEnv,
): string | null {
  if (!getPomeriumConfig(env)) return null;
  return new URL("/.pomerium/sign_out", request.url).toString();
}

export const POMERIUM_PROVIDER: ProxyAuthProvider = {
  authSource: POMERIUM_AUTH_SOURCE,
  oauthProvider: "pomerium",
  membershipSource: "pomerium",
  jwtHeader: POMERIUM_JWT_HEADER,
  getConfig: getPomeriumConfig,
  // Pomerium embeds email/name/groups in the signed assertion, so the payload
  // itself is the identity document — no network round-trip, never unavailable.
  resolveIdentity: (_request, _token, payload) =>
    Promise.resolve(payload as ProxyIdentity),
  getLogoutUrl: getPomeriumLogoutUrl,
};
