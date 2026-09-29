import { beforeEach, describe, expect, it, vi } from "vitest";

const waitUntilMock = vi.fn();
const requireSessionWorkspaceAccessMock = vi.fn();
const getEnvMock = vi.fn();
const getAuthEnvMock = vi.fn();
const createThreadMock = vi.fn();
const deleteThreadMock = vi.fn();
const generateThreadTitleMock = vi.fn();
const createGroupForNewThreadMock = vi.fn();
const addThreadToExistingGroupMock = vi.fn();

vi.mock("@/lib/wait-until", () => ({
  waitUntil: waitUntilMock,
}));

vi.mock("@/lib/auth.server", () => ({
  requireSessionWorkspaceAccess: requireSessionWorkspaceAccessMock,
}));

vi.mock("@/lib/cloudflare.server", () => ({
  getEnv: getEnvMock,
}));

vi.mock("@/lib/auth-helpers", () => ({
  getAuthEnv: getAuthEnvMock,
}));

vi.mock("@/lib/auth-do", () => ({
  getWorkerScript: vi.fn(),
}));

vi.mock("@/lib/chat-do.server", () => ({
  createThread: createThreadMock,
  deleteThread: deleteThreadMock,
  generateThreadTitle: generateThreadTitleMock,
  setThreadPreviewTarget: vi.fn(),
}));

// New threads are pinned to the agent runtime as they are made.
vi.mock("@/lib/runtime-threads.server", () => ({
  pinNewWebThread: vi.fn(async () => ({ threadId: "thread_123", agentId: null, model: null, keyScope: null, configured: null, createdAt: 1, updatedAt: 1 })),
}));

vi.mock("@/lib/chat-groups.server", () => ({
  addThreadToExistingGroup: addThreadToExistingGroupMock,
  createGroupForNewThread: createGroupForNewThreadMock,
}));

const route = await import("@/routes/api/workspaces.$id.chat.threads");

describe("workspace chat threads API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireSessionWorkspaceAccessMock.mockResolvedValue({
      session: { workspace_id: "ws_1" },
      orgId: "org_1",
      workspaceId: "ws_1",
      userId: "user_1",
    });
    getEnvMock.mockReturnValue({});
    getAuthEnvMock.mockReturnValue({});
    createThreadMock.mockResolvedValue({
      id: "thread_1",
      workspace_id: "ws_1",
      title: "New Chat",
    });
    deleteThreadMock.mockResolvedValue(undefined);
    generateThreadTitleMock.mockResolvedValue(undefined);
    createGroupForNewThreadMock.mockResolvedValue({ id: "group_1" });
    addThreadToExistingGroupMock.mockResolvedValue({ id: "group_existing" });
  });

  it("returns 400 for malformed JSON", async () => {
    const response = await route.action({
      request: new Request("https://camelai.test/api/workspaces/ws_1/chat/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{",
      }),
      context: {},
      params: { id: "ws_1" },
    } as never);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid JSON" });
    expect(createThreadMock).not.toHaveBeenCalled();
  });

  it("creates a thread with the first message persisted and returns its group", async () => {
    const response = await route.action({
      request: new Request("https://camelai.test/api/workspaces/ws_1/chat/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          firstMessage: "Keep this first message",
          model: "sonnet",
        }),
      }),
      context: {},
      params: { id: "ws_1" },
    } as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      thread: { id: "thread_1" },
      groupId: "group_1",
    });
    expect(createThreadMock).toHaveBeenCalledWith(
      {},
      "ws_1",
      undefined,
      "user_1",
      "Keep this first message",
      "sonnet",
    );
    expect(createGroupForNewThreadMock).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        userId: "user_1",
        orgId: "org_1",
        workspaceId: "ws_1",
        threadId: "thread_1",
        initialThreadTitle: undefined,
      }),
    );
    expect(waitUntilMock).toHaveBeenCalledTimes(1);
    expect(generateThreadTitleMock).toHaveBeenCalledWith(
      {},
      "thread_1",
      "ws_1",
      "Keep this first message",
      "user_1",
    );
  });

  it("adds created threads to an existing group without creating another group", async () => {
    const response = await route.action({
      request: new Request("https://camelai.test/api/workspaces/ws_1/chat/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          firstMessage: "Use the open group",
          groupId: "group_existing",
        }),
      }),
      context: {},
      params: { id: "ws_1" },
    } as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      groupId: "group_existing",
    });
    expect(addThreadToExistingGroupMock).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        groupId: "group_existing",
        threadId: "thread_1",
      }),
    );
    expect(createGroupForNewThreadMock).not.toHaveBeenCalled();
  });

  it("returns not found instead of 500 when a stale group id is submitted", async () => {
    addThreadToExistingGroupMock.mockRejectedValueOnce(
      new Error("Chat group not found"),
    );

    const response = await route.action({
      request: new Request("https://camelai.test/api/workspaces/ws_1/chat/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          firstMessage: "Use a stale group",
          groupId: "group_stale",
        }),
      }),
      context: {},
      params: { id: "ws_1" },
    } as never);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Chat group not found",
    });
    expect(deleteThreadMock).toHaveBeenCalledWith({}, "thread_1", "ws_1", {
      orgId: "org_1",
    });
  });
});
