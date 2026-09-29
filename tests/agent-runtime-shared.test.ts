import { describe, expect, it, vi } from "vitest";
import { normalizePreviewTabs } from "../workers/main/src/chat-thread/preview-state";
import {
  RUNTIME_REQUEST_ID,
  requireSameOriginJson,
  initialRuntimeRequestId,
  runtimeDirectThreadsEnabled,
  startErrorStillCurrent,
} from "@/lib/agent-runtime-shared";

// The runtime's own check (agent-runtime src/client-sessions.ts `validId`).
const RUNTIME_VALID_ID = /^[A-Za-z0-9_-]{1,80}$/;

describe("runtime request ids", () => {
  it("gives a new thread's first message an id the runtime accepts", () => {
    const id = initialRuntimeRequestId("0f8fad5b-d9cb-469f-a165-70867728950e");
    expect(RUNTIME_VALID_ID.test(id)).toBe(true);
    expect(id).toBe("initial_0f8fad5b-d9cb-469f-a165-70867728950e");
  });

  it("accepts exactly what the runtime accepts", () => {
    for (const id of ["client_1790000000000_ab12cd34", "initial_x", "a".repeat(80)]) {
      expect(RUNTIME_REQUEST_ID.test(id)).toBe(RUNTIME_VALID_ID.test(id));
      expect(RUNTIME_REQUEST_ID.test(id)).toBe(true);
    }
    for (const id of ["initial:thread", "", "a".repeat(81), "has space", "slash/id"]) {
      expect(RUNTIME_REQUEST_ID.test(id)).toBe(false);
    }
  });
});

describe("runtimeDirectThreadsEnabled", () => {
  const tenant = { AGENT_RUNTIME_API_TOKEN: "t", AGENT_RUNTIME_TENANT: "x", AGENT_RUNTIME_DEFINITION: "d" };
  it("is on wherever the runtime tenant is configured (every thread runs there)", () => {
    expect(runtimeDirectThreadsEnabled(tenant)).toBe(true);
    expect(runtimeDirectThreadsEnabled({ ...tenant, AGENT_RUNTIME_DEFINITION: "" })).toBe(false);
    expect(runtimeDirectThreadsEnabled({})).toBe(false);
  });
});

describe("startErrorStillCurrent", () => {
  const error = { id: "rt-start:100", error: "LLM usage limit reached.", at: 100 };
  it("keeps a refusal while nothing newer reached the agent, even once the agent exists", () => {
    expect(startErrorStillCurrent(error, [])).toEqual({ id: "rt-start:100", error: "LLM usage limit reached." });
    expect(startErrorStillCurrent(error, [{ message: { role: "user", timestamp: 50 } }])).not.toBeNull();
  });
  it("drops it once a newer message reached the agent", () => {
    expect(startErrorStillCurrent(error, [{ message: { role: "assistant", timestamp: 150 } }])).toBeNull();
    expect(startErrorStillCurrent(null, [])).toBeNull();
  });
});

const requireRuntimeThreadMock = vi.fn(async () => { throw new Error("must not reach access checks"); });
vi.mock("@/lib/runtime-threads.server", () => ({
  requestWorkspaceId: () => null,
  requireRuntimeThread: requireRuntimeThreadMock,
}));
vi.mock("@/lib/wait-until", () => ({ waitUntil: vi.fn() }));
const startRuntimeTurnMock = vi.fn();
vi.mock("../workers/main/src/agent-runtime/thread-runtime", () => ({ startRuntimeTurn: startRuntimeTurnMock }));

describe("POST /api/threads/:id/messages", () => {
  it("refuses a client message id the runtime would refuse", async () => {
    const { action } = await import("@/routes/api/threads.$id.messages");
    const response = await action({
      request: new Request("https://camelai.test/api/threads/t1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "hi", clientMessageId: "initial:t1" }),
      }),
      context: {},
      params: { id: "t1" },
    } as never) as Response;
    expect(response.status).toBe(400);
  });
});

