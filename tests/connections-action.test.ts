import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptCredentials } from "@/lib/integration-crypto";

const requireAuthContextMock = vi.fn();
const requireWorkspaceAccessMock = vi.fn();
const getAuthEnvMock = vi.fn();
const getEnvMock = vi.fn();
const isOrgAdminMock = vi.fn();
const authUserGetMock = vi.fn();
const authUserGetProfileMock = vi.fn();
const createIntegrationMock = vi.fn();
const createDefinitionMock = vi.fn();
const getDefinitionMock = vi.fn();
const discoverSurfacesMock = vi.fn();
const updateIntegrationMock = vi.fn();
const deleteIntegrationMock = vi.fn();
const getIntegrationMock = vi.fn();
const getIntegrationsMock = vi.fn();
const sourceIntegrationNameExistsMock = vi.fn();
const targetCreateIntegrationMock = vi.fn();
const targetIntegrationNameExistsMock = vi.fn();
const targetGetInfoMock = vi.fn();
const putSetupTokenMock = vi.fn();
const listProjectsMock = vi.fn();
const verifyConnectionMock = vi.fn();

vi.mock("@/lib/auth.server", () => ({
  requireAuthContext: requireAuthContextMock,
  requireWorkspaceAccess: requireWorkspaceAccessMock,
  getAuthEnv: getAuthEnvMock,
}));

vi.mock("@/lib/cloudflare.server", () => ({
  getEnv: getEnvMock,
}));

vi.mock("@/lib/openapi-integration.server", () => ({
  discoverIntegrationSurfaces: discoverSurfacesMock,
}));

vi.mock("@/lib/auth-do", () => ({
  isOrgAdmin: isOrgAdminMock,
  createWorkspaceIntegrationDefinitionRecord: vi.fn(
    (_authEnv, _workspaceId: string, ...args: unknown[]) => createDefinitionMock(...args),
  ),
  getWorkspaceIntegrationDefinitionRecord: vi.fn(
    (_authEnv, _workspaceId: string, definitionId: string) => getDefinitionMock(definitionId),
  ),
  createWorkspaceIntegrationRecord: vi.fn(
    (
      _authEnv,
      workspaceId: string,
      ...args: [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        number | null | undefined,
      ]
    ) => {
      const spy =
        workspaceId === "ws_2" ? targetCreateIntegrationMock : createIntegrationMock;
      return spy(...args);
    },
  ),
  updateWorkspaceIntegrationRecord: vi.fn(
    (_authEnv, _workspaceId: string, integrationId: string, updates, actorId: string) =>
      updateIntegrationMock(integrationId, updates, actorId),
  ),
  deleteWorkspaceIntegrationRecord: vi.fn(
    (_authEnv, _workspaceId: string, integrationId: string, actorId: string) =>
      deleteIntegrationMock(integrationId, actorId),
  ),
  getWorkspaceIntegrationRecord: vi.fn(
    (_authEnv, _workspaceId: string, integrationId: string) =>
      getIntegrationMock(integrationId),
  ),
  listWorkspaceIntegrationRecords: vi.fn((_authEnv, _workspaceId: string) =>
    getIntegrationsMock(),
  ),
  workspaceIntegrationNameExists: vi.fn(
    (
      _authEnv,
      workspaceId: string,
      integrationType: string,
      name: string,
      excludeId?: string,
    ) => {
      const spy =
        workspaceId === "ws_2"
          ? targetIntegrationNameExistsMock
          : sourceIntegrationNameExistsMock;
      return spy(integrationType, name, excludeId);
    },
  ),
}));

vi.mock("../workers/main/src/workspace-filesystem-do", () => ({
  WorkspaceFilesystemClient: class WorkspaceFilesystemClient {
    listProjects = listProjectsMock;
  },
}));

vi.mock("../workers/main/src/connections-runtime", () => ({
  verifyConnection: verifyConnectionMock,
}));

const { action, loader } = await import("@/routes/_app.connections");

function postForm(fields: Record<string, string>) {
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    formData.set(key, value);
  }
  return new Request("https://camelai.test/connections", {
    method: "POST",
    body: formData,
  });
}

function makeRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "int_1",
    integration_type: "postgres",
    name: "Primary DB",
    category: "databases",
    auth_method: "api_key",
    config: JSON.stringify({ host: "db.example.com" }),
    credentials_encrypted: "",
    created_by: "creator_1",
    created_at: 100,
    updated_at: 200,
    deleted_at: null,
    token_expires_at: null,
    auth_status: "connected",
    auth_error_code: null,
    auth_error_message: null,
    auth_checked_at: null,
    reauth_required_at: null,
    ...overrides,
  };
}

function setEnv(overrides: Record<string, unknown> = {}) {
  const sourceWorkspaceStub = {
    createIntegration: createIntegrationMock,
    updateIntegration: updateIntegrationMock,
    deleteIntegration: deleteIntegrationMock,
    getIntegration: getIntegrationMock,
    getIntegrations: getIntegrationsMock,
    integrationNameExists: sourceIntegrationNameExistsMock,
  };
  const targetWorkspaceStub = {
    createIntegration: targetCreateIntegrationMock,
    getInfo: targetGetInfoMock,
    integrationNameExists: targetIntegrationNameExistsMock,
  };
  const telegramRegistryStub = {
    putSetupToken: putSetupTokenMock,
  };

  getEnvMock.mockReturnValue({
    INTEGRATION_SECRET_KEY: "test-secret",
    DISCORD_CLIENT_ID: "123456789012345678",
    DISCORD_CLIENT_SECRET: "test-discord-client-secret-value",
    WORKSPACE_EMAIL_DOMAIN: "mail.camelai.test",
    TELEGRAM_BOT_USERNAME: "@camelai_test_bot",
    TELEGRAM_BOT_TOKEN: "telegram-token",
    TELEGRAM_REGISTRY: {
      idFromName: vi.fn((id: string) => id),
      get: vi.fn(() => telegramRegistryStub),
    },
    WORKSPACE: {
      idFromName: vi.fn((id: string) => id),
      get: vi.fn((id: string) =>
        id === "ws_2" ? targetWorkspaceStub : sourceWorkspaceStub,
      ),
    },
    ...overrides,
  });

  return { sourceWorkspaceStub, targetWorkspaceStub, telegramRegistryStub };
}

