/**
 * Analytics Engine events of the runtime's MCP route (/mcp/agent): one
 * `agent_mcp_call` per tool call with its outcome and duration, and
 * `agent_mcp_auth_failed` when a request's runtime token is refused.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { testRuntime, type TestIdentity } from "@camelai/run/testing";

import { agentMcpHandler, type ToolsFactory } from "../src/routes/agent-mcp";
import type { Env } from "../src/types";

const MCP_URL = "https://camel.test/mcp/agent";
const ALICE: TestIdentity = { tenant: "chiridion", subject: "user1", context: { org: "org1", workspace: "ws1", thread: "thread1" } };

let rt: Awaited<ReturnType<typeof testRuntime>>;
beforeAll(async () => {
  rt = await testRuntime();
});

type Envelope = Awaited<ReturnType<ReturnType<ToolsFactory>["callToolEnvelope"]>>;
type Point = { blobs: string[]; doubles: number[] };

function setup(options: { denied?: boolean; result?: Envelope | (() => Promise<Envelope>) } = {}) {
  const points: Point[] = [];
  const env = {
    AGENT_RUNTIME_URL: rt.url,
    AGENT_RUNTIME_TENANT: "chiridion",
    OBSERVABILITY_EVENTS: { writeDataPoint: (point: Point) => points.push(point) },
    ORG: {
      idFromName: (name: string) => name,
      get: () => ({
        validateChatWebSocketAccess: async (_user: string, workspaceId: string, threadId: string) => options.denied
          ? { ok: false, reason: "forbidden" }
          : { ok: true, orgId: "org1", orgSlug: "org1", workspaceId, threadId },
      }),
    },
  } as unknown as Env;
  const result = options.result ?? { ok: true, data: { projects: [] } };
  const callToolEnvelope = vi.fn(typeof result === "function" ? result : async () => result);
  const handler = agentMcpHandler(env, () => ({ callToolEnvelope, describeDestructiveConfirmation: async () => null }), { fetch: rt.fetch });
  const events = (name: string) => points.filter((point) => point.blobs[0] === name);
  return { handler, events };
}

describe("agent MCP telemetry", () => {
  it("records each tool call: its tool, outcome, duration and thread", async () => {
    const { handler, events } = setup();
    await rt.callTool(handler, MCP_URL, "list_projects", {}, ALICE);
    const [call] = events("agent_mcp_call");
    expect(call.blobs[2]).toBe("agent_mcp");
    expect(call.blobs[3]).toBe("list_projects");
    expect(call.blobs[4]).toBe("ok");
    expect([call.blobs[8], call.blobs[9], call.blobs[10], call.blobs[11]]).toEqual(["thread1", "ws1", "org1", "user1"]);
    expect(call.doubles[1]).toBeGreaterThanOrEqual(0);
  });

  it("records failed, refused and thrown calls, never the tool's output", async () => {
    const failed = setup({ result: { ok: false, error: { message: "File not found: secret.txt" } } });
    await rt.callTool(failed.handler, MCP_URL, "read", { location: "workspace", path: "secret.txt" }, ALICE);
    expect(failed.events("agent_mcp_call").map((point) => point.blobs[4])).toEqual(["error"]);
    expect(JSON.stringify(failed.events("agent_mcp_call"))).not.toContain("secret.txt");

    const denied = setup({ denied: true });
    await rt.callTool(denied.handler, MCP_URL, "list_projects", {}, ALICE);
    expect(denied.events("agent_mcp_call").map((point) => point.blobs[4])).toEqual(["forbidden"]);

    const thrown = setup({ result: async () => { throw new Error("binding exploded"); } });
    await rt.callTool(thrown.handler, MCP_URL, "list_projects", {}, ALICE).catch(() => {});
    const [call] = thrown.events("agent_mcp_call");
    expect(call.blobs[4]).toBe("exception");
    expect(call.blobs[15]).toBe("Error");
  });

  it("records requests whose runtime token is refused", async () => {
    const { handler, events } = setup();
    const list = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    expect((await handler(await rt.request(MCP_URL, list, null))).status).toBe(401);
    const response = await handler(new Request(MCP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${await rt.token(ALICE, "https://elsewhere.test/mcp")}` },
      body: JSON.stringify(list),
    }));
    expect(response.status).toBe(401);
    const refused = events("agent_mcp_auth_failed");
    expect(refused).toHaveLength(2);
    expect(refused.map((point) => point.blobs[2])).toEqual(["agent_mcp", "agent_mcp"]);
    expect(refused.map((point) => point.doubles[2])).toEqual([401, 401]);
    expect(refused[0].blobs[4]).toBe("no_token");
    expect(refused[1].blobs[4]).toBe("invalid_token");
    // Answering with the list itself is not a failure.
    await handler(await rt.request(MCP_URL, list, ALICE));
    expect(events("agent_mcp_auth_failed")).toHaveLength(2);
  });
});
