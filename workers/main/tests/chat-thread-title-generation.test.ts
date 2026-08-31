import { afterEach, describe, expect, it, vi } from "vitest";

import { CHAT_GROUP_ICON_SELECTION_STRATEGY } from "../../../src/lib/chat-group-avatar-generation.server";
import { ChatThreadDO } from "../src/chat-thread-do";

function makeClaim() {
  return {
    id: "group1",
    name: "Database Migrations",
    avatar: {
      color: "#4F46E5",
      content: "messages-square",
      status: "pending" as const,
    },
    claimId: "claim1",
    claimedAt: 123,
    trigger: "first_title" as const,
  };
}

function createFakeThread(options: { iconFails?: boolean; aiMissing?: boolean } = {}) {
  const waitUntilPromises: Promise<unknown>[] = [];
  const order: string[] = [];
  let resolveClaim:
    | ((claim: ReturnType<typeof makeClaim>) => void)
    | null = null;
  const claimPromise = new Promise<ReturnType<typeof makeClaim>>((resolve) => {
    resolveClaim = resolve;
  });
  const aiRun = vi.fn(async (_model: string, input: { max_tokens?: number }) => {
    if (input.max_tokens === 50) {
      order.push("title-ai");
      return { choices: [{ message: { content: "database migrations" } }] };
    }
    order.push("icon-ai");
    if (options.iconFails) {
      throw new Error("icon unavailable");
    }
    return { choices: [{ message: { content: "database" } }] };
  });
  const orgStub = {
    updateThread: vi.fn(async () => {
      order.push("update-thread");
      return { updated_at: 123 };
    }),
  };
  const userStub = {
    renameEmptySingleThreadGroupForThread: vi.fn(async () => {
      order.push("rename-group");
    }),
    claimChatGroupAvatarGenerationForThread: vi.fn(() => {
      order.push("claim-icon");
      return claimPromise;
    }),
    setGeneratedChatGroupIcon: vi.fn(async () => {
      order.push("set-generated");
      return { color: "#4F46E5", content: "database", status: "generated" };
    }),
    markChatGroupAvatarGenerationFailed: vi.fn(async () => {
      order.push("mark-failed");
      return { color: "#4F46E5", content: "💬", status: "default" };
    }),
  };
  const fake = Object.create(ChatThreadDO.prototype) as any;
  fake.chatContext = {
    orgId: "org1",
    workspaceId: "workspace1",
    threadId: "thread1",
    userId: "user1",
  };
  fake.titleGenerationInFlight = true;
  fake.setTitle = vi.fn(async () => {
    order.push("set-title");
  });
  fake.broadcastChat = vi.fn((message: unknown) => {
    order.push("broadcast");
    return message;
  });
  fake.recordChatThreadObservabilityEvent = vi.fn();
  fake.ctx = {
    storage: {
      kv: {
        put: vi.fn(),
      },
    },
    waitUntil: vi.fn((promise: Promise<unknown>) => {
      order.push("wait-until");
      waitUntilPromises.push(promise);
    }),
  };
  fake.env = {
    CF_GATEWAY_NAME: "gw_1",
    AI: options.aiMissing ? undefined : { run: aiRun },
    ORG: {
      idFromName: vi.fn((id: string) => id),
      get: vi.fn(() => orgStub),
    },
    USER: {
      idFromName: vi.fn((id: string) => id),
      get: vi.fn(() => userStub),
    },
  };

  return {
    fake,
    order,
    aiRun,
    orgStub,
    userStub,
    waitUntilPromises,
    resolveClaim: resolveClaim!,
  };
}

