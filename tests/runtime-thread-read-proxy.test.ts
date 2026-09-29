import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runtimeReadProxyBase } from "@/lib/agent-runtime-shared";

const requireRuntimeThreadMock = vi.fn();
const getEnvMock = vi.fn();
vi.mock("@/lib/cloudflare.server", () => ({ getEnv: getEnvMock }));
const mintRuntimeBrowserTokenMock = vi.fn();
vi.mock("@/lib/runtime-threads.server", () => ({
  requestWorkspaceId: (request: Request) => new URL(request.url).searchParams.get("workspaceId"),
  requireRuntimeThread: requireRuntimeThreadMock,
}));
vi.mock("../workers/main/src/agent-runtime/thread-runtime", () => ({
  mintRuntimeBrowserToken: mintRuntimeBrowserTokenMock,
}));
vi.mock("../workers/main/src/agent-runtime/runtime-thread-telemetry", () => ({
  recordRuntimeTokenMintFailure: vi.fn(),
}));

const { loader } = await import("@/routes/api/threads.$id.runtime");
const { action: tokenAction } = await import("@/routes/api/threads.$id.token");

const RUNTIME = "http://127.0.0.1:8790";
const fetchMock = vi.fn();

function read(path: string, headers: Record<string, string> = { authorization: "Bearer abt_1" }, search = "") {
  const [workspaceId, , , agentId, what] = path.split("/");
  return loader({
    request: new Request(`https://camel.example.com${runtimeReadProxyBase("t1", workspaceId)}/v1/agents/${agentId}/${what}${search}`, { headers }),
    context: {},
    params: { id: "t1", workspaceId, agentId, read: what },
  } as never) as Promise<Response>;
}

beforeEach(() => {
  vi.clearAllMocks();
  getEnvMock.mockReturnValue({ CF_ACCOUNT_ID: "selfhost", CF_DISPATCH_NAMESPACE: "selfhost" });
  requireRuntimeThreadMock.mockResolvedValue({
    env: { AGENT_RUNTIME_URL: RUNTIME },
    context: { threadId: "t1", workspaceId: "ws_1" },
    sender: { userId: "u1" },
    row: { agentId: "agt_1", keyScope: "org_1" },
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runtimeReadProxyBase", () => {
  it("is a same-origin path the watcher appends /v1/agents/:id/<read> to, with the workspace as a segment", () => {
    expect(runtimeReadProxyBase("t 1", "ws/1")).toBe("/api/threads/t%201/runtime/ws%2F1");
  });
});

describe("POST /api/threads/:id/token", () => {
  it("hands the browser chiridion's read proxy when the runtime is private (its token names no URL)", async () => {
    mintRuntimeBrowserTokenMock.mockImplementation(async (_env, row, _user, readProxy) => ({
      token: "abt_1", expiresAt: 1, agentId: row.agentId, url: readProxy,
    }));
    const response = await tokenAction({
      request: new Request("https://camel.example.com/api/threads/t1/token?workspaceId=ws_1", { method: "POST" }),
      context: {},
      params: { id: "t1" },
    } as never) as Response;
    expect(mintRuntimeBrowserTokenMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ agentId: "agt_1" }),
      "u1",
      "/api/threads/t1/runtime/ws_1",
    );
    expect(await response.json()).toMatchObject({ url: "/api/threads/t1/runtime/ws_1" });
  });
});

describe("GET /api/threads/:id/runtime/:workspaceId/v1/agents/:agentId/:read", () => {
  it("passes the thread's own agent's read to the private runtime with the browser token, streaming", async () => {
    fetchMock.mockResolvedValue(new Response("event: frame\ndata: {}\n\n", {
      headers: { "Content-Type": "text/event-stream", "Set-Cookie": "runtime=1" },
    }));
    const response = await read("ws_1/v1/agents/agt_1/events", {
      authorization: "Bearer abt_1",
      accept: "text/event-stream",
      "last-event-id": "42",
      cookie: "session=secret",
    }, "?after=3");
    expect(requireRuntimeThreadMock).toHaveBeenCalledWith(expect.any(Request), {}, "t1", "ws_1");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${RUNTIME}/v1/agents/agt_1/events?after=3`);
    const sent = init.headers as Headers;
    expect(sent.get("authorization")).toBe("Bearer abt_1");
    expect(sent.get("last-event-id")).toBe("42");
    expect(sent.get("accept")).toBe("text/event-stream");
    // The session never reaches the runtime.
    expect(sent.get("cookie")).toBeNull();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toBe("event: frame\ndata: {}\n\n");
  });

  it("passes the runtime's refusal through, so the watcher renews its token on a 401", async () => {
    fetchMock.mockResolvedValue(Response.json({ error: "expired" }, { status: 401 }));
    const response = await read("ws_1/v1/agents/agt_1/history");
    expect(response.status).toBe(401);
  });

  it("reads only the thread's own agent, only the browser-token reads, and only with a token", async () => {
    expect((await read("ws_1/v1/agents/agt_2/events")).status).toBe(404);
    expect((await read("ws_1/v1/agents/agt_1/prompt")).status).toBe(404);
    expect((await read("ws_1/v1/agents/agt_1/state", {})).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
    requireRuntimeThreadMock.mockResolvedValue({ env: {}, context: {}, row: { agentId: null } });
    expect((await read("ws_1/v1/agents/agt_1/state")).status).toBe(404);
  });

  it("answers 502 when the runtime cannot be reached", async () => {
    fetchMock.mockRejectedValue(new TypeError("connect ECONNREFUSED"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await read("ws_1/v1/agents/agt_1/state")).status).toBe(502);
  });

  it("is not there unless the runtime is private (self-host): the hosted runtime is read directly", async () => {
    getEnvMock.mockReturnValue({ CF_ACCOUNT_ID: "acct", AGENT_RUNTIME_URL: "https://agents.camelai.dev" });
    expect((await read("ws_1/v1/agents/agt_1/events")).status).toBe(404);
    expect(requireRuntimeThreadMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes only JSON and event streams as what they are, never a type the browser would render", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { headers: { "Content-Type": "application/json; charset=utf-8" } }));
    expect((await read("ws_1/v1/agents/agt_1/state")).headers.get("content-type")).toBe("application/json; charset=utf-8");
    for (const type of ["text/html; charset=utf-8", "image/svg+xml", "application/javascript"]) {
      fetchMock.mockResolvedValue(new Response("<script>alert(1)</script>", { headers: { "Content-Type": type } }));
      const response = await read("ws_1/v1/agents/agt_1/state");
      expect(response.headers.get("content-type")).toBe("application/octet-stream");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });
});
