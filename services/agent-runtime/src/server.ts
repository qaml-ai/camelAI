import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, join, extname, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentSupervisor, type Hosting } from "./supervisor.ts";
import { configuredModel } from "./model.ts";
import { localTools } from "./local-tools.ts";
import { errorText } from "./protocol.ts";
import { sessionConfig } from "./session-config.ts";
import { ClientSessions } from "./client-sessions.ts";
import { openStorage, storageFromEnvironment } from "../shared/storage-config.ts";
import { postgresLeases, storageLeases, type LeaseStore } from "../shared/leases.ts";
import type { Storage } from "../shared/storage.ts";
import { DEFAULT_TENANT, Tenants } from "./tenants.ts";
import { Accounts } from "./accounts.ts";
import { ConsoleAuth } from "./console-auth.ts";
import { handleApi } from "./api.ts";
import { Scheduler } from "./scheduler.ts";
import { Executions, executorEndpoint } from "./executions.ts";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

// Hosted mode reads tenants (operator token hashes and provider keys) from AGENT_TENANTS_FILE.
// Without it, one operator token (AGENT_RUNTIME_TOKEN) and key (AGENT_API_KEY) serve everything.
const tenants = new Tenants({ file: process.env.AGENT_TENANTS_FILE, legacyToken: process.env.AGENT_RUNTIME_TOKEN, legacyApiKey: process.env.AGENT_API_KEY });
// Derives client session tokens. It must stay stable, or re-provisioning returns tokens that no longer verify.
const sessionSecret = process.env.AGENT_SESSION_SECRET ?? (tenants.legacy ? process.env.AGENT_RUNTIME_TOKEN : undefined);
if (!sessionSecret || sessionSecret.length < (process.env.AGENT_SESSION_SECRET ? 32 : 24)) throw new Error("Set AGENT_SESSION_SECRET to at least 32 random characters");
const root = resolve(process.env.AGENT_DATA_DIR ?? ".agent-runtime");
const maxAgents = Number(process.env.AGENT_MAX_PROCESSES ?? 8);
if (!Number.isInteger(maxAgents) || maxAgents < 1) throw new Error("AGENT_MAX_PROCESSES must be a positive integer");
const maxProcessesPerTenant = Number(process.env.AGENT_MAX_PROCESSES_PER_TENANT ?? Math.max(1, Math.ceil(maxAgents / 2)));
if (!Number.isInteger(maxProcessesPerTenant) || maxProcessesPerTenant < 1) throw new Error("AGENT_MAX_PROCESSES_PER_TENANT must be a positive integer");
const port = Number(process.env.PORT ?? 8790);
// Durable state: local files by default, or shared storage (S3) so any node can serve any agent.
const storageDescriptor = storageFromEnvironment(root);
const storage = await openStorage(storageDescriptor);
const distributed = storageDescriptor.kind === "s3" || !!(storageDescriptor.kind === "file" && storageDescriptor.shared);
// How peers reach this node; it is also the lease owner name.
const node = (process.env.AGENT_NODE_URL ?? `http://127.0.0.1:${port}`).replace(/\/+$/, "");
const leases = await leasesFromEnvironment(storage);
const hosting = (process.env.AGENT_HOSTING ?? "process") as Hosting;
if (!["process", "inline"].includes(hosting)) throw new Error("AGENT_HOSTING must be process or inline");
// With AGENT_EXECUTOR_URL, js_exec runs on executor hosts that hold no credentials or agent state.
// They call tools back through a separate listener on a private address, never the public one.
const executor = process.env.AGENT_EXECUTOR_URL ? {
  endpoint: executorEndpoint(process.env.AGENT_EXECUTOR_URL, process.env.AGENT_EXECUTOR_TOKEN),
  executions: new Executions(process.env.AGENT_EXECUTOR_CALLBACK_URL ?? ""),
} : undefined;
const callbackPort = Number(process.env.AGENT_EXECUTOR_CALLBACK_PORT ?? 8791);
if (!Number.isInteger(callbackPort) || callbackPort < 1 || callbackPort > 65535) throw new Error("AGENT_EXECUTOR_CALLBACK_PORT must be a TCP port");
const supervisor = new AgentSupervisor(join(root, "sessions"), { runtime: process.env.AGENT_RUNTIME, maxAgents, hosting, executor, ...(distributed ? { storage: storageDescriptor } : {}) });

