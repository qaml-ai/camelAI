import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getOrgStubMock,
  getWorkspaceStubMock,
  startInitialUserMessageMock,
  startChannelRuntimeTurnMock,
  pinNewThreadToRuntimeMock,
} = vi.hoisted(() => ({
  getOrgStubMock: vi.fn(),
  getWorkspaceStubMock: vi.fn(),
  startInitialUserMessageMock: vi.fn(),
  startChannelRuntimeTurnMock: vi.fn(async () => null),
  pinNewThreadToRuntimeMock: vi.fn(async () => null),
}));

vi.mock("../src/agent-runtime/channel-turns.js", () => ({
  startChannelRuntimeTurn: startChannelRuntimeTurnMock,
}));

vi.mock("../src/agent-runtime/thread-runtime.js", () => ({
  pinNewThreadToRuntime: pinNewThreadToRuntimeMock,
}));

vi.mock("../src/helpers/stubs.js", () => ({
  getOrgStub: getOrgStubMock,
  getWorkspaceStub: getWorkspaceStubMock,
}));

import {
  appendEmailThreadReferenceIds,
  buildEmailReplyHeaders,
  buildChannelReplySystemMessage,
  enqueueChannelMessage,
  formatEmailMessageIdHeader,
  getChannelDedupeKey,
  getChannelReplyToolName,
  getChannelThreadMapKey,
  getEmailReplyReferenceKey,
  getOrCreateChannelThread,
} from "../src/channels.js";

function createMockKvStore(initial?: Record<string, string>) {
  const store = new Map<string, string>(Object.entries(initial || {}));
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    _store: store,
  };
}

function defaultOrgModelPickerConfig() {
  return {
    use_platform_defaults: true,
    default_model: null,
    models: [],
  };
}

function defaultWorkspaceModelPickerConfig() {
  return {
    use_org_defaults: true,
    use_platform_defaults: true,
    default_model: null,
    models: [],
  };
}

