import type { Route } from "./+types/admin.oauth.token";
import { getEnv } from "@/lib/cloudflare.server";
import {
  getAdminMcpOAuth,
  getAdminMcpResource,
  OAuthError,
} from "@/lib/admin-mcp-oauth.server";
import { actionOnlyLoader } from '@/lib/method-not-allowed';

export const loader = actionOnlyLoader('POST');

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const env = getEnv(context);
  const oauth = getAdminMcpOAuth(env);
  const params = new URLSearchParams(await request.text());
  const clientId = params.get("client_id");
  if (!clientId) return new OAuthError("invalid_request", "client_id is required").toResponse();

  const resource = params.get("resource") ?? getAdminMcpResource(request);

  try {
    const grantType = params.get("grant_type");
    if (grantType === "authorization_code") {
      const code = params.get("code");
      const redirectUri = params.get("redirect_uri");
      if (!code) return new OAuthError("invalid_request", "code is required").toResponse();
      if (!redirectUri) return new OAuthError("invalid_request", "redirect_uri is required").toResponse();
      if (!(await oauth.validateClient(clientId, redirectUri))) {
        return new OAuthError("invalid_client", "Unknown client_id").toResponse(401);
      }
      return Response.json(
        await oauth.exchangeAuthorizationCode(
          clientId,
          code,
          params.get("code_verifier") ?? undefined,
          redirectUri,
          resource,
        ),
        { headers: { "cache-control": "no-store" } },
      );
    }

    if (grantType === "refresh_token") {
      const refreshToken = params.get("refresh_token");
      if (!refreshToken) return new OAuthError("invalid_request", "refresh_token is required").toResponse();
      if (!(await oauth.validateClient(clientId))) {
        return new OAuthError("invalid_client", "Unknown client_id").toResponse(401);
      }
      return Response.json(
        await oauth.exchangeRefreshToken(clientId, refreshToken, resource),
        { headers: { "cache-control": "no-store" } },
      );
    }

    return new OAuthError("unsupported_grant_type", `Unsupported: ${grantType}`).toResponse();
  } catch (error) {
    if (error instanceof OAuthError) return error.toResponse();
    return Response.json({ error: "Token exchange failed" }, { status: 500 });
  }
}