/** AGENT_LEASES: none | storage | postgres (AGENT_LEASES_POSTGRES_URL). Distributed storage defaults to storage leases. */
async function leasesFromEnvironment(storage: Storage): Promise<LeaseStore | undefined> {
  const kind = process.env.AGENT_LEASES ?? (distributed ? "storage" : "none");
  if (kind === "none") {
    if (distributed) throw new Error("Shared storage needs leases so two nodes never serve the same agent");
    return undefined;
  }
  if (kind === "storage") return storageLeases(storage);
  if (kind === "postgres") {
    if (!process.env.AGENT_LEASES_POSTGRES_URL) throw new Error("AGENT_LEASES=postgres needs AGENT_LEASES_POSTGRES_URL");
    const { default: pg } = await import("pg");
    return postgresLeases(new pg.Pool({ connectionString: process.env.AGENT_LEASES_POSTGRES_URL, max: 10 }));
  }
  throw new Error(`Unknown AGENT_LEASES: ${kind}`);
}
const model = configuredModel();
const toolTimeoutMs = Number(process.env.AGENT_TOOL_TIMEOUT_MS ?? 15_000);
if (!Number.isInteger(toolTimeoutMs) || toolTimeoutMs < 1 || toolTimeoutMs > 15 * 60_000) throw new Error("AGENT_TOOL_TIMEOUT_MS must be an integer between 1 and 900000");
const idleMs = Number(process.env.AGENT_IDLE_MS ?? 5 * 60_000);
if (!Number.isInteger(idleMs) || idleMs < 1000) throw new Error("AGENT_IDLE_MS must be an integer of at least 1000");
// Endpoints beyond the default model's and Pi's published ones that may receive a provider key.
const allowedBaseUrls = (process.env.AGENT_ALLOWED_BASE_URLS ?? "").split(",").map(value => value.trim()).filter(Boolean);
const publicUrl = (process.env.AGENT_PUBLIC_URL ?? `http://127.0.0.1:${port}`).replace(/\/+$/, "");
// Tenant-set provider keys are encrypted with AGENT_SECRETS_KEY; without it tenants cannot store keys.
const accounts = new Accounts({ tenants, storage, secretsKey: process.env.AGENT_SECRETS_KEY, node });
const github = process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET
  ? { clientId: process.env.GITHUB_CLIENT_ID, clientSecret: process.env.GITHUB_CLIENT_SECRET, org: process.env.GITHUB_ORG ?? "qaml-ai",
      webUrl: process.env.AGENT_GITHUB_WEB_URL, apiUrl: process.env.AGENT_GITHUB_API_URL }
  : undefined;
const consoleAuth = new ConsoleAuth({ accounts, secret: sessionSecret, publicUrl, github });
const consoleDir = resolve(process.env.AGENT_CONSOLE_DIR ?? fileURLToPath(new URL("../console/dist", import.meta.url)));

/** Provision an agent for `tenant`: the shared path behind POST /client-sessions and POST /v1/agents. */
async function createAgent(tenant: string, params: any, key?: string) {
  const config = sessionConfig(params, model, process.env.AGENT_SYSTEM_PROMPT, allowedBaseUrls);
  // A single-tenant development host may run code-only agents without a model key.
  if (!tenants.legacy && !await accounts.hasKey(tenant, config.model.provider)) {
    throw new Error(`No ${config.model.provider} API key is configured for tenant ${tenant}; set one with PUT /v1/providers/${config.model.provider}/key`);
  }
  return clients.create(params.tools ?? [], config, key, { name: params.name, type: params.type }, tenant);
}

