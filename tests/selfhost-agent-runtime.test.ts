import { createHash, createHmac } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AGENT_RUNTIME_ENV_DEFAULTS,
  RUNTIME_WEBHOOK_EVENTS,
  SELFHOST_AGENT_RUNTIME_IMAGE,
  chiridionLoopbackUrl,
  inspectSelfhostAgentRuntime,
  provisionSelfhostAgentRuntime,
  readAgentRuntimeState,
  threadDefinitionId,
} from "../scripts/selfhost-agent-runtime.mjs";
import { ensureSelfhostSecrets } from "../scripts/selfhost-secret-migrations.mjs";

/** The app's check of a runtime delivery (workers/main/src/agent-runtime/webhooks.ts), in Node. */
async function verifyStandardWebhook(secret: string, headers: Headers, body: string) {
  const id = headers.get("webhook-id");
  const timestamp = headers.get("webhook-timestamp");
  const signatures = headers.get("webhook-signature") ?? "";
  if (!id || !timestamp || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const expected = createHmac("sha256", Buffer.from(secret.replace(/^whsec_/, ""), "base64")).update(`${id}.${timestamp}.${body}`).digest("base64");
  return signatures.split(" ").includes(`v1,${expected}`);
}

const RUNTIME = "http://127.0.0.1:8790";
const TOKEN = "art_operator-token-of-at-least-24-chars";
const temporaryDirectories: string[] = [];

async function temporaryDirectory() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "camelai-selfhost-runtime-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

type Webhook = { id: string; url: string; events: string[]; secret: string; description?: string };

/** The runtime's tenant API as the provisioner and doctor use it: definitions, webhooks, /v1/me. */
function fakeRuntime(options: { tenant?: string; healthy?: boolean; webhooks?: Webhook[] } = {}) {
  const tenant = options.tenant ?? "camelai-selfhost";
  const definitions = new Map<string, { id: string; revision: number; spec: any }>();
  const webhooks = options.webhooks ?? [];
  const calls: Array<{ method: string; path: string; body: any; headers: Headers }> = [];
  let secrets = 0;
  const fetchImpl = vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname, body, headers });
    if (url.pathname === "/healthz") {
      return options.healthy === false ? new Response("starting", { status: 503 }) : new Response("ok");
    }
    if (headers.get("authorization") !== `Bearer ${TOKEN}`) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (method === "GET" && url.pathname === "/v1/me") return Response.json({ tenant, via: "operator" });
    if (method === "POST" && url.pathname === "/v1/definitions") {
      const key = headers.get("idempotency-key")!;
      const id = `def_${createHash("sha256").update(`${tenant}:${key}`).digest("hex").slice(0, 20)}`;
      const current = definitions.get(id);
      const changed = !current || JSON.stringify(current.spec) !== JSON.stringify(body);
      const next = { id, revision: (current?.revision ?? 0) + (changed ? 1 : 0), spec: body };
      definitions.set(id, next);
      return Response.json({ id, revision: next.revision, ...body }, { status: 201 });
    }
    const definition = /^\/v1\/definitions\/([^/]+)$/.exec(url.pathname);
    if (method === "GET" && definition) {
      const found = definitions.get(definition[1]);
      return found ? Response.json({ id: found.id, revision: found.revision, ...found.spec }) : Response.json({ error: "No such definition" }, { status: 404 });
    }
    if (method === "GET" && url.pathname === "/v1/webhooks") {
      return Response.json(webhooks.map(({ secret: _secret, ...endpoint }) => endpoint));
    }
    if (method === "POST" && url.pathname === "/v1/webhooks") {
      const endpoint = { id: `we_${webhooks.length + 1}`, url: body.url, events: body.events, description: body.description, secret: `whsec_${Buffer.from(`secret-${++secrets}`).toString("base64")}` };
      webhooks.push(endpoint);
      return Response.json({ ...endpoint, createdAt: 1 }, { status: 201 });
    }
    const rotate = /^\/v1\/webhooks\/([^/]+)\/secret$/.exec(url.pathname);
    if (method === "POST" && rotate) {
      const endpoint = webhooks.find((entry) => entry.id === rotate[1])!;
      endpoint.secret = `whsec_${Buffer.from(`secret-${++secrets}`).toString("base64")}`;
      return Response.json({ secret: endpoint.secret });
    }
    const patch = /^\/v1\/webhooks\/([^/]+)$/.exec(url.pathname);
    if (method === "DELETE" && patch) {
      webhooks.splice(webhooks.findIndex((entry) => entry.id === patch[1]), 1);
      return new Response(null, { status: 204 });
    }
    if (method === "PATCH" && patch) {
      const endpoint = webhooks.find((entry) => entry.id === patch[1])!;
      endpoint.events = body.events;
      return Response.json(endpoint);
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls, definitions, webhooks };
}

