/**
 * Cloudflare Access app-side login wrappers.
 *
 * Thin bindings of the Cloudflare Access provider into the provider-agnostic
 * silent-login/provisioning engine (`proxy-auth.server.ts`). The shared engine
 * owns the actual logic; this module exists to preserve the Cloudflare-named
 * public API used across the app.
 */

import type { AuthEnv } from "./auth-helpers";
import {
  CLOUDFLARE_ACCESS_PROVIDER,
  getAccessConfig,
  type CloudflareAccessEnv,
} from "../../workers/main/src/helpers/access-session";
import {
  tryProxySilentLogin,
  type ProxyAuthSessionResult,
} from "./proxy-auth.server";

export type { CloudflareAccessEnv } from "../../workers/main/src/helpers/access-session";

// Generic guard; dispatches by the session's auth source so it covers every
// reverse-proxy provider, not just Cloudflare Access.
export { requireProxyMappedOrg as requireAccessMappedOrg } from "./proxy-auth.server";

export function isCloudflareAccessConfigured(env: CloudflareAccessEnv): boolean {
  return Boolean(getAccessConfig(env));
}

export function getCloudflareAccessLogoutUrl(
  request: Request,
  env: CloudflareAccessEnv,
): string | null {
  return CLOUDFLARE_ACCESS_PROVIDER.getLogoutUrl(request, env);
}

export function tryCloudflareAccessSilentLogin(
  request: Request,
  env: CloudflareAccessEnv,
  authEnv: AuthEnv,
): Promise<ProxyAuthSessionResult | null> {
  return tryProxySilentLogin(
    request,
    env,
    authEnv,
    CLOUDFLARE_ACCESS_PROVIDER,
  );
}
