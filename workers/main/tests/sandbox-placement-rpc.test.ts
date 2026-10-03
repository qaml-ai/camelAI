// followSandboxGeneration against real workerd Durable Object stubs. Fake stubs
// hide what a real one does with `stub.method.apply(...)` (an RPC call named
// "apply"), so routing is checked here over real RPC.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { getProjectBuildSandbox } from "../src/project-build-sandbox-lifecycle";
import type { ProjectBuildContainer } from "../src/project-build-container";
import { sandboxGenerationName } from "../src/sandbox-placement";
import { projectBuildSandboxKey } from "../src/project-build-sandbox-lifecycle";

const testEnv = env as unknown as { PROJECT_BUILD_SANDBOX: DurableObjectNamespace<ProjectBuildContainer> };

describe("followSandboxGeneration over real DO RPC", () => {
  it("calls methods on a real stub, follows a relocation, and is not a thenable", async () => {
    const orgId = `rpc-${crypto.randomUUID()}`;
    const sandbox = getProjectBuildSandbox(testEnv, orgId) as unknown as ProjectBuildContainer;
    expect(await Promise.resolve(sandbox)).toBe(sandbox);

    // Generation 0 is current: the call runs there.
    await sandbox.noteBuildSessionActivity(1_000);

    const result = await sandbox.rotateSandboxPlacement({ fromGeneration: 0, reason: "test" });
    expect(result).toEqual({ generation: 1, rotated: true, limited: false });

    // Generation 0 now refuses, over real RPC, with the error the proxy follows.
    const base = projectBuildSandboxKey(orgId);
    const old = testEnv.PROJECT_BUILD_SANDBOX.getByName(base);
    const refused = await old.noteBuildSessionActivity(1_000).then(
      () => null,
      (error: unknown) => error,
    );
    expect(String(refused)).toContain("SandboxRelocatedError: the sandbox moved to generation 1");

    // A fresh routed stub lands on generation 1.
    await (getProjectBuildSandbox(testEnv, orgId) as unknown as ProjectBuildContainer).noteBuildSessionActivity(1_000);
    const current = testEnv.PROJECT_BUILD_SANDBOX.getByName(sandboxGenerationName(base, 1));
    await expect(current.noteBuildSessionActivity(1_000)).resolves.toBeUndefined();
  });
});
