import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, join, extname, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentSupervisor } from "./supervisor.ts";
import { configuredModel } from "./model.ts";
import { localTools } from "./local-tools.ts";
import { errorText } from "./protocol.ts";
import { sessionConfig } from "./session-config.ts";
import { ClientSessions } from "./client-sessions.ts";
import { DEFAULT_TENANT, Tenants } from "./tenants.ts";
import { Accounts } from "./accounts.ts";
import { ConsoleAuth } from "./console-auth.ts";
import { handleApi } from "./api.ts";

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
const supervisor = new AgentSupervisor(join(root, "sessions"), { runtime: process.env.AGENT_RUNTIME, maxAgents });
const model = configuredModel();
const toolTimeoutMs = Number(process.env.AGENT_TOOL_TIMEOUT_MS ?? 15_000);
if (!Number.isInteger(toolTimeoutMs) || toolTimeoutMs < 1 || toolTimeoutMs > 15 * 60_000) throw new Error("AGENT_TOOL_TIMEOUT_MS must be an integer between 1 and 900000");
const idleMs = Number(process.env.AGENT_IDLE_MS ?? 5 * 60_000);
if (!Number.isInteger(idleMs) || idleMs < 1000) throw new Error("AGENT_IDLE_MS must be an integer of at least 1000");
// Endpoints beyond the default model's and Pi's published ones that may receive a provider key.
const allowedBaseUrls = (process.env.AGENT_ALLOWED_BASE_URLS ?? "").split(",").map(value => value.trim()).filter(Boolean);
const port = Number(process.env.PORT ?? 8790);
const publicUrl = (process.env.AGENT_PUBLIC_URL ?? `http://127.0.0.1:${port}`).replace(/\/+$/, "");
// Tenant-set provider keys are encrypted with AGENT_SECRETS_KEY; without it tenants cannot store keys.
const accounts = new Accounts({ tenants, root: join(root, "tenants"), secretsKey: process.env.AGENT_SECRETS_KEY });
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
  if (!tenants.legacy && !accounts.hasKey(tenant, config.model.provider)) {
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

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}'); return;
  }
  if (await consoleAuth.handle(req, res)) return;
  if (await handleApi(req, res, { accounts, clients, consoleAuth, createAgent, verifyKeys: process.env.AGENT_VERIFY_KEYS !== "false" })) return;
  if (req.method === "GET" && (req.url === "/console" || req.url?.startsWith("/console/"))) { await serveConsole(req, res); return; }
  if (req.method === "GET" && req.url === "/") { res.writeHead(302, { Location: "/console/" }).end(); return; }
  if (await clients.handle(req, res)) return;
  const principal = accounts.authenticate(req.headers.authorization);
  const tenant = principal && { id: principal.tenant };
  if (!tenant) { res.writeHead(401).end(); return; }
  let streaming = false;
  try {
    if (req.headers.origin) { res.writeHead(403).end(); return; }
    if (req.method === "GET" && req.url === "/registry") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(clients.list(tenant.id))); return;
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
  root: join(root, "client-sessions"), secret: sessionSecret, toolTimeoutMs, idleMs, maxProcessesPerTenant,
  apiKeyFor: (tenant, provider) => accounts.apiKey(tenant, provider),
  onUsage: (tenant, agent, message) => { void accounts.recordUsage(tenant, agent, message).catch(error => console.error(JSON.stringify({ type: "usage_record_failed", error: errorText(error) }))); },
});
server.requestTimeout = 30_000;
server.listen(port, process.env.HOST ?? "127.0.0.1", () => {
  console.log(JSON.stringify({ type: "listening", address: server.address(), tenants: tenants.legacy ? "single" : "file", github: !!github, keyStorage: accounts.canStoreKeys }));
});
process.on("SIGHUP", () => {
  try { tenants.reload(); console.log(JSON.stringify({ type: "tenants_reloaded" })); }
  catch (error) { console.error(JSON.stringify({ type: "tenants_reload_failed", error: errorText(error) })); }
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
  server.close();
  void clients.close().then(() => supervisor.close()).then(() => process.exit(0));
});
