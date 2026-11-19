import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { CAMEL_CODE_LLM_MODEL } from "../../../src/lib/llm-provider-config";
import type { LlmModel } from "../../../src/types";
import { CAMEL_CODE_RUNTIME_MODEL, FREE_TIER_RUNTIME_MODEL, PREVIOUS_AZURE_CAMEL_CODE_RUNTIME_MODEL } from "../src/agent-runtime/model-routes";
import { RUNTIME_PROMPT_VERSION } from "../src/agent-runtime/runtime-prompt";
import type { OrgDO } from "../src/identity/org-do";
import { createOrg, createUser, type TestEnv } from "./test-helpers";

const testEnv = env as unknown as TestEnv;
const bindings = {
  WORKER_BASE_URL: "https://camelai.dev",
  AGENT_RUNTIME_V2_WORKSPACE: "all",
  AGENT_RUNTIME_V2_ADDITIONAL_MODELS: CAMEL_CODE_RUNTIME_MODEL,
  AGENT_RUNTIME_V2_API_TOKEN: "synthetic-tenant",
};
const old = PREVIOUS_AZURE_CAMEL_CODE_RUNTIME_MODEL;
const configured = { promptVersion: RUNTIME_PROMPT_VERSION, thinkingLevel: "high", retained: true };

function withRuntime<T>(stub: DurableObjectStub<OrgDO>, run: (org: OrgDO) => Promise<T>): Promise<T> {
  return runInDurableObject(stub, async (org) => {
    const workerEnv = (org as unknown as { env: Record<string, string> }).env;
    const previous = Object.fromEntries(Object.keys(bindings).map((key) => [key, workerEnv[key]]));
    Object.assign(workerEnv, bindings);
    try {
      return await run(org);
    } finally {
      Object.assign(workerEnv, previous);
      vi.restoreAllMocks();
    }
  });
}

async function fixture() {
  const { userId } = await createUser(testEnv, `sol-${crypto.randomUUID()}@example.com`, "password123", "Synthetic user");
  const { org, defaultWorkspaceId } = await createOrg(testEnv, "Synthetic org", userId);
  const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
  async function chat(options: {
    version?: "v1" | "v2";
    channel?: boolean;
    scheduled?: boolean;
    keyScope?: string;
    backing?: string;
    product?: LlmModel;
  } = {}) {
    const thread = await orgStub.createThread(
      defaultWorkspaceId as string, "Synthetic chat", userId, undefined, options.product ?? CAMEL_CODE_LLM_MODEL,
      options.channel ? { source: "channel", channelKind: "slack" } : options.scheduled ? { source: "scheduled" } : {},
    );
    if (options.version) {
      await orgStub.pinThreadRuntime(thread.id, null, options.version);
      await orgStub.setThreadRuntimeAgent(thread.id, {
        agentId: `agent-${thread.id}`,
        keyScope: options.keyScope ?? "hosted",
        model: options.backing ?? old,
        configured,
      });
    }
    return thread;
  }
  return { orgStub, chat };
}

