import type { Route } from "./+types/orgs";
import { requireAuthContext } from "@/lib/auth.server";
import { getUserOrgs } from "@/lib/auth-do";
import { getAuthEnv } from "@/lib/auth-helpers";
import { getEnv } from "@/lib/cloudflare.server";
import { ENTERPRISE_OIDC_AUTH_SOURCE } from "../../../workers/main/src/signed-session";

/**
 * The user's full org list with names + archived filtering — i.e. the per-org
 * ORG.getInfo() fan-out that used to run inside getAuthContext on every page
 * load. It was the dominant auth latency (a single cold OrgDO could stall the
 * request ~1.4s), so it now lives here and is fetched lazily by the workspace
 * switcher, which is the only consumer that needs org names.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const authContext = await requireAuthContext(request, context);
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const orgs = await getUserOrgs(authEnv, authContext.user.id, { d1Read: true });
  return {
    orgs:
      authContext.session.auth_source === ENTERPRISE_OIDC_AUTH_SOURCE
        ? orgs.filter((org) => org.org_id === authContext.session.org_id)
        : orgs,
  };
}
