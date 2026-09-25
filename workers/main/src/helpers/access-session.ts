/**
 * Cloudflare Access provider adapter.
 *
 * Implements the {@link ProxyAuthProvider} contract on top of the shared
 * reverse-proxy identity engine in `proxy-auth-core.ts`. Cloudflare Access
 * forwards an RS256-signed assertion in the `Cf-Access-Jwt-Assertion` header
 * and exposes a separate `get-identity` endpoint for the full identity
 * document (groups/claims). All org-mapping, session-minting, and revalidation
 * logic is provider-independent and lives in the core.
 *
 * Public names here are kept stable for the app-side login path
 * (`src/lib/cloudflare-access-auth.server.ts`) and existing imports.
 */

import { parseCookie } from "../cookies.js";
import { CLOUDFLARE_ACCESS_AUTH_SOURCE } from "../signed-session.js";
import {
  fetchIdentityViaWeakMap,
  normalizeHttpsUrl,
  parseList,
  parseOrgMap,
  normalizedOptional,
  ProxyAuthUnavailableError,
  validateProxyIdentityMapsToOrg,
  type ProxyAuthConfig,
  type ProxyAuthProvider,
  type ProxyAuthValidationEnv,
  type ProxyIdentity,
  type ProxySessionValidation,
} from "./proxy-auth-core.js";

export { CLOUDFLARE_ACCESS_AUTH_SOURCE } from "../signed-session.js";

export const ACCESS_JWT_HEADER = "Cf-Access-Jwt-Assertion";
const ACCESS_COOKIE_NAME = "CF_Authorization";
// KV namespaces for the org mapping. These literals are persisted in APP_KV and
// the lock DO; do not change them or existing mappings orphan.
export const ORG_KV_PREFIX = "cloudflare_access:org:";
export const ORG_LOCK_PREFIX = "cloudflare_access:org_lock:";

export interface CloudflareAccessEnv {
  APP_KV: KVNamespace;
  CLOUDFLARE_ACCESS_TEAM_DOMAIN?: string;
  CLOUDFLARE_ACCESS_AUD?: string;
  CLOUDFLARE_ACCESS_AUDS?: string;
  CLOUDFLARE_ACCESS_ORG_MAP?: string;
  CLOUDFLARE_ACCESS_ORG_CLAIMS?: string;
  CLOUDFLARE_ACCESS_ORG_GROUP_PREFIX?: string;
  CLOUDFLARE_ACCESS_ADMIN_GROUP_PREFIX?: string;
  CLOUDFLARE_ACCESS_DEFAULT_ORG_NAME?: string;
  CLOUDFLARE_ACCESS_REQUIRED_EMAIL_DOMAIN?: string;
}

/**
 * Resolve Cloudflare Access configuration from env. Returns null (feature
 * disabled) unless a team domain and at least one audience are configured.
 */
export function getAccessConfig(
  env: CloudflareAccessEnv,
): ProxyAuthConfig | null {
  const teamDomain = normalizeHttpsUrl(env.CLOUDFLARE_ACCESS_TEAM_DOMAIN);
  const audiences = parseList(env.CLOUDFLARE_ACCESS_AUDS);
  if (env.CLOUDFLARE_ACCESS_AUD?.trim()) {
    audiences.push(env.CLOUDFLARE_ACCESS_AUD.trim());
  }
  const uniqueAudiences = [...new Set(audiences)];
  if (!teamDomain || uniqueAudiences.length === 0) return null;

  return {
    namespace: teamDomain,
    kvPrefix: ORG_KV_PREFIX,
    lockPrefix: ORG_LOCK_PREFIX,
    jwksUrl: `${teamDomain}/cdn-cgi/access/certs`,
    allowedAlgs: ["RS256"],
    issuer: teamDomain,
    audiences: uniqueAudiences,
    orgClaimPaths: parseList(env.CLOUDFLARE_ACCESS_ORG_CLAIMS),
    orgMap: parseOrgMap(env.CLOUDFLARE_ACCESS_ORG_MAP),
    orgGroupPrefix: normalizedOptional(env.CLOUDFLARE_ACCESS_ORG_GROUP_PREFIX),
    adminGroupPrefix: normalizedOptional(
      env.CLOUDFLARE_ACCESS_ADMIN_GROUP_PREFIX,
    ),
    defaultOrgName: normalizedOptional(env.CLOUDFLARE_ACCESS_DEFAULT_ORG_NAME),
    requiredEmailDomain:
      normalizedOptional(
        env.CLOUDFLARE_ACCESS_REQUIRED_EMAIL_DOMAIN,
      )?.toLowerCase() ?? null,
  };
}

