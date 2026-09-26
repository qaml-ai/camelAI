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
    const body = await response.json() as { result: { tools: Array<{ name: string; inputSchema: { type?: string } }> } };
    const names = body.result.tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining([
      "list_projects", "list_apps", "read", "write",
      // UI-state tools reach the thread's DO by RPC.
      "TodoWrite", "set_preview", "set_app_visibility", "deploy_project", "run_notebook",
      // js_exec's binding-only capabilities as tools.
      "connections_query", "connections_invoke", "browser_launch", "browser_action",
      "generate_image", "transcribe_audio", "http_request",
    ]));
    for (const excluded of [
      "AskUserQuestion", "prompt_connection_setup", "delete_app", "delete_project", "delete_connection",
      "WebSearch", "WebFetch", "Agent", "Explore", "warehouse_run_code", "warehouse_list_connections",
    ]) expect(names).not.toContain(excluded);
    expect(names).toEqual([...AGENT_MCP_TOOL_NAMES].filter((name) => names.includes(name)));
    expect(new Set(names)).toEqual(AGENT_MCP_TOOL_NAMES);
    for (const tool of body.result.tools) expect(tool.inputSchema.type).toBe("object");
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

  it("refuses callers OrgDO does not admit, other tenants, and agents without a thread", async () => {
    const denied = setup({ access: () => ({ ok: false, reason: "forbidden" }) });
    expect(await rt.callTool(denied.handler, MCP_URL, "list_projects", {}, ALICE))
      .toMatchObject({ isError: true, content: [{ text: "Forbidden (forbidden)" }] });
    expect(denied.tools).not.toHaveBeenCalled();

    const { handler, validate, tools } = setup();
    expect(await rt.callTool(handler, MCP_URL, "list_projects", {}, { ...ALICE, tenant: "someone-else" }))
      .toMatchObject({ isError: true });
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
      .toEqual({ content, structuredContent: { image: true } });
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

  it("refuses tools it does not serve", async () => {
    const { handler, tools } = setup();
    for (const name of ["AskUserQuestion", "delete_project", "WebFetch", "Agent", "warehouse_run_code"]) {
      await expect(rt.callTool(handler, MCP_URL, name, {}, ALICE)).rejects.toThrow(/Unknown tool/);
    }
    expect(tools).not.toHaveBeenCalled();
  });
});
