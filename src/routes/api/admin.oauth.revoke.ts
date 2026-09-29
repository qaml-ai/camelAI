import type { Route } from "./+types/admin.oauth.revoke";
import { getEnv } from "@/lib/cloudflare.server";
import { getAdminMcpOAuth, OAuthError } from "@/lib/admin-mcp-oauth.server";
import { actionOnlyLoader } from '@/lib/method-not-allowed';

export const loader = actionOnlyLoader('POST');

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const env = getEnv(context);
  const oauth = getAdminMcpOAuth(env);
  const params = new URLSearchParams(await request.text());
  const token = params.get("token");
  if (!token) return new OAuthError("invalid_request", "token is required").toResponse();

  await oauth.revokeToken(token, params.get("token_type_hint") ?? undefined);
  return new Response(null, { status: 200 });
}
