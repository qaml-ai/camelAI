import { describe, expect, it, vi } from "vitest";

// Channel turns start on the agent runtime; recorded here through the env's CHAT_THREAD double.
vi.mock("../src/agent-runtime/channel-turns.js", async (importOriginal) =>
  (await import("./helpers/channel-turn-recorder")).recordChannelTurns(await importOriginal<object>()));
import {
  handleDiscordEventsDeadLetterQueue,
  handleDiscordEventsQueue,
} from "../src/discord-events-queue.js";
import type { DiscordBridgeDelivery } from "../src/discord-types.js";

function activeConfig() {
  return JSON.stringify({
    schema_version: 1,
    status: "active",
    application_id: "application-1",
    guild_id: "guild-1",
    guild_name: "Camel",
    parent_channel_id: "parent-1",
    parent_channel_name: "support",
    bot_user_id: "application-1",
    binding_version: 7,
    message_content_mode: "full",
  });
}

function delivery(overrides: Partial<DiscordBridgeDelivery> = {}): DiscordBridgeDelivery {
  return {
    kind: "message",
    discordMessageId: "message-1",
    guildId: "guild-1",
    channelId: "thread-1",
    parentChannelId: "parent-1",
    threadId: "thread-1",
    integrationId: "integration-1",
    orgId: "org-1",
    workspaceId: "workspace-1",
    bindingVersion: 7,
    ordinal: 2,
    content: "follow up",
    messageType: 0,
    author: {
      id: "discord-user-1",
      username: "reader",
      globalName: "Reader",
      guildNickname: null,
    },
    mentions: [],
    attachments: [],
    timestamp: null,
    contentMode: "full",
    starter: false,
    ...overrides,
  } as DiscordBridgeDelivery;
}