describe("connections action admin guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    discoverSurfacesMock.mockReset();
    requireAuthContextMock.mockResolvedValue({
      currentOrg: { id: "org_1" },
      currentWorkspace: { id: "ws_1" },
      user: { id: "user_1" },
      workspaces: [
        { id: "ws_1", name: "Source" },
        { id: "ws_2", name: "Target" },
      ],
    });
    requireWorkspaceAccessMock.mockResolvedValue(undefined);
    getAuthEnvMock.mockReturnValue({ auth: true });
    setEnv();
    isOrgAdminMock.mockResolvedValue(false);
    createIntegrationMock.mockResolvedValue(undefined);
    updateIntegrationMock.mockResolvedValue(undefined);
    deleteIntegrationMock.mockResolvedValue(undefined);
    targetCreateIntegrationMock.mockResolvedValue(undefined);
    targetGetInfoMock.mockResolvedValue({ id: "ws_2", org_id: "org_1" });
    targetIntegrationNameExistsMock.mockResolvedValue(false);
    getIntegrationMock.mockResolvedValue(makeRecord());
    getIntegrationsMock.mockResolvedValue([]);
    putSetupTokenMock.mockResolvedValue(undefined);
    verifyConnectionMock.mockResolvedValue({
      ok: true,
      status: "ready",
      message: "Connection verified successfully.",
    });
  });

  it.each([
    ["createIntegration", { integration_type: "postgres", name: "DB" }],
    ["updateIntegration", { integrationId: "int_1", name: "Renamed" }],
    ["deleteIntegration", { integrationId: "int_1" }],
    ["duplicateIntegration", { integrationId: "int_1", targetWorkspaceId: "ws_2" }],
    ["discordListChannels", { integrationId: "int_1" }],
    ["discordActivateChannel", { integrationId: "int_1", parentChannelId: "channel_1" }],
    ["discordDisconnect", { integrationId: "int_1" }],
  ])("blocks %s for full-access non-admins", async (intent, fields) => {
    await expect(
      action({
        request: postForm({ intent, ...fields }),
        context: {},
        params: {},
      } as never),
    ).resolves.toEqual({
      error: "Only organization admins can manage connections",
    });

    expect(requireWorkspaceAccessMock).toHaveBeenCalledWith(
      expect.any(Request),
      {},
      "ws_1",
      "full",
    );
    expect(isOrgAdminMock).toHaveBeenCalledWith({ auth: true }, "user_1", "org_1");
    expect(createIntegrationMock).not.toHaveBeenCalled();
    expect(updateIntegrationMock).not.toHaveBeenCalled();
    expect(deleteIntegrationMock).not.toHaveBeenCalled();
  });

  it("does not invoke the admin guard for unknown intents", async () => {
    await expect(
      action({
        request: postForm({ intent: "wat" }),
        context: {},
        params: {},
      } as never),
    ).resolves.toEqual({ error: "Unknown action" });

    expect(isOrgAdminMock).not.toHaveBeenCalled();
  });

  it("allows a full-access member to verify without granting management access", async () => {
    const response = await action({
      request: postForm({ intent: "verifyIntegration", integrationId: "int_1" }),
      context: {},
      params: {},
    } as never);

    expect(response).toMatchObject({
      success: true,
      verification: { ok: true, status: "ready" },
    });
    expect(isOrgAdminMock).not.toHaveBeenCalled();
    expect(verifyConnectionMock).toHaveBeenCalledWith(
      expect.any(Object),
      { orgId: "org_1", workspaceId: "ws_1", userId: "user_1" },
      { id: "int_1" },
    );
  });

  it("allows admins to create, update, delete, and duplicate integrations", async () => {
    isOrgAdminMock.mockResolvedValue(true);

    await expect(
      action({
        request: postForm({
          intent: "createIntegration",
          integration_type: "postgres",
          name: "Primary DB",
          config: JSON.stringify({
            host: "db.example.com",
            port: 5432,
            database: "app_db",
          }),
          credentials: JSON.stringify({ username: "app", password: "secret" }),
        }),
        context: {},
        params: {},
      } as never),
    ).resolves.toEqual({ success: true });
    expect(createIntegrationMock).toHaveBeenCalledWith(
      expect.any(String),
      "postgres",
      "Primary DB",
      "databases",
      "api_key",
      JSON.stringify({ host: "db.example.com", port: 5432, database: "app_db" }),
      expect.any(String),
      "user_1",
    );

    await expect(
      action({
        request: postForm({
          intent: "updateIntegration",
          integrationId: "int_1",
          name: "Renamed DB",
        }),
        context: {},
        params: {},
      } as never),
    ).resolves.toEqual({ success: true });
    expect(updateIntegrationMock).toHaveBeenCalledWith(
      "int_1",
      { name: "Renamed DB" },
      "user_1",
    );

    await expect(
      action({
        request: postForm({
          intent: "deleteIntegration",
          integrationId: "int_1",
        }),
        context: {},
        params: {},
      } as never),
    ).resolves.toEqual({ success: true });
    expect(deleteIntegrationMock).toHaveBeenCalledWith("int_1", "user_1");

    await expect(
      action({
        request: postForm({
          intent: "duplicateIntegration",
          integrationId: "int_1",
          targetWorkspaceId: "ws_2",
        }),
        context: {},
        params: {},
      } as never),
    ).resolves.toEqual({ success: true });
    expect(targetCreateIntegrationMock).toHaveBeenCalledWith(
      expect.any(String),
      "postgres",
      "Primary DB",
      "databases",
      "api_key",
      JSON.stringify({ host: "db.example.com" }),
      "",
      "user_1",
      null,
    );
  });

  it("rejects duplicate targets outside the current org", async () => {
    isOrgAdminMock.mockResolvedValue(true);
    requireAuthContextMock.mockResolvedValue({
      currentOrg: { id: "org_1" },
      currentWorkspace: { id: "ws_1" },
      user: { id: "user_1" },
      workspaces: [{ id: "ws_1", name: "Source" }],
    });

    await expect(
      action({
        request: postForm({
          intent: "duplicateIntegration",
          integrationId: "int_1",
          targetWorkspaceId: "ws_2",
        }),
        context: {},
        params: {},
      } as never),
    ).resolves.toEqual({
      error: "Target workspace must belong to the same organization",
    });

    expect(getIntegrationMock).not.toHaveBeenCalled();
    expect(targetCreateIntegrationMock).not.toHaveBeenCalled();
  });

  it("lists eligible Discord channels and activates the acknowledged selection", async () => {
    isOrgAdminMock.mockResolvedValue(true);
    getIntegrationMock.mockResolvedValue(makeRecord({
      integration_type: "discord_channel",
      name: "Example Guild",
      category: "communication",
      auth_method: "oauth2",
      config: JSON.stringify({
        schema_version: 1,
        status: "pending_channel",
        application_id: "app_1",
        guild_id: "guild_1",
        guild_name: "Example Guild",
        bot_user_id: "bot_1",
        message_content_mode: "full",
        activation_attempt_id: "attempt-initial",
      }),
    }));
    const bridgeFetch = vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === "/internal/v1/guilds/guild_1/channels") {
        return Response.json({
          ok: true,
          guild: { id: "guild_1", name: "Example Guild" },
          channels: [{
            id: "channel_1",
            name: "camel",
            categoryId: null,
            categoryName: null,
            position: 1,
            missingPermissions: [],
            canActivate: true,
            exposure: "restricted",
          }],
        });
      }
      if (request.method === "GET" && path === "/internal/v1/bindings/int_1") {
        return Response.json(
          { ok: false, error: "binding_not_found" },
          { status: 404 },
        );
      }
      if (path === "/internal/v1/bindings/activate") {
        const body = await request.json() as { idempotencyKey: string };
        expect(body.idempotencyKey).toBe(
          "discord-binding-activation:int_1:attempt-initial:guild_1:channel_1",
        );
        return Response.json({
          ok: true,
          binding: {
            guildId: "guild_1",
            parentChannelId: "channel_1",
            integrationId: "int_1",
            orgId: "org_1",
            workspaceId: "ws_1",
            guildName: "Example Guild",
            parentChannelName: "camel",
            version: 7,
          },
          previousBinding: null,
          confirmationMessageIds: ["confirmation-1"],
        });
      }
      return Response.json({ ok: false, error: "not_found" }, { status: 404 });
    });
    setEnv({
      DISCORD_CHANNEL_ENABLED: "true",
      DISCORD_BRIDGE: { fetch: bridgeFetch },
    });

    await expect(action({
      request: postForm({ intent: "discordListChannels", integrationId: "int_1" }),
      context: {},
      params: {},
    } as never)).resolves.toMatchObject({
      success: true,
      discordSetup: {
        integrationId: "int_1",
        channels: [{ id: "channel_1", canActivate: true }],
      },
    });

    await expect(action({
      request: postForm({
        intent: "discordActivateChannel",
        integrationId: "int_1",
        parentChannelId: "channel_1",
        securityAcknowledged: "true",
      }),
      context: {},
      params: {},
    } as never)).resolves.toEqual({ success: true });

    expect(updateIntegrationMock).toHaveBeenCalledWith(
      "int_1",
      expect.objectContaining({
        name: "Example Guild #camel",
        config: expect.stringContaining('"binding_version":7'),
      }),
      "user_1",
    );
    expect(bridgeFetch.mock.calls.map(([request]) => new URL(request.url).pathname)).toEqual([
      "/internal/v1/guilds/guild_1/channels",
      "/internal/v1/bindings/int_1",
      "/internal/v1/bindings/activate",
    ]);
  });

  it("lists channels from the staged reauthorization guild", async () => {
    isOrgAdminMock.mockResolvedValue(true);
    getIntegrationMock.mockResolvedValue(makeRecord({
      integration_type: "discord_channel",
      name: "Existing Guild #general",
      category: "communication",
      auth_method: "oauth2",
      config: JSON.stringify({
        schema_version: 1,
        status: "active",
        application_id: "123456789012345678",
        guild_id: "guild_old",
        guild_name: "Existing Guild",
        parent_channel_id: "channel_old",
        parent_channel_name: "general",
        bot_user_id: "123456789012345678",
        binding_version: 7,
        message_content_mode: "full",
        pending_reauthorization: {
          activation_attempt_id: "reauthorization-attempt",
          application_id: "123456789012345678",
          guild_id: "guild_new",
          guild_name: "Replacement Guild",
          bot_user_id: "123456789012345678",
          message_content_mode: "full",
        },
      }),
    }));
    const bridgeFetch = vi.fn(async (request: Request) => {
      expect(new URL(request.url).pathname).toBe(
        "/internal/v1/guilds/guild_new/channels",
      );
      return Response.json({
        ok: true,
        guild: { id: "guild_new", name: "Replacement Guild" },
        channels: [],
      });
    });
    setEnv({
      DISCORD_CHANNEL_ENABLED: "true",
      DISCORD_BRIDGE: { fetch: bridgeFetch },
    });

    await expect(action({
      request: postForm({
        intent: "discordListChannels",
        integrationId: "int_1",
      }),
      context: {},
      params: {},
    } as never)).resolves.toMatchObject({
      success: true,
      discordSetup: {
        integrationId: "int_1",
        guild: { id: "guild_new", name: "Replacement Guild" },
      },
    });
    expect(bridgeFetch).toHaveBeenCalledOnce();
  });

  it("completes same-channel reauthorization without replaying a finalized activation", async () => {
    isOrgAdminMock.mockResolvedValue(true);
    let record = makeRecord({
      integration_type: "discord_channel",
      name: "Example Guild #camel",
      category: "communication",
      auth_method: "oauth2",
      config: JSON.stringify({
        schema_version: 1,
        status: "active",
        application_id: "123456789012345678",
        guild_id: "guild_1",
        guild_name: "Example Guild",
        parent_channel_id: "channel_1",
        parent_channel_name: "camel",
        bot_user_id: "123456789012345678",
        binding_version: 7,
        message_content_mode: "full",
        pending_reauthorization: {
          activation_attempt_id: "fresh-reauthorization-attempt",
          application_id: "123456789012345678",
          guild_id: "guild_1",
          guild_name: "Renamed Guild",
          bot_user_id: "123456789012345678",
          message_content_mode: "mention_only",
        },
      }),
    });
    getIntegrationMock.mockImplementation(async () => record);
    updateIntegrationMock.mockImplementation(async (_id, updates) => {
      record = {
        ...record,
        ...(updates.name ? { name: updates.name } : {}),
        ...(updates.config ? { config: updates.config } : {}),
      };
    });
    const binding = {
      guildId: "guild_1",
      parentChannelId: "channel_1",
      integrationId: "int_1",
      orgId: "org_1",
      workspaceId: "ws_1",
      guildName: "Example Guild",
      parentChannelName: "camel",
      status: "active",
      version: 7,
    };
    const bridgeFetch = vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (request.method === "GET") {
        expect(path).toBe("/internal/v1/bindings/int_1");
        return Response.json({ ok: true, binding });
      }
      expect(path).toBe("/internal/v1/bindings/activate");
      return Response.json({
        ok: true,
        binding: { ...binding, guildName: "Renamed Guild" },
        previousBinding: binding,
        confirmationMessageIds: ["confirmation-1"],
      });
    });
    setEnv({
      DISCORD_CHANNEL_ENABLED: "true",
      DISCORD_BRIDGE: { fetch: bridgeFetch },
    });

    await expect(action({
      request: postForm({
        intent: "discordActivateChannel",
        integrationId: "int_1",
        parentChannelId: "channel_1",
        securityAcknowledged: "true",
      }),
      context: {},
      params: {},
    } as never)).resolves.toEqual({ success: true });

    expect(bridgeFetch).toHaveBeenCalledTimes(2);
    expect(updateIntegrationMock).toHaveBeenCalledOnce();
    expect(record.name).toBe("Renamed Guild #camel");
    const config = JSON.parse(record.config);
    expect(config).toMatchObject({
      status: "active",
      guild_id: "guild_1",
      guild_name: "Renamed Guild",
      parent_channel_id: "channel_1",
      binding_version: 7,
      message_content_mode: "mention_only",
    });
    expect(config).not.toHaveProperty("pending_reauthorization");
    expect(config).not.toHaveProperty("activation_attempt_id");
  });

  it("clears a pending chat setup once after confirmation and exact binding persistence", async () => {
    isOrgAdminMock.mockResolvedValue(true);
    let record = makeRecord({
      integration_type: "discord_channel",
      name: "Example Guild",
      category: "communication",
      auth_method: "oauth2",
      config: JSON.stringify({
        schema_version: 1,
        status: "pending_channel",
        application_id: "123456789012345678",
        guild_id: "guild_1",
        guild_name: "Example Guild",
        bot_user_id: "123456789012345678",
        message_content_mode: "full",
        activation_attempt_id: "attempt-chat-setup",
        pending_setup: {
          request_id: "request-1",
          thread_id: "thread-1",
          return_path: "/chat/thread-1",
          created_at: 123,
        },
      }),
    });
    getIntegrationMock.mockImplementation(async () => record);
    updateIntegrationMock.mockImplementation(async (_id, updates) => {
      record = {
        ...record,
        ...(updates.name ? { name: updates.name } : {}),
        ...(updates.config ? { config: updates.config } : {}),
      };
    });
    const receiveConnectionSetupResponse = vi.fn(async () => ({ accepted: true }));
    let live = false;
    const binding = {
      guildId: "guild_1",
      parentChannelId: "channel_1",
      integrationId: "int_1",
      orgId: "org_1",
      workspaceId: "ws_1",
      guildName: "Example Guild",
      parentChannelName: "camel",
      status: "active",
      version: 7,
    };
    const mutationPaths: string[] = [];
    const bridgeFetch = vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path === "/internal/v1/bindings/int_1") {
        return live
          ? Response.json({ ok: true, binding })
          : Response.json(
              { ok: false, error: "binding_not_found" },
              { status: 404 },
            );
      }
      mutationPaths.push(path);
      if (path === "/internal/v1/bindings/activate") {
        live = true;
        return Response.json({
          ok: true,
          binding,
          previousBinding: null,
          confirmationMessageIds: ["confirmation-1"],
        });
      }
      return Response.json({ ok: true });
    });
    setEnv({
      DISCORD_CHANNEL_ENABLED: "true",
      DISCORD_BRIDGE: { fetch: bridgeFetch },
      CHAT_THREAD: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({ receiveConnectionSetupResponse })),
      },
    });

    const activate = () => action({
      request: postForm({
        intent: "discordActivateChannel",
        integrationId: "int_1",
        parentChannelId: "channel_1",
        securityAcknowledged: "true",
      }),
      context: {},
      params: {},
    } as never);

    await expect(activate()).resolves.toEqual({
      success: true,
      returnTo: "/chat/thread-1",
    });
    // The chat that asked runs on the agent runtime: nothing waits in ChatThreadDO.
    expect(receiveConnectionSetupResponse).not.toHaveBeenCalled();
    expect(JSON.parse(record.config)).not.toHaveProperty("pending_setup");
    await expect(activate()).resolves.toEqual({ success: true });
    expect(receiveConnectionSetupResponse).not.toHaveBeenCalled();
    expect(mutationPaths.filter((path) => path === "/internal/v1/bindings/activate")).toHaveLength(1);
  });

  it("retries setup cleanup after a failed record write", async () => {
    isOrgAdminMock.mockResolvedValue(true);
    let record = makeRecord({
      integration_type: "discord_channel",
      name: "Example Guild #camel",
      category: "communication",
      auth_method: "oauth2",
      config: JSON.stringify({
        schema_version: 1,
        status: "active",
        application_id: "123456789012345678",
        guild_id: "guild_1",
        guild_name: "Example Guild",
        parent_channel_id: "channel_1",
        parent_channel_name: "camel",
        bot_user_id: "123456789012345678",
        binding_version: 7,
        message_content_mode: "full",
        pending_setup: {
          request_id: "request-1",
          thread_id: "thread-1",
          return_path: "/chat/thread-1",
          created_at: 123,
        },
      }),
    });
    getIntegrationMock.mockImplementation(async () => record);
    updateIntegrationMock
      .mockRejectedValueOnce(new Error("transient config write failure"))
      .mockImplementationOnce(async (_id, updates) => {
        record = {
          ...record,
          ...(updates.config ? { config: updates.config } : {}),
        };
      });
    const receiveConnectionSetupResponse = vi.fn(
      async () => ({ accepted: true }),
    );
    const binding = {
      guildId: "guild_1",
      parentChannelId: "channel_1",
      integrationId: "int_1",
      orgId: "org_1",
      workspaceId: "ws_1",
      guildName: "Example Guild",
      parentChannelName: "camel",
      status: "active",
      version: 7,
    };
    setEnv({
      DISCORD_CHANNEL_ENABLED: "true",
      DISCORD_BRIDGE: {
        fetch: vi.fn(async () => Response.json({ ok: true, binding })),
      },
      CHAT_THREAD: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({ receiveConnectionSetupResponse })),
      },
    });
    const activate = () => action({
      request: postForm({
        intent: "discordActivateChannel",
        integrationId: "int_1",
        parentChannelId: "channel_1",
        securityAcknowledged: "true",
      }),
      context: {},
      params: {},
    } as never);

    await expect(activate()).resolves.toEqual({
      error: "Discord is connected, but its connection record could not be updated: transient config write failure",
    });
    expect(JSON.parse(record.config)).toHaveProperty("pending_setup");

    await expect(activate()).resolves.toEqual({
      success: true,
      returnTo: "/chat/thread-1",
    });
    expect(receiveConnectionSetupResponse).not.toHaveBeenCalled();
    expect(JSON.parse(record.config)).not.toHaveProperty("pending_setup");
  });

  it("keeps an activated bridge binding when product projection persistence fails", async () => {
    isOrgAdminMock.mockResolvedValue(true);
    getIntegrationMock.mockResolvedValue(makeRecord({
      integration_type: "discord_channel",
      category: "communication",
      auth_method: "oauth2",
      config: JSON.stringify({
        schema_version: 1,
        status: "pending_channel",
        application_id: "app_1",
        guild_id: "guild_1",
        guild_name: "Example Guild",
        message_content_mode: "full",
        activation_attempt_id: "attempt-persistence-failure",
      }),
    }));
    updateIntegrationMock.mockRejectedValueOnce(new Error("product persistence failed"));
    const bridgeFetch = vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path === "/internal/v1/bindings/int_1") {
        return Response.json(
          { ok: false, error: "binding_not_found" },
          { status: 404 },
        );
      }
      if (path === "/internal/v1/bindings/activate") {
        return Response.json({
          ok: true,
          binding: {
            guildId: "guild_1",
            parentChannelId: "channel_1",
            integrationId: "int_1",
            orgId: "org_1",
            workspaceId: "ws_1",
            guildName: "Example Guild",
            parentChannelName: "camel",
            version: 8,
          },
          previousBinding: null,
          confirmationMessageIds: ["confirmation-1"],
        });
      }
      return Response.json({ ok: false, error: "not_found" }, { status: 404 });
    });
    setEnv({
      DISCORD_CHANNEL_ENABLED: "true",
      DISCORD_BRIDGE: { fetch: bridgeFetch },
    });

    await expect(action({
      request: postForm({
        intent: "discordActivateChannel",
        integrationId: "int_1",
        parentChannelId: "channel_1",
        securityAcknowledged: "true",
      }),
      context: {},
      params: {},
    } as never)).resolves.toEqual({
      error: "Discord is connected, but its connection record could not be updated: product persistence failed",
    });
    expect(bridgeFetch.mock.calls.map(([request]) => request.method)).toEqual([
      "GET",
      "POST",
    ]);
  });

  it("leaves the product projection untouched when bridge activation fails", async () => {
    isOrgAdminMock.mockResolvedValue(true);
    getIntegrationMock.mockResolvedValue(makeRecord({
      integration_type: "discord_channel",
      category: "communication",
      auth_method: "oauth2",
      config: JSON.stringify({
        schema_version: 1,
        status: "active",
        application_id: "app_1",
        guild_id: "guild_1",
        guild_name: "Example Guild",
        parent_channel_id: "channel_old",
        parent_channel_name: "old-camel",
        binding_version: 4,
        message_content_mode: "full",
        pending_reauthorization: {
          activation_attempt_id: "attempt-replacement",
          application_id: "app_1",
          guild_id: "guild_1",
          guild_name: "Example Guild",
          message_content_mode: "full",
        },
        pending_setup: {
          request_id: "request-1",
          thread_id: "thread-1",
          return_path: "/chat/thread-1",
          created_at: 123,
        },
      }),
    }));
    const activationPaths: string[] = [];
    const bridgeFetch = vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path === "/internal/v1/bindings/int_1") {
        return Response.json({
          ok: true,
          binding: {
            guildId: "guild_1",
            parentChannelId: "channel_old",
            integrationId: "int_1",
            orgId: "org_1",
            workspaceId: "ws_1",
            guildName: "Example Guild",
            parentChannelName: "old-camel",
            status: "active",
            version: 4,
          },
        });
      }
      if (path === "/internal/v1/bindings/activate") {
        activationPaths.push(path);
        const body = await request.json() as {
          idempotencyKey: string;
          expectedVersion: number;
        };
        expect(body.idempotencyKey).toBe(
          "discord-binding-activation:int_1:attempt-replacement:guild_1:channel_new",
        );
        expect(body.expectedVersion).toBe(4);
        return Response.json({
          ok: false,
          error: "missing_permissions",
          message: "Send Messages in Threads is missing",
        }, { status: 403 });
      }
      return Response.json({ ok: false, error: "not_found" }, { status: 404 });
    });
    setEnv({
      DISCORD_CHANNEL_ENABLED: "true",
      DISCORD_BRIDGE: { fetch: bridgeFetch },
    });

    await expect(action({
      request: postForm({
        intent: "discordActivateChannel",
        integrationId: "int_1",
        parentChannelId: "channel_new",
        securityAcknowledged: "true",
      }),
      context: {},
      params: {},
    } as never)).resolves.toEqual({
      error: "Discord could not confirm and activate the channel: Send Messages in Threads is missing",
    });

    expect(activationPaths).toEqual(["/internal/v1/bindings/activate"]);
    expect(updateIntegrationMock).not.toHaveBeenCalled();
  });

  it("uses a new target-scoped activation id when retrying another channel", async () => {
    isOrgAdminMock.mockResolvedValue(true);
    let record = makeRecord({
      integration_type: "discord_channel",
      name: "Example Guild #old-camel",
      category: "communication",
      auth_method: "oauth2",
      config: JSON.stringify({
        schema_version: 1,
        status: "active",
        application_id: "app_1",
        guild_id: "guild_1",
        guild_name: "Example Guild",
        parent_channel_id: "channel_old",
        parent_channel_name: "old-camel",
        binding_version: 4,
        message_content_mode: "full",
        pending_reauthorization: {
          activation_attempt_id: "attempt-target-retry",
          application_id: "app_1",
          guild_id: "guild_1",
          guild_name: "Example Guild",
          message_content_mode: "full",
        },
      }),
    });
    getIntegrationMock.mockImplementation(async () => record);
    updateIntegrationMock.mockImplementation(async (_id, updates) => {
      record = {
        ...record,
        ...(updates.name ? { name: updates.name } : {}),
        ...(updates.config ? { config: updates.config } : {}),
      };
    });
    const previousBinding = {
      guildId: "guild_1",
      parentChannelId: "channel_old",
      integrationId: "int_1",
      orgId: "org_1",
      workspaceId: "ws_1",
      guildName: "Example Guild",
      parentChannelName: "old-camel",
      status: "active",
      version: 4,
    };
    const preparedIds: string[] = [];
    const bridgeFetch = vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path === "/internal/v1/bindings/int_1") {
        return Response.json({ ok: true, binding: previousBinding });
      }
      if (path === "/internal/v1/bindings/activate") {
        const body = await request.json() as {
          guildId: string;
          parentChannelId: string;
          idempotencyKey: string;
          expectedVersion: number;
        };
        expect(body).toMatchObject({
          guildId: "guild_1",
          expectedVersion: 4,
        });
        preparedIds.push(body.idempotencyKey);
        if (body.parentChannelId === "channel_a") {
          return Response.json({
            ok: false,
            error: "missing_permissions",
            message: "Send Messages in Threads is missing",
          }, { status: 403 });
        }
        return Response.json({
          ok: true,
          binding: {
            ...previousBinding,
            parentChannelId: body.parentChannelId,
            parentChannelName: "channel-b",
            version: 5,
          },
          previousBinding,
          confirmationMessageIds: ["confirmation-1"],
        });
      }
      return Response.json({ ok: false, error: "not_found" }, { status: 404 });
    });
    setEnv({
      DISCORD_CHANNEL_ENABLED: "true",
      DISCORD_BRIDGE: { fetch: bridgeFetch },
    });
    const activate = (parentChannelId: string) => action({
      request: postForm({
        intent: "discordActivateChannel",
        integrationId: "int_1",
        parentChannelId,
        securityAcknowledged: "true",
      }),
      context: {},
      params: {},
    } as never);

    await expect(activate("channel_a")).resolves.toEqual({
      error:
        "Discord could not confirm and activate the channel: Send Messages in Threads is missing",
    });
    await expect(activate("channel_b")).resolves.toEqual({ success: true });

    const transactionA =
      "discord-binding-activation:int_1:attempt-target-retry:guild_1:channel_a";
    const transactionB =
      "discord-binding-activation:int_1:attempt-target-retry:guild_1:channel_b";
    expect(preparedIds).toEqual([transactionA, transactionB]);
    expect(transactionA).not.toBe(transactionB);
    expect(transactionA).toContain(":attempt-target-retry:");
    expect(transactionB).toContain(":attempt-target-retry:");
    const config = JSON.parse(record.config);
    expect(config).toMatchObject({
      status: "active",
      guild_id: "guild_1",
      parent_channel_id: "channel_b",
      parent_channel_name: "channel-b",
      binding_version: 5,
    });
    expect(config).not.toHaveProperty("activation_attempt_id");
    expect(config).not.toHaveProperty("pending_reauthorization");
  });

  it("requires the Discord delegated-access acknowledgement before claiming a channel", async () => {
    isOrgAdminMock.mockResolvedValue(true);
    const bridgeFetch = vi.fn();
    setEnv({
      DISCORD_CHANNEL_ENABLED: "true",
      DISCORD_BRIDGE: { fetch: bridgeFetch },
    });

    await expect(action({
      request: postForm({
        intent: "discordActivateChannel",
        integrationId: "int_1",
        parentChannelId: "channel_1",
      }),
      context: {},
      params: {},
    } as never)).resolves.toEqual({
      error: "Acknowledge the Discord channel security boundary before connecting",
    });
    expect(bridgeFetch).not.toHaveBeenCalled();
  });

  it("releases before disconnecting and clears stale binding metadata for reconnect", async () => {
    isOrgAdminMock.mockResolvedValue(true);
    getIntegrationMock.mockResolvedValue(makeRecord({
      integration_type: "discord_channel",
      category: "communication",
      auth_method: "oauth2",
      config: JSON.stringify({
        schema_version: 1,
        status: "active",
        application_id: "123456789012345678",
        guild_id: "guild_1",
        guild_name: "Example Guild",
        parent_channel_id: "channel_1",
        parent_channel_name: "camel",
        bot_user_id: "123456789012345678",
        binding_version: 7,
        message_content_mode: "full",
      }),
    }));
    const events: string[] = [];
    updateIntegrationMock.mockImplementationOnce(async () => {
      events.push("persist-disconnected");
    });
    const bridgeFetch = vi.fn(async (request: Request) => {
      if (request.method === "GET") {
        return Response.json({
          ok: true,
          binding: {
            guildId: "guild_1",
            parentChannelId: "channel_1",
            integrationId: "int_1",
            orgId: "org_1",
            workspaceId: "ws_1",
            guildName: "Example Guild",
            parentChannelName: "camel",
            version: 9,
          },
        });
      }
      events.push("release-binding");
      expect(request.method).toBe("DELETE");
      expect(new URL(request.url).searchParams.get("version")).toBe("9");
      return Response.json({ ok: true, released: true });
    });
    setEnv({
      DISCORD_CHANNEL_ENABLED: "true",
      DISCORD_BRIDGE: { fetch: bridgeFetch },
    });

    await expect(action({
      request: postForm({ intent: "discordDisconnect", integrationId: "int_1" }),
      context: {},
      params: {},
    } as never)).resolves.toEqual({ success: true });

    expect(events).toEqual(["release-binding", "persist-disconnected"]);
    const persistedConfig = JSON.parse(
      String(updateIntegrationMock.mock.calls[0]?.[1]?.config),
    );
    expect(persistedConfig).toMatchObject({ status: "disconnected" });
    expect(persistedConfig).not.toHaveProperty("parent_channel_id");
    expect(persistedConfig).not.toHaveProperty("parent_channel_name");
    expect(persistedConfig).not.toHaveProperty("binding_version");
  });

  it("releases a Discord binding before deleting its integration record", async () => {
    isOrgAdminMock.mockResolvedValue(true);
    getIntegrationMock.mockResolvedValue(makeRecord({
      integration_type: "discord_channel",
      category: "communication",
      auth_method: "oauth2",
      config: JSON.stringify({
        schema_version: 1,
        status: "active",
        application_id: "123456789012345678",
        guild_id: "guild_1",
        guild_name: "Example Guild",
        parent_channel_id: "channel_1",
        parent_channel_name: "camel",
        binding_version: 7,
        message_content_mode: "full",
      }),
    }));
    const events: string[] = [];
    deleteIntegrationMock.mockImplementationOnce(async () => {
      events.push("delete-integration");
    });
    const bridgeFetch = vi.fn(async (request: Request) => {
      if (request.method === "GET") {
        return Response.json({
          ok: true,
          binding: {
            guildId: "guild_1",
            parentChannelId: "channel_1",
            integrationId: "int_1",
            orgId: "org_1",
            workspaceId: "ws_1",
            guildName: "Example Guild",
            parentChannelName: "camel",
            version: 9,
          },
        });
      }
      events.push("release-binding");
      expect(request.method).toBe("DELETE");
      expect(new URL(request.url).pathname).toBe("/internal/v1/bindings/int_1");
      expect(new URL(request.url).searchParams.get("version")).toBe("9");
      return Response.json({ ok: true, released: true });
    });
    setEnv({ DISCORD_BRIDGE: { fetch: bridgeFetch } });

    await expect(action({
      request: postForm({ intent: "deleteIntegration", integrationId: "int_1" }),
      context: {},
      params: {},
    } as never)).resolves.toEqual({ success: true });

    expect(events).toEqual(["release-binding", "delete-integration"]);
  });

  it("preserves a Discord integration when a version-guarded release loses a race", async () => {
    isOrgAdminMock.mockResolvedValue(true);
    getIntegrationMock.mockResolvedValue(makeRecord({
      integration_type: "discord_channel",
      category: "communication",
      auth_method: "oauth2",
      config: JSON.stringify({
        schema_version: 1,
        status: "active",
        application_id: "123456789012345678",
        guild_id: "guild_1",
        guild_name: "Example Guild",
        parent_channel_id: "channel_1",
        parent_channel_name: "camel",
        binding_version: 7,
        message_content_mode: "full",
      }),
    }));
    const bridgeFetch = vi.fn(async (request: Request) => {
      if (request.method === "GET") {
        return Response.json({
          ok: true,
          binding: {
            guildId: "guild_1",
            parentChannelId: "channel_1",
            integrationId: "int_1",
            orgId: "org_1",
            workspaceId: "ws_1",
            guildName: "Example Guild",
            parentChannelName: "camel",
            version: 8,
          },
        });
      }
      expect(new URL(request.url).searchParams.get("version")).toBe("8");
      return Response.json(
        {
          ok: false,
          error: "binding_mismatch",
          message: "Discord binding changed; refresh and try again",
        },
        { status: 409 },
      );
    });
    setEnv({ DISCORD_BRIDGE: { fetch: bridgeFetch } });

    await expect(action({
      request: postForm({ intent: "deleteIntegration", integrationId: "int_1" }),
      context: {},
      params: {},
    } as never)).resolves.toEqual({
      error: "Failed to release Discord channel: Discord binding changed; refresh and try again",
    });

    expect(bridgeFetch).toHaveBeenCalledTimes(2);
    expect(deleteIntegrationMock).not.toHaveBeenCalled();
  });

  it("activates from bridge state when the product projection is stale", async () => {
    isOrgAdminMock.mockResolvedValue(true);
    getIntegrationMock.mockResolvedValue(makeRecord({
      integration_type: "discord_channel",
      category: "communication",
      auth_method: "oauth2",
      config: JSON.stringify({
        schema_version: 1,
        status: "active",
        application_id: "123456789012345678",
        guild_id: "guild_1",
        guild_name: "Example Guild",
        parent_channel_id: "stale-channel",
        parent_channel_name: "stale",
        bot_user_id: "123456789012345678",
        binding_version: 7,
        message_content_mode: "full",
        activation_attempt_id: "attempt-stale-record",
      }),
    }));
    const paths: string[] = [];
    const bridgeFetch = vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname;
      paths.push(path);
      if (request.method === "GET") {
        return Response.json(
          { ok: false, error: "binding_not_found" },
          { status: 404 },
        );
      }
      if (path === "/internal/v1/bindings/activate") {
        return Response.json({
          ok: true,
          binding: {
            guildId: "guild_1",
            parentChannelId: "channel_1",
            integrationId: "int_1",
            orgId: "org_1",
            workspaceId: "ws_1",
            guildName: "Example Guild",
            parentChannelName: "camel",
            version: 8,
          },
          previousBinding: null,
          confirmationMessageIds: ["confirmation-1"],
        });
      }
      return Response.json({ ok: false, error: "not_found" }, { status: 404 });
    });
    setEnv({
      DISCORD_CHANNEL_ENABLED: "true",
      DISCORD_BRIDGE: { fetch: bridgeFetch },
    });

    await expect(action({
      request: postForm({
        intent: "discordActivateChannel",
        integrationId: "int_1",
        parentChannelId: "channel_1",
        securityAcknowledged: "true",
      }),
      context: {},
      params: {},
    } as never)).resolves.toEqual({ success: true });
    expect(paths).toEqual([
      "/internal/v1/bindings/int_1",
      "/internal/v1/bindings/activate",
    ]);
  });

  it("creates Telegram setup records and returns the setup deep link", async () => {
    isOrgAdminMock.mockResolvedValue(true);

    const response = await action({
      request: postForm({
        intent: "createIntegration",
        integration_type: "telegram",
        name: "Team Telegram",
        config: JSON.stringify({}),
        credentials: JSON.stringify({}),
      }),
      context: {},
      params: {},
    } as never);

    expect(response).toMatchObject({ success: true });
    expect(response.oauthUrl).toContain("https://t.me/camelai_test_bot?start=");
    const [integrationId, , , , , configJson, credentialsEncrypted] =
      createIntegrationMock.mock.calls[0];
    expect(JSON.parse(configJson)).toMatchObject({
      status: "pending",
      bot_username: "camelai_test_bot",
    });
    expect(credentialsEncrypted).toEqual(expect.any(String));
    expect(putSetupTokenMock).toHaveBeenCalledWith(
      JSON.parse(configJson).setup_token,
      {
        workspaceId: "ws_1",
        orgId: "org_1",
        integrationId,
        userId: "user_1",
      },
      30 * 60,
    );
  });

  it("requires OAuth for native Discord and blocks new legacy token records", async () => {
    isOrgAdminMock.mockResolvedValue(true);

    await expect(action({
      request: postForm({
        intent: "createIntegration",
        integration_type: "discord_channel",
        name: "Discord",
        config: "{}",
        credentials: "{}",
      }),
      context: {},
      params: {},
    } as never)).resolves.toEqual({
      error: "Use Add Camel to Discord to create this connection",
    });
    await expect(action({
      request: postForm({
        intent: "createIntegration",
        integration_type: "discord",
        name: "Legacy Discord",
        config: JSON.stringify({ application_id: "app" }),
        credentials: JSON.stringify({ bot_token: "secret" }),
      }),
      context: {},
      params: {},
    } as never)).resolves.toEqual({
      error: "Discord bot token (legacy) can no longer be created",
    });
    expect(createIntegrationMock).not.toHaveBeenCalled();
  });

  it("normalizes remote MCP OAuth URLs and returns the follow-up OAuth URL", async () => {
    isOrgAdminMock.mockResolvedValue(true);

    const response = await action({
      request: postForm({
        intent: "createIntegration",
        integration_type: "remote_mcp",
        name: "Docs MCP",
        config: JSON.stringify({
          server_url: "https://mcp.example.com/mcp#token",
          auth_type: "oauth",
        }),
        credentials: JSON.stringify({}),
      }),
      context: {},
      params: {},
    } as never);

    expect(response).toMatchObject({ success: true });
    expect(response.oauthUrl).toContain("/api/integrations/remote_mcp/oauth?");
    expect(response.oauthUrl).toContain("redirect=%2Fconnections");
    const [integrationId, , , , , configJson, credentialsEncrypted] =
      createIntegrationMock.mock.calls[0];
    expect(JSON.parse(configJson)).toEqual({
      server_url: "https://mcp.example.com/mcp",
      auth_type: "oauth",
    });
    expect(credentialsEncrypted).toBe("");
    expect(response.oauthUrl).toContain(`integration_id=${integrationId}`);
  });

  it("creates a discovered MCP surface as a remote MCP OAuth connection", async () => {
    isOrgAdminMock.mockResolvedValue(true);
    discoverSurfacesMock.mockResolvedValue([{
      schemaVersion: 1,
      slug: "example-mcp",
      displayName: "Example MCP",
      surface: "mcp",
      source: "discovered",
      sourceUrl: "https://integrations.sh/api/example.com/surface",
      baseUrl: "https://mcp.example.com/mcp",
      auth: [{ kind: "oauth2" }],
      operations: [],
      provenance: { kind: "discovered" },
    }]);

    const response = await action({
      request: postForm({
        intent: "createDiscoveredIntegration",
        source_url: "https://example.com",
        surface_slug: "example-mcp",
        name: "Example MCP",
        auth_type: "oauth2",
        operation_policy: "read_only",
        credentials: "{}",
      }),
      context: {},
      params: {},
    } as never);

    expect(response).toMatchObject({ success: true });
    expect(response.oauthUrl).toContain("/api/integrations/remote_mcp/oauth?");
    const [, integrationType, name, , , configJson, credentialsEncrypted] = createIntegrationMock.mock.calls[0];
    expect(integrationType).toBe("remote_mcp");
    expect(name).toBe("Example MCP");
    expect(JSON.parse(configJson)).toEqual({
      server_url: "https://mcp.example.com/mcp",
      auth_type: "oauth",
      discovery_source: "https://integrations.sh/api/example.com/surface",
    });
    expect(credentialsEncrypted).toBe("");
    expect(createDefinitionMock).not.toHaveBeenCalled();
  });

  it("persists a discovered GraphQL surface with generic fetch and a guarded operation", async () => {
    isOrgAdminMock.mockResolvedValue(true);
    discoverSurfacesMock.mockResolvedValue([{
      schemaVersion: 1,
      slug: "example-graphql",
      displayName: "Example GraphQL",
      surface: "graphql",
      source: "discovered",
      sourceUrl: "https://integrations.sh/api/example.com/surface",
      baseUrl: "https://api.example.com/graphql",
      auth: [{ kind: "none" }],
      operations: [{
        id: "graphql.execute",
        name: "executeGraphql",
        method: "POST",
        path: "",
        access: "write",
      }],
      provenance: { kind: "discovered" },
    }]);

    const response = await action({
      request: postForm({
        intent: "createDiscoveredIntegration",
        source_url: "https://example.com",
        surface_slug: "example-graphql",
        name: "Example GraphQL",
        auth_type: "none",
        operation_policy: "read_only",
        credentials: "{}",
      }),
      context: {},
      params: {},
    } as never);

    expect(response).toMatchObject({ success: true });
    expect(createDefinitionMock).toHaveBeenCalledWith(
      expect.any(String),
      "example-graphql",
      expect.stringContaining('"surface":"graphql"'),
      "discovered",
      "https://integrations.sh/api/example.com/surface",
      "user_1",
    );
    const [, integrationType, , , , configJson, credentialsEncrypted] = createIntegrationMock.mock.calls[0];
    expect(integrationType).toBe("other");
    expect(JSON.parse(configJson)).toMatchObject({
      base_url: "https://api.example.com/graphql",
      operation_policy: "read_only",
      restrict_to_base_origin: true,
      generic_fetch_enabled: true,
    });
    expect(credentialsEncrypted).toBe("");
  });

  it("resolves tenant URL variables before persisting a discovered connection", async () => {
    isOrgAdminMock.mockResolvedValue(true);
    discoverSurfacesMock.mockResolvedValue([{
      schemaVersion: 1,
      slug: "shopify-graphql",
      displayName: "Shopify GraphQL",
      surface: "graphql",
      source: "discovered",
      sourceUrl: "https://integrations.sh/api/shopify.com/surface",
      baseUrl: "https://{shop}.myshopify.com/admin/api/%7Bapi_version%7D/graphql.json",
      auth: [{ kind: "unknown" }],
      variables: [
        { name: "shop", in: "url" },
        { name: "api_version", in: "url" },
      ],
      warnings: ["The discovered endpoint is hosted outside shopify.com."],
      operations: [{
        id: "graphql.execute",
        name: "executeGraphql",
        method: "POST",
        path: "",
        access: "write",
      }],
      provenance: { kind: "discovered" },
    }]);

    const unconfirmedResponse = await action({
      request: postForm({
        intent: "createDiscoveredIntegration",
        source_url: "https://shopify.com",
        surface_slug: "shopify-graphql",
        name: "Storefront",
        auth_type: "bearer",
        operation_policy: "read_only",
        credentials: JSON.stringify({ api_key: "shop-token" }),
        surface_variables: JSON.stringify({ shop: "acme-store", api_version: "2026-07" }),
      }),
      context: {},
      params: {},
    } as never);

    expect(unconfirmedResponse).toEqual({
      error: "Confirm the integrations.sh endpoint before creating this connection",
    });
    expect(createIntegrationMock).not.toHaveBeenCalled();

    const response = await action({
      request: postForm({
        intent: "createDiscoveredIntegration",
        source_url: "https://shopify.com",
        surface_slug: "shopify-graphql",
        name: "Storefront",
        auth_type: "bearer",
        operation_policy: "read_only",
        credentials: JSON.stringify({ api_key: "shop-token" }),
        surface_variables: JSON.stringify({ shop: "acme-store", api_version: "2026-07" }),
        endpoint_confirmed: "true",
      }),
      context: {},
      params: {},
    } as never);

    expect(response).toMatchObject({ success: true });
    expect(createDefinitionMock).toHaveBeenCalledWith(
      expect.any(String),
      "shopify-graphql",
      expect.stringContaining("https://acme-store.myshopify.com/admin/api/2026-07/graphql.json"),
      "discovered",
      "https://integrations.sh/api/shopify.com/surface",
      "user_1",
    );
    const configJson = createIntegrationMock.mock.calls[0][5];
    expect(JSON.parse(configJson)).toMatchObject({
      base_url: "https://acme-store.myshopify.com/admin/api/2026-07/graphql.json",
      auth_type: "bearer",
    });
  });
});

