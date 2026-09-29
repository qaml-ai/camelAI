/**
 * Runtime threads' metadata work outside ChatThreadDO (agent-runtime/thread-metadata.ts).
 *
 * Run with: bun run test:workers
 */
import { describe, expect, it, vi } from "vitest";
import { generateRuntimeThreadGroupAvatar } from "../src/agent-runtime/thread-metadata";

describe("generateRuntimeThreadGroupAvatar", () => {
  it("claims the group avatar for the thread's first title as its creator", async () => {
    const claimChatGroupAvatarGenerationForThread = vi.fn(async () => null);
    const env = {
      AI: { run: vi.fn() },
      USER: { idFromName: (name: string) => name, get: (id: string) => (id === "u1" ? { claimChatGroupAvatarGenerationForThread } : null) },
    };
    await generateRuntimeThreadGroupAvatar(env, { orgId: "org1", workspaceId: "ws1", threadId: "t1", userId: "u1", userName: null, userEmail: null });
    expect(claimChatGroupAvatarGenerationForThread).toHaveBeenCalledWith("t1", "first_title");
    expect(env.AI.run).not.toHaveBeenCalled();
  });
});