describe("ChatThreadDO title generation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renames the group before scheduling generated icon work", async () => {
    const {
      fake,
      order,
      aiRun,
      orgStub,
      userStub,
      waitUntilPromises,
      resolveClaim,
    } = createFakeThread();

    await ChatThreadDO.prototype["generateThreadTitleFromMessage"].call(
      fake,
      "thread1",
      "help me plan database migrations",
    );

    expect(orgStub.updateThread).toHaveBeenCalledWith(
      "thread1",
      "Database Migrations",
    );
    expect(fake.setTitle).toHaveBeenCalledWith("Database Migrations", 123);
    expect(userStub.renameEmptySingleThreadGroupForThread).toHaveBeenCalledWith(
      "thread1",
      "Database Migrations",
    );
    expect(fake.titleGenerationInFlight).toBe(false);
    expect(waitUntilPromises).toHaveLength(1);
    expect(aiRun).toHaveBeenCalledTimes(1);
    expect(order.indexOf("rename-group")).toBeLessThan(
      order.indexOf("wait-until"),
    );

    resolveClaim(makeClaim());
    await Promise.all(waitUntilPromises);

    expect(aiRun).toHaveBeenCalledTimes(2);
    expect(userStub.setGeneratedChatGroupIcon).toHaveBeenCalledWith(
      "group1",
      "claim1",
      "database",
    );
    expect(fake.recordChatThreadObservabilityEvent).toHaveBeenCalledWith(
      "chat_group_icon_generation",
      expect.objectContaining({
        operation: `${CHAT_GROUP_ICON_SELECTION_STRATEGY}:first_title`,
        status: "metadata_match",
      }),
    );
    expect(fake.broadcastChat).toHaveBeenNthCalledWith(1, {
      type: "chat_group_avatar_updated",
      threadId: "thread1",
      groupId: "group1",
      avatar: { color: "#4F46E5", content: "messages-square", status: "pending" },
    });
    expect(fake.broadcastChat).toHaveBeenNthCalledWith(2, {
      type: "chat_group_avatar_updated",
      threadId: "thread1",
      groupId: "group1",
      avatar: { color: "#4F46E5", content: "database", status: "generated" },
    });
  });

  it("leaves the default avatar after icon generation failure without blocking title naming", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const {
      fake,
      aiRun,
      userStub,
      waitUntilPromises,
      resolveClaim,
    } = createFakeThread({ iconFails: true });

    await ChatThreadDO.prototype["generateThreadTitleFromMessage"].call(
      fake,
      "thread1",
      "help me plan database migrations",
    );

    expect(fake.titleGenerationInFlight).toBe(false);
    expect(aiRun).toHaveBeenCalledTimes(1);

    resolveClaim(makeClaim());
    await Promise.all(waitUntilPromises);

    expect(userStub.setGeneratedChatGroupIcon).not.toHaveBeenCalled();
    expect(userStub.markChatGroupAvatarGenerationFailed).toHaveBeenCalledWith(
      "group1",
      "claim1",
    );
    expect(fake.recordChatThreadObservabilityEvent).toHaveBeenCalledWith(
      "chat_group_icon_generation",
      expect.objectContaining({
        operation: `${CHAT_GROUP_ICON_SELECTION_STRATEGY}:first_title`,
        status: "ai_error",
      }),
    );
    expect(fake.broadcastChat).toHaveBeenLastCalledWith({
      type: "chat_group_avatar_updated",
      threadId: "thread1",
      groupId: "group1",
      avatar: { color: "#4F46E5", content: "💬", status: "default" },
    });
  });

  it("generates an accessed thread group avatar and broadcasts pending before final", async () => {
    const {
      fake,
      aiRun,
      userStub,
      resolveClaim,
    } = createFakeThread();

    const task = ChatThreadDO.prototype[
      "maybeGenerateChatGroupAvatarForThread"
    ].call(fake, "thread1");

    expect(userStub.claimChatGroupAvatarGenerationForThread).toHaveBeenCalledWith(
      "thread1",
    );
    resolveClaim(makeClaim());
    await task;

    expect(aiRun).toHaveBeenCalledTimes(1);
    expect(userStub.setGeneratedChatGroupIcon).toHaveBeenCalledWith(
      "group1",
      "claim1",
      "database",
    );
    expect(fake.broadcastChat).toHaveBeenNthCalledWith(1, {
      type: "chat_group_avatar_updated",
      threadId: "thread1",
      groupId: "group1",
      avatar: { color: "#4F46E5", content: "messages-square", status: "pending" },
    });
    expect(fake.broadcastChat).toHaveBeenNthCalledWith(2, {
      type: "chat_group_avatar_updated",
      threadId: "thread1",
      groupId: "group1",
      avatar: { color: "#4F46E5", content: "database", status: "generated" },
    });
  });

  it("broadcasts the actual user avatar when a generated completion loses its claim", async () => {
    const { fake, userStub, resolveClaim } = createFakeThread();
    userStub.setGeneratedChatGroupIcon.mockResolvedValueOnce({
      color: "#E0476B",
      content: "sparkles",
      status: "user",
    });

    const task = ChatThreadDO.prototype[
      "maybeGenerateChatGroupAvatarForThread"
    ].call(fake, "thread1");
    resolveClaim(makeClaim());
    await task;

    expect(fake.broadcastChat).toHaveBeenLastCalledWith({
      type: "chat_group_avatar_updated",
      threadId: "thread1",
      groupId: "group1",
      avatar: { color: "#E0476B", content: "sparkles", status: "user" },
    });
    expect(fake.recordChatThreadObservabilityEvent).toHaveBeenCalledWith(
      "chat_group_icon_generation",
      expect.objectContaining({ status: "claim_lost" }),
    );
  });

  it("generates a chat group avatar from explicit app-side thread context", async () => {
    const {
      fake,
      userStub,
      resolveClaim,
    } = createFakeThread();
    fake.chatContext = null;

    const task = ChatThreadDO.prototype[
      "generateChatGroupAvatarForThread"
    ].call(fake, {
      threadId: "thread1",
      workspaceId: "workspace1",
      orgId: "org1",
      userId: "user1",
    });

    expect(userStub.claimChatGroupAvatarGenerationForThread).toHaveBeenCalledWith(
      "thread1",
      "first_title",
    );
    resolveClaim(makeClaim());
    await task;

    expect(fake.ctx.storage.kv.put).toHaveBeenCalledWith(
      "chatContext",
      expect.objectContaining({
        threadId: "thread1",
        workspaceId: "workspace1",
        orgId: "org1",
        userId: "user1",
      }),
    );
    expect(fake.broadcastChat).toHaveBeenLastCalledWith({
      type: "chat_group_avatar_updated",
      threadId: "thread1",
      groupId: "group1",
      avatar: { color: "#4F46E5", content: "database", status: "generated" },
    });
  });

  it("skips accessed thread avatar generation without claiming when AI is missing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { fake, userStub, aiRun } = createFakeThread({ aiMissing: true });

    await ChatThreadDO.prototype[
      "maybeGenerateChatGroupAvatarForThread"
    ].call(fake, "thread1");

    expect(userStub.claimChatGroupAvatarGenerationForThread).not.toHaveBeenCalled();
    expect(userStub.setGeneratedChatGroupIcon).not.toHaveBeenCalled();
    expect(userStub.markChatGroupAvatarGenerationFailed).not.toHaveBeenCalled();
    expect(fake.broadcastChat).not.toHaveBeenCalled();
    expect(aiRun).not.toHaveBeenCalled();
  });

  it("does not run accessed thread avatar generation without complete user context", async () => {
    const { fake, userStub } = createFakeThread();
    fake.chatContext = {
      orgId: "org1",
      workspaceId: "workspace1",
      threadId: "thread1",
      userId: null,
    };

    await ChatThreadDO.prototype[
      "maybeGenerateChatGroupAvatarForThread"
    ].call(fake, "thread1");

    expect(userStub.claimChatGroupAvatarGenerationForThread).not.toHaveBeenCalled();
    expect(fake.broadcastChat).not.toHaveBeenCalled();
  });
});
