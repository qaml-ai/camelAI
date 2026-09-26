import { beforeAll, describe, expect, it, vi } from "vitest";
import { testRuntime, type TestIdentity } from "@camelai/agent-runtime/testing";

import { handleAgentRuntimeLlmRequest } from "../src/routes/agent-runtime-llm";
import type { Env } from "../src/types";

const BASE = "https://camel.test/agent-runtime/llm/v1";
const URL_ = `${BASE}/chat/completions`;
const ALICE: TestIdentity = { tenant: "chiridion", subject: "user1", actor: "user2", context: { org: "org1", workspace: "ws1", thread: "thread1" } };
const BODY = { model: "chiridion", stream: true, messages: [{ role: "user", content: "hi" }] };

let rt: Awaited<ReturnType<typeof testRuntime>>;
beforeAll(async () => {
  rt = await testRuntime();
});

function setup(member = true) {
  const completion = vi.fn(async () => new Response("data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } }));
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
    CHAT_THREAD: {
      idFromName: (name: string) => name,
      get: (id: string) => ({ runtimeChatCompletion: (body: unknown, caller: unknown) => completion(id, body, caller) }),
    },
  } as unknown as Env;
  return { env, completion };
}

async function post(env: Env, audience: string, identity: TestIdentity = ALICE) {
  const token = await rt.token(identity, audience);
  return handleAgentRuntimeLlmRequest(new Request(URL_, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(BODY),
  }), env, { fetch: rt.fetch });
}

describe("agent runtime inference proxy", () => {
  it("runs the call in the thread's DO as the acting user", async () => {
    const { env, completion } = setup();
    const response = await post(env, BASE);
    expect(response.status).toBe(200);
    expect(completion).toHaveBeenCalledWith("thread1", BODY, { orgId: "org1", workspaceId: "ws1", threadId: "thread1", userId: "user2" });
    expect((await post(env, URL_)).status).toBe(200);
  });

  it("refuses bad tokens, other tenants and non-members before touching the thread", async () => {
    const { env, completion } = setup();
    expect((await post(env, "https://camel.test/mcp/agent")).status).toBe(401);
    expect((await post(env, BASE, { ...ALICE, tenant: "other" })).status).toBe(403);
    const denied = setup(false);
    expect((await post(denied.env, BASE)).status).toBe(403);
    const unsigned = await handleAgentRuntimeLlmRequest(new Request(URL_, { method: "POST", body: "{}" }), env, { fetch: rt.fetch });
    expect(unsigned.status).toBe(401);
    expect(await unsigned.json()).toMatchObject({ error: { code: "invalid_token" } });
    expect(completion).not.toHaveBeenCalled();
    expect(denied.completion).not.toHaveBeenCalled();
  });
});