/**
 * Fetch the full Access identity from the team domain. Returns null when the
 * endpoint deterministically has no identity for the request (4xx); throws
 * {@link ProxyAuthUnavailableError} on network failures and 5xx so callers can
 * distinguish a transient outage from de-provisioning. Request-scoped memoized.
 */
export function fetchAccessIdentity(
  request: Request,
  token: string,
  config: ProxyAuthConfig,
): Promise<ProxyIdentity | null> {
  return fetchIdentityViaWeakMap(request, () =>
    fetchAccessIdentityFromOrigin(request, token, config),
  );
}

async function fetchAccessIdentityFromOrigin(
  request: Request,
  token: string,
  config: ProxyAuthConfig,
): Promise<ProxyIdentity | null> {
  const headers = new Headers({
    Authorization: `Bearer ${token}`,
    [ACCESS_JWT_HEADER]: token,
  });
  // get-identity is cookie-based. CF_Authorization carries the same Access
  // application JWT as the assertion header, so when Cloudflare did not
  // forward the cookie to the origin, fall back to the assertion token —
  // otherwise group/claim-based mapping breaks on those deployments.
  const accessCookie =
    parseCookie(request.headers.get("Cookie"), ACCESS_COOKIE_NAME) ?? token;
  headers.set("Cookie", `${ACCESS_COOKIE_NAME}=${accessCookie}`);
  const identityUrl = new URL("/cdn-cgi/access/get-identity", config.issuer);
  let response: Response;
  try {
    response = await fetch(identityUrl.toString(), { headers });
  } catch (error) {
    throw new ProxyAuthUnavailableError(
      `Unable to fetch Cloudflare Access identity: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (response.status >= 500) {
    throw new ProxyAuthUnavailableError(
      `Cloudflare Access identity endpoint returned ${response.status}`,
    );
  }
  if (!response.ok) return null;
  return (await response.json()) as ProxyIdentity;
}

export const CLOUDFLARE_ACCESS_PROVIDER: ProxyAuthProvider = {
  authSource: CLOUDFLARE_ACCESS_AUTH_SOURCE,
  oauthProvider: "cloudflare_access",
  membershipSource: "cloudflare-access",
  jwtHeader: ACCESS_JWT_HEADER,
  getConfig: getAccessConfig,
  resolveIdentity: (request, token, _payload, config) =>
    fetchAccessIdentity(request, token, config),
  getLogoutUrl: (request, env) => {
    if (!getAccessConfig(env)) return null;
    return new URL("/cdn-cgi/access/logout", request.url).toString();
  },
};

/**
 * Validate an Access-backed signed session cookie against the live Access
 * identity on the request. Sessions from other auth sources are always
 * "valid". Read-only.
 */
export async function validateAccessBackedSignedSession(
  request: Request,
  env: ProxyAuthValidationEnv,
  session: {
    auth_source?: string | null;
    user_email?: string | null;
    org_id?: string | null;
  },
): Promise<ProxySessionValidation> {
  if (session.auth_source !== CLOUDFLARE_ACCESS_AUTH_SOURCE) return "valid";
  return validateProxyIdentityMapsToOrg(
    request,
    env,
    CLOUDFLARE_ACCESS_PROVIDER,
    session.user_email,
    session.org_id,
  );
}