const CONTENT_TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".woff2": "font/woff2" };
/** Serve the console's static build; unknown paths get index.html for client-side routing. */
async function serveConsole(req: IncomingMessage, res: ServerResponse) {
  const path = new URL(req.url ?? "/", publicUrl).pathname;
  if (path === "/console") { res.writeHead(302, { Location: "/console/" }).end(); return; }
  const relative = normalize(decodeURIComponent(path.slice("/console/".length))).replace(/^(\.\.(\/|\\|$))+/, "");
  const file = join(consoleDir, relative);
  let asset = !!relative && !relative.endsWith("/") && file.startsWith(consoleDir + sep);
  let body: Buffer | undefined;
  if (asset) {
    try { body = await readFile(file); } catch { asset = false; }
  }
  // Anything that is not a built file is a client-side route: serve the app shell.
  if (!body) {
    try { body = await readFile(join(consoleDir, "index.html")); }
    catch { res.writeHead(404, { "Content-Type": "text/plain" }).end("The console is not built on this host"); return; }
  }
  const type = asset ? CONTENT_TYPES[extname(file)] ?? "application/octet-stream" : CONTENT_TYPES[".html"];
  res.writeHead(200, {
    "Content-Type": type,
    "Cache-Control": asset && relative.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-store",
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin",
  }).end(body);
}

async function body(req: import("node:http").IncomingMessage, limit: number) {
  let text = "";
  for await (const chunk of req) {
    text += chunk;
    if (Buffer.byteLength(text) > limit) throw new Error("Request too large");
  }
  return text ? JSON.parse(text) : {};
}

/** The agent a request addresses, if any: `/clients/<id>`, `/v1/agents/<id>`, `/registry/<id>` or `/internal/agents/<id>`. */
const agentOf = (url = "") => /^\/(?:clients|v1\/agents|registry|internal\/agents)\/(client_[a-f0-9]{40})(?:[/?]|$)/.exec(url)?.[1];

/** Node-to-node requests are signed with the session secret all nodes share. */
const internalSignature = (timestamp: string, path: string, body: string) =>
  createHmac("sha256", sessionSecret!).update(`internal:${timestamp}:${path}:${createHash("sha256").update(body).digest("hex")}`).digest("hex");

/** Submit a request to an agent wherever it is served: here, or on the node that owns it. */
async function submitAnywhere(agent: string, tenant: string, request: { id: string; method: string; params: Record<string, unknown> }) {
  const owner = await clients.ownerElsewhere(agent);
  if (!owner) return clients.submit(agent, tenant, request);
  const path = `/internal/agents/${agent}/requests`;
  const body = JSON.stringify({ tenant, request });
  const timestamp = String(Date.now());
  const response = await fetch(new URL(path, owner), {
    method: "POST", body, signal: AbortSignal.timeout(15_000),
    headers: { "Content-Type": "application/json", "x-agent-runtime-internal": `${timestamp}.${internalSignature(timestamp, path, body)}` },
  });
  if (!response.ok) throw Object.assign(new Error(`Owner rejected the request: HTTP ${response.status}`), { status: response.status });
  return response.json();
}

async function handleInternal(req: IncomingMessage, res: ServerResponse) {
  const match = /^\/internal\/agents\/(client_[a-f0-9]{40})\/requests$/.exec(req.url ?? "");
  if (!match || req.method !== "POST") { res.writeHead(404).end(); return; }
  let body = "";
  for await (const chunk of req) { body += chunk; if (body.length > 1_100_000) { res.writeHead(413).end(); return; } }
  const [timestamp, signature] = String(req.headers["x-agent-runtime-internal"] ?? "").split(".");
  const expected = Buffer.from(internalSignature(timestamp ?? "", req.url!, body));
  const given = Buffer.from(signature ?? "");
  if (!timestamp || Math.abs(Date.now() - Number(timestamp)) > 60_000 || expected.length !== given.length || !timingSafeEqual(expected, given)) { res.writeHead(401).end(); return; }
  try {
    const { tenant, request } = JSON.parse(body);
    res.writeHead(202, { "Content-Type": "application/json" }).end(JSON.stringify(await clients.submit(match[1], tenant, request)));
  } catch (error) {
    res.writeHead((error as { status?: number }).status ?? 400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: errorText(error) }));
  }
}
const FORWARDED = "x-agent-runtime-forwarded";

