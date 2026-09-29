import { beforeAll, describe, expect, it, vi } from "vitest";
import { testRuntime, type TestIdentity } from "@camelai/agent-runtime/testing";

const { forward } = vi.hoisted(() => ({ forward: vi.fn() }));
vi.mock("../src/agent-runtime/thread-runtime.js", () => ({ forwardRuntimeThreadCodexCall: forward }));

import { handleAgentRuntimeLlmRequest } from "../src/routes/agent-runtime-llm";
import type { Env } from "../src/types";

const BASE = "https://camel.test/agent-runtime/llm";
const URL_ = `${BASE}/openai-codex/codex/responses`;
const ALICE: TestIdentity = { tenant: "chiridion", subject: "user1", actor: "user2", context: { org: "org1", workspace: "ws1", thread: "thread1" } };
const BODY = { model: "anthropic/claude-sonnet-5", stream: true, input: [] };

let rt: Awaited<ReturnType<typeof testRuntime>>;
beforeAll(async () => {
  rt = await testRuntime();
});

function setup(member = true) {
  const completion = forward;
  completion.mockReset();
  completion.mockImplementation(async () => new Response("data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } }));
  const env = {
    AGENT_RUNTIME_URL: rt.url,
    AGENT_RUNTIME_TENANT: "chiridion",
    ORG: {
      idFromName: (name: string) => name,
      get: () => ({
        validateChatWebSocketAccess: async (_user: string, workspaceId: string, threadId: string) => member
          ? { ok: true, orgId: "org1", orgSlug: "o", workspaceId, threadId }
          : { ok: false, reason: "forbidden" },
      }),
    },
  } as unknown as Env;
  return { env, completion };
}

async function post(env: Env, audience: string, identity: TestIdentity = ALICE) {
  const token = await rt.token(identity, audience);
  return handleAgentRuntimeLlmRequest(new Request(URL_, {
    method: "POST",
    // The runtime's Pi client also puts the token where the provider's key goes; the identity header is what counts.
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "X-Agent-Runtime-Identity": token },
    body: JSON.stringify(BODY),
  }), env, { fetch: rt.fetch });
}

describe("agent runtime inference proxy", () => {
  it("answers 503 without a runtime tenant to check tokens against", async () => {
    const { env, completion } = setup();
    expect((await post({ ...env, AGENT_RUNTIME_TENANT: "" } as Env, BASE)).status).toBe(503);
    expect(completion).not.toHaveBeenCalled();
  });

  it("forwards the call as the thread's acting user", async () => {
    const { env, completion } = setup();
    const response = await post(env, BASE);
    expect(response.status).toBe(200);
    expect(completion).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ provider: "openai-codex", path: "codex/responses", method: "POST", body: expect.any(ArrayBuffer) }),
      { orgId: "org1", workspaceId: "ws1", threadId: "thread1", userId: "user2" },
    );
  });

  it("refuses bad tokens, other tenants and non-members before touching the thread", async () => {
    const { env, completion } = setup();
    expect((await post(env, "https://camel.test/mcp/agent")).status).toBe(401);
    expect((await post(env, URL_)).status).toBe(401);
    expect((await post(env, BASE, { ...ALICE, tenant: "other" })).status).toBe(401);
    const denied = setup(false);
    expect((await post(denied.env, BASE)).status).toBe(403);
    const unsigned = await handleAgentRuntimeLlmRequest(new Request(URL_, { method: "POST", body: "{}" }), env, { fetch: rt.fetch });
    expect(unsigned.status).toBe(401);
    expect(await unsigned.json()).toMatchObject({ error: { code: "invalid_token" } });
    // Only the identity header counts, not the provider key slot.
    const keySlotOnly = await handleAgentRuntimeLlmRequest(new Request(URL_, {
      method: "POST",
      headers: { Authorization: `Bearer ${await rt.token(ALICE, BASE)}` },
      body: JSON.stringify(BODY),
    }), env, { fetch: rt.fetch });
    expect(keySlotOnly.status).toBe(401);
    expect(completion).not.toHaveBeenCalled();
    expect(denied.completion).not.toHaveBeenCalled();
  });
});
