import { afterEach, describe, expect, it, vi } from "vitest";
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { AdminMcpOAuthProvider } from "../src/admin-mcp-oauth";
import { getAppIndexDatabase } from "../src/app-index-db";
import { handleAdminMcp } from "../src/routes/admin-mcp";
import { handleOAuthMetadata, handleResourceMetadata } from "../src/routes/well-known";
import type { Env as WorkerEnv } from "../src/types";
import { action as tokenAction } from "../../../src/routes/api/admin.oauth.token";
import {
  createOrg,
  createUser,
  type TestEnv,
  updateUserProfile,
} from "./test-helpers";

const testEnv = env as unknown as TestEnv & WorkerEnv;

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

async function codeChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return base64url(new Uint8Array(hash));
}

async function issueAdminMcpToken(userId: string): Promise<string> {
  const oauth = new AdminMcpOAuthProvider(testEnv.APP_KV);
  const client = await oauth.registerClient({
    client_name: "Test MCP Client",
    redirect_uris: ["http://localhost:4321/callback"],
  });
  const verifier = `verifier-${crypto.randomUUID()}`;
  const resource = "https://example.com/api/admin/mcp";
  const code = await oauth.createAuthorizationCode({
    client_id: client.client_id,
    redirect_uri: client.redirect_uris[0],
    code_challenge: await codeChallenge(verifier),
    user_id: userId,
    resource,
  });
  const token = await oauth.exchangeAuthorizationCode(
    client.client_id,
    code,
    verifier,
    client.redirect_uris[0],
    resource,
  );
  return token.access_token;
}

