import { randomBytes } from "node:crypto";
import {
  createOAuthClient,
  type OAuthProviderName,
} from "../auth/oauth.ts";
import { AuthService } from "../auth/service.ts";
import {
  parseSessionCookie,
  serializeSessionCookie,
  SessionService,
} from "../auth/session.ts";
import type { StripeBillingClient } from "../billing/stripe.ts";
import type { BillingService } from "../platform/billing.ts";
import type { Platform } from "../platform/index.ts";
import {
  createBillingRoutes,
  type BillingRouteOptions,
} from "./billing-routes.ts";

export interface ApiOptions {
  billingService: BillingService;
  stripeClient?: StripeBillingClient;
  authorizeBilling?: BillingRouteOptions["authorize"];
  allowTestOrgHeader?: boolean;
  platform?: Platform;
  authService?: AuthService;
  sessionService?: SessionService;
}

/**
 * Composable API fetch handler. The Rivet HTTP host (or a standalone Bun
 * listener) can mount this before its actor routes.
 */
export function createApiHandler(options: ApiOptions) {
  const sessions = options.platform
    ? (options.sessionService ?? new SessionService(options.platform.store))
    : undefined;
  const auth =
    options.platform && sessions
      ? (options.authService ??
        new AuthService(options.platform.identity, sessions))
      : undefined;
  const billingRoutes = createBillingRoutes({
    billingService: options.billingService,
    ...(options.stripeClient ? { stripeClient: options.stripeClient } : {}),
    ...(options.authorizeBilling || auth
      ? {
          authorize:
            options.authorizeBilling ??
            ((request, orgId) => {
              try {
                return (
                  auth?.requireSession(request.headers.get("cookie")).session
                    .orgId === orgId
                );
              } catch {
                return undefined;
              }
            }),
        }
      : {}),
    ...(options.allowTestOrgHeader === undefined
      ? {}
      : { allowTestOrgHeader: options.allowTestOrgHeader }),
  });
  const authRoutes = options.platform
    ? createAuthHttpHandler({
        platform: options.platform,
        ...(options.authService ? { authService: options.authService } : {}),
        ...(sessions ? { sessionService: sessions } : {}),
      })
    : undefined;

  return async function apiHandler(request: Request): Promise<Response> {
    const billingResponse = await billingRoutes(request);
    if (billingResponse) return billingResponse;
    if (authRoutes) return authRoutes(request);
    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  };
}

const OAUTH_STATE_COOKIE = "camelai_oauth_state";
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

type OAuthStateRecord = {
  provider: OAuthProviderName;
  redirectUri: string;
  expiresAt: string;
};

export type AuthHttpApiOptions = {
  platform: Platform;
  authService?: AuthService;
  sessionService?: SessionService;
  port?: number;
};

function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { status, headers: responseHeaders });
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new Error("Content-Type must be application/json");
  }
  const body: unknown = await request.json();
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("JSON request body must be an object");
  }
  return body as Record<string, unknown>;
}

