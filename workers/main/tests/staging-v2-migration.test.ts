import { describe, expect, it, vi } from "vitest";
import { CAMEL_CODE_LLM_MODEL } from "../../../src/lib/llm-provider-config";
import { StagingV2Migration } from "../src/agent-runtime/staging-v2-migration";

function migrationWithThread(model: string, agentId: string | null) {
  const org = {
    getThread: () => ({ model, workspace_id: "workspace", source: "web" }),
    getThreadRuntime: () => agentId ? { agentId, keyScope: "hosted" } : null,
    publishV1ThreadInV2: vi.fn(),
  };
  const migration = Object.create(StagingV2Migration.prototype) as StagingV2Migration;
  Object.defineProperty(migration, "env", { value: {
    ORG: { idFromName: (name: string) => name, get: () => org },
  } });
  return { migration, org };
}

const expectedThreadModel = CAMEL_CODE_LLM_MODEL;

describe("legacy handoff model selection", () => {
  it("refuses the v1 publication if the picker changed after the workspace was prepared", async () => {
    const { migration, org } = migrationWithThread("gpt-6-luna", "client-original");
    await expect(migration.moveIdleV1Thread("org", "thread", {
      phase: "publish", fencedAgentId: "client-original", expectedThreadModel,
    })).resolves.toEqual({ status: "source_changed" });
    expect(org.publishV1ThreadInV2).not.toHaveBeenCalled();
  });

  it("refuses a legacy copy whose picker changed after inspection", async () => {
    const { migration } = migrationWithThread("gpt-6-luna", null);
    await expect(migration.moveLegacyThread("org", "thread", false, { expectedThreadModel }))
      .resolves.toEqual({ status: "source_changed" });
    await expect(migration.moveLegacyThread("org", "thread", false))
      .resolves.toEqual({ status: "workspace_disabled" });
  });

  it("continues eligibility checks when the selection still matches", async () => {
    const { migration } = migrationWithThread(CAMEL_CODE_LLM_MODEL, "client-original");
    await expect(migration.moveIdleV1Thread("org", "thread", { phase: "inspect", expectedThreadModel }))
      .resolves.toEqual({ status: "workspace_disabled" });
  });
});
