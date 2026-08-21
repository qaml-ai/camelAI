import {
  getObservabilitySnapshot,
  recordEvent,
} from "../observability.ts";

export const SERVER_VERSION = "0.1.0";

export function handlePlatformHttpRequest(request: Request): Response {
  const url = new URL(request.url);
  const status =
    request.method === "GET" &&
    (url.pathname === "/health" || url.pathname === "/api/metrics")
      ? 200
      : 404;

  recordHttpRequest(request, status);

  if (request.method === "GET" && url.pathname === "/health") {
    return json({ ok: true, version: SERVER_VERSION });
  }
  if (request.method === "GET" && url.pathname === "/api/metrics") {
    return json(getObservabilitySnapshot());
  }
  return json({ error: "Not found" }, { status: 404 });
}

export function startPlatformHttpServer(
  port = Number(process.env.PORT_HTTP ?? "6422"),
  fallback?: (request: Request) => Response | Promise<Response>,
): Bun.Server<undefined> {
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`Invalid PORT_HTTP: ${process.env.PORT_HTTP ?? port}`);
  }
  return Bun.serve({
    port,
    fetch: fallback
      ? async (request) => {
          const url = new URL(request.url);
          if (
            request.method === "GET" &&
            (url.pathname === "/health" || url.pathname === "/api/metrics")
          ) {
            return handlePlatformHttpRequest(request);
          }
          const response = await fallback(request);
          recordHttpRequest(request, response.status);
          return response;
        }
      : handlePlatformHttpRequest,
  });
}

function recordHttpRequest(request: Request, status: number): void {
  const url = new URL(request.url);
  recordEvent({
    event: "http_requests",
    component: "http",
    operation: `${request.method} ${url.pathname}`,
    status: String(status),
    meta: { method: request.method, path: url.pathname, statusCode: status },
  });
}

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { ...init, headers });
}
