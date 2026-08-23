const CAPABILITIES = new Set([
  "object-store",
  "artifacts",
  "compute",
  "code-executor",
  "ai",
  "email",
  "browser",
  "images",
  "queues",
  "pipelines",
  "observability",
  "dispatcher",
  "discord",
]);

interface Env {
  FACADE_GATEWAY_URL?: string;
  FACADE_GATEWAY_TOKEN?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestUrl = new URL(request.url);
    if (requestUrl.pathname === "/__celld/health") {
      const gateway = parseGatewayUrl(env.FACADE_GATEWAY_URL);
      const gatewayToken = env.FACADE_GATEWAY_TOKEN?.trim();
      if (!gateway || !gatewayToken) {
        return Response.json({
          ok: false,
          gatewayConfigured: Boolean(gateway),
          gatewayTokenConfigured: Boolean(gatewayToken),
          capabilities: [...CAPABILITIES],
        }, { status: 503 });
      }
      return checkGatewayHealth(gateway, gatewayToken, requestUrl);
    }

    const match = /^\/v1\/([a-z0-9-]+)(?:\/|$)/i.exec(requestUrl.pathname);
    const capability = match?.[1];
    if (!capability || !CAPABILITIES.has(capability)) {
      return Response.json({ error: "Unknown binding facade capability" }, { status: 404 });
    }

    const gateway = parseGatewayUrl(env.FACADE_GATEWAY_URL);
    if (!gateway) {
      return Response.json(
        { error: "FACADE_GATEWAY_URL is not configured" },
        { status: 503 },
      );
    }
    const gatewayToken = env.FACADE_GATEWAY_TOKEN?.trim();
    if (!gatewayToken) {
      return Response.json(
        { error: "FACADE_GATEWAY_TOKEN is not configured" },
        { status: 503 },
      );
    }

    const target = gatewayTarget(gateway, requestUrl);
    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.set("x-camelai-facade-capability", capability);
    headers.set("authorization", `Bearer ${gatewayToken}`);
    const body = request.method === "GET" || request.method === "HEAD"
      ? undefined
      : request.body;
    const response = await fetch(target, {
      method: request.method,
      headers,
      body,
      redirect: "manual",
      ...(body ? { duplex: "half" } : {}),
    } as RequestInit);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  },
};

function parseGatewayUrl(value: string | undefined): URL | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
    return url;
  } catch {
    return null;
  }
}

function gatewayTarget(gateway: URL, requestUrl: URL): URL {
  const target = new URL(gateway);
  const gatewayPrefix = target.pathname.replace(/\/+$/, "");
  target.pathname = `${gatewayPrefix}${requestUrl.pathname}`;
  target.search = requestUrl.search;
  return target;
}

async function checkGatewayHealth(
  gateway: URL,
  gatewayToken: string,
  requestUrl: URL,
): Promise<Response> {
  try {
    const response = await fetch(gatewayTarget(gateway, requestUrl), {
      method: "GET",
      headers: { authorization: `Bearer ${gatewayToken}` },
      signal: AbortSignal.timeout(3_000),
      redirect: "manual",
    });
    return Response.json({
      ok: response.ok,
      gatewayConfigured: true,
      gatewayTokenConfigured: true,
      gatewayStatus: response.status,
      capabilities: [...CAPABILITIES],
    }, { status: response.ok ? 200 : 503 });
  } catch (error) {
    return Response.json({
      ok: false,
      gatewayConfigured: true,
      gatewayTokenConfigured: true,
      gatewayStatus: 0,
      error: error instanceof Error ? error.name : "GatewayHealthError",
      capabilities: [...CAPABILITIES],
    }, { status: 503 });
  }
}