describe("requireSameOriginJson", () => {
  const request = (headers: Record<string, string>, method = "POST") => new Request("https://camelai.test/api/threads/t/stop", { method, headers });
  const status = (fn: () => void) => { try { fn(); return 200; } catch (error) { return (error as Response).status; } };
  it("lets this origin's JSON writes through", () => {
    expect(status(() => requireSameOriginJson(request({ "content-type": "application/json", "sec-fetch-site": "same-origin" })))).toBe(200);
    expect(status(() => requireSameOriginJson(request({ "content-type": "application/json; charset=utf-8" })))).toBe(200);
  });
  it("refuses other sites, including same-site user apps, and non-JSON writes", () => {
    expect(status(() => requireSameOriginJson(request({ "content-type": "application/json", "sec-fetch-site": "same-site" })))).toBe(403);
    expect(status(() => requireSameOriginJson(request({ "content-type": "application/json", "sec-fetch-site": "cross-site" })))).toBe(403);
    expect(status(() => requireSameOriginJson(request({ "content-type": "application/x-www-form-urlencoded" })))).toBe(415);
    expect(status(() => requireSameOriginJson(request({})))).toBe(415);
  });
});

describe("normalizePreviewTabs", () => {
  it("keeps well-formed tabs from the thread's workspace, bounded, with a real active tab", () => {
    const result = normalizePreviewTabs([
      { kind: "app", scriptName: "shop\"><script>", isPublic: true },
      { kind: "app", scriptName: 42 },
      { kind: "file", source: "workspace", workspaceId: "other", path: "/a.md" },
      { kind: "file", source: "workspace", workspaceId: "ws1", path: "/b.md" },
      { kind: "file", source: "workspace", workspaceId: "ws1", path: "/../etc" },
      "junk",
      null,
    ], "app:nope", "ws1");
    expect(result.tabs).toEqual([
      { kind: "app", scriptName: "shop___script_", isPublic: true },
      { kind: "file", source: "workspace", workspaceId: "ws1", path: "/b.md", project: undefined, filename: undefined, contentType: undefined },
    ]);
    expect(result.activeTabId).toBe("app:shop___script_");
    const many = Array.from({ length: 50 }, (_, index) => ({ kind: "app", scriptName: `app${index}` }));
    expect(normalizePreviewTabs(many, null, "ws1").tabs).toHaveLength(32);
  });
});

describe("POST /api/threads/:id/messages failures", () => {
  const post = async () => {
    const { action } = await import("@/routes/api/threads.$id.messages");
    return await action({
      request: new Request("https://camelai.test/api/threads/t1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "hi", clientMessageId: "client_1_abc" }),
      }),
      context: {},
      params: { id: "t1" },
    } as never) as Response;
  };
  it("asks for a retry under the same id when the runtime or network fails", async () => {
    requireRuntimeThreadMock.mockResolvedValueOnce({ env: {}, context: {}, sender: {}, row: {} } as never);
    startRuntimeTurnMock.mockRejectedValueOnce(new Error("socket hang up"));
    const response = await post();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ retryable: true });
  });
  it("reports the runtime's refusal of the request as final", async () => {
    const { RuntimeApiError } = await import("../workers/main/src/agent-runtime/runtime-api");
    requireRuntimeThreadMock.mockResolvedValueOnce({ env: {}, context: {}, sender: {}, row: {} } as never);
    startRuntimeTurnMock.mockRejectedValueOnce(new RuntimeApiError("Agent runtime POST /prompt: HTTP 400 bad", 400));
    const response = await post();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "error" });
  });
});

describe("normalizePreviewTabs and scratch files", () => {
  it("keeps a scratch tab only for its own thread, under /workspace", () => {
    const own = { kind: "file", source: "scratch", workspaceId: "ws1", threadId: "t1", path: "/workspace/out/r.html" };
    const other = { ...own, threadId: "t2" };
    const outside = { ...own, path: "/etc/passwd" };
    const noThread = { kind: "file", source: "scratch", workspaceId: "ws1", path: "/workspace/x" };
    const result = normalizePreviewTabs([own, other, outside, noThread], null, "ws1", "t1");
    expect(result.tabs).toEqual([expect.objectContaining({ source: "scratch", threadId: "t1", path: "/workspace/out/r.html" })]);
    expect(normalizePreviewTabs([own], null, "ws1").tabs).toEqual([]);
  });
});