describe("connections loader", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    requireAuthContextMock.mockResolvedValue({
      currentOrg: {
        id: "org_1",
        billing_plan: "starter",
        billing_status: "active",
      },
      currentWorkspace: {
        id: "ws_1",
        name: "Workspace",
        email_handle: "quiet-river-field",
        created_by: "creator_1",
        created_at: 50,
      },
      user: { id: "user_1" },
      workspaces: [
        { id: "ws_1", name: "Source" },
        { id: "ws_2", name: "Target" },
      ],
    });
    authUserGetMock.mockImplementation((id: string) => ({
      getProfile: () => authUserGetProfileMock(id),
    }));
    authUserGetProfileMock.mockImplementation(async (id: string) =>
      id === "creator_1"
        ? {
            id: "creator_1",
            name: "Creator One",
            email: "creator@example.com",
            avatar: null,
          }
        : null,
    );
    getAuthEnvMock.mockReturnValue({
      auth: true,
      USER: {
        idFromName: vi.fn((id: string) => id),
        get: authUserGetMock,
      },
    });
    setEnv();
    getIntegrationsMock.mockResolvedValue([]);
    listProjectsMock.mockResolvedValue([]);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("shows Discord only when configured bridge identity and heartbeat are healthy", async () => {
    const applicationId = "123456789012345678";
    getIntegrationsMock.mockResolvedValue([makeRecord({
      id: "discord-existing",
      integration_type: "discord_channel",
      name: "Support Discord",
      category: "communication",
      auth_method: "oauth2",
      config: JSON.stringify({
        schema_version: 1,
        status: "active",
        application_id: applicationId,
        guild_id: "guild-1",
        guild_name: "Camel",
        parent_channel_id: "channel-1",
        parent_channel_name: "support",
        bot_user_id: applicationId,
        binding_version: 1,
        message_content_mode: "full",
      }),
      verification_status: "ready",
      verification_message: "Discord channel is ready",
      verification_checked_at: Date.now(),
      verification_live: 1,
      verification_strategy: "discord_channel_access",
    })]);
    const statusFetch = vi.fn(async () => Response.json({
      ok: true,
      applicationId,
      botUserId: applicationId,
      readiness: { ready: false, reason: "ingress_disabled" },
      gateway: {
        state: "ready",
        heartbeatIntervalMs: 45_000,
        lastHeartbeatAckAt: Date.now(),
      },
    }));
    setEnv({
      DISCORD_CHANNEL_ENABLED: "true",
      DISCORD_CLIENT_ID: applicationId,
      DISCORD_CLIENT_SECRET: "test-discord-client-secret-value",
      DISCORD_BRIDGE: { fetch: statusFetch },
    });

    const healthy = await loader({
      request: new Request("https://camelai.test/connections"),
      context: {},
      params: {},
    } as never);
    expect(healthy.integrations.map((integration) => integration.type))
      .toContain("discord_channel");
    await expect(healthy.pageData).resolves.toMatchObject({
      connections: [expect.objectContaining({
        id: "discord-existing",
        verification: expect.objectContaining({
          status: "degraded",
          message: "Discord channels are unavailable in this environment.",
        }),
      })],
    });
    getIntegrationsMock.mockResolvedValue([]);

    setEnv({
      DISCORD_CHANNEL_ENABLED: "true",
      DISCORD_CLIENT_ID: applicationId,
      DISCORD_CLIENT_SECRET: "test-discord-client-secret-value",
      DISCORD_BRIDGE: {
        fetch: vi.fn(async () => Response.json({
          ok: true,
          applicationId,
          botUserId: applicationId,
          readiness: { ready: false, reason: "outbound_disabled" },
          gateway: {
            state: "ready",
            heartbeatIntervalMs: 45_000,
            lastHeartbeatAckAt: Date.now(),
          },
        })),
      },
    });
    const outboundDisabled = await loader({
      request: new Request("https://camelai.test/connections"),
      context: {},
      params: {},
    } as never);
    expect(outboundDisabled.integrations.map((integration) => integration.type))
      .not.toContain("discord_channel");

    setEnv({
      DISCORD_CHANNEL_ENABLED: "true",
      DISCORD_CLIENT_ID: applicationId,
      DISCORD_CLIENT_SECRET: "test-discord-client-secret-value",
      DISCORD_BRIDGE: {
        fetch: vi.fn(async () => Response.json({
          ok: true,
          applicationId,
          botUserId: applicationId,
          readiness: { ready: false, reason: "heartbeat_stale" },
          gateway: {
            state: "ready",
            heartbeatIntervalMs: 45_000,
            lastHeartbeatAckAt: 1,
          },
        })),
      },
    });
    const stale = await loader({
      request: new Request("https://camelai.test/connections"),
      context: {},
      params: {},
    } as never);
    expect(stale.integrations.map((integration) => integration.type))
      .not.toContain("discord_channel");
  });

  it("keeps connection records when optional creator profile lookup fails", async () => {
    getIntegrationsMock.mockResolvedValue([
      makeRecord({ id: "pg_1", created_by: "missing_user" }),
    ]);
    authUserGetProfileMock.mockRejectedValue(new Error("profile lookup failed"));

    const result = await loader({
      request: new Request("https://camelai.test/connections"),
      context: {},
      params: {},
    } as never);

    await expect(result.pageData).resolves.toMatchObject({
      connections: [
        {
          id: "pg_1",
          name: "Primary DB",
          created_by_name: null,
          created_by_avatar: null,
        },
      ],
      projects: [],
    });
    expect(result).not.toHaveProperty("connections");
    expect(result).not.toHaveProperty("projects");
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "Failed to load workspace email creator profiles:",
      expect.any(Error),
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "Failed to load workspace connection creator profiles:",
      expect.any(Error),
    );
  });

  it("keeps pageData resolved with empty connections when integration loading fails", async () => {
    getIntegrationsMock.mockRejectedValue(new Error("integration list failed"));

    const result = await loader({
      request: new Request("https://camelai.test/connections"),
      context: {},
      params: {},
    } as never);

    await expect(result.pageData).resolves.toEqual({
      connections: [],
      projects: [],
    });
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "Failed to load workspace connections:",
      expect.any(Error),
    );
  });

  it("returns connection and project data through one stable pageData promise", async () => {
    getIntegrationsMock.mockResolvedValue([
      makeRecord({ id: "pg_1", created_by: "creator_1" }),
    ]);
    listProjectsMock.mockResolvedValue([
      {
        id: "ca-ws_1-query-tool",
        name: "Query Tool",
        description: "Project exposed to mentions",
        kind: "project",
        createdAt: "2026-06-10T12:00:00.000Z",
        updatedAt: "2026-06-11T12:00:00.000Z",
      },
    ]);

    const result = await loader({
      request: new Request("https://camelai.test/connections"),
      context: {},
      params: {},
    } as never);

    expect(result.pageData).toBeInstanceOf(Promise);
    await expect(result.pageData).resolves.toMatchObject({
      connections: [
        {
          id: "pg_1",
          name: "Primary DB",
          created_by_name: "Creator One",
        },
      ],
      projects: [
        {
          id: "ca-ws_1-query-tool",
          name: "Query Tool",
        },
      ],
    });
    expect(result).not.toHaveProperty("connections");
    expect(result).not.toHaveProperty("projects");
  });

  it("loads Slack metadata from config without exposing encrypted credentials", async () => {
    getIntegrationsMock.mockResolvedValue([
      {
        ...makeRecord({
          id: "slack_1",
          integration_type: "slack",
          name: "Slack Team",
          category: "communication",
          auth_method: "oauth2",
          config: JSON.stringify({
            team_id: "T123",
            team_name: "Camel Team",
            bot_user_id: "B123",
          }),
          credentials_encrypted: "not-used",
        }),
      },
    ]);

    const result = await loader({
      request: new Request("https://camelai.test/connections"),
      context: {},
      params: {},
    } as never);
    const { connections } = await result.pageData;
    const [connection] = connections;

    expect(connection.channelMetadata).toEqual({
      team_id: "T123",
      team_name: "Camel Team",
      bot_user_id: "B123",
    });
    expect(connection).not.toHaveProperty("credentials_encrypted");
  });

  it("falls back to decrypted Slack metadata server-side", async () => {
    getIntegrationsMock.mockResolvedValue([
      makeRecord({
        id: "slack_1",
        integration_type: "slack",
        name: "Slack Team",
        category: "communication",
        auth_method: "oauth2",
        config: JSON.stringify({}),
        credentials_encrypted: await encryptCredentials(
          {
            team_id: "T456",
            team_name: "Fallback Team",
            bot_user_id: "B456",
          },
          "test-secret",
        ),
      }),
    ]);

    const result = await loader({
      request: new Request("https://camelai.test/connections"),
      context: {},
      params: {},
    } as never);
    const { connections } = await result.pageData;
    const [connection] = connections;

    expect(connection.channelMetadata).toEqual({
      team_id: "T456",
      team_name: "Fallback Team",
      bot_user_id: "B456",
    });
    expect(connection).not.toHaveProperty("credentials_encrypted");
  });

  it("returns configured native email data and Starter plan enabled state", async () => {
    const result = await loader({
      request: new Request("https://camelai.test/connections"),
      context: {},
      params: {},
    } as never);

    expect(result.workspaceEmailAddress).toBe(
      "quiet-river-field@mail.camelai.test",
    );
    expect(result.emailInboxEnabled).toBe(true);
    expect(result.emailHandle).toBe("quiet-river-field");
    expect(result.workspaceCreatedByName).toBe("Creator One");
  });

  it("loads project mentionables for connection mention slug collisions", async () => {
    listProjectsMock.mockResolvedValue([
      {
        id: "ca-ws_1-primary-db",
        name: "Primary DB",
        description: "Project with colliding slug",
        kind: "project",
        createdAt: "2026-06-10T12:00:00.000Z",
        updatedAt: "2026-06-11T12:00:00.000Z",
        clones: [
          {
            id: "ca-ws_1-primary-db-v2",
            name: "Primary DB v2",
            description: "Clone excluded from mentions",
          },
        ],
      },
    ]);

    const result = await loader({
      request: new Request("https://camelai.test/connections"),
      context: {},
      params: {},
    } as never);

    await expect(result.pageData).resolves.toMatchObject({
      connections: [],
      projects: [
        {
          kind: "project",
          id: "ca-ws_1-primary-db",
          name: "Primary DB",
          description: "Project with colliding slug",
          created_at: Date.parse("2026-06-10T12:00:00.000Z"),
          updated_at: Date.parse("2026-06-11T12:00:00.000Z"),
        },
      ],
    });
  });

  it("keeps pageData resolved with empty projects when project loading fails", async () => {
    listProjectsMock.mockRejectedValue(new Error("project list failed"));

    const result = await loader({
      request: new Request("https://camelai.test/connections"),
      context: {},
      params: {},
    } as never);

    await expect(result.pageData).resolves.toEqual({
      connections: [],
      projects: [],
    });
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "Failed to load workspace projects:",
      expect.any(Error),
    );
  });

  it("handles missing email domain and plan-disabled states", async () => {
    requireAuthContextMock.mockResolvedValue({
      currentOrg: {
        id: "org_1",
        billing_plan: "free",
        billing_status: "active",
      },
      currentWorkspace: {
        id: "ws_1",
        name: "Workspace",
        email_handle: "quiet-river-field",
        created_by: "creator_1",
        created_at: 50,
      },
      user: { id: "user_1" },
      workspaces: [{ id: "ws_1", name: "Source" }],
    });
    setEnv({ WORKSPACE_EMAIL_DOMAIN: "" });

    const result = await loader({
      request: new Request("https://camelai.test/connections"),
      context: {},
      params: {},
    } as never);

    expect(result.workspaceEmailAddress).toBeNull();
    expect(result.emailInboxEnabled).toBe(false);
    expect(result.emailHandle).toBe("quiet-river-field");
  });
});
