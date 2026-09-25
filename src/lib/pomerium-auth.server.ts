/**
 * Pomerium app-side login wrappers.
 *
 * Thin bindings of the Pomerium provider into the provider-agnostic
 * silent-login/provisioning engine (`proxy-auth.server.ts`). The shared engine
 * owns the actual logic; this module exists to give Pomerium a named public
 * API parallel to Cloudflare Access.
 */

import type { AuthEnv } from "./auth-helpers";
import {
  POMERIUM_PROVIDER,
  type PomeriumEnv,
} from "../../workers/main/src/helpers/pomerium-session";
import {
  tryProxySilentLogin,
  type ProxyAuthSessionResult,
} from "./proxy-auth.server";

export {
  getPomeriumLogoutUrl,
  isPomeriumConfigured,
  type PomeriumEnv,
} from "../../workers/main/src/helpers/pomerium-session";

export function tryPomeriumSilentLogin(
  request: Request,
  env: PomeriumEnv,
  authEnv: AuthEnv,
): Promise<ProxyAuthSessionResult | null> {
  return tryProxySilentLogin(request, env, authEnv, POMERIUM_PROVIDER);
}
