import { redirect } from "react-router";
import type { Route } from "./+types/auth.enterprise-oidc.link";
import { requireAuthContext } from "@/lib/auth.server";
import { getEnv } from "@/lib/cloudflare.server";
import { createSsoLinkCookie } from "@/lib/org-sso-browser.server";
import { createSignedEnterpriseSsoLink } from "../../../workers/main/src/signed-session";
import { actionOnlyLoader } from '@/lib/method-not-allowed';

export const loader = actionOnlyLoader('POST');

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  const env = getEnv(context);
  if (request.headers.get("Origin") !== new URL(env.WORKER_BASE_URL).origin) {
    return Response.json({ error: "Invalid request origin" }, { status: 403 });
  }
  const auth = await requireAuthContext(request, context);
  if (auth.user.is_superuser) {
    return Response.json({ error: "Superuser accounts cannot be linked to organization SSO" }, { status: 403 });
  }
  const form = await request.formData();
  const orgId = String(form.get("org_id") ?? "");
  if (!orgId || auth.currentOrg.id !== orgId) {
    return Response.json({ error: "SSO linking must target the current organization" }, { status: 403 });
  }
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  const [org, config, member] = await Promise.all([
    orgStub.getInfo(),
    orgStub.getSsoConfig(),
    orgStub.getMember(auth.user.id),
  ]);
  if (!org || org.billing_status !== "enterprise" || !config?.enabled || !member) {
    return Response.json({ error: "Enterprise SSO is not available" }, { status: 403 });
  }
  const linkToken = await createSignedEnterpriseSsoLink(env.TOKEN_SIGNING_SECRET, {
    org_id: orgId,
    user_id: auth.user.id,
    created_at: Date.now(),
  });
  return redirect(`/sso/${encodeURIComponent(org.slug)}?link=1`, {
    headers: { "Set-Cookie": createSsoLinkCookie(orgId, linkToken) },
  });
}
