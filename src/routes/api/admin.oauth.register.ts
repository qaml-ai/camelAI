import type { Route } from "./+types/admin.oauth.register";
import { getEnv } from "@/lib/cloudflare.server";
import { getAdminMcpOAuth, OAuthError } from "@/lib/admin-mcp-oauth.server";
import { actionOnlyLoader } from '@/lib/method-not-allowed';

type RegistrationMetadata = Parameters<ReturnType<typeof getAdminMcpOAuth>["registerClient"]>[0];

function asRegistrationMetadata(value: unknown): RegistrationMetadata {
  return typeof value === "object" && value !== null ? value : {};
}

export const loader = actionOnlyLoader('POST');

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const env = getEnv(context);
  const oauth = getAdminMcpOAuth(env);

  try {
    const metadata = asRegistrationMetadata(await request.json().catch(() => ({})));
    const client = await oauth.registerClient(metadata);
    return Response.json(
      {
        ...client,
        client_id_issued_at: client.created_at,
      },
      { status: 201, headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof OAuthError) return error.toResponse();
    return Response.json({ error: "Client registration failed" }, { status: 500 });
  }
}
