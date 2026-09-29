import { beforeAll, describe, expect, it, vi } from "vitest";
import { testRuntime, type TestIdentity } from "@camelai/agent-runtime/testing";

import { AGENT_MCP_TOOL_NAMES, agentMcpHandler, type ToolsFactory } from "../src/routes/agent-mcp";
import type { Env } from "../src/types";

const MCP_URL = "https://camel.test/mcp/agent";
const CONTEXT = { org: "org1", workspace: "ws1", thread: "thread1" };
const ALICE: TestIdentity = { tenant: "chiridion", subject: "user1", context: CONTEXT };

let rt: Awaited<ReturnType<typeof testRuntime>>;
beforeAll(async () => {
  rt = await testRuntime();
});

type Access =
  | { ok: true; orgId: string; orgSlug: string; workspaceId: string; threadId: string }
  | { ok: false; reason: string };

const allowed = (_user: string, workspaceId: string, threadId: string): Access =>
  ({ ok: true, orgId: "org1", orgSlug: "org1", workspaceId, threadId });

type Envelope = Awaited<ReturnType<ReturnType<ToolsFactory>["callToolEnvelope"]>>;

function setup(options: { access?: typeof allowed; result?: Envelope } = {}) {
  const validate = vi.fn(async (userId: string, workspaceId: string, threadId: string) =>
    (options.access ?? allowed)(userId, workspaceId, threadId));
  const env = {
    AGENT_RUNTIME_URL: rt.url,
    AGENT_RUNTIME_TENANT: "chiridion",
    ORG: {
      idFromName: (name: string) => name,
      get: () => ({ validateChatWebSocketAccess: validate }),
    },
  } as unknown as Env;
  const callToolEnvelope = vi.fn(async (): Promise<Envelope> => options.result ?? { ok: true, data: { projects: ["a"] } });
  const tools = vi.fn<ToolsFactory>(() => ({ callToolEnvelope }));
  const handler = agentMcpHandler(env, tools, { fetch: rt.fetch });
  return { handler, validate, tools, callToolEnvelope };
}

