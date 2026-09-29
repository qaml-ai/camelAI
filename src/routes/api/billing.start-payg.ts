import type { Route } from "./+types/billing.start-payg";
import { requireAuthContext, requireOrgAdmin } from "@/lib/auth.server";
import { activatePayAsYouGoPlan } from "@/lib/billing.server";
import { getEnv } from "@/lib/cloudflare.server";
import { actionOnlyLoader } from '@/lib/method-not-allowed';

export const loader = actionOnlyLoader('POST');

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const authContext = await requireAuthContext(request, context);
  await requireOrgAdmin(request, context, authContext.currentOrg.id);
  const env = getEnv(context);

  try {
    await activatePayAsYouGoPlan({
      env,
      org: authContext.currentOrg,
    });

    return Response.json({
      success: true,
      redirectTo: "/settings/organization/usage?action=topup",
    });
  } catch (error) {
    console.error("[billing] failed to activate pay as you go", {
      orgId: authContext.currentOrg.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to activate Pay as you go",
      },
      { status: 503 },
    );
  }
}
