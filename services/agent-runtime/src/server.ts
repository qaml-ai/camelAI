import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { resolve, join } from "node:path";
import { AgentSupervisor } from "./supervisor.ts";
import { configuredModel } from "./model.ts";
import { localTools } from "./local-tools.ts";
import { errorText } from "./protocol.ts";
import { sessionConfig } from "./session-config.ts";
import { ClientSessions } from "./client-sessions.ts";


const token = process.env.AGENT_RUNTIME_TOKEN;
if (!token || token.length < 24) throw new Error("Set AGENT_RUNTIME_TOKEN to at least 24 random characters");
const root = resolve(process.env.AGENT_DATA_DIR ?? ".agent-runtime");
const supervisor = new AgentSupervisor(join(root, "sessions"), { runtime: process.env.AGENT_RUNTIME });
const model = configuredModel();
const toolTimeoutMs = Number(process.env.AGENT_TOOL_TIMEOUT_MS ?? 15_000);
if (!Number.isInteger(toolTimeoutMs) || toolTimeoutMs < 1 || toolTimeoutMs > 15 * 60_000) throw new Error("AGENT_TOOL_TIMEOUT_MS must be an integer between 1 and 900000");
const server = createServer(async (req, res) => {
  if (await clients.handle(req, res)) return;
  const received = Buffer.from(req.headers.authorization ?? "");
  const expected = Buffer.from(`Bearer ${token}`);
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    res.writeHead(401).end(); return;
  }
  let streaming = false;
  try {
    if (req.headers.origin) { res.writeHead(403).end(); return; }
    if (req.method === "GET" && req.url === "/registry") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(clients.list())); return;
    }
    const registered = /^\/registry\/(client_[a-f0-9]{40})(\/requests)?$/.exec(req.url ?? "");
    if (registered) {
      if (req.method === "GET" && !registered[2]) {
        const agent = clients.inspect(registered[1]);
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(agent)); return;
      }
      if (req.method === "POST" && registered[2]) {
        req.url = `/clients/${registered[1]}/requests`; await clients.handle(req, res, true); return;
      }
      res.writeHead(405).end(); return;
    }
    if (req.method === "POST" && req.url === "/client-sessions") {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 18 * 1024 * 1024) throw new Error("Request too large");
      }
      const params = JSON.parse(body);
      const key = req.headers["idempotency-key"];
      if (key !== undefined && typeof key !== "string") throw new Error("Invalid idempotency key");
      const config = sessionConfig(params, model, process.env.AGENT_SYSTEM_PROMPT);
      const result = await clients.create(params.tools, config, key, { name: params.name, type: params.type });
      res.writeHead(201, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(result));
      return;
    }
    const match = /^\/agents\/([a-zA-Z0-9_-]{1,80})(?:\/(prompt|execute|abort))?$/.exec(req.url ?? "");
    if (!match) { res.writeHead(404).end(); return; }
    const [, id, action] = match;
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (Buffer.byteLength(body) > 256_000) throw new Error("Request too large");
    }
    const params = body ? JSON.parse(body) : {};
    let result: unknown;
    if (req.method === "POST" && !action) {
      result = await supervisor.start(id, { model, apiKey: process.env.AGENT_API_KEY, ...(process.env.AGENT_SYSTEM_PROMPT ? { systemPrompt: process.env.AGENT_SYSTEM_PROMPT } : {}) }, await localTools(join(root, "workspaces", id)));
    } else if (req.method === "GET" && !action) result = await supervisor.request(id, "status");
    else if (req.method === "DELETE" && !action) { clients.remove(id); await supervisor.stop(id); result = { stopped: true }; }
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
const clients = new ClientSessions(supervisor, { root: join(root, "client-sessions"), secret: token, apiKey: process.env.AGENT_API_KEY, toolTimeoutMs });
server.requestTimeout = 30_000;
server.listen(Number(process.env.PORT ?? 8790), process.env.HOST ?? "127.0.0.1", () => {
  console.log(JSON.stringify({ type: "listening", address: server.address() }));
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
  clients.close();
  server.close();
  void supervisor.close().then(() => process.exit(0));
});