describe("idle camelCode backing model migration", () => {
  it("keeps a running turn, then changes only the existing agent model", async () => {
    const { orgStub, chat } = await fixture();
    const thread = await chat({ version: "v2" });
    await withRuntime(orgStub, async (org) => {
      const patch = vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(Response.json({ error: { code: "agent_busy" } }, { status: 409 }))
        .mockResolvedValueOnce(Response.json({ model: CAMEL_CODE_RUNTIME_MODEL, changed: true }));
      expect(await org.moveCamelCodeThreadToSol(thread.id)).toEqual({ status: "candidate" });
      expect(patch).not.toHaveBeenCalled();
      expect(await org.moveCamelCodeThreadToSol(thread.id, true)).toEqual({ status: "agent_busy" });
      expect(org.getThreadRuntime(thread.id)).toMatchObject({ model: old, configured });
      expect(await org.moveCamelCodeThreadToSol(thread.id, true)).toEqual({ status: "moved" });
      const [address, init] = patch.mock.calls[1];
      expect(new URL(String(address)).pathname).toBe(`/v2/agents/agent-${thread.id}/model`);
      expect(init?.method).toBe("PATCH");
      expect(JSON.parse(String(init?.body))).toEqual({ model: CAMEL_CODE_RUNTIME_MODEL, expectedModel: old });
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer synthetic-tenant");
      expect(org.getThreadRuntime(thread.id)).toMatchObject({
        agentId: `agent-${thread.id}`, keyScope: "hosted", runtimeVersion: "v2",
        model: CAMEL_CODE_RUNTIME_MODEL, configured: { ...configured, thinkingLevel: "low" },
      });
      expect(org.getThread(thread.id)).toMatchObject({ model: CAMEL_CODE_LLM_MODEL });
      expect(await org.moveCamelCodeThreadToSol(thread.id, true)).toEqual({ status: "already_sol" });
      expect(patch).toHaveBeenCalledTimes(2);
    });
  });

  it("reconciles the app after the runtime changed earlier, and respects another model replacement", async () => {
    const { orgStub, chat } = await fixture();
    const thread = await chat({ version: "v2" });
    await withRuntime(orgStub, async (org) => {
      const patch = vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(Response.json({ error: { code: "model_changed" } }, { status: 409 }))
        .mockResolvedValueOnce(Response.json({ error: { code: "runtime_error" } }, { status: 502 }))
        .mockResolvedValueOnce(Response.json({ model: CAMEL_CODE_RUNTIME_MODEL, changed: false }));
      expect(await org.moveCamelCodeThreadToSol(thread.id, true)).toEqual({ status: "model_changed" });
      expect(org.getThreadRuntime(thread.id)).toMatchObject({ model: old });
      expect(await org.moveCamelCodeThreadToSol(thread.id, true)).toEqual({ status: "reconciled" });
      expect(org.getThreadRuntime(thread.id)).toMatchObject({ model: CAMEL_CODE_RUNTIME_MODEL });
      expect(patch).toHaveBeenCalledTimes(3);
    });
  });

  it("inventories exact hosted camelCode choices and leaves paid and BYOK placements alone", async () => {
    const { orgStub, chat } = await fixture();
    const web = await chat({ version: "v1" });
    const channel = await chat({ version: "v1", channel: true });
    const legacy = await chat();
    const luna = await chat({ version: "v2", backing: FREE_TIER_RUNTIME_MODEL });
    const paid = await chat({ version: "v2", product: "gpt-6-luna", backing: FREE_TIER_RUNTIME_MODEL });
    const byok = await chat({ version: "v2", keyScope: "org_scoped" });
    const first = await orgStub.listCamelCodeModelMigrationThreads(null, 2);
    const rest = await orgStub.listCamelCodeModelMigrationThreads(first[1].thread_id, 2);
    expect([...first, ...rest].map((row) => row.thread_id)).toEqual([web.id, channel.id, legacy.id, luna.id].sort());
    await withRuntime(orgStub, async (org) => {
      const patch = vi.spyOn(globalThis, "fetch");
      expect(await org.moveCamelCodeThreadToSol(web.id, true)).toEqual({ status: "needs_v1_handoff" });
      expect(await org.moveCamelCodeThreadToSol(channel.id, true)).toEqual({ status: "v1_channel" });
      expect(await org.moveCamelCodeThreadToSol(legacy.id, true)).toEqual({ status: "needs_legacy_handoff" });
      expect(await org.moveCamelCodeThreadToSol(luna.id)).toEqual({ status: "candidate" });
      expect(await org.moveCamelCodeThreadToSol(paid.id, true)).toEqual({ status: "ineligible" });
      expect(await org.moveCamelCodeThreadToSol(byok.id, true)).toEqual({ status: "ineligible" });
      expect(patch).not.toHaveBeenCalled();
    });
  });

  it("keeps scheduled chats on their existing runtime while allowing a v2 model-only change", async () => {
    const { orgStub, chat } = await fixture();
    const local = await chat({ scheduled: true });
    const v1 = await chat({ scheduled: true, version: "v1" });
    const v2 = await chat({ scheduled: true, version: "v2" });
    await withRuntime(orgStub, async (org) => {
      const patch = vi.spyOn(globalThis, "fetch");
      expect(await org.moveCamelCodeThreadToSol(local.id, true)).toEqual({ status: "scheduled_handoff" });
      expect(await org.moveCamelCodeThreadToSol(v1.id, true)).toEqual({ status: "scheduled_handoff" });
      expect(await org.moveCamelCodeThreadToSol(v2.id)).toEqual({ status: "candidate" });
      expect(patch).not.toHaveBeenCalled();
    });
  });

  it("serializes a same-thread picker change while other chats continue", async () => {
    const { orgStub, chat } = await fixture();
    const thread = await chat({ version: "v2", backing: FREE_TIER_RUNTIME_MODEL });
    const other = await chat({ version: "v2" });
    await withRuntime(orgStub, async (org) => {
      const reply = Promise.withResolvers<Response>();
      vi.spyOn(globalThis, "fetch").mockReturnValueOnce(reply.promise);
      const upgraded = org.moveCamelCodeThreadToSol(thread.id, true);
      const userSelection = org.updateThreadModel(thread.id, "gpt-6-luna");
      expect((await org.updateThreadModel(other.id, "gpt-6-luna"))?.model).toBe("gpt-6-luna");
      expect(org.getThread(thread.id)?.model).toBe(CAMEL_CODE_LLM_MODEL);
      reply.resolve(Response.json({ model: CAMEL_CODE_RUNTIME_MODEL, changed: true }));
      expect(await upgraded).toEqual({ status: "moved" });
      expect((await userSelection)?.model).toBe("gpt-6-luna");
      expect(org.getThreadRuntime(thread.id)?.model).toBe(CAMEL_CODE_RUNTIME_MODEL);
    });
  });
});