describe("agent MCP", () => {
  it("answers 503 without a runtime tenant to check tokens against", async () => {
    const env = { AGENT_RUNTIME_URL: rt.url } as unknown as Env;
    const handler = agentMcpHandler(env, vi.fn<ToolsFactory>(), { fetch: rt.fetch });
    const list = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    expect((await handler(await rt.request(MCP_URL, list, ALICE))).status).toBe(503);
  });

  it("rejects requests without a valid runtime token", async () => {
    const { handler, validate } = setup();
    const list = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    expect((await handler(await rt.request(MCP_URL, list, null))).status).toBe(401);
    const bad = [
      await rt.token(ALICE, "https://elsewhere.test/mcp"),
      await rt.token(ALICE, MCP_URL, { expiresIn: -600 }),
      await rt.token(ALICE, MCP_URL, { claims: { iss: "https://evil.test" } }),
    ];
    for (const token of bad) {
      const response = await handler(new Request(MCP_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(list),
      }));
      expect(response.status).toBe(401);
    }
    expect(validate).not.toHaveBeenCalled();
  });

  it("lists the served tools with JSON schemas", async () => {
    const { handler } = setup();
    const response = await handler(await rt.request(MCP_URL, { jsonrpc: "2.0", id: 1, method: "tools/list" }, ALICE));
    const body = await response.json() as { result: { tools: Array<{ name: string; inputSchema: { type?: string }; _meta: Record<string, string> }> } };
    const names = body.result.tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining([
      "list_projects", "list_apps", "read", "write",
      // UI-state tools reach the thread's DO by RPC.
      "TodoWrite", "set_preview", "set_app_visibility", "deploy_project", "run_notebook",
      // js_exec's binding-only capabilities as tools.
      "connections_query", "connections_invoke", "browser_launch", "browser_action",
      "generate_image", "transcribe_audio", "http_request",
      // Confirmed through the runtime's human input.
      "delete_app", "delete_project", "delete_connection", "prompt_connection_setup",
    ]));
    for (const excluded of [
      "AskUserQuestion",
      "WebSearch", "WebFetch", "Agent", "Explore", "warehouse_run_code", "warehouse_list_connections",
    ]) expect(names).not.toContain(excluded);
    // The tools chiridion's own loop gives the model directly come first (the
    // runtime declares a source's first 64 directly).
    expect(new Set(names.slice(0, 5))).toEqual(new Set(["read", "write", "edit", "ls", "delete"]));
    expect(names.indexOf("deploy_project")).toBeLessThan(64);
    expect(names.indexOf("run_notebook")).toBeLessThan(64);
    expect(new Set(names)).toEqual(AGENT_MCP_TOOL_NAMES);
    for (const tool of body.result.tools) expect(tool.inputSchema.type).toBe("object");
    const exposure = (name: string) => body.result.tools.find((tool) => tool.name === name)?._meta["agent-runtime/exposure"];
    // Tools that wait on the user cannot run in js_exec; long builds stay direct too.
    expect(exposure("delete_app")).toBe("direct");
    expect(exposure("prompt_connection_setup")).toBe("direct");
    expect(exposure("deploy_project")).toBe("both");
    expect(exposure("connections_query")).toBe("codemode");
  });

  it("calls a tool scoped to the agent's context, as the turn's actor", async () => {
    const { handler, validate, tools, callToolEnvelope } = setup();
    const result = await rt.callTool(handler, MCP_URL, "list_projects", {}, { ...ALICE, actor: "user2" });
    expect(validate).toHaveBeenCalledWith("user2", "ws1", "thread1");
    expect(tools).toHaveBeenCalledWith({
      orgId: "org1", workspaceId: "ws1", threadId: "thread1", userId: "user2", allowWebTools: false,
    });
    expect(callToolEnvelope).toHaveBeenCalledWith("list_projects", {});
    expect(result).toEqual({ content: [{ type: "text", text: '{"projects":["a"]}' }], structuredContent: { projects: ["a"] } });
  });

  it("tells the tools when the thread runs on the runtime without a ChatThreadDO", async () => {
    const runtime = { threadId: "thread1", agentId: "agt_1", model: "m", keyScope: null, configured: null, createdAt: 1, updatedAt: 1 };
    const { handler, tools } = setup({
      access: (_user, workspaceId, threadId) => ({ ...allowed(_user, workspaceId, threadId), runtime }) as Access,
    });
    await rt.callTool(handler, MCP_URL, "list_projects", {}, ALICE);
    expect(tools).toHaveBeenCalledWith(expect.objectContaining({ threadId: "thread1", directRuntime: true }));
  });

  it("keeps a runtime thread marked running while a tool call is in flight", async () => {
    const runtime = { threadId: "thread1", agentId: "agt_1", model: "m", keyScope: null, configured: null, createdAt: 1, updatedAt: 1 };
    const streaming = vi.fn(async () => {});
    const workspaces: string[] = [];
    let finish!: () => void;
    const validate = vi.fn(async (_user: string, workspaceId: string, threadId: string) => ({ ...allowed(_user, workspaceId, threadId), runtime }));
    const env = {
      AGENT_RUNTIME_URL: rt.url,
      AGENT_RUNTIME_TENANT: "chiridion",
      ORG: { idFromName: (name: string) => name, get: () => ({ validateChatWebSocketAccess: validate }) },
      WORKSPACE: { idFromName: (name: string) => name, get: (id: string) => { workspaces.push(id); return { recordThreadStreaming: streaming }; } },
    } as unknown as Env;
    const callToolEnvelope = vi.fn(() => new Promise<Envelope>((resolve) => { finish = () => resolve({ ok: true, data: { done: true } }); }));
    const handler = agentMcpHandler(env, () => ({ callToolEnvelope }) as never, { fetch: rt.fetch });

    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const call = rt.callTool(handler, MCP_URL, "list_projects", {}, ALICE);
      await vi.waitFor(() => expect(callToolEnvelope).toHaveBeenCalled());
      // Marked running when the call starts (a sweep may have cleared the row).
      expect(streaming).toHaveBeenCalledWith("thread1", true, undefined);
      await vi.advanceTimersByTimeAsync(130_000);
      expect(streaming.mock.calls.filter(([, , options]) => (options as { refresh?: boolean } | undefined)?.refresh)).toHaveLength(2);
      finish();
      await call;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(streaming.mock.calls.filter(([, , options]) => (options as { refresh?: boolean } | undefined)?.refresh)).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
    expect(new Set(workspaces)).toEqual(new Set(["ws1"]));
  });

  it("refuses callers OrgDO does not admit, other tenants, and agents without a thread", async () => {
    const denied = setup({ access: () => ({ ok: false, reason: "forbidden" }) });
    expect(await rt.callTool(denied.handler, MCP_URL, "list_projects", {}, ALICE))
      .toMatchObject({ isError: true, content: [{ text: "Forbidden (forbidden)" }] });
    expect(denied.tools).not.toHaveBeenCalled();

    const { handler, validate, tools } = setup();
    // The SDK refuses another tenant's token before any tool runs.
    await expect(rt.callTool(handler, MCP_URL, "list_projects", {}, { ...ALICE, tenant: "someone-else" })).rejects.toThrow();
    expect(await rt.callTool(handler, MCP_URL, "list_projects", {}, { ...ALICE, context: { org: "org1", workspace: "ws1" } }))
      .toMatchObject({ isError: true });
    expect(validate).not.toHaveBeenCalled();
    expect(tools).not.toHaveBeenCalled();
  });

  it("passes Pi file tool content blocks through, images included", async () => {
    const content = [
      { type: "text", text: "Read image file [image/png]" },
      { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
    ];
    const { handler } = setup({ result: { ok: true, data: { text: "Read image file [image/png]", content, details: { image: true } } } });
    expect(await rt.callTool(handler, MCP_URL, "read", { location: "workspace", path: "a.png" }, ALICE))
      .toEqual({ content, structuredContent: { image: true, text: "Read image file [image/png]" } });
  });

  it("gives code a read's text beside its details", async () => {
    const content = [{ type: "text", text: "line 1\nline 2" }];
    const { handler } = setup({ result: { ok: true, data: { content, details: { path: "a.txt", truncation: { truncated: false } } } } });
    expect(await rt.callTool(handler, MCP_URL, "read", { location: "workspace", path: "a.txt" }, ALICE))
      .toEqual({ content, structuredContent: { path: "a.txt", truncation: { truncated: false }, text: "line 1\nline 2" } });
  });

  it("gives code a read's text when it has no details, in the same shape", async () => {
    // A short file's read has no truncation details: code still gets { text }, not a bare string.
    const content = [{ type: "text", text: "line 1" }];
    const { handler } = setup({ result: { ok: true, data: { content } } });
    expect(await rt.callTool(handler, MCP_URL, "read", { location: "workspace", path: "a.txt" }, ALICE))
      .toEqual({ content, structuredContent: { text: "line 1" } });
  });

  it("returns tool failures as isError results", async () => {
    const { handler } = setup({ result: { ok: false, error: { message: "File not found" } } });
    expect(await rt.callTool(handler, MCP_URL, "read", { location: "workspace", path: "x" }, ALICE))
      .toEqual({ content: [{ type: "text", text: "File not found" }], isError: true });
  });

  it("shows screenshot data URLs as image content", async () => {
    const { handler } = setup({ result: { ok: true, data: { imageDataUrl: "data:image/png;base64,iVBORw0KGgo=", width: 800, height: 600 } } });
    expect(await rt.callTool(handler, MCP_URL, "browser_action", { session_id: "s", script_name: "app", method: "screenshot" }, ALICE))
      .toEqual({
        content: [
          { type: "text", text: '{"width":800,"height":600}' },
          { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
        ],
        structuredContent: { width: 800, height: 600 },
      });
  });

  it("confirms a destructive tool through the runtime before running it preconfirmed", async () => {
    const { handler, tools, callToolEnvelope } = setup({ result: { ok: true, data: { success: true, deleted: "shop" } } });
    const describe = vi.fn(async () => 'Delete deployed app "shop"?');
    tools.mockImplementation(() => ({ callToolEnvelope, describeDestructiveConfirmation: describe }));
    const call = async (extra: Record<string, unknown> = {}) => {
      const response = await handler(await rt.request(MCP_URL, {
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "delete_app", arguments: { script_name: "shop" }, ...extra },
      }, ALICE));
      return (await response.json() as { result: Record<string, unknown> }).result;
    };

    // First call: the question goes back as input_required; nothing is deleted.
    const asked = await call();
    expect(asked).toMatchObject({
      resultType: "input_required",
      inputRequests: { input_1: { method: "elicitation/create", params: { mode: "form", message: 'Delete deployed app "shop"?' } } },
    });
    expect(callToolEnvelope).not.toHaveBeenCalled();

    // Declined: still nothing deleted.
    expect(await call({ inputResponses: { input_1: { action: "decline" } } }))
      .toMatchObject({ structuredContent: { cancelled: true } });
    expect(callToolEnvelope).not.toHaveBeenCalled();

    // Accepted: the tool runs, preconfirmed so it skips the chat question.
    expect(await call({ inputResponses: { input_1: { action: "accept", content: {} } } }))
      .toMatchObject({ structuredContent: { success: true, deleted: "shop" } });
    expect(tools).toHaveBeenLastCalledWith(expect.objectContaining({ preconfirmed: true }));
    expect(callToolEnvelope).toHaveBeenCalledWith("delete_app", { script_name: "shop" });
  });

  it("refuses tools it does not serve", async () => {
    const { handler, tools } = setup();
    for (const name of ["AskUserQuestion", "WebFetch", "Agent", "warehouse_run_code"]) {
      await expect(rt.callTool(handler, MCP_URL, name, {}, ALICE)).rejects.toThrow(/Unknown tool/);
    }
    expect(tools).not.toHaveBeenCalled();
  });
});
