import type { Route } from "./+types/marketing-attribution.activate";
import { getAuthEnv, requireAuthContext } from "@/lib/auth.server";
import { getEnv } from "@/lib/cloudflare.server";
import {
  associateAttributionWithUser,
  recordNewCamelActivation,
} from "@/lib/marketing-attribution.server";
import { actionOnlyLoader } from '@/lib/method-not-allowed';

export const loader = actionOnlyLoader('POST');

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const auth = await requireAuthContext(request, context);
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const userId = auth.user.id;
  const user = authEnv.USER.get(authEnv.USER.idFromName(userId));

  await associateAttributionWithUser(request, env.APP_KV, userId);
  const claim = await user.claimNewCamelActivation();
  const activation = await recordNewCamelActivation(env.APP_KV, {
    userId,
    eventId: claim.eventId,
    activatedAt: claim.activatedAt,
  });

  return Response.json(
    {
      activated: claim.isFirst,
      eventId: activation.eventId,
      completionBasis: activation.completionBasis,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
