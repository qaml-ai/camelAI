import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";

import { agentMcpTools, handleAgentMcpRequest, type ToolsFactory } from "../src/routes/agent-mcp";
import type { Env } from "../src/types";

const ISSUER = "https://runtime.test";
const MCP_URL = "https://camel.test/mcp/agent";
// A fresh JWKS URL per run keeps the edge cache from serving another run's keys.
const JWKS_URL = `${ISSUER}/.well-known/jwks-${crypto.randomUUID()}.json`;

let privateKey: CryptoKey;
let publicJwk: JWK;

beforeAll(async () => {
  const pair = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  privateKey = pair.privateKey;
  publicJwk = { ...await exportJWK(pair.publicKey), kid: "k1", alg: "EdDSA", use: "sig" };
});

afterEach(() => {
  vi.restoreAllMocks();
});

function serveJwks() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === JWKS_URL) return Response.json({ keys: [publicJwk] });
    return new Response("unexpected fetch", { status: 500 });
  });
}

type Access =
  | { ok: true; orgId: string; orgSlug: string; workspaceId: string; threadId: string }
  | { ok: false; reason: string };

function makeEnv(access: (userId: string, workspaceId: string, threadId: string) => Access) {
  const validate = vi.fn(async (userId: string, workspaceId: string, threadId: string) =>
    access(userId, workspaceId, threadId));
  const env = {
    AGENT_RUNTIME_ISSUER: ISSUER,
    AGENT_RUNTIME_JWKS_URL: JWKS_URL,
    AGENT_RUNTIME_TENANT: "chiridion",
    ORG: {
      idFromName: (name: string) => name,
      get: () => ({ validateChatWebSocketAccess: validate }),
    },
  } as unknown as Env;
  return { env, validate };
}

const allowed = (_user: string, workspaceId: string, threadId: string): Access =>
  ({ ok: true, orgId: "org1", orgSlug: "org1", workspaceId, threadId });

async function token(claims: Record<string, unknown> = {}, options: { audience?: string; issuer?: string; expiresIn?: string } = {}) {
  return new SignJWT({
    tenant: "chiridion",
    agent: "client_1",
    ctx: { org: "org1", workspace: "ws1", thread: "thread1" },
    ...claims,
  })
    .setProtectedHeader({ alg: "EdDSA", kid: "k1", typ: "JWT" })
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? MCP_URL)
    .setSubject("user1")
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? "120s")
    .setJti(crypto.randomUUID())
    .sign(privateKey);
}

function rpc(body: unknown, bearer?: string) {
  return new Request(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

function toolsSpy(result: Awaited<ReturnType<ReturnType<ToolsFactory>["callToolEnvelope"]>> = { ok: true, data: { projects: [] } }) {
  const callToolEnvelope = vi.fn(async () => result);
  const factory = vi.fn<ToolsFactory>(() => ({ callToolEnvelope }));
  return { factory, callToolEnvelope };
}

describe("agent MCP auth", () => {
  it("rejects a request without a token", async () => {
    const { env } = makeEnv(allowed);
    const response = await handleAgentMcpRequest(rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }), env, toolsSpy().factory);
    expect(response.status).toBe(401);
  });

  it("rejects tokens for another audience, issuer, tenant, or past expiry", async () => {
    serveJwks();
    const { env, validate } = makeEnv(allowed);
    const bad = [
      await token({}, { audience: "https://elsewhere.test/mcp" }),
      await token({}, { issuer: "https://evil.test" }),
      await token({ tenant: "someone-else" }),
      await token({}, { expiresIn: "-10s" }),
    ];
    for (const bearer of bad) {
      const response = await handleAgentMcpRequest(rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, bearer), env, toolsSpy().factory);
      expect([401, 403]).toContain(response.status);
    }
    expect(validate).not.toHaveBeenCalled();
  });

  it("rejects a token signed by another key", async () => {
    serveJwks();
    const { env } = makeEnv(allowed);
    const other = await generateKeyPair("EdDSA", { crv: "Ed25519" });
    const forged = await new SignJWT({ tenant: "chiridion", ctx: { org: "org1", workspace: "ws1", thread: "thread1" } })
      .setProtectedHeader({ alg: "EdDSA", kid: "k1" })
      .setIssuer(ISSUER).setAudience(MCP_URL).setSubject("user1")
      .setIssuedAt().setExpirationTime("120s").setJti("j")
      .sign(other.privateKey);
    const response = await handleAgentMcpRequest(rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, forged), env, toolsSpy().factory);
    expect(response.status).toBe(401);
  });

  it("authorizes the actor, not the subject, when a turn names one", async () => {
    serveJwks();
    const { env, validate } = makeEnv(allowed);
    const response = await handleAgentMcpRequest(
      rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, await token({ act: "user2" })),
      env,
      toolsSpy().factory,
    );
    expect(response.status).toBe(200);
    expect(validate).toHaveBeenCalledWith("user2", "ws1", "thread1");
  });

  it("forbids a caller OrgDO does not admit", async () => {
    serveJwks();
    const { env } = makeEnv(() => ({ ok: false, reason: "forbidden" }));
    const response = await handleAgentMcpRequest(rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, await token()), env, toolsSpy().factory);
    expect(response.status).toBe(403);
  });

  it("forbids a token without a thread in its context", async () => {
    serveJwks();
    const { env } = makeEnv(allowed);
    const response = await handleAgentMcpRequest(
      rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, await token({ ctx: { org: "org1", workspace: "ws1" } })),
      env,
      toolsSpy().factory,
    );
    expect(response.status).toBe(403);
  });
});