function queueMessage(body: unknown) {
  return {
    body,
    attempts: 1,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

function baseEnv(args: {
  bridgeFetch: (request: Request) => Promise<Response>;
  chatStatus?: "accepted" | "busy";
  integrationConfig?: string;
  actions?: string[];
}) {
  const values = new Map<string, string>();
  const integration = {
    id: "integration-1",
    integration_type: "discord_channel",
    config: args.integrationConfig ?? activeConfig(),
    credentials_encrypted: "encrypted-empty-credentials",
    created_by: "user-1",
  };
  const orgStub = {
    getWorkspaceRecord: vi.fn(async () => ({
      id: "workspace-1",
      org_id: "org-1",
      archived: false,
    })),
    getWorkspaceIntegration: vi.fn(async () => integration),
    getThread: vi.fn(async () => ({ id: "camel-thread", title: "Discord thread" })),
    updateWorkspaceIntegration: vi.fn(async () => undefined),
    updateWorkspaceIntegrationVerification: vi.fn(async () => true),
  };
  const startInitialUserMessage = vi.fn(async () => {
    args.actions?.push("chat");
    return { status: args.chatStatus ?? "accepted" };
  });
  return {
    DISCORD_BRIDGE: { fetch: args.bridgeFetch },
    APP_KV: {
      get: vi.fn(async (key: string) => {
        if (key.startsWith("channel_thread:discord:")) return "camel-thread";
        return values.get(key) ?? null;
      }),
      put: vi.fn(async (key: string, value: string) => {
        values.set(key, value);
      }),
      delete: vi.fn(async (key: string) => {
        values.delete(key);
      }),
    },
    ORG: {
      idFromName: vi.fn((id: string) => id),
      get: vi.fn(() => orgStub),
    },
    CHAT_THREAD: {
      idFromName: vi.fn((id: string) => id),
      get: vi.fn(() => ({
        startInitialUserMessage,
      })),
    },
    R2_BUCKET: {
      head: vi.fn(async () => null),
      put: vi.fn(async () => undefined),
    },
    _orgStub: orgStub,
    _startInitialUserMessage: startInitialUserMessage,
  };
}

describe("Discord event queue", () => {
  it("acknowledges a later ordinal so the durable outbox can republish it", async () => {
    const message = queueMessage({ version: 1, eventId: "event-2" });
    const env = baseEnv({
      bridgeFetch: async () => Response.json({
        ok: true,
        status: "ordered_wait",
      }),
    });

    await handleDiscordEventsQueue({
      queue: "chiridion-app-discord-events-test",
      messages: [message],
    } as never, env as never);

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it("retries when another consumer still owns the eligible delivery lease", async () => {
    const message = queueMessage({ version: 1, eventId: "event-1" });
    const env = baseEnv({
      bridgeFetch: async () => Response.json({
        ok: true,
        status: "wait",
        retryAfterMs: 4_000,
      }),
    });

    await handleDiscordEventsQueue({
      queue: "chiridion-app-discord-events-test",
      messages: [message],
    } as never, env as never);

    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 4 });
    expect(message.ack).not.toHaveBeenCalled();
  });

  it("creates the visible Discord thread before accepting the agent turn", async () => {
    const actions: string[] = [];
    const payload = delivery({
      discordMessageId: "starter-message",
      channelId: "parent-1",
      threadId: null,
      ordinal: 1,
      content: "<@application-1> build the dashboard",
      starter: true,
    });
    const message = queueMessage({ version: 1, eventId: "event-1" });
    const bridgeFetch = vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/claim")) {
        return Response.json({
          ok: true,
          status: "claimed",
          leaseToken: "lease-1",
          payload,
        });
      }
      if (path === "/internal/v1/threads/from-message") {
        actions.push("discord-thread");
        return Response.json({ ok: true, threadId: "thread-start" });
      }
      if (path.endsWith("/complete")) {
        actions.push("complete");
        return Response.json({ ok: true });
      }
      throw new Error(`Unexpected bridge path: ${path}`);
    });
    const env = baseEnv({ bridgeFetch, actions });

    await handleDiscordEventsQueue({
      queue: "chiridion-app-discord-events-test",
      messages: [message],
    } as never, env as never);

    expect(actions).toEqual(["discord-thread", "chat", "complete"]);
    expect(env._startInitialUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({ clientMessageId: "discord:starter-message" }),
    );
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it("continues delivering from the active binding while reauthorization is staged", async () => {
    const message = queueMessage({ version: 1, eventId: "event-reauthorizing" });
    const paths: string[] = [];
    const bridgeFetch = vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname;
      paths.push(path);
      if (path.endsWith("/claim")) {
        return Response.json({
          ok: true,
          status: "claimed",
          leaseToken: "lease-reauthorizing",
          payload: delivery(),
        });
      }
      if (path.endsWith("/complete")) return Response.json({ ok: true });
      throw new Error(`Unexpected bridge path: ${path}`);
    });
    const env = baseEnv({
      bridgeFetch,
      integrationConfig: JSON.stringify({
        ...JSON.parse(activeConfig()),
        pending_reauthorization: {
          activation_attempt_id: "reauthorization-attempt",
          application_id: "application-1",
          guild_id: "guild-2",
          guild_name: "Replacement Guild",
          bot_user_id: "application-1",
          message_content_mode: "full",
        },
      }),
    });

    await handleDiscordEventsQueue({
      queue: "chiridion-app-discord-events-test",
      messages: [message],
    } as never, env as never);

    expect(paths).toEqual([
      "/internal/v1/deliveries/event-reauthorizing/claim",
      "/internal/v1/deliveries/event-reauthorizing/complete",
    ]);
    expect(env._startInitialUserMessage).toHaveBeenCalledOnce();
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it("releases its lease and retries when the chat thread is busy", async () => {
    const message = queueMessage({ version: 1, eventId: "event-1" });
    const paths: string[] = [];
    const bridgeFetch = vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname;
      paths.push(path);
      if (path.endsWith("/claim")) {
        return Response.json({
          ok: true,
          status: "claimed",
          leaseToken: "lease-1",
          payload: delivery(),
        });
      }
      if (path.endsWith("/retry")) return Response.json({ ok: true });
      throw new Error(`Unexpected bridge path: ${path}`);
    });
    const env = baseEnv({ bridgeFetch, chatStatus: "busy" });

    await handleDiscordEventsQueue({
      queue: "chiridion-app-discord-events-test",
      messages: [message],
    } as never, env as never);

    expect(paths.at(-1)).toBe("/internal/v1/deliveries/event-1/retry");
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(message.ack).not.toHaveBeenCalled();
  });

  it("posts one actionable notice and degrades verification when Discord cannot start a thread", async () => {
    const payload = delivery({
      discordMessageId: "starter-limit",
      channelId: "parent-1",
      threadId: null,
      ordinal: 1,
      content: "<@application-1> help",
      starter: true,
    });
    const message = queueMessage({ version: 1, eventId: "event-limit" });
    const paths: string[] = [];
    const bridgeFetch = vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname;
      paths.push(path);
      if (path.endsWith("/claim")) {
        return Response.json({
          ok: true,
          status: "claimed",
          leaseToken: "lease-limit",
          payload,
        });
      }
      if (path === "/internal/v1/threads/from-message") {
        return Response.json({
          ok: false,
          error: "active_thread_limit",
          message: "Discord channel has reached its active thread limit",
        }, { status: 409 });
      }
      if (path === "/internal/v1/failure-notices") {
        return Response.json({ ok: true, noticeMessageId: "notice-1" });
      }
      if (path.endsWith("/complete")) return Response.json({ ok: true });
      throw new Error(`Unexpected bridge path: ${path}`);
    });
    const env = baseEnv({ bridgeFetch });

    await handleDiscordEventsQueue({
      queue: "chiridion-app-discord-events-test",
      messages: [message],
    } as never, env as never);

    expect(paths).toEqual([
      "/internal/v1/deliveries/event-limit/claim",
      "/internal/v1/threads/from-message",
      "/internal/v1/failure-notices",
      "/internal/v1/deliveries/event-limit/complete",
    ]);
    expect(env._orgStub.updateWorkspaceIntegrationVerification).toHaveBeenCalledWith(
      "workspace-1",
      "integration-1",
      expect.objectContaining({ status: "degraded" }),
      "system",
      {
        config: activeConfig(),
        credentialsEncrypted: "encrypted-empty-credentials",
      },
    );
    expect(env._startInitialUserMessage).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledOnce();
  });

  it("disconnects and releases a binding after a permanent guild removal", async () => {
    const message = queueMessage({ version: 1, eventId: "event-life" });
    const payload = delivery({
      kind: "lifecycle",
      lifecycleType: "guild_removed",
      parentChannelId: null,
    } as Partial<DiscordBridgeDelivery>);
    const paths: string[] = [];
    const bridgeFetch = vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname;
      paths.push(path);
      if (path.endsWith("/claim")) {
        return Response.json({
          ok: true,
          status: "claimed",
          leaseToken: "lease-life",
          payload,
        });
      }
      return Response.json({ ok: true, released: true });
    });
    const env = baseEnv({ bridgeFetch });

    await handleDiscordEventsQueue({
      queue: "chiridion-app-discord-events-test",
      messages: [message],
    } as never, env as never);

    expect(env._orgStub.updateWorkspaceIntegration).toHaveBeenCalledWith(
      "workspace-1",
      "integration-1",
      expect.objectContaining({ config: expect.stringContaining('"status":"disconnected"') }),
      "user-1",
    );
    const persisted = JSON.parse(String(
      env._orgStub.updateWorkspaceIntegration.mock.calls[0]?.[2]?.config,
    ));
    expect(persisted).not.toHaveProperty("parent_channel_id");
    expect(persisted).not.toHaveProperty("parent_channel_name");
    expect(persisted).not.toHaveProperty("binding_version");
    expect(paths).toContain("/internal/v1/bindings/integration-1");
    expect(paths.at(-1)).toBe("/internal/v1/deliveries/event-life/complete");
    expect(message.ack).toHaveBeenCalledOnce();
  });

  it("uses the atomic dead-letter operation and only acknowledges terminal outcomes", async () => {
    const failed = queueMessage({ version: 1, eventId: "event-failed" });
    const waiting = queueMessage({ version: 1, eventId: "event-waiting" });
    const bridgeFetch = vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname;
      expect(path).toMatch(/\/dead-letter$/);
      return path.includes("event-waiting")
        ? Response.json({ ok: true, status: "wait", retryAfterMs: 4_000 })
        : Response.json({ ok: true, status: "failed" });
    });
    const env = baseEnv({ bridgeFetch });

    await handleDiscordEventsDeadLetterQueue({
      queue: "chiridion-app-discord-events-dlq-test",
      messages: [failed, waiting],
    } as never, env as never);

    expect(failed.ack).toHaveBeenCalledOnce();
    expect(failed.retry).not.toHaveBeenCalled();
    expect(waiting.ack).not.toHaveBeenCalled();
    expect(waiting.retry).toHaveBeenCalledWith({ delaySeconds: 4 });
    expect(bridgeFetch).toHaveBeenCalledTimes(2);
  });

  it("acks malformed queue bodies without contacting the bridge", async () => {
    const message = queueMessage({ version: 2, eventId: "event-1" });
    const bridgeFetch = vi.fn(async () => Response.json({ ok: true }));
    const env = baseEnv({ bridgeFetch });

    await handleDiscordEventsQueue({
      queue: "chiridion-app-discord-events-test",
      messages: [message],
    } as never, env as never);

    expect(message.ack).toHaveBeenCalledOnce();
    expect(bridgeFetch).not.toHaveBeenCalled();
  });
});
