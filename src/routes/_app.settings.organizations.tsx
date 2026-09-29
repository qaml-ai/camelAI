import { useLoaderData } from "react-router";
import type { Route } from "./+types/_app.settings.organizations";
import { requireAuthContext, getAuthEnv } from "@/lib/auth.server";
import { getEnv } from "@/lib/cloudflare.server";
import * as authDO from "@/lib/auth-do";
import { normalizeBillingPlan } from "@/lib/billing-plans";
import { Separator } from "@/components/ui/separator";
import { SettingsHeader } from "@/components/settings/settings-header";
import { OrgMembershipsList } from "@/components/settings/org-memberships-list";
import { ENTERPRISE_OIDC_AUTH_SOURCE } from "../../workers/main/src/signed-session";

export function meta() {
  return [
    { title: "Organizations - Settings - camelAI" },
    { name: "description", content: "Manage your organizations" },
  ];
}

export async function action({ request, context }: Route.ActionArgs) {
  const authContext = await requireAuthContext(request, context);
  const formData = await request.formData();
  const intent = formData.get("intent");
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const actorId = authContext.user!.id;
  const isEnterpriseSession =
    authContext.session.auth_source === ENTERPRISE_OIDC_AUTH_SOURCE;

  if (intent === "createOrg") {
    if (isEnterpriseSession) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }
    const name = formData.get("name") as string;
    if (!name?.trim()) {
      return { error: "Organization name is required" };
    }
    const { org } = await authDO.createOrg(authEnv, name.trim(), actorId);
    return { success: true, orgId: org.id };
  }

  if (intent === "leaveOrg") {
    const orgId = formData.get("orgId") as string;
    if (!orgId) {
      return { error: "Organization ID is required" };
    }
    if (isEnterpriseSession && authContext.session.org_id !== orgId) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }
    await authDO.removeOrgMember(authEnv, orgId, actorId, actorId);
    return { success: true };
  }

  return { error: "Unknown action" };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const authContext = await requireAuthContext(request, context);
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);

  // Fetch each org display summary without hydrating members/workspaces.
  const orgSummaries = await Promise.all(
    authContext.orgs.map(async (org) => {
      const summary = await authDO.getOrgSettingsSummary(authEnv, org.org_id);

      return {
        org_id: org.org_id,
        // org_name on AuthContext.orgs is only resolved for the current org
        // (others are deferred); use the per-org summary's name here.
        org_name: summary?.name || org.org_name,
        role: org.role,
        joined_at: org.joined_at,
        archived: summary?.archived ?? false,
        billing_plan: normalizeBillingPlan(
          summary?.billing_plan,
          summary?.billing_status ?? "inactive",
        ),
        member_count: summary?.member_count ?? 0,
        workspace_count: summary?.workspace_count ?? 0,
      };
    }),
  );

  // The admin archive path (POST /api/admin/orgs/:id/archive) calls OrgDO.archiveOrg without pruning
  // UserDO memberships, so authContext.orgs can still include archived orgs.
  // Hide them here (mirroring getUserOrgs' archived filter) so the page never
  // renders an archived org or its "Switch to this org" action. Keep the
  // current org regardless, so a user already inside one isn't stranded.
  const visibleOrgs = orgSummaries.filter(
    (org) => !org.archived || org.org_id === authContext.currentOrg.id,
  );

  return {
    orgs: visibleOrgs,
    currentOrgId: authContext.currentOrg.id,
    currentUserId: authContext.user.id,
  };
}

export default function OrganizationsPage() {
  const { orgs } = useLoaderData<typeof loader>();

  return (
    <div className="space-y-6">
      <SettingsHeader
        title="Organizations"
        description="Switch between or manage your organizations."
      />
      <Separator />
      <OrgMembershipsList orgs={orgs} />
    </div>
  );
}