describe("agent MCP protocol", () => {
  it("initializes, acknowledges notifications, and refuses GET", async () => {
    serveJwks();
    const { env } = makeEnv(allowed);
    const init = await handleAgentMcpRequest(
      rpc({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }, await token()),
      env,
      toolsSpy().factory,
    );
    expect(await init.json()).toMatchObject({ id: 0, result: { capabilities: { tools: {} } } });

    const notification = await handleAgentMcpRequest(
      rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, await token()),
      env,
      toolsSpy().factory,
    );
    expect(notification.status).toBe(202);

    const get = await handleAgentMcpRequest(new Request(MCP_URL), env, toolsSpy().factory);
    expect(get.status).toBe(405);
  });

  it("lists the served tools with JSON schemas", async () => {
    serveJwks();
    const { env } = makeEnv(allowed);
    const response = await handleAgentMcpRequest(rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, await token()), env, toolsSpy().factory);
    const body = await response.json() as { result: { tools: Array<{ name: string; inputSchema: { type?: string } }> } };
    const names = body.result.tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["list_projects", "list_apps", "read", "write"]));
    expect(names).not.toContain("deploy_project");
    for (const tool of body.result.tools) expect(tool.inputSchema.type).toBe("object");
    expect(agentMcpTools().length).toBe(names.length);
  });

  it("calls a tool scoped to the token's org, workspace, thread and user", async () => {
    serveJwks();
    const { env } = makeEnv(allowed);
    const { factory, callToolEnvelope } = toolsSpy({ ok: true, data: { projects: ["a"] } });
    const response = await handleAgentMcpRequest(
      rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_projects", arguments: {} } }, await token({ act: "user2" })),
      env,
      factory,
    );
    expect(factory).toHaveBeenCalledWith({
      orgId: "org1", workspaceId: "ws1", threadId: "thread1", userId: "user2", allowWebTools: false,
    });
    expect(callToolEnvelope).toHaveBeenCalledWith("list_projects", {});
    expect(await response.json()).toMatchObject({
      id: 2,
      result: { content: [{ type: "text", text: '{"projects":["a"]}' }], structuredContent: { projects: ["a"] } },
    });
  });

  it("passes Pi file tool content blocks through, images included", async () => {
    serveJwks();
    const { env } = makeEnv(allowed);
    const content = [
      { type: "text", text: "Read image file [image/png]" },
      { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
    ];
    const { factory } = toolsSpy({ ok: true, data: { text: "Read image file [image/png]", content, details: { image: true } } });
    const response = await handleAgentMcpRequest(
      rpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "read", arguments: { location: "workspace", path: "a.png" } } }, await token()),
      env,
      factory,
    );
    expect(await response.json()).toMatchObject({ result: { content, structuredContent: { image: true } } });
  });

  it("returns tool failures as isError results", async () => {
    serveJwks();
    const { env } = makeEnv(allowed);
    const { factory } = toolsSpy({ ok: false, error: { tool: "read", message: "File not found", origin: "tool" } } as never);
    const response = await handleAgentMcpRequest(
      rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "read", arguments: { location: "workspace", path: "x" } } }, await token()),
      env,
      factory,
    );
    expect(await response.json()).toMatchObject({ result: { isError: true, content: [{ text: "File not found" }] } });
  });

  it("refuses tools it does not serve", async () => {
    serveJwks();
    const { env } = makeEnv(allowed);
    const { factory } = toolsSpy();
    const response = await handleAgentMcpRequest(
      rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "deploy_project", arguments: {} } }, await token()),
      env,
      factory,
    );
    expect(await response.json()).toMatchObject({ error: { code: -32602 } });
    expect(factory).not.toHaveBeenCalled();
  });
});