function mcpRequest(body: unknown, token?: string): Request {
  return new Request("https://example.com/api/admin/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

function routeContext(req: Request) {
  const url = new URL(req.url);
  return {
    req,
    env: testEnv,
    ctx: {} as ExecutionContext,
    url,
    match: [] as unknown as RegExpMatchArray,
  };
}

function parseToolText(rpc: any) {
  return JSON.parse(rpc.result.content[0].text);
}

async function seedMcpChatErrors(prefix = `mcp-chat-errors-${crypto.randomUUID()}`) {
  const appIndex = getAppIndexDatabase(testEnv)!;
  const base = Date.now() + Math.floor(Math.random() * 1_000_000);
  const userId = `${prefix}-user`;
  const orgId = `${prefix}-org`;
  const workspaceId = `${prefix}-workspace`;
  const threadId = `${prefix}-thread`;
  const fingerprint = `${prefix}-fingerprint`;

  await appIndex.applyAdminEvent({
    type: "user_upsert",
    payload: {
      id: userId,
      email: `${prefix}@example.com`,
      name: `${prefix} User`,
      created_at: base - 10_000,
      avatar: { color: "#111111", content: "U" },
    },
  });
  await appIndex.applyAdminEvent({
    type: "org_upsert",
    payload: {
      id: orgId,
      name: `${prefix} Org`,
      created_at: base - 9_000,
      created_by: userId,
      archived: false,
    },
  });
  await appIndex.applyAdminEvent({
    type: "workspace_upsert",
    payload: {
      id: workspaceId,
      name: `${prefix} Workspace`,
      org_id: orgId,
      created_at: base - 8_000,
      created_by: userId,
      archived: false,
    },
  });
  await appIndex.applyAdminEvent({
    type: "thread_upsert",
    payload: {
      id: threadId,
      title: `${prefix} Thread`,
      model: "sonnet",
      org_id: orgId,
      workspace_id: workspaceId,
      created_by: userId,
      created_at: base - 7_000,
      updated_at: base + 2_000,
    },
  });
  await appIndex.applyAdminEvent({
    type: "thread_error_recorded",
    payload: {
      id: `${threadId}:${base + 1_000}:${fingerprint}`,
      fingerprint,
      thread_id: threadId,
      org_id: orgId,
      workspace_id: workspaceId,
      user_id: userId,
      created_at: base + 1_000,
      source: "pi_provider",
      error_kind: "rate_limit",
      status: 429,
      provider: "openai",
      model: "gpt-5.4-mini",
      message_normalized: "Provider returned [id]",
      message_sample: "Provider returned request id",
    },
  });
  await appIndex.markBootstrapComplete();

  return { base, userId, orgId, workspaceId, threadId, fingerprint };
}

describe("admin MCP OAuth resource", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("advertises a distinct admin OAuth issuer for the admin MCP resource", async () => {
    const resourceResponse = await handleResourceMetadata(routeContext(
      new Request("https://example.com/.well-known/oauth-protected-resource?resource=https%3A%2F%2Fexample.com%2Fapi%2Fadmin%2Fmcp"),
    ));
    expect(resourceResponse?.status).toBe(200);
    await expect(resourceResponse?.json()).resolves.toMatchObject({
      resource: "https://example.com/api/admin/mcp",
      authorization_servers: ["https://example.com/api/admin/oauth"],
    });

    const pathResourceResponse = await handleResourceMetadata(routeContext(
      new Request("https://example.com/.well-known/oauth-protected-resource/api/admin/mcp"),
    ));
    expect(pathResourceResponse?.status).toBe(200);
    await expect(pathResourceResponse?.json()).resolves.toMatchObject({
      resource: "https://example.com/api/admin/mcp",
      authorization_servers: ["https://example.com/api/admin/oauth"],
    });

    const adminMetadataResponse = await handleOAuthMetadata(routeContext(
      new Request("https://example.com/.well-known/oauth-authorization-server/api/admin/oauth"),
    ));
    expect(adminMetadataResponse?.status).toBe(200);
    await expect(adminMetadataResponse?.json()).resolves.toMatchObject({
      issuer: "https://example.com/api/admin/oauth",
      authorization_endpoint: "https://example.com/api/admin/oauth/authorize",
      token_endpoint: "https://example.com/api/admin/oauth/token",
    });

    const issuerMetadataResponse = await handleOAuthMetadata(routeContext(
      new Request("https://example.com/api/admin/oauth"),
    ));
    expect(issuerMetadataResponse?.status).toBe(200);
    await expect(issuerMetadataResponse?.json()).resolves.toMatchObject({
      issuer: "https://example.com/api/admin/oauth",
      authorization_endpoint: "https://example.com/api/admin/oauth/authorize",
      token_endpoint: "https://example.com/api/admin/oauth/token",
    });

    const issuerWellKnownMetadataResponse = await handleOAuthMetadata(routeContext(
      new Request("https://example.com/api/admin/oauth/.well-known/oauth-authorization-server"),
    ));
    expect(issuerWellKnownMetadataResponse?.status).toBe(200);
    await expect(issuerWellKnownMetadataResponse?.json()).resolves.toMatchObject({
      issuer: "https://example.com/api/admin/oauth",
      authorization_endpoint: "https://example.com/api/admin/oauth/authorize",
      token_endpoint: "https://example.com/api/admin/oauth/token",
    });

    const retiredWorkspaceMetadataResponse = await handleOAuthMetadata(routeContext(
      new Request("https://example.com/.well-known/oauth-authorization-server"),
    ));
    expect(retiredWorkspaceMetadataResponse?.status).toBe(404);

    const retiredWorkspaceResourceResponse = await handleResourceMetadata(routeContext(
      new Request("https://example.com/.well-known/oauth-protected-resource"),
    ));
    expect(retiredWorkspaceResourceResponse?.status).toBe(404);
  });

  it("accepts Cursor's native-app callback during dynamic client registration", async () => {
    const oauth = new AdminMcpOAuthProvider(testEnv.APP_KV);
    const redirectUris = [
      "cursor://anysphere.cursor-mcp/oauth/callback",
      "https://www.cursor.com/agents/mcp/oauth/callback",
      "http://localhost:8787/callback",
    ];

    const client = await oauth.registerClient({
      client_name: "Cursor",
      redirect_uris: redirectUris,
    });

    expect(client.redirect_uris).toEqual(redirectUris);
  });

  it("rejects lookalike Cursor native-app callbacks", async () => {
    const oauth = new AdminMcpOAuthProvider(testEnv.APP_KV);

    await expect(oauth.registerClient({
      client_name: "Untrusted Cursor callback",
      redirect_uris: ["cursor://attacker.example/oauth/callback"],
    })).rejects.toMatchObject({ error: "invalid_client_metadata" });
    await expect(oauth.registerClient({
      client_name: "Untrusted Cursor callback path",
      redirect_uris: ["cursor://anysphere.cursor-mcp/other"],
    })).rejects.toMatchObject({ error: "invalid_client_metadata" });
  });

  it("requires redirect_uri during authorization-code token exchange", async () => {
    const oauth = new AdminMcpOAuthProvider(testEnv.APP_KV);
    const client = await oauth.registerClient({
      client_name: "Redirect URI Test Client",
      redirect_uris: ["http://localhost:4321/callback"],
    });
    const verifier = `verifier-${crypto.randomUUID()}`;
    const code = await oauth.createAuthorizationCode({
      client_id: client.client_id,
      redirect_uri: client.redirect_uris[0],
      code_challenge: await codeChallenge(verifier),
      user_id: crypto.randomUUID(),
      resource: "https://example.com/api/admin/mcp",
    });
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client.client_id,
      code,
      code_verifier: verifier,
      resource: "https://example.com/api/admin/mcp",
    });

    const response = await tokenAction({
      request: new Request("https://example.com/api/admin/oauth/token", {
        method: "POST",
        body: body.toString(),
      }),
      context: { cloudflare: { env: testEnv } },
      params: {},
    } as never);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid_request",
      error_description: "redirect_uri is required",
    });
  });

  it("binds static admin clients to configured redirect URIs", async () => {
    const oauth = new AdminMcpOAuthProvider(
      testEnv.APP_KV,
      "static-admin-client",
      ["https://trusted.example/callback", "http://localhost:4321/callback"],
    );

    await expect(
      oauth.validateClient("static-admin-client", "https://trusted.example/callback"),
    ).resolves.toBe(true);
    await expect(
      oauth.validateClient("static-admin-client", "https://attacker.example/callback"),
    ).resolves.toBe(false);
    await expect(
      oauth.validateClient("static-admin-client", "http://localhost:9999/callback"),
    ).resolves.toBe(false);
    await expect(
      oauth.validateClient("static-admin-client"),
    ).resolves.toBe(true);
  });

  it("fails closed for static admin clients without a redirect URI allowlist", async () => {
    const oauth = new AdminMcpOAuthProvider(testEnv.APP_KV, "static-admin-client");

    await expect(
      oauth.validateClient("static-admin-client", "https://trusted.example/callback"),
    ).resolves.toBe(false);
    await expect(
      oauth.validateClient("static-admin-client"),
    ).resolves.toBe(false);
  });

  it("challenges unauthenticated MCP requests with protected resource metadata", async () => {
    const response = await handleAdminMcp({
      req: mcpRequest({ jsonrpc: "2.0", id: 1, method: "initialize" }),
      env: testEnv,
      ctx: {} as ExecutionContext,
      url: new URL("https://example.com/api/admin/mcp"),
      match: [] as unknown as RegExpMatchArray,
    });

    expect(response?.status).toBe(401);
    expect(response?.headers.get("www-authenticate")).toContain(
      "/.well-known/oauth-protected-resource",
    );
  });

  it("rejects valid OAuth tokens after the user loses superuser access", async () => {
    const { userId } = await createUser(
      testEnv,
      `admin-mcp-demoted-${crypto.randomUUID()}@example.com`,
      "password123",
      "Demoted User",
    );
    await createOrg(testEnv, "Demoted Org", userId);
    await updateUserProfile(testEnv, userId, { is_superuser: true });
    const token = await issueAdminMcpToken(userId);
    await updateUserProfile(testEnv, userId, { is_superuser: false });

    const response = await handleAdminMcp({
      req: mcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }, token),
      env: testEnv,
      ctx: {} as ExecutionContext,
      url: new URL("https://example.com/api/admin/mcp"),
      match: [] as unknown as RegExpMatchArray,
    });

    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toMatchObject({
      details: "Admin access required",
    });
  });

  it("rejects org owners who are not superusers", async () => {
    const { userId } = await createUser(
      testEnv,
      `admin-mcp-org-owner-${crypto.randomUUID()}@example.com`,
      "password123",
      "Org Owner",
    );
    await createOrg(testEnv, "Org Owner Org", userId);
    const token = await issueAdminMcpToken(userId);

    const response = await handleAdminMcp({
      req: mcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }, token),
      env: testEnv,
      ctx: {} as ExecutionContext,
      url: new URL("https://example.com/api/admin/mcp"),
      match: [] as unknown as RegExpMatchArray,
    });

    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toMatchObject({
      details: "Admin access required",
    });
  });

  it("allows superusers to list admin MCP tools", async () => {
    const { userId } = await createUser(
      testEnv,
      `admin-mcp-super-${crypto.randomUUID()}@example.com`,
      "password123",
      "Admin User",
    );
    await createOrg(testEnv, "Admin Org", userId);
    await updateUserProfile(testEnv, userId, { is_superuser: true });
    const token = await issueAdminMcpToken(userId);

    const response = await handleAdminMcp({
      req: mcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }, token),
      env: testEnv,
      ctx: {} as ExecutionContext,
      url: new URL("https://example.com/api/admin/mcp"),
      match: [] as unknown as RegExpMatchArray,
    });

    expect(response?.status).toBe(200);
    const rpc = (await response?.json()) as any;
    expect(rpc).toMatchObject({
      result: {
        tools: expect.arrayContaining([
          expect.objectContaining({ name: "admin_api_request" }),
          expect.objectContaining({ name: "admin_openapi" }),
          expect.objectContaining({ name: "get_admin_stats" }),
          expect.objectContaining({ name: "search_users" }),
          expect.objectContaining({ name: "search_orgs" }),
          expect.objectContaining({ name: "search_threads" }),
          expect.objectContaining({ name: "query_chat_errors" }),
          expect.objectContaining({ name: "get_thread_jsonl" }),
          expect.objectContaining({ name: "search_workspaces" }),
          expect.objectContaining({ name: "search_apps" }),
          expect.objectContaining({ name: "list_bans" }),
          expect.objectContaining({ name: "grant_org_credits" }),
          expect.objectContaining({ name: "set_user_credits" }),
          expect.objectContaining({ name: "get_user_llm_limits" }),
          expect.objectContaining({ name: "set_user_llm_limits" }),
          expect.objectContaining({ name: "set_llm_usage_pricing" }),
          expect.objectContaining({ name: "admin_js_exec" }),
        ]),
      },
    });
    const setCreditsTool = rpc.result.tools.find(
      (tool: { name: string }) => tool.name === "set_user_credits",
    );
    expect(setCreditsTool.description).toContain(
      "without creating a grant ledger row",
    );
    const usageTool = rpc.result.tools.find(
      (tool: { name: string }) => tool.name === "get_org_usage",
    );
    const usageVariants = usageTool.inputSchema.oneOf as Array<{
      properties: { view: { const: string } };
      required: string[];
    }>;
    expect(usageVariants.find((variant) => variant.properties.view.const === "users")?.required)
      .toEqual(expect.arrayContaining(["org_id", "view", "from", "to"]));
    expect(usageVariants.find((variant) => variant.properties.view.const === "log_sum")?.required)
      .toEqual(expect.arrayContaining(["org_id", "view", "from", "to"]));
  });

  it("delegates first-class LLM usage policy tools through the admin REST routes", async () => {
    const { userId } = await createUser(
      testEnv,
      `admin-mcp-usage-${crypto.randomUUID()}@example.com`,
      "password123",
      "Usage Policy Admin",
    );
    const { org } = await createOrg(testEnv, "MCP Usage Policy Org", userId);
    await updateUserProfile(testEnv, userId, { is_superuser: true });
    const token = await issueAdminMcpToken(userId);
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await handleAdminMcp({
        req: mcpRequest({
          jsonrpc: "2.0",
          id: crypto.randomUUID(),
          method: "tools/call",
          params: { name, arguments: args },
        }, token),
        env: testEnv,
        ctx: {} as ExecutionContext,
        url: new URL("https://example.com/api/admin/mcp"),
        match: [] as unknown as RegExpMatchArray,
      });
      expect(response?.status).toBe(200);
      return parseToolText(await response?.json());
    };

    await expect(call("set_llm_usage_pricing", {
      org_id: org.id,
      prices: [{
        provider: "custom",
        model: "mcp-model",
        input_usd_per_million: 1,
        output_usd_per_million: 2,
      }],
    })).resolves.toMatchObject({
      status: 200,
      body_json: { prices: [{ provider: "custom", model: "mcp-model" }] },
    });
    await expect(call("set_user_llm_limits", {
      org_id: org.id,
      user_id: userId,
      limits: [{ window_hours: 24, limit_usd: 5, label: "daily" }],
    })).resolves.toMatchObject({
      status: 200,
      body_json: { limits: [{ window_hours: 24, limit_usd: 5, label: "daily" }] },
    });
    await expect(call("get_user_llm_limits", {
      org_id: org.id,
      user_id: userId,
    })).resolves.toMatchObject({
      status: 200,
      body_json: { status: { reason: "within_limits" } },
    });
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    await runInDurableObject(orgStub, (_instance, state) => {
      expect(state.storage.sql.exec<{ updated_by: string }>(
        "SELECT updated_by FROM llm_model_pricing_overrides WHERE provider = 'custom' AND model = 'mcp-model'",
      ).one().updated_by).toBe(userId);
      expect(state.storage.sql.exec<{ updated_by: string }>(
        "SELECT updated_by FROM user_llm_usage_limits WHERE user_id = ?",
        userId,
      ).one().updated_by).toBe(userId);
    });
  });

  it("lets superusers query chat errors through the dedicated MCP tool", async () => {
    const { userId } = await createUser(
      testEnv,
      `admin-mcp-chat-errors-${crypto.randomUUID()}@example.com`,
      "password123",
      "Chat Error Admin",
    );
    await createOrg(testEnv, "MCP Chat Error Admin Org", userId);
    await updateUserProfile(testEnv, userId, { is_superuser: true });
    const fixture = await seedMcpChatErrors();
    const token = await issueAdminMcpToken(userId);

    const response = await handleAdminMcp({
      req: mcpRequest(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "query_chat_errors",
            arguments: {
              from: fixture.base,
              to: fixture.base + 2_000,
              fingerprint: fixture.fingerprint,
              include_events: true,
              events_limit: 1,
            },
          },
        },
        token,
      ),
      env: testEnv,
      ctx: {} as ExecutionContext,
      url: new URL("https://example.com/api/admin/mcp"),
      match: [] as unknown as RegExpMatchArray,
    });

    expect(response?.status).toBe(200);
    const rpc = (await response?.json()) as any;
    const payload = parseToolText(rpc);
    expect(payload).toMatchObject({
      status: 200,
      ok: true,
      body_json: {
        summary: {
          total_events: 1,
          affected_threads: 1,
          distinct_groups: 1,
        },
        groups: [
          expect.objectContaining({
            fingerprint: fixture.fingerprint,
            count: 1,
          }),
        ],
        threads: [
          expect.objectContaining({
            thread_id: fixture.threadId,
            workspace_id: fixture.workspaceId,
            count: 1,
          }),
        ],
        events: [
          expect.objectContaining({
            fingerprint: fixture.fingerprint,
            thread_id: fixture.threadId,
            org_id: fixture.orgId,
            user_id: fixture.userId,
          }),
        ],
      },
    });
  });

  it("runs admin JavaScript that can call Durable Object RPC methods", async () => {
    const { userId } = await createUser(
      testEnv,
      `admin-mcp-js-exec-${crypto.randomUUID()}@example.com`,
      "password123",
      "JS Exec Admin",
    );
    await createOrg(testEnv, "MCP JS Exec Org", userId);
    await updateUserProfile(testEnv, userId, { is_superuser: true });
    const token = await issueAdminMcpToken(userId);

    const response = await SELF.fetch(
      mcpRequest(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "admin_js_exec",
            arguments: {
              code: `
                const profile = await DO.call("USER", ${JSON.stringify(userId)}, "getProfile");
                text({ available: DO.namespaces.includes("USER") });
                return { profile };
              `,
            },
          },
        },
        token,
      ),
    );

    expect(response?.status).toBe(200);
    const rpc = (await response?.json()) as any;
    const payload = parseToolText(rpc);
    expect(payload).toMatchObject({
      success: true,
      result: {
        profile: {
          id: userId,
          is_superuser: true,
        },
      },
    });
    expect(payload.namespaces).toContain("USER");
    expect(payload.output[0]).toContain('"available": true');
  });

  it("runs admin JavaScript through a DO stub proxy", async () => {
    const { userId } = await createUser(
      testEnv,
      `admin-mcp-js-stub-${crypto.randomUUID()}@example.com`,
      "password123",
      "JS Stub Admin",
    );
    await createOrg(testEnv, "MCP JS Stub Org", userId);
    await updateUserProfile(testEnv, userId, { is_superuser: true });
    const token = await issueAdminMcpToken(userId);

    const response = await SELF.fetch(
      mcpRequest(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "admin_js_exec",
            arguments: {
              code: `
                const user = DO.stub("USER", ${JSON.stringify(userId)});
                return await user.getProfile();
              `,
            },
          },
        },
        token,
      ),
    );

    expect(response?.status).toBe(200);
    const rpc = (await response?.json()) as any;
    const payload = parseToolText(rpc);
    expect(payload).toMatchObject({
      success: true,
      result: {
        id: userId,
        is_superuser: true,
      },
    });
  });

  it("preserves idFromName when using the DO namespace facade", async () => {
    const { userId } = await createUser(
      testEnv,
      `admin-mcp-js-namespace-${crypto.randomUUID()}@example.com`,
      "password123",
      "JS Namespace Admin",
    );
    await createOrg(testEnv, "MCP JS Namespace Org", userId);
    await updateUserProfile(testEnv, userId, { is_superuser: true });
    const token = await issueAdminMcpToken(userId);

    const response = await SELF.fetch(
      mcpRequest(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "admin_js_exec",
            arguments: {
              code: `
                const users = DO.namespace("USER");
                const user = users.get(users.idFromName(${JSON.stringify(userId)}));
                return await user.getProfile();
              `,
            },
          },
        },
        token,
      ),
    );

    expect(response?.status).toBe(200);
    const rpc = (await response?.json()) as any;
    const payload = parseToolText(rpc);
    expect(payload).toMatchObject({
      success: true,
      result: {
        id: userId,
        is_superuser: true,
      },
    });
  });

  it("runs reusable integration tests through generic bindings and the admin API", async () => {
    const { userId } = await createUser(
      testEnv,
      `admin-mcp-console-${crypto.randomUUID()}@example.com`,
      "password123",
      "Console Admin",
    );
    await createOrg(testEnv, "MCP Console Admin Org", userId);
    await updateUserProfile(testEnv, userId, { is_superuser: true });
    const token = await issueAdminMcpToken(userId);
    const key = `admin-console-${crypto.randomUUID()}`;

    const response = await SELF.fetch(
      mcpRequest(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "admin_js_exec",
            arguments: {
              input: { key },
              code: `
                await test("KV binding round trip", async () => {
                  await env.APP_KV.put(input.key, "console-value");
                  assert.equal(await env.APP_KV.get(input.key), "console-value");
                  await env.APP_KV.delete(input.key);
                });
                await test("authenticated admin API", async () => {
                  const response = await ADMIN.fetch("/api/admin/stats");
                  assert.equal(response.status, 200);
                  const stats = await response.json();
                  assert.ok(stats.total_users >= 1);
                });
                await test("actor request facade", async () => {
                  assert.equal(typeof ACTOR.fetch, "function");
                });
                await test("identity control facade", async () => {
                  assert.equal(typeof IDENTITY.createActor, "function");
                  assert.equal(typeof IDENTITY.resetActor, "function");
                  assert.equal(typeof IDENTITY.deleteActor, "function");
                });
                await test("billing control facade", async () => {
                  assert.equal(typeof BILLING.snapshot, "function");
                  assert.equal(typeof BILLING.setAvailableCredits, "function");
                  assert.equal(typeof BILLING.deleteTestCustomer, "function");
                });
                await test("chained binding APIs", async () => {
                  const row = await env.APP_DB.chain([
                    { method: "prepare", args: ["SELECT 1 AS value"] },
                    { method: "first" },
                  ]);
                  assert.deepEqual(row, { value: 1 });
                });
                await test("R2 object body chains", async () => {
                  await env.R2_BUCKET.put(input.key, "r2-console-value");
                  const value = await env.R2_BUCKET.chain([
                    { method: "get", args: [input.key] },
                    { method: "text" },
                  ]);
                  assert.equal(value, "r2-console-value");
                  await env.R2_BUCKET.delete(input.key);
                });
                await test("fetch-capable bindings", async () => {
                  const response = await env.ASSETS.fetch("/__admin-console-missing__");
                  assert.ok(response.status >= 200);
                  assert.ok(response.url.startsWith("https://example.com/"));
                });
                await test("primitive secrets stay protected", async () => {
                  const descriptor = ENV.describe("TOKEN_SIGNING_SECRET");
                  assert.equal(descriptor.kind, "value");
                  assert.equal(descriptor.accessible, false);
                  await assert.rejects(
                    () => env.TOKEN_SIGNING_SECRET.get(),
                    /protected primitive value/,
                  );
                });
                return {
                  baseUrl: runtime.baseUrl,
                  kvKind: ENV.describe("APP_KV").kind,
                  hasLoader: ENV.has("CODE_MODE_LOADER"),
                  secretDescriptor: ENV.describe("TOKEN_SIGNING_SECRET"),
                };
              `,
            },
          },
        },
        token,
      ),
    );

    expect(response.status).toBe(200);
    const rpc = (await response.json()) as any;
    const payload = parseToolText(rpc);
    expect(rpc.result.isError).toBeUndefined();
    expect(payload).toMatchObject({
      success: true,
      result: {
        baseUrl: "https://example.com",
        kvKind: "kv_namespace",
        hasLoader: false,
        secretDescriptor: {
          name: "TOKEN_SIGNING_SECRET",
          kind: "value",
          accessible: false,
          methods: [],
        },
      },
      tests: {
        total: 9,
        passed: 9,
        failed: 0,
      },
      runtime: {
        baseUrl: "https://example.com",
        adminUserId: userId,
        bindingCount: expect.any(Number),
      },
    });
    expect(payload.runtime.bindingCount).toBeGreaterThan(0);
  });

  it("provisions and cleans up a verified onboarding actor through console controls", async () => {
    const { userId: adminUserId } = await createUser(
      testEnv,
      `admin-mcp-control-${crypto.randomUUID()}@example.com`,
      "password123",
      "Control Admin",
    );
    await createOrg(testEnv, "MCP Control Admin Org", adminUserId);
    await updateUserProfile(testEnv, adminUserId, { is_superuser: true });
    const token = await issueAdminMcpToken(adminUserId);
    const email = `admin-console-actor-${crypto.randomUUID()}@example.com`;
    const password = "fixture-password-123";

    const response = await SELF.fetch(
      mcpRequest(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "admin_js_exec",
            arguments: {
              timeout_ms: 120_000,
              input: { email, password },
              code: `
                const actor = await IDENTITY.createActor({
                  email: input.email,
                  password: input.password,
                  name: "Staging E2E Actor",
                });
                const verifiedPassword = await DO.call(
                  "USER",
                  actor.userId,
                  "verifyPassword",
                  [input.password],
                );
                assert.equal(verifiedPassword, true);
                const verification = await DO.call(
                  "USER",
                  actor.userId,
                  "getEmailVerificationStatus",
                );
                assert.deepEqual(verification, {
                  required: true,
                  verified: true,
                  email_verified_at: verification.email_verified_at,
                });
                const onboarding = await DO.call(
                  "USER",
                  actor.userId,
                  "getOnboarding",
                );
                assert.ok(!onboarding.completed_at);

                const initial = await BILLING.snapshot(actor.orgId);
                assert.equal(initial.available_credits_cents, 0);
                assert.equal(initial.stripe_customer_configured, false);
                assert.equal(initial.stripe_subscription_configured, false);

                const changed = await BILLING.setAvailableCredits(actor.orgId, 250);
                assert.equal(changed.previous.available_credits_cents, 0);
                assert.equal(changed.current.available_credits_cents, 250);
                await IDENTITY.resetActor(actor.userId);
                const deleted = await IDENTITY.deleteActor(actor.userId);
                assert.equal(deleted.orgDeleted, true);
                const deletedAgain = await IDENTITY.deleteActor(actor.userId);
                assert.equal(deletedAgain.alreadyDeleted, true);
                return {
                  actor,
                  initial,
                  changed: changed.current,
                  deleted,
                  deletedAgain,
                };
              `,
            },
          },
        },
        token,
      ),
    );

    expect(response.status).toBe(200);
    const rpc = (await response.json()) as any;
    const payload = parseToolText(rpc);
    expect(rpc.result.isError).toBeUndefined();
    expect(payload).toMatchObject({
      success: true,
      result: {
        actor: {
          userId: expect.any(String),
          orgId: expect.any(String),
          workspaceId: expect.any(String),
        },
        initial: {
          billing_status: "inactive",
          available_credits_cents: 0,
        },
        changed: {
          available_credits_cents: 250,
        },
        deleted: {
          orgDeleted: true,
          deletedWorkspaces: 1,
        },
      },
    });
    const actorUserId = payload.result.actor.userId as string;
    expect(
      await testEnv.USER.get(testEnv.USER.idFromName(actorUserId)).getProfile(),
    ).toBeNull();
    expect(await testEnv.EMAIL_TO_USER.get(`email:${email}`)).toBeNull();
  });

  it("returns a failing tool result when a console test fails", async () => {
    const { userId } = await createUser(
      testEnv,
      `admin-mcp-console-failure-${crypto.randomUUID()}@example.com`,
      "password123",
      "Console Failure Admin",
    );
    await createOrg(testEnv, "MCP Console Failure Org", userId);
    await updateUserProfile(testEnv, userId, { is_superuser: true });
    const token = await issueAdminMcpToken(userId);

    const response = await SELF.fetch(
      mcpRequest(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "admin_js_exec",
            arguments: {
              code: `
                await test("intentional failure", () => {
                  assert.equal(1, 2);
                });
                return "finished";
              `,
            },
          },
        },
        token,
      ),
    );

    expect(response.status).toBe(200);
    const rpc = (await response.json()) as any;
    const payload = parseToolText(rpc);
    expect(rpc.result.isError).toBe(true);
    expect(payload).toMatchObject({
      success: false,
      result: "finished",
      tests: {
        total: 1,
        passed: 0,
        failed: 1,
        cases: [
          expect.objectContaining({
            name: "intentional failure",
            status: "failed",
            error: expect.stringContaining("Expected 1 to equal 2"),
          }),
        ],
      },
    });
  });

  it("grants org credits through MCP with a grant ledger row", async () => {
    const { userId } = await createUser(
      testEnv,
      `admin-mcp-grant-${crypto.randomUUID()}@example.com`,
      "password123",
      "Grant Admin",
    );
    const { org } = await createOrg(testEnv, "MCP Grant Org", userId);
    await updateUserProfile(testEnv, userId, { is_superuser: true });
    const token = await issueAdminMcpToken(userId);
    const idempotencyKey = `mcp-grant-${crypto.randomUUID()}`;

    const response = await handleAdminMcp({
      req: mcpRequest(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "grant_org_credits",
            arguments: {
              org_id: org.id,
              amount_cents: 1800,
              reason: "MCP grant test",
              idempotency_key: idempotencyKey,
            },
          },
        },
        token,
      ),
      env: testEnv,
      ctx: {} as ExecutionContext,
      url: new URL("https://example.com/api/admin/mcp"),
      match: [] as unknown as RegExpMatchArray,
    });

    expect(response?.status).toBe(200);
    const rpc = (await response?.json()) as any;
    expect(parseToolText(rpc)).toMatchObject({
      success: true,
      org_id: org.id,
      applied: true,
      grant_id: idempotencyKey,
      amount_cents: 1800,
      reason: "MCP grant test",
      created_by: userId,
      source: "admin-mcp",
      billing_credit_grant_total_cents: 1800,
    });

    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    await expect(orgStub.listManualCreditGrants()).resolves.toMatchObject([
      {
        grant_id: idempotencyKey,
        amount_cents: 1800,
        reason: "MCP grant test",
        created_by: userId,
        source: "admin-mcp",
      },
    ]);
  });

  it("keeps MCP credit override separate from grant ledger records", async () => {
    const { userId } = await createUser(
      testEnv,
      `admin-mcp-credit-override-${crypto.randomUUID()}@example.com`,
      "password123",
      "Override Admin",
    );
    const { org } = await createOrg(testEnv, "MCP Credit Override Org", userId);
    await updateUserProfile(testEnv, userId, { is_superuser: true });
    const token = await issueAdminMcpToken(userId);

    const response = await handleAdminMcp({
      req: mcpRequest(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "set_user_credits",
            arguments: {
              user_id: userId,
              org_id: org.id,
              billing_credit_grant_total_cents: 9900,
            },
          },
        },
        token,
      ),
      env: testEnv,
      ctx: {} as ExecutionContext,
      url: new URL("https://example.com/api/admin/mcp"),
      match: [] as unknown as RegExpMatchArray,
    });

    expect(response?.status).toBe(200);
    const rpc = (await response?.json()) as any;
    expect(parseToolText(rpc)).toMatchObject({
      status: 200,
      ok: true,
      body_json: {
        org_id: org.id,
        billing_credit_grant_total_cents: 9900,
      },
    });

    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    await expect(orgStub.getInfo()).resolves.toMatchObject({
      billing_credit_grant_total_cents: 9900,
    });
    await expect(orgStub.listManualCreditGrants()).resolves.toEqual([]);
  });

  it("bridges MCP tool calls into the admin API", async () => {
    const { userId } = await createUser(
      testEnv,
      `admin-mcp-openapi-${crypto.randomUUID()}@example.com`,
      "password123",
      "OpenAPI Admin",
    );
    await createOrg(testEnv, "OpenAPI Admin Org", userId);
    await updateUserProfile(testEnv, userId, { is_superuser: true });
    const token = await issueAdminMcpToken(userId);

    const response = await handleAdminMcp({
      req: mcpRequest(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "admin_openapi", arguments: {} },
        },
        token,
      ),
      env: testEnv,
      ctx: {} as ExecutionContext,
      url: new URL("https://example.com/api/admin/mcp"),
      match: [] as unknown as RegExpMatchArray,
    });

    expect(response?.status).toBe(200);
    const rpc = (await response?.json()) as any;
    expect(rpc.result.content[0].text).toContain("camelAI Admin API");
  });

  it("supports named admin API tools", async () => {
    const { userId } = await createUser(
      testEnv,
      `admin-mcp-stats-${crypto.randomUUID()}@example.com`,
      "password123",
      "Stats Admin",
    );
    await createOrg(testEnv, "Stats Admin Org", userId);
    await updateUserProfile(testEnv, userId, { is_superuser: true });
    const token = await issueAdminMcpToken(userId);

    const response = await handleAdminMcp({
      req: mcpRequest(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "get_admin_stats", arguments: {} },
        },
        token,
      ),
      env: testEnv,
      ctx: {} as ExecutionContext,
      url: new URL("https://example.com/api/admin/mcp"),
      match: [] as unknown as RegExpMatchArray,
    });

    expect(response?.status).toBe(200);
    const rpc = (await response?.json()) as any;
    const text = rpc.result.content[0].text as string;
    expect(text).toContain("body_json");
    expect(text).toContain("total_users");
  });

  it("surfaces reconstructed thread JSONL through the admin MCP server", async () => {
    const { userId } = await createUser(
      testEnv,
      `admin-mcp-jsonl-${crypto.randomUUID()}@example.com`,
      "password123",
      "JSONL Admin",
    );
    const { org, defaultWorkspaceId } = await createOrg(
      testEnv,
      "JSONL Admin Org",
      userId,
    );
    await updateUserProfile(testEnv, userId, { is_superuser: true });
    const token = await issueAdminMcpToken(userId);

    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    const thread = await orgStub.createThread(
      defaultWorkspaceId,
      "JSONL Thread",
      userId,
    );
    const appIndex = getAppIndexDatabase(testEnv)!;
    await appIndex.ensureSchema();
    await appIndex.applyAdminEvent({
      type: "thread_upsert",
      payload: { ...thread, org_id: org.id },
    });

    // A thread not yet moved to the runtime: its transcript as ChatThreadDO stored it.
    const stored = [
      {
        role: "user",
        content: "run the command",
        timestamp: 100,
      },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "tool-1",
            name: "bash",
            arguments: { command: "false" },
          },
        ],
        responseId: "resp-tool",
        timestamp: 200,
        api: "test",
        provider: "test",
        model: "test",
        usage: {},
        stopReason: "toolUse",
      },
      {
        role: "toolResult",
        toolCallId: "tool-1",
        toolName: "bash",
        content: [{ type: "text", text: "exit 1\n" }],
        isError: true,
        timestamp: 300,
      },
    ];
    await runInDurableObject(
      testEnv.CHAT_THREAD.get(testEnv.CHAT_THREAD.idFromName(thread.id)),
      async (_instance: unknown, state: DurableObjectState) => {
        state.storage.sql.exec("CREATE TABLE IF NOT EXISTS pi_core_messages (idx INTEGER PRIMARY KEY, payload TEXT NOT NULL, created_at INTEGER NOT NULL)");
        stored.forEach((message, idx) => {
          state.storage.sql.exec("INSERT INTO pi_core_messages (idx, payload, created_at) VALUES (?, ?, ?)", idx, JSON.stringify(message), message.timestamp);
        });
      },
    );

    const response = await handleAdminMcp({
      req: mcpRequest(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "get_thread_jsonl",
            arguments: { thread_id: thread.id },
          },
        },
        token,
      ),
      env: testEnv,
      ctx: {} as ExecutionContext,
      url: new URL("https://example.com/api/admin/mcp"),
      match: [] as unknown as RegExpMatchArray,
    });

    expect(response?.status).toBe(200);
    const rpc = (await response?.json()) as any;
    expect(rpc.result.structuredContent).toMatchObject({
      success: true,
      thread_id: thread.id,
      org_id: org.id,
      workspace_id: defaultWorkspaceId,
      filename: `${thread.id}.jsonl`,
      content_type: "application/x-ndjson; charset=utf-8",
      message_count: 2,
    });

    const jsonl = rpc.result.content[0].text as string;
    const lines = jsonl.trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      role: "user",
      content: "run the command",
    });
    expect(lines[1]).toMatchObject({
      id: "resp-tool",
      role: "assistant",
      content: expect.arrayContaining([
        expect.objectContaining({
          type: "tool_result",
          tool_use_id: "tool-1",
          content: "exit 1\n",
          is_error: true,
          status: "failed",
        }),
      ]),
    });
  });

});