const env = {
  AGENT_RUNTIME_URL: RUNTIME,
  AGENT_RUNTIME_API_TOKEN: TOKEN,
  AGENT_RUNTIME_TENANT: "camelai-selfhost",
  SELFHOST_WORKERD_SOCKET: "127.0.0.1:3001",
};
const quiet = { log: () => {}, error: () => {} } as unknown as Console;
const refused = (message: string) => vi.fn(async () => { throw new TypeError(message); }) as unknown as typeof fetch;

describe("selfhost agent runtime provisioning", () => {
  it("upserts the thread definition, registers the events webhook, and keeps its secret on the state volume", async () => {
    const stateDir = await temporaryDirectory();
    const runtime = fakeRuntime();
    const result = await provisionSelfhostAgentRuntime({ env, stateDir, fetchImpl: runtime.fetchImpl, log: quiet });
    expect(result).toEqual({ definitionId: threadDefinitionId("camelai-selfhost"), webhookSecret: runtime.webhooks[0].secret, fresh: true });

    const upsert = runtime.calls.find((call) => call.path === "/v1/definitions")!;
    expect(upsert.headers.get("idempotency-key")).toBe("camelai-thread");
    expect(upsert.body).toMatchObject({
      name: "camelai-thread",
      fileTools: false,
      mcpServers: [{ name: "camel", url: "http://127.0.0.1:3001/mcp/agent", auth: { type: "runtime" }, exposure: "both" }],
    });
    expect(runtime.webhooks).toEqual([
      expect.objectContaining({ url: "http://127.0.0.1:3001/agent-runtime/events", events: RUNTIME_WEBHOOK_EVENTS }),
    ]);
    const state = await readAgentRuntimeState(stateDir);
    expect(state).toMatchObject({ definitionId: result!.definitionId, webhookId: "we_1", webhookSecret: runtime.webhooks[0].secret });
    expect((await fs.stat(path.join(stateDir, "agent-runtime.json"))).mode % 0o1000).toBe(0o600);
  });

  it("is idempotent across restarts: the same definition, one webhook, the kept secret", async () => {
    const stateDir = await temporaryDirectory();
    const runtime = fakeRuntime();
    const first = await provisionSelfhostAgentRuntime({ env, stateDir, fetchImpl: runtime.fetchImpl, log: quiet });
    const second = await provisionSelfhostAgentRuntime({ env, stateDir, fetchImpl: runtime.fetchImpl, log: quiet });
    expect(second).toEqual(first);
    expect(runtime.webhooks).toHaveLength(1);
    expect(runtime.definitions.get(first!.definitionId)!.revision).toBe(1);
    expect(runtime.calls.filter((call) => call.path.endsWith("/secret"))).toHaveLength(0);
  });

  it("rotates an existing endpoint's secret when the state volume lost it, instead of adding a second endpoint", async () => {
    const stateDir = await temporaryDirectory();
    const runtime = fakeRuntime({
      webhooks: [{ id: "we_old", url: "http://127.0.0.1:3001/agent-runtime/events", events: ["run.completed"], secret: "whsec_lost" }],
    });
    const result = await provisionSelfhostAgentRuntime({ env, stateDir, fetchImpl: runtime.fetchImpl, log: quiet });
    expect(runtime.webhooks).toHaveLength(1);
    expect(result!.webhookSecret).toBe(runtime.webhooks[0].secret);
    expect(result!.webhookSecret).not.toBe("whsec_lost");
    // Events it lacked are added.
    expect(runtime.webhooks[0].events).toEqual(expect.arrayContaining(RUNTIME_WEBHOOK_EVENTS));
  });

  it("keeps using the last provisioned state while the runtime is down, and fails without one", async () => {
    const stateDir = await temporaryDirectory();
    const runtime = fakeRuntime();
    const first = await provisionSelfhostAgentRuntime({ env, stateDir, fetchImpl: runtime.fetchImpl, log: quiet });
    const down = refused("connect ECONNREFUSED");
    const again = await provisionSelfhostAgentRuntime({ env, stateDir, fetchImpl: down, waitTimeoutMs: 0, log: quiet });
    expect(again).toEqual({ ...first, fresh: false });
    await expect(provisionSelfhostAgentRuntime({ env, stateDir: await temporaryDirectory(), fetchImpl: down, waitTimeoutMs: 0, log: quiet }))
      .rejects.toThrow(/not healthy/);
  });

  it("refuses an operator token of another tenant, and does nothing without a runtime configured", async () => {
    const runtime = fakeRuntime({ tenant: "someone-else" });
    await expect(provisionSelfhostAgentRuntime({ env, stateDir: await temporaryDirectory(), fetchImpl: runtime.fetchImpl, log: quiet }))
      .rejects.toThrow(/someone-else/);
    expect(await provisionSelfhostAgentRuntime({ env: { AGENT_RUNTIME_URL: RUNTIME }, stateDir: await temporaryDirectory(), fetchImpl: runtime.fetchImpl, log: quiet }))
      .toBeNull();
  });

  it("calls the app back at http://127.0.0.1:<port>, the exact origin the runtime allows", async () => {
    expect(chiridionLoopbackUrl({ SELFHOST_WORKERD_SOCKET: "127.0.0.1:3001" })).toBe("http://127.0.0.1:3001");
    expect(chiridionLoopbackUrl({ SELFHOST_WORKERD_SOCKET: "*:3001" })).toBe("http://127.0.0.1:3001");
    expect(chiridionLoopbackUrl({ SELFHOST_WORKERD_SOCKET: "::1:4000" })).toBe("http://127.0.0.1:4000");
    expect(chiridionLoopbackUrl({ AGENT_RUNTIME_CHIRIDION_URL: "http://10.0.0.2:3001/" })).toBe("http://10.0.0.2:3001");
    // Compose allows exactly this origin (AGENT_OUTBOUND_ALLOW_ORIGINS), and nothing else on loopback.
    const compose = await fs.readFile(path.join(import.meta.dirname, "..", "docker-compose.selfhost.yml"), "utf8");
    expect(compose).toContain("AGENT_OUTBOUND_ALLOW_ORIGINS: http://127.0.0.1:${SELFHOST_APP_PORT:-3001}");
    expect(compose).not.toMatch(/AGENT_OUTBOUND_ALLOW_(HTTP|CIDRS)/);
  });

  it("does not fall back to the last state when the runtime refuses the token or it is another tenant's", async () => {
    const stateDir = await temporaryDirectory();
    await provisionSelfhostAgentRuntime({ env, stateDir, fetchImpl: fakeRuntime().fetchImpl, log: quiet });
    await expect(provisionSelfhostAgentRuntime({ env: { ...env, AGENT_RUNTIME_API_TOKEN: "art_rotated-but-not-on-the-runtime" }, stateDir, fetchImpl: fakeRuntime().fetchImpl, log: quiet }))
      .rejects.toThrow(/HTTP 401/);
    await expect(provisionSelfhostAgentRuntime({ env, stateDir, fetchImpl: fakeRuntime({ tenant: "someone-else" }).fetchImpl, log: quiet }))
      .rejects.toThrow(/someone-else/);
  });

  it("removes this app's other events webhooks (an old port, a duplicate), and no one else's", async () => {
    const description = "camelAI self-host: chat threads (runs, inputs, usage)";
    const runtime = fakeRuntime({
      webhooks: [
        { id: "we_oldport", url: "http://127.0.0.1:3000/agent-runtime/events", events: RUNTIME_WEBHOOK_EVENTS, secret: "whsec_a", description },
        { id: "we_dup", url: "http://127.0.0.1:3001/agent-runtime/events", events: RUNTIME_WEBHOOK_EVENTS, secret: "whsec_b" },
        { id: "we_dup2", url: "http://127.0.0.1:3001/agent-runtime/events", events: RUNTIME_WEBHOOK_EVENTS, secret: "whsec_c" },
        { id: "we_theirs", url: "https://elsewhere.example/hook", events: ["run.completed"], secret: "whsec_d", description: "billing" },
      ],
    });
    await provisionSelfhostAgentRuntime({ env, stateDir: await temporaryDirectory(), fetchImpl: runtime.fetchImpl, log: quiet });
    expect(runtime.webhooks.map((entry) => entry.id)).toEqual(["we_dup", "we_theirs"]);
  });
});