function requiredString(
  body: Record<string, unknown>,
  field: string,
): string {
  const value = body[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required`);
  }
  return value;
}

function oauthProvider(pathname: string, suffix: "start" | "callback"):
  | OAuthProviderName
  | null {
  const match = pathname.match(
    new RegExp(`^/api/auth/oauth/(github|google)/${suffix}$`),
  );
  return (match?.[1] as OAuthProviderName | undefined) ?? null;
}

function publicUrl(request: Request): URL {
  const configured = process.env.AUTH_PUBLIC_URL?.trim();
  return new URL(configured || request.url);
}

function oauthRedirectUri(
  request: Request,
  provider: OAuthProviderName,
): string {
  return new URL(
    `/api/auth/oauth/${provider}/callback`,
    publicUrl(request),
  ).toString();
}

function oauthStateCookie(state: string, maxAge = 600): string {
  const secure =
    process.env.SESSION_COOKIE_SECURE === "true" ||
    process.env.SESSION_COOKIE_SECURE === "1" ||
    process.env.NODE_ENV === "production";
  return [
    `${OAUTH_STATE_COOKIE}=${encodeURIComponent(state)}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/api/auth/oauth",
    `Max-Age=${maxAge}`,
    secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

function cookieValue(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) {
    return null;
  }
  for (const part of cookieHeader.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName === name) {
      try {
        return decodeURIComponent(rawValue.join("=")) || null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

function errorStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  if (/Authentication required|Invalid email or password/.test(message)) {
    return 401;
  }
  if (/already exists/.test(message)) {
    return 409;
  }
  if (/OAuth not configured/.test(message)) {
    return 503;
  }
  return 400;
}

export function createAuthHttpHandler(options: AuthHttpApiOptions) {
  const sessions =
    options.sessionService ?? new SessionService(options.platform.store);
  const auth =
    options.authService ??
    new AuthService(options.platform.identity, sessions);

  return async function handleAuthHttpRequest(
    request: Request,
  ): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return json({ ok: true, service: "camelai-agentos" });
      }

      if (request.method === "POST" && url.pathname === "/api/auth/register") {
        const body = await readJson(request);
        const session = await auth.registerPassword({
          email: requiredString(body, "email"),
          password: requiredString(body, "password"),
          name: requiredString(body, "name"),
        });
        const user = options.platform.identity.getUser(session.userId);
        return json(
          { session, user },
          201,
          { "Set-Cookie": serializeSessionCookie(session.sessionId) },
        );
      }

      if (request.method === "POST" && url.pathname === "/api/auth/login") {
        const body = await readJson(request);
        const session = await auth.loginPassword({
          email: requiredString(body, "email"),
          password: requiredString(body, "password"),
        });
        const user = options.platform.identity.getUser(session.userId);
        return json(
          { session, user },
          200,
          { "Set-Cookie": serializeSessionCookie(session.sessionId) },
        );
      }

      if (request.method === "POST" && url.pathname === "/api/auth/logout") {
        const sessionId = parseSessionCookie(request.headers.get("cookie"));
        if (sessionId) {
          sessions.revokeSession(sessionId);
        }
        return json(
          { ok: true },
          200,
          {
            "Set-Cookie": serializeSessionCookie("", { maxAge: 0 }),
          },
        );
      }

      if (request.method === "GET" && url.pathname === "/api/auth/me") {
        const current = auth.requireSession(request.headers.get("cookie"));
        return json(current);
      }

      const startProvider = oauthProvider(url.pathname, "start");
      if (request.method === "GET" && startProvider) {
        const state = randomBytes(32).toString("base64url");
        const redirectUri = oauthRedirectUri(request, startProvider);
        const stateRecord: OAuthStateRecord = {
          provider: startProvider,
          redirectUri,
          expiresAt: new Date(Date.now() + OAUTH_STATE_TTL_MS).toISOString(),
        };
        const client = createOAuthClient(startProvider);
        const location = client.buildAuthorizeUrl(state, redirectUri);
        options.platform.store.set(`oauth-state:${state}`, stateRecord);
        return new Response(null, {
          status: 302,
          headers: {
            Location: location,
            "Set-Cookie": oauthStateCookie(state),
          },
        });
      }

      const callbackProvider = oauthProvider(url.pathname, "callback");
      if (request.method === "GET" && callbackProvider) {
        const code = url.searchParams.get("code");
        const returnedState = url.searchParams.get("state");
        const cookieState = cookieValue(
          request.headers.get("cookie"),
          OAUTH_STATE_COOKIE,
        );
        if (!code || !returnedState || returnedState !== cookieState) {
          throw new Error("Invalid OAuth callback state");
        }
        const stateKey = `oauth-state:${returnedState}`;
        const stateRecord =
          options.platform.store.get<OAuthStateRecord>(stateKey);
        options.platform.store.delete(stateKey);
        if (
          !stateRecord ||
          stateRecord.provider !== callbackProvider ||
          Date.parse(stateRecord.expiresAt) <= Date.now()
        ) {
          throw new Error("OAuth callback state expired or was not found");
        }

        const client = createOAuthClient(callbackProvider);
        const profile = await client.exchangeCodeForProfile(
          code,
          stateRecord.redirectUri,
        );
        const session = auth.loginFromOAuthProfile(profile);
        const destination = process.env.AUTH_SUCCESS_REDIRECT?.trim() || "/";
        const headers = new Headers({
          Location: new URL(destination, publicUrl(request)).toString(),
          "Set-Cookie": serializeSessionCookie(session.sessionId),
        });
        headers.append("Set-Cookie", oauthStateCookie("", 0));
        return new Response(null, { status: 302, headers });
      }

      return json({ error: "Not found" }, 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return json({ error: message }, errorStatus(error));
    }
  };
}

function authHttpPort(explicitPort?: number): number {
  const raw =
    explicitPort ??
    Number(process.env.AUTH_HTTP_PORT ?? process.env.PORT_HTTP ?? "6422");
  if (!Number.isInteger(raw) || raw <= 0 || raw > 65_535) {
    throw new Error(
      `Invalid AUTH_HTTP_PORT: ${process.env.AUTH_HTTP_PORT ?? process.env.PORT_HTTP}`,
    );
  }
  return raw;
}

export function startAuthHttpServer(options: AuthHttpApiOptions) {
  const port = authHttpPort(options.port);
  const fetch = createAuthHttpHandler(options);
  const server = Bun.serve({ port, fetch });
  console.log(`camelAI auth HTTP API ready at http://127.0.0.1:${server.port}`);
  return server;
}