describe("channels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    startChannelRuntimeTurnMock.mockResolvedValue(null);
  });

  it("starts a direct runtime thread's turn there, not through ChatThreadDO", async () => {
    startChannelRuntimeTurnMock.mockResolvedValue({ status: "accepted" });
    const result = await enqueueChannelMessage(
      { CHAT_THREAD: { idFromName: (id: string) => id, get: () => ({ startInitialUserMessage: startInitialUserMessageMock }) } } as never,
      { channelKind: "slack", threadId: "thread-1", workspaceId: "workspace-1", orgId: "org-1", userId: "owner-1", userName: "Slack U1", message: "hello" },
    );
    expect(result).toEqual({ status: "accepted" });
    expect(startInitialUserMessageMock).not.toHaveBeenCalled();
    expect(startChannelRuntimeTurnMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      threadId: "thread-1",
      channelKind: "slack",
      userId: "owner-1",
      message: "hello",
      systemMessage: expect.stringContaining("await tools.camel__send_slack_message("),
    }));
  });

  it("answers an error, and never reaches ChatThreadDO, when the thread cannot run on the runtime", async () => {
    startChannelRuntimeTurnMock.mockResolvedValueOnce(null);
    const result = await enqueueChannelMessage(
      { CHAT_THREAD: { idFromName: (id: string) => id, get: () => ({ startInitialUserMessage: startInitialUserMessageMock }) } } as never,
      { channelKind: "discord", threadId: "thread-1", workspaceId: "workspace-1", orgId: "org-1", userId: "owner-1", userName: "D", message: "hello" },
    );
    expect(result).toMatchObject({ status: "error" });
    expect(startInitialUserMessageMock).not.toHaveBeenCalled();
  });

  it("pins a new channel thread to the runtime", async () => {
    const kv = createMockKvStore();
    getOrgStubMock.mockReturnValue({
      getLlmProviderConfig: vi.fn().mockResolvedValue(null),
      getModelPickerConfig: vi.fn().mockResolvedValue(defaultOrgModelPickerConfig()),
      createThread: vi.fn().mockResolvedValue({ id: "thread-9", title: "Chat" }),
    });
    getWorkspaceStubMock.mockReturnValue({
      getModelPickerConfig: vi.fn().mockResolvedValue(defaultWorkspaceModelPickerConfig()),
    });
    await getOrCreateChannelThread({ APP_KV: kv } as never, {
      kind: "telegram", workspaceId: "ws-1", orgId: "org-1", connectionId: "int-1",
      remoteConversationId: "42", title: "Chat", createdBy: "telegram",
    });
    expect(pinNewThreadToRuntimeMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: "org-1", workspaceId: "ws-1", threadId: "thread-9",
    }));
  });

  it("normalizes channel thread map keys", () => {
    expect(
      getChannelThreadMapKey({
        kind: "telegram",
        workspaceId: "Workspace 1",
        orgId: "org-1",
        connectionId: "Bot #1",
        remoteConversationId: "Chat #123",
      }),
    ).toBe("channel_thread:telegram:workspace_1:bot__1:chat__123");
    expect(
      getChannelThreadMapKey({
        kind: "telegram",
        workspaceId: "Workspace 1",
        orgId: "org-1",
        connectionId: "Bot #2",
        remoteConversationId: "Chat #123",
      }),
    ).toBe("channel_thread:telegram:workspace_1:bot__2:chat__123");
  });

  it("normalizes email reply reference keys shared by ingress and outbound tools", () => {
    expect(getEmailReplyReferenceKey("workspace-1", "<Message.ID+bad@example.com>"))
      .toBe("email_reply_ref:workspace-1:message.id_bad@example.com");
  });

  it("builds safe RFC email reply headers from thread references", () => {
    const references = appendEmailThreadReferenceIds(
      ["<first@example.com>", "second@example.com"],
      "second@example.com",
      "latest@example.com",
    );

    expect(references).toEqual([
      "first@example.com",
      "second@example.com",
      "latest@example.com",
    ]);
    expect(
      buildEmailReplyHeaders({
        inReplyToMessageId: references.at(-1),
        referenceMessageIds: references,
      }),
    ).toEqual({
      "In-Reply-To": "<latest@example.com>",
      References:
        "<first@example.com> <second@example.com> <latest@example.com>",
    });
  });

  it("trims References to Cloudflare Email Service header limits", () => {
    const ids = Array.from(
      { length: 20 },
      (_, index) => `message-${index}-${"a".repeat(500)}@example.com`,
    );
    const latest = ids[ids.length - 1]!;
    const formattedLatest = formatEmailMessageIdHeader(latest)!;

    const headers = buildEmailReplyHeaders({
      inReplyToMessageId: latest,
      referenceMessageIds: ids,
    });

    expect(headers?.["In-Reply-To"]).toBe(formattedLatest);
    expect(headers?.References).toContain(formattedLatest);
    expect(headers?.References).not.toContain(`<${ids[0]!}>`);
    expect(new TextEncoder().encode(headers?.References || "").byteLength)
      .toBeLessThanOrEqual(2048);
  });

  it("keeps generated KV keys below Cloudflare key length limits", () => {
    const longValue = "Very Long Value ".repeat(80);
    expect(
      getChannelThreadMapKey({
        kind: "telegram",
        workspaceId: longValue,
        orgId: "org-1",
        connectionId: longValue,
        remoteConversationId: longValue,
      }).length,
    ).toBeLessThan(512);
    expect(getChannelDedupeKey("slack", longValue, longValue).length)
      .toBeLessThan(512);
    expect(getEmailReplyReferenceKey(longValue, longValue).length)
      .toBeLessThan(512);
  });

  it("builds hidden channel reply instructions for js_exec provider tools", () => {
    expect(getChannelReplyToolName("email")).toBe("send_email");
    expect(getChannelReplyToolName("slack")).toBe("send_slack_message");
    expect(getChannelReplyToolName("telegram")).toBe("send_telegram_message");
    expect(getChannelReplyToolName("discord")).toBe("send_discord_message");

    const message = buildChannelReplySystemMessage("email", {
      userEmail: "user@example.com",
    });

    expect(message).toContain("<camelai system message>");
    expect(message).toContain("call the js_exec tool");
    expect(message).toContain("await tools.send_email");
    expect(message).toContain("user@example.com");
    expect(message).toContain("will not be sent to the external channel automatically");
  });

  it("tells Telegram replies to use js_exec without a chat id", () => {
    const message = buildChannelReplySystemMessage("telegram", {
      userEmail: null,
    });

    expect(message).toContain("await tools.send_telegram_message");
    expect(message).toContain("do not need to provide the channel/chat id");
    expect(message).toContain("originating conversation");
  });

  it("names the reply tool as the agent runtime has it, for a thread on the runtime", () => {
    const message = buildChannelReplySystemMessage("telegram", { userEmail: null }, { runtime: true });
    expect(message).toContain("await tools.camel__send_telegram_message(");
    expect(message).not.toContain("tools.send_telegram_message");
  });

  it("tells Discord replies to use the scoped js_exec provider tool", () => {
    const message = buildChannelReplySystemMessage("discord", {
      userEmail: null,
    });

    expect(message).toContain("await tools.send_discord_message");
    expect(message).toContain("do not need to provide the channel/chat id");
    expect(message).toContain("originating conversation");
  });

  it("reuses an existing channel thread map", async () => {
    const kv = createMockKvStore({
      "channel_thread:slack:workspace-1:slack-int:t1:c1:1700.0001": "thread-1",
    });
    const orgStub = {
      getThread: vi.fn().mockResolvedValue({
        id: "thread-1",
        title: "Existing channel thread",
      }),
      createThread: vi.fn(),
    };
    getOrgStubMock.mockReturnValue(orgStub);

    const result = await getOrCreateChannelThread(
      { APP_KV: kv } as never,
      {
        kind: "slack",
        workspaceId: "workspace-1",
        orgId: "org-1",
        connectionId: "slack-int",
        remoteConversationId: "T1:C1:1700.0001",
        title: "New title",
      },
    );

    expect(result).toEqual({
      threadId: "thread-1",
      title: "Existing channel thread",
      created: false,
    });
    expect(orgStub.createThread).not.toHaveBeenCalled();
  });

  it("recreates a channel thread when an existing map points at a missing thread", async () => {
    const key = "channel_thread:slack:workspace-1:slack-int:t1:c1:1700.0001";
    const kv = createMockKvStore({ [key]: "missing-thread" });
    const orgStub = {
      getThread: vi.fn().mockResolvedValue(null),
      getLlmProviderConfig: vi.fn().mockResolvedValue(null),
      getModelPickerConfig: vi.fn().mockResolvedValue(defaultOrgModelPickerConfig()),
      createThread: vi.fn().mockResolvedValue({
        id: "thread-2",
        title: "Recreated channel thread",
      }),
    };
    getOrgStubMock.mockReturnValue(orgStub);
    getWorkspaceStubMock.mockReturnValue({
      getModelPickerConfig: vi.fn().mockResolvedValue(defaultWorkspaceModelPickerConfig()),
    });

    const result = await getOrCreateChannelThread(
      { APP_KV: kv } as never,
      {
        kind: "slack",
        workspaceId: "workspace-1",
        orgId: "org-1",
        connectionId: "slack-int",
        remoteConversationId: "T1:C1:1700.0001",
        title: "Recreated channel thread",
        firstUserMessage: "hello again",
      },
    );

    expect(result).toEqual({
      threadId: "thread-2",
      title: "Recreated channel thread",
      created: true,
    });
    expect(kv.delete).toHaveBeenCalledWith(key);
    expect(kv._store.get(key)).toBe("thread-2");
  });

  it("creates a channel thread with the workspace default model", async () => {
    const kv = createMockKvStore();
    const orgStub = {
      getLlmProviderConfig: vi.fn().mockResolvedValue(null),
      getModelPickerConfig: vi.fn().mockResolvedValue(defaultOrgModelPickerConfig()),
      createThread: vi.fn().mockResolvedValue({
        id: "thread-2",
        title: "Telegram chat",
      }),
    };
    const workspaceStub = {
      getModelPickerConfig: vi.fn().mockResolvedValue(defaultWorkspaceModelPickerConfig()),
    };
    getOrgStubMock.mockReturnValue(orgStub);
    getWorkspaceStubMock.mockReturnValue(workspaceStub);

    const result = await getOrCreateChannelThread(
      { APP_KV: kv } as never,
      {
        kind: "telegram",
        workspaceId: "workspace-1",
        orgId: "org-1",
        remoteConversationId: "bot-1:chat-9",
        connectionId: "telegram-bot-1",
        title: "Telegram chat",
        createdBy: "telegram",
        firstUserMessage: "hello from Telegram",
        firstRemoteMessageId: "message-1",
      },
    );

    expect(result).toEqual({
      threadId: "thread-2",
      title: "Telegram chat",
      created: true,
    });
    expect(orgStub.createThread).toHaveBeenCalledWith(
      "workspace-1",
      "Telegram chat",
      "telegram",
      "hello from Telegram",
      "gpt-6-luna",
      expect.objectContaining({
        source: "channel",
        channelKind: "telegram",
        channelConnectionId: "telegram-bot-1",
        channelConversationId: "bot-1:chat-9",
        channelMessageId: "message-1",
      }),
    );
    expect(
      kv._store.get(
        "channel_thread:telegram:workspace-1:telegram-bot-1:bot-1:chat-9",
      ),
    ).toBe("thread-2");
  });

  it("passes full first user messages when creating channel threads", async () => {
    const kv = createMockKvStore();
    const longMessage = `${"x".repeat(700)} tail`;
    const orgStub = {
      getLlmProviderConfig: vi.fn().mockResolvedValue(null),
      getModelPickerConfig: vi.fn().mockResolvedValue(defaultOrgModelPickerConfig()),
      createThread: vi.fn().mockResolvedValue({
        id: "thread-long",
        title: "Long Slack chat",
      }),
    };
    getOrgStubMock.mockReturnValue(orgStub);
    getWorkspaceStubMock.mockReturnValue({
      getModelPickerConfig: vi.fn().mockResolvedValue(defaultWorkspaceModelPickerConfig()),
    });

    await getOrCreateChannelThread(
      { APP_KV: kv } as never,
      {
        kind: "slack",
        workspaceId: "workspace-1",
        orgId: "org-1",
        remoteConversationId: "T1:C1:1700.0002",
        connectionId: "slack-int",
        title: "Long Slack chat",
        firstUserMessage: `  ${longMessage}  `,
      },
    );

    expect(orgStub.createThread).toHaveBeenCalledWith(
      "workspace-1",
      "Long Slack chat",
      "slack",
      longMessage,
      "gpt-6-luna",
      expect.objectContaining({
        source: "channel",
        channelKind: "slack",
      }),
    );
  });

  it("acts as the member who connected the channel when the sender is no member", async () => {
    startChannelRuntimeTurnMock.mockResolvedValue({ status: "accepted" });
    const getIntegration = vi.fn(async (id: string) => (id === "int-1" ? { id, created_by: "owner-1" } : null));
    const env = {
      WORKSPACE: {
        idFromName: (workspaceId: string) => workspaceId,
        get: () => ({ getIntegration }),
      },
    } as never;

    await enqueueChannelMessage(env, {
      channelKind: "discord",
      threadId: "thread-1",
      workspaceId: "workspace-1",
      orgId: "org-1",
      connectionId: "int-1",
      userName: "discord-author",
      message: "hi",
    });
    expect(getIntegration).toHaveBeenCalledWith("int-1");
    expect((startChannelRuntimeTurnMock.mock.calls.at(-1) as unknown[] | undefined)?.[1]).toMatchObject({
      userId: "owner-1",
      userName: "discord-author",
    });

    // A sender who is a member (email) keeps acting as themself.
    await enqueueChannelMessage(env, {
      channelKind: "email",
      threadId: "thread-1",
      workspaceId: "workspace-1",
      orgId: "org-1",
      connectionId: "int-1",
      userId: "member-9",
      message: "hi",
    });
    expect((startChannelRuntimeTurnMock.mock.calls.at(-1) as unknown[] | undefined)?.[1]).toMatchObject({ userId: "member-9" });
  });

  it("starts channel messages on the runtime, with the channel's reply instructions", async () => {
    startChannelRuntimeTurnMock.mockResolvedValue({ status: "accepted" });

    const result = await enqueueChannelMessage(
      {} as never,
      {
        channelKind: "slack",
        threadId: "thread-1",
        workspaceId: "workspace-1",
        orgId: "org-1",
        message: "hello",
      },
    );

    expect(result).toEqual({ status: "accepted" });
    expect(startChannelRuntimeTurnMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      threadId: "thread-1",
      workspaceId: "workspace-1",
      orgId: "org-1",
      channelKind: "slack",
      message: "hello",
      systemMessage: expect.stringContaining("send_slack_message"),
    }));
    expect(startInitialUserMessageMock).not.toHaveBeenCalled();
  });

  it("re-homes a conversation whose thread can never move: a new thread for the channel, a note linking the old one", async () => {
    const kv = createMockKvStore();
    const address = { kind: "slack", workspaceId: "workspace-1", orgId: "org-1", connectionId: "int-1", remoteConversationId: "C1:1.2" };
    await kv.put(getChannelThreadMapKey(address), "thread-old");
    const createThread = vi.fn(async () => ({ id: "thread-new", title: "Deploy help" }));
    getOrgStubMock.mockReturnValue({
      getThread: vi.fn(async (id: string) => id === "thread-old"
        ? { id, title: "Deploy help", created_by: "slack", channel_kind: "slack", channel_connection_id: "int-1", channel_conversation_id: "C1:1.2" }
        : id === "thread-new" ? { id, title: "Deploy help" } : null),
      getLlmProviderConfig: vi.fn().mockResolvedValue(null),
      getModelPickerConfig: vi.fn().mockResolvedValue(defaultOrgModelPickerConfig()),
      createThread,
    });
    getWorkspaceStubMock.mockReturnValue({
      getModelPickerConfig: vi.fn().mockResolvedValue(defaultWorkspaceModelPickerConfig()),
    });
    startChannelRuntimeTurnMock
      .mockResolvedValueOnce({ status: "unmovable", reason: "too_large" } as never)
      .mockResolvedValue({ status: "accepted" } as never);
    const env = { APP_KV: kv } as never;
    const request = { channelKind: "slack", threadId: "thread-old", workspaceId: "workspace-1", orgId: "org-1", userId: "owner-1", message: "hello" };

    expect(await enqueueChannelMessage(env, request)).toEqual({ status: "accepted" });
    // A new thread for the same channel conversation, pinned, and the mapping points at it.
    expect(createThread).toHaveBeenCalledOnce();
    expect(pinNewThreadToRuntimeMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ threadId: "thread-new" }));
    expect(kv._store.get(getChannelThreadMapKey(address))).toBe("thread-new");
    // The message ran there, its first message carrying a note linking the old thread.
    const second = (startChannelRuntimeTurnMock.mock.calls[1] as unknown[])[1] as { threadId: string; systemMessage: string };
    expect(second.threadId).toBe("thread-new");
    expect(second.systemMessage).toContain("continues from the earlier thread \"Deploy help\" (thread-old)");
    expect(second.systemMessage).toContain("/chat/thread-old");

    // A later message on the old thread's other mappings (an email's reply
    // references, say) goes straight to the new thread, with no note and no new thread.
    startChannelRuntimeTurnMock.mockClear();
    expect(await enqueueChannelMessage(env, request)).toEqual({ status: "accepted" });
    expect(startChannelRuntimeTurnMock).toHaveBeenCalledOnce();
    const third = (startChannelRuntimeTurnMock.mock.calls[0] as unknown[])[1] as { threadId: string; systemMessage: string };
    expect(third.threadId).toBe("thread-new");
    expect(third.systemMessage).not.toContain("earlier thread");
    expect(createThread).toHaveBeenCalledOnce();
  });
});