describe("selfhost doctor: agent runtime", () => {
  it("passes a provisioned runtime, and names what is missing on one that is not", async () => {
    const stateDir = await temporaryDirectory();
    const runtime = fakeRuntime();
    const doctorEnv = { AGENT_RUNTIME_TENANT: "camelai-selfhost", AGENT_RUNTIME_API_TOKEN: TOKEN };
    const before = await inspectSelfhostAgentRuntime({ env: doctorEnv, fetchImpl: runtime.fetchImpl });
    expect(before.listening).toBe(true);
    expect(before.findings.filter((finding) => finding.level === "warn").map((finding) => finding.message).join("\n"))
      .toMatch(/not provisioned yet[\s\S]*no events webhook/);

    await provisionSelfhostAgentRuntime({ env, stateDir, fetchImpl: runtime.fetchImpl, log: quiet });
    const after = await inspectSelfhostAgentRuntime({ env: doctorEnv, fetchImpl: runtime.fetchImpl });
    expect(after.findings.every((finding) => finding.level === "pass")).toBe(true);
    // Nothing secret in what the doctor prints.
    expect(JSON.stringify(after)).not.toContain(TOKEN);
    expect(JSON.stringify(after)).not.toContain("whsec_");
  });

  it("sends the app a signed test event with the provisioned secret, and fails when the app refuses it", async () => {
    const stateDir = await temporaryDirectory();
    const runtime = fakeRuntime();
    const provisioned = await provisionSelfhostAgentRuntime({ env, stateDir, fetchImpl: runtime.fetchImpl, log: quiet });
    const received: Array<{ type: string }> = [];
    const app = (bound: string) => vi.fn(async (input: string, init: RequestInit = {}) => {
      if (!String(input).startsWith("http://127.0.0.1:3001/agent-runtime/events")) return runtime.fetchImpl(input, init);
      const body = String(init.body);
      if (!await verifyStandardWebhook(bound, new Headers(init.headers), body)) return Response.json({ error: "Invalid webhook signature" }, { status: 401 });
      received.push(JSON.parse(body));
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const doctorEnv = { AGENT_RUNTIME_TENANT: "camelai-selfhost", AGENT_RUNTIME_API_TOKEN: TOKEN };

    const good = await inspectSelfhostAgentRuntime({ env: doctorEnv, fetchImpl: app(provisioned!.webhookSecret), webhookSecret: provisioned!.webhookSecret });
    expect(good.findings.at(-1)).toMatchObject({ level: "pass", message: expect.stringMatching(/accepts events signed/) });
    expect(received).toEqual([expect.objectContaining({ type: "selfhost.doctor" })]);
    expect(JSON.stringify(good)).not.toContain(provisioned!.webhookSecret);

    const stale = await inspectSelfhostAgentRuntime({ env: doctorEnv, fetchImpl: app("whsec_c29tZXRoaW5nLWVsc2U="), webhookSecret: provisioned!.webhookSecret });
    expect(stale.findings.at(-1)).toMatchObject({ level: "fail", message: expect.stringMatching(/HTTP 401/) });
  });

  it("fails on a token the runtime refuses, and reports a stopped runtime as not listening", async () => {
    const runtime = fakeRuntime();
    const wrongToken = await inspectSelfhostAgentRuntime({ env: { AGENT_RUNTIME_TENANT: "camelai-selfhost", AGENT_RUNTIME_API_TOKEN: "wrong" }, fetchImpl: runtime.fetchImpl });
    expect(wrongToken.findings.at(-1)).toMatchObject({ level: "fail", message: expect.stringMatching(/HTTP 401/) });
    const stopped = await inspectSelfhostAgentRuntime({ env: {}, fetchImpl: refused("refused") });
    expect(stopped).toMatchObject({ listening: false, findings: [] });
  });
});

describe("selfhost secret migrations: agent runtime", () => {
  it("adds the runtime's image, tenant and secrets to an existing install once, never rotating them", async () => {
    const directory = await temporaryDirectory();
    const envPath = path.join(directory, ".env.selfhost");
    await fs.writeFile(envPath, "TOKEN_SIGNING_SECRET=existing\nADMIN_API_KEY=kept\n", { mode: 0o644 });
    const first = await ensureSelfhostSecrets(envPath, { existingVolumes: async () => [] });
    expect(first.created).toEqual(AGENT_RUNTIME_ENV_DEFAULTS.map((entry) => entry[0]));
    const text = await fs.readFile(envPath, "utf8");
    expect(text).toContain("TOKEN_SIGNING_SECRET=existing\nADMIN_API_KEY=kept\n");
    expect(text).toContain(`SELFHOST_AGENT_RUNTIME_IMAGE=${SELFHOST_AGENT_RUNTIME_IMAGE}`);
    expect(text).toContain("AGENT_RUNTIME_TENANT=camelai-selfhost");
    expect(text).toMatch(/^AGENT_RUNTIME_API_TOKEN=art_[A-Za-z0-9_-]{43}$/m);
    for (const key of ["AGENT_RUNTIME_SESSION_SECRET", "AGENT_RUNTIME_SECRETS_KEY", "AGENT_RUNTIME_POSTGRES_PASSWORD"]) {
      expect(text).toMatch(new RegExp(`^${key}=[0-9a-f]{64}$`, "m"));
    }
    expect((await fs.stat(envPath)).mode % 0o1000).toBe(0o600);

    const second = await ensureSelfhostSecrets(envPath, { existingVolumes: async (names) => names });
    expect(second.created).toEqual([]);
    expect(await fs.readFile(envPath, "utf8")).toBe(text);
  });

  it("refuses to generate the runtime's stateful secrets while its volumes exist", async () => {
    const directory = await temporaryDirectory();
    const envPath = path.join(directory, ".env.selfhost");
    const before = "COMPOSE_PROJECT_NAME=acme\nADMIN_API_KEY=kept\nAGENT_RUNTIME_SESSION_SECRET=kept\n";
    await fs.writeFile(envPath, before, { mode: 0o600 });
    const asked: string[][] = [];
    const existingVolumes = async (names: string[]) => { asked.push(names); return names.slice(0, 1); };
    await expect(ensureSelfhostSecrets(envPath, { existingVolumes }))
      .rejects.toThrow(/Refusing to generate AGENT_RUNTIME_SECRETS_KEY, AGENT_RUNTIME_POSTGRES_PASSWORD: the agent runtime's volumes \(acme_agent-runtime-postgres\) exist/);
    expect(asked).toEqual([["acme_agent-runtime-postgres", "acme_agent-runtime-data"]]);
    // Nothing written: not even the values that are safe to add.
    expect(await fs.readFile(envPath, "utf8")).toBe(before);
    // Without the volumes (a new install), they are generated.
    const created = await ensureSelfhostSecrets(envPath, { existingVolumes: async () => [] });
    expect(created.created).toEqual(expect.arrayContaining(["AGENT_RUNTIME_SECRETS_KEY", "AGENT_RUNTIME_POSTGRES_PASSWORD"]));
  });
});