/** Stream a request to the node that owns its agent, and stream the answer back (SSE included). */
function forward(req: IncomingMessage, res: ServerResponse, owner: string) {
  const target = new URL(req.url ?? "/", owner);
  const upstream = httpRequest(target, { method: req.method, headers: { ...req.headers, host: target.host, [FORWARDED]: node } }, answer => {
    res.writeHead(answer.statusCode ?? 502, answer.headers);
    answer.pipe(res);
    // Piping does not end the client's response when the owner dies mid-stream; cut it so the client reconnects now.
    answer.on("close", () => { if (!answer.complete) res.destroy(); });
  });
  upstream.on("error", () => { if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json" }).end('{"error":"The node serving this agent is unreachable; retry"}'); else res.destroy(); });
  res.on("close", () => upstream.destroy());
  req.pipe(upstream);
}

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}'); return;
  }
  // One node serves each agent; anything addressed to an agent another node holds goes there.
  const agent = leases && !req.headers[FORWARDED] ? agentOf(req.url) : undefined;
  if (agent) {
    const owner = await clients.ownerElsewhere(agent).catch(() => undefined);
    if (owner) { forward(req, res, owner); return; }
  }
  if (req.url?.startsWith("/internal/")) { await handleInternal(req, res); return; }
  if (await consoleAuth.handle(req, res)) return;
  if (await handleApi(req, res, { accounts, clients, consoleAuth, createAgent, scheduler, verifyKeys: process.env.AGENT_VERIFY_KEYS !== "false" })) return;
  if (req.method === "GET" && (req.url === "/console" || req.url?.startsWith("/console/"))) { await serveConsole(req, res); return; }
  if (req.method === "GET" && req.url === "/") { res.writeHead(302, { Location: "/console/" }).end(); return; }
  if (await clients.handle(req, res)) return;
  const principal = await accounts.authenticate(req.headers.authorization);
  const tenant = principal && { id: principal.tenant };
  if (!tenant) { res.writeHead(401).end(); return; }
  let streaming = false;
  try {
    if (req.headers.origin) { res.writeHead(403).end(); return; }
    if (req.method === "GET" && req.url === "/registry") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(await clients.list(tenant.id))); return;
    }
    const registered = /^\/registry\/(client_[a-f0-9]{40})(\/requests)?$/.exec(req.url ?? "");
    if (registered) {
      if (req.method === "GET" && !registered[2]) {
        const agent = await clients.inspect(registered[1], tenant.id);
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(agent)); return;
      }
      if (req.method === "POST" && registered[2]) {
        req.url = `/clients/${registered[1]}/requests`; await clients.handle(req, res, tenant.id); return;
      }
      res.writeHead(405).end(); return;
    }
    if (req.method === "POST" && req.url === "/client-sessions") {
      const params = await body(req, 18 * 1024 * 1024);
      const key = req.headers["idempotency-key"];
      if (key !== undefined && typeof key !== "string") throw new Error("Invalid idempotency key");
      const result = await createAgent(tenant.id, params, key);
      res.writeHead(201, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(result));
      return;
    }
    // Local diagnostic agents with a host workspace: single-tenant development hosts only.
    const match = tenants.legacy && /^\/agents\/([a-zA-Z0-9_-]{1,80})(?:\/(prompt|execute|abort))?$/.exec(req.url ?? "");
    if (!match) { res.writeHead(404).end(); return; }
    const [, id, action] = match;
    const params = await body(req, 256_000);
    let result: unknown;
    if (req.method === "POST" && !action) {
      result = await supervisor.start(id, { model, apiKey: tenants.apiKey(DEFAULT_TENANT, model.provider), ...(process.env.AGENT_SYSTEM_PROMPT ? { systemPrompt: process.env.AGENT_SYSTEM_PROMPT } : {}) }, await localTools(join(root, "workspaces", id)));
    } else if (req.method === "GET" && !action) result = await supervisor.request(id, "status");
    else if (req.method === "DELETE" && !action) { await clients.remove(id); await supervisor.stop(id); result = { stopped: true }; }
    else if (req.method === "POST" && action === "abort") result = await supervisor.request(id, "abort");
    else if (req.method === "POST" && (action === "prompt" || action === "execute")) {
      streaming = true;
      res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" });
      const emit = (event: unknown) => {
        if (!res.destroyed && !res.write(`${JSON.stringify(event)}\n`)) {
          // This prototype has no replay queue. Disconnect slow consumers
          // instead of buffering an unbounded transcript in the supervisor.
          res.destroy();
        }
      };
      result = await supervisor.request(id, action, params, event => emit({ type: "event", event }));
      emit({ type: "result", result });
      res.end(); return;
    } else { res.writeHead(405).end(); return; }
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
  } catch (error) {
    if (!streaming) res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: errorText(error) }) + "\n");
  }
});
const clients = new ClientSessions(supervisor, {
  secret: sessionSecret, toolTimeoutMs, idleMs, maxProcessesPerTenant,
  apiKeyFor: (tenant, provider) => accounts.apiKey(tenant, provider),
  onUsage: (tenant, agent, message) => accounts.recordUsage(tenant, agent, message),
  storage, prefix: "client-sessions/", leases, node, leaseTtlMs: Number(process.env.AGENT_LEASE_TTL_MS ?? 30_000),
  get scheduler() { return scheduler; },
});
// Wake-ups are delivered as prompts with ids derived from the schedule, so repeats are no-ops.
const scheduler = new Scheduler({
  storage, node,
  deliver: async (schedule, requestId) => {
    const request = schedule.code !== undefined ? { method: "execute", params: { code: schedule.code } } : { method: "prompt", params: { text: schedule.text! } };
    await submitAnywhere(schedule.agent, schedule.tenant, { id: requestId, ...request });
  },
});
scheduler.start(Number(process.env.AGENT_SCHEDULER_INTERVAL_MS ?? 5_000));
// One-time migrations of single-host data (both are no-ops once done).
await clients.init();
await accounts.init();
server.requestTimeout = 30_000;
server.listen(port, process.env.HOST ?? "127.0.0.1", () => {
  console.log(JSON.stringify({ type: "listening", address: server.address(), tenants: tenants.legacy ? "single" : "file", hosting, storage: storageDescriptor.kind, github: !!github, keyStorage: accounts.canStoreKeys }));
});
const callbacks = executor && createServer(async (req, res) => {
  if (!await executor.executions.handle(req, res)) res.writeHead(404).end();
});
if (callbacks) {
  callbacks.requestTimeout = 10_000;
  callbacks.listen(callbackPort, process.env.HOST ?? "127.0.0.1", () => {
    console.log(JSON.stringify({ type: "executor_callbacks_listening", address: callbacks.address(), executors: executor!.endpoint.urls }));
  });
}
process.on("SIGHUP", () => {
  try { tenants.reload(); console.log(JSON.stringify({ type: "tenants_reloaded" })); }
  catch (error) { console.error(JSON.stringify({ type: "tenants_reload_failed", error: errorText(error) })); }
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
  server.close();
  callbacks?.close();
  scheduler.stop();
  void clients.close().then(() => supervisor.close()).then(() => accounts.flushUsage()).catch(() => {}).then(() => process.exit(0));
});
