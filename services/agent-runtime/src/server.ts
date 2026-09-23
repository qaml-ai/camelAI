import { createServer } from "node:http";
import { resolve, join } from "node:path";
import { AgentSupervisor } from "./supervisor.ts";
import { configuredModel } from "./model.ts";
import { localTools } from "./local-tools.ts";
import { errorText } from "./protocol.ts";
import { sessionConfig } from "./session-config.ts";
import { ClientSessions } from "./client-sessions.ts";
import { DEFAULT_TENANT, Tenants } from "./tenants.ts";

// Hosted mode reads tenants (operator token hashes and provider keys) from AGENT_TENANTS_FILE.
// Without it, one operator token (AGENT_RUNTIME_TOKEN) and key (AGENT_API_KEY) serve everything.
const tenants = new Tenants({ file: process.env.AGENT_TENANTS_FILE, legacyToken: process.env.AGENT_RUNTIME_TOKEN, legacyApiKey: process.env.AGENT_API_KEY });
// Derives client session tokens. It must stay stable, or re-provisioning returns tokens that no longer verify.
const sessionSecret = process.env.AGENT_SESSION_SECRET ?? (tenants.legacy ? process.env.AGENT_RUNTIME_TOKEN : undefined);
if (!sessionSecret || sessionSecret.length < (process.env.AGENT_SESSION_SECRET ? 32 : 24)) throw new Error("Set AGENT_SESSION_SECRET to at least 32 random characters");
const root = resolve(process.env.AGENT_DATA_DIR ?? ".agent-runtime");
const maxAgents = Number(process.env.AGENT_MAX_PROCESSES ?? 8);
if (!Number.isInteger(maxAgents) || maxAgents < 1) throw new Error("AGENT_MAX_PROCESSES must be a positive integer");
const supervisor = new AgentSupervisor(join(root, "sessions"), { runtime: process.env.AGENT_RUNTIME, maxAgents });
const model = configuredModel();
const toolTimeoutMs = Number(process.env.AGENT_TOOL_TIMEOUT_MS ?? 15_000);
if (!Number.isInteger(toolTimeoutMs) || toolTimeoutMs < 1 || toolTimeoutMs > 15 * 60_000) throw new Error("AGENT_TOOL_TIMEOUT_MS must be an integer between 1 and 900000");
const idleMs = Number(process.env.AGENT_IDLE_MS ?? 5 * 60_000);
if (!Number.isInteger(idleMs) || idleMs < 1000) throw new Error("AGENT_IDLE_MS must be an integer of at least 1000");
// Endpoints beyond the default model's and Pi's published ones that may receive a provider key.
const allowedBaseUrls = (process.env.AGENT_ALLOWED_BASE_URLS ?? "").split(",").map(value => value.trim()).filter(Boolean);

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
  if (await clients.handle(req, res)) return;
  const tenant = tenants.authenticate(req.headers.authorization);
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
      const config = sessionConfig(params, model, process.env.AGENT_SYSTEM_PROMPT, allowedBaseUrls);
      // A single-tenant development host may run code-only agents without a model key.
      if (!tenants.legacy && !tenants.apiKey(tenant.id, config.model.provider)) throw new Error(`No ${config.model.provider} API key is configured for tenant ${tenant.id}`);
      const result = await clients.create(params.tools, config, key, { name: params.name, type: params.type }, tenant.id);
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
  root: join(root, "client-sessions"), secret: sessionSecret, toolTimeoutMs, idleMs,
  apiKeyFor: (tenant, provider) => tenants.apiKey(tenant, provider),
});
server.requestTimeout = 30_000;
server.listen(Number(process.env.PORT ?? 8790), process.env.HOST ?? "127.0.0.1", () => {
  console.log(JSON.stringify({ type: "listening", address: server.address(), tenants: tenants.legacy ? "single" : "file" }));
});
process.on("SIGHUP", () => {
  try { tenants.reload(); console.log(JSON.stringify({ type: "tenants_reloaded" })); }
  catch (error) { console.error(JSON.stringify({ type: "tenants_reload_failed", error: errorText(error) })); }
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
  server.close();
  void clients.close().then(() => supervisor.close()).then(() => process.exit(0));
});
