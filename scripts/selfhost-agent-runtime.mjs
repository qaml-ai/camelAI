/**
 * The agent runtime a self-host install runs its chat threads on
 * (docker-compose.selfhost.yml `agent-runtime`): its pinned image, the
 * secrets selfhost:init and selfhost:migrate-secrets provision, and the
 * tenant state the app sets up at startup, idempotently, before workerd
 * starts (selfhost-workerd-config.mjs):
 *
 * - the tenant: one per install (AGENT_RUNTIME_TENANT), whose operator token
 *   is AGENT_RUNTIME_API_TOKEN; the runtime reads both from its environment,
 *   so it exists as soon as the runtime runs;
 * - the `camelai-thread` definition: upserted by its Idempotency-Key, so its
 *   id is stable (def_<sha256(tenant:key)>) and a changed spec becomes a new
 *   revision of the same definition; its MCP server is chiridion's
 *   /mcp/agent on loopback;
 * - the events webhook (chiridion's /agent-runtime/events): created once; its
 *   signing secret, which the runtime shows only when it makes one, is kept
 *   on the app-state volume. A secret that was lost is replaced by rotating
 *   the endpoint's, never by a second endpoint (which would double events).
 *
 * The runtime is private: it listens on the VM's loopback only (as the app
 * does), and browsers read threads through the app (routes/api/threads.$id.runtime.ts).
 */
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/** The runtime release this checkout runs; release manifests pin it by digest. */
export const SELFHOST_AGENT_RUNTIME_VERSION = "0.1.0";
export const SELFHOST_AGENT_RUNTIME_IMAGE = `ghcr.io/qaml-ai/agent-runtime:${SELFHOST_AGENT_RUNTIME_VERSION}`;
export const SELFHOST_AGENT_RUNTIME_POSTGRES_IMAGE =
  "postgres:16@sha256:1a6ab3f5345eb6dbe04a1349529caabdb0ab09293a09590fad07b2246bfa4b54";
export const SELFHOST_AGENT_RUNTIME_TENANT = "camelai-selfhost";
export const DEFAULT_AGENT_RUNTIME_PORT = "8790";
export const DEFAULT_AGENT_RUNTIME_POSTGRES_PORT = "15432";

/** The definition every chat thread's agent is made from. */
export const THREAD_DEFINITION_KEY = "camelai-thread";
/** The events chiridion's /agent-runtime/events handles (scripts/agent-runtime-webhook.sh). */
export const RUNTIME_WEBHOOK_EVENTS = [
  "run.started",
  "run.completed",
  "run.failed",
  "input.requested",
  "input.resolved",
  "usage.recorded",
];
/** Where the provisioned state (definition id, webhook secret) is kept, under the app's state directory. */
export const AGENT_RUNTIME_STATE_FILE = "agent-runtime.json";

const hex = () => randomBytes(32).toString("hex");

/**
 * The values an install needs for its runtime, each generated only when
 * missing (selfhost:init writes them all; secret migrations add the ones an
 * older install lacks, and never rotate one it has).
 */
export const AGENT_RUNTIME_ENV_DEFAULTS = Object.freeze([
  ["SELFHOST_AGENT_RUNTIME_IMAGE", () => SELFHOST_AGENT_RUNTIME_IMAGE],
  ["SELFHOST_AGENT_RUNTIME_POSTGRES_IMAGE", () => SELFHOST_AGENT_RUNTIME_POSTGRES_IMAGE],
  ["AGENT_RUNTIME_TENANT", () => SELFHOST_AGENT_RUNTIME_TENANT],
  // The tenant's operator token: chiridion's bearer token on the runtime.
  ["AGENT_RUNTIME_API_TOKEN", () => `art_${randomBytes(32).toString("base64url")}`],
  // Agents' tokens and signed links; changing it invalidates them.
  ["AGENT_RUNTIME_SESSION_SECRET", hex],
  // Encrypts stored provider keys and webhook secrets; changing it makes them unreadable.
  ["AGENT_RUNTIME_SECRETS_KEY", hex],
  // Hex, so it goes into the database URL unescaped.
  ["AGENT_RUNTIME_POSTGRES_PASSWORD", hex],
]);

/** The runtime's secrets, which only the runtime's containers need (never Worker bindings). */
export const AGENT_RUNTIME_PRIVATE_KEYS = Object.freeze([
  "AGENT_RUNTIME_SESSION_SECRET",
  "AGENT_RUNTIME_SECRETS_KEY",
  "AGENT_RUNTIME_POSTGRES_PASSWORD",
]);

/**
 * Where the runtime calls the app back (MCP tools, events): the app's own
 * loopback socket (SELFHOST_WORKERD_SOCKET), which the runtime shares the
 * network namespace of.
 */
export function chiridionLoopbackUrl(env) {
  const explicit = String(env.AGENT_RUNTIME_CHIRIDION_URL ?? "").trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const socket = String(env.SELFHOST_WORKERD_SOCKET ?? "").trim() || "127.0.0.1:3001";
  const match = /^(.*):(\d+)$/.exec(socket);
  const [host, port] = match ? [match[1], match[2]] : [socket, "3001"];
  const loopback = !host || host === "*" || host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host;
  return `http://${loopback.includes(":") && !loopback.startsWith("[") ? `[${loopback}]` : loopback}:${port}`;
}

/** The camelai-thread definition for this install (plans/agent-runtime-migration.md §12). */
export function threadDefinition(chiridionUrl) {
  return {
    name: THREAD_DEFINITION_KEY,
    // No model: chiridion sets each agent's model and key scope.
    // No web_search: a self-hosted runtime has no search provider unless its operator adds one.
    builtins: ["web_fetch", "ask_user"],
    fileTools: false,
    mcpServers: [{
      name: "camel",
      url: `${chiridionUrl}/mcp/agent`,
      auth: { type: "runtime" },
      exposure: "both",
      timeoutMs: 1_200_000,
    }],
  };
}

/**
 * The camelai-thread definition's id on a tenant: the runtime derives an
 * upserted definition's id from its tenant and Idempotency-Key.
 */
export function threadDefinitionId(tenant) {
  return `def_${createHash("sha256").update(`${tenant}:${THREAD_DEFINITION_KEY}`).digest("hex").slice(0, 20)}`;
}

/**
 * The runtime's live state for selfhost:doctor, from the host: healthy, the
 * operator token is the tenant's, the thread definition calls the app's
 * tools, and the events webhook is registered with every event. Findings are
 * `{ level: "pass" | "warn" | "fail", message }`; nothing secret is in them.
 * `listening: false` when the runtime is not up (the stack is stopped).
 */
export async function inspectSelfhostAgentRuntime({ env, fetchImpl = globalThis.fetch }) {
  const port = String(env.SELFHOST_AGENT_RUNTIME_PORT || DEFAULT_AGENT_RUNTIME_PORT).trim();
  const url = `http://127.0.0.1:${port}`;
  const tenant = String(env.AGENT_RUNTIME_TENANT ?? "").trim();
  const token = String(env.AGENT_RUNTIME_API_TOKEN ?? "").trim();
  const findings = [];
  const add = (level, message) => findings.push({ level, message });
  try {
    const health = await fetchImpl(`${url}/healthz`, { signal: AbortSignal.timeout(3_000) });
    await health.body?.cancel?.();
    if (!health.ok) {
      add("fail", `runtime at ${url} answers /healthz with HTTP ${health.status}`);
      return { listening: true, url, findings };
    }
  } catch {
    return { listening: false, url, findings };
  }
  add("pass", `runtime healthy at ${url}`);
  const call = runtimeClient({ url, token, fetchImpl });
  try {
    const me = await call("GET", "/v1/me");
    if (me?.tenant !== tenant) {
      add("fail", `AGENT_RUNTIME_API_TOKEN is tenant ${me?.tenant}'s, not ${tenant}'s`);
      return { listening: true, url, findings };
    }
    add("pass", `tenant ${tenant}: operator token accepted`);
  } catch (error) {
    add("fail", `operator token refused (${error.status === 401 ? "HTTP 401: AGENT_RUNTIME_API_TOKEN does not match the runtime's" : error.message})`);
    return { listening: true, url, findings };
  }
  const chiridionUrl = chiridionLoopbackUrl({
    SELFHOST_WORKERD_SOCKET: `${String(env.SELFHOST_BIND_ADDRESS || "127.0.0.1").trim()}:${String(env.SELFHOST_APP_PORT || "3001").trim()}`,
  });
  const definitionId = threadDefinitionId(tenant);
  try {
    const definition = await call("GET", `/v1/definitions/${definitionId}`);
    const mcp = definition?.mcpServers?.find?.((server) => server?.name === "camel");
    if (mcp?.url !== `${chiridionUrl}/mcp/agent`) {
      add("fail", `definition ${definitionId} calls ${mcp?.url ?? "no camel MCP server"}, not ${chiridionUrl}/mcp/agent; restart the app to provision it again`);
    } else {
      add("pass", `thread definition ${definitionId} (revision ${definition.revision}) calls ${mcp.url}`);
    }
  } catch (error) {
    add(error.status === 404 ? "warn" : "fail", error.status === 404
      ? `thread definition ${definitionId} is not provisioned yet (the app provisions it as it starts); new threads run on the in-app loop until then`
      : `could not read the thread definition: ${error.message}`);
  }
  try {
    const endpoints = await call("GET", "/v1/webhooks");
    const webhookUrl = `${chiridionUrl}/agent-runtime/events`;
    const endpoint = (Array.isArray(endpoints) ? endpoints : []).find((entry) => entry?.url === webhookUrl);
    const missing = endpoint ? RUNTIME_WEBHOOK_EVENTS.filter((event) => !endpoint.events?.includes(event)) : RUNTIME_WEBHOOK_EVENTS;
    if (!endpoint) add("warn", `no events webhook for ${webhookUrl} yet (the app registers it as it starts)`);
    else if (missing.length > 0) add("fail", `events webhook ${endpoint.id} lacks ${missing.join(", ")}; restart the app to update it`);
    else add("pass", `events webhook ${endpoint.id} -> ${webhookUrl}`);
  } catch (error) {
    add("fail", `could not list webhooks: ${error.message}`);
  }
  return { listening: true, url, findings };
}

export class AgentRuntimeProvisionError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "AgentRuntimeProvisionError";
    this.status = status;
  }
}

function runtimeClient({ url, token, fetchImpl }) {
  return async (method, route, body, headers = {}) => {
    const response = await fetchImpl(`${url}${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      const detail = typeof parsed?.error === "string" ? parsed.error : parsed?.error?.message ?? text.slice(0, 200);
      throw new AgentRuntimeProvisionError(`${method} ${route}: HTTP ${response.status} ${detail}`, response.status);
    }
    return parsed;
  };
}

/** Wait until the runtime answers /healthz (it applies its migrations as it starts). */
export async function waitForAgentRuntime({ url, fetchImpl = globalThis.fetch, timeoutMs = 120_000, intervalMs = 1_000 }) {
  const deadline = Date.now() + timeoutMs;
  let last = "no answer";
  for (;;) {
    try {
      const response = await fetchImpl(`${url}/healthz`, { signal: AbortSignal.timeout(5_000) });
      await response.body?.cancel?.();
      if (response.ok) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    if (Date.now() >= deadline) {
      throw new AgentRuntimeProvisionError(`The agent runtime at ${url} is not healthy (${last})`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export async function readAgentRuntimeState(stateDir) {
  try {
    return JSON.parse(await fs.readFile(path.join(stateDir, AGENT_RUNTIME_STATE_FILE), "utf8"));
  } catch {
    return null;
  }
}

async function writeAgentRuntimeState(stateDir, state) {
  await fs.mkdir(stateDir, { recursive: true });
  const file = path.join(stateDir, AGENT_RUNTIME_STATE_FILE);
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, file);
}

/**
 * Set up the install's tenant on its runtime (definition, events webhook) and
 * return what the app's Worker needs: AGENT_RUNTIME_DEFINITION and
 * AGENT_RUNTIME_EVENTS_WEBHOOK_SECRET. Idempotent: run on every start.
 *
 * Null when the install has no runtime configured (no URL or token). When
 * the runtime cannot be reached, the last provisioned state is used if there
 * is one (threads keep working once it is back); without one this throws.
 */
export async function provisionSelfhostAgentRuntime({
  env,
  stateDir,
  fetchImpl = globalThis.fetch,
  waitTimeoutMs = 120_000,
  log = console,
}) {
  const url = String(env.AGENT_RUNTIME_URL ?? "").trim().replace(/\/+$/, "");
  const token = String(env.AGENT_RUNTIME_API_TOKEN ?? "").trim();
  const tenant = String(env.AGENT_RUNTIME_TENANT ?? "").trim();
  if (!url || !token || !tenant) return null;
  const chiridionUrl = chiridionLoopbackUrl(env);
  const previous = await readAgentRuntimeState(stateDir);
  try {
    await waitForAgentRuntime({ url, fetchImpl, timeoutMs: waitTimeoutMs });
    const call = runtimeClient({ url, token, fetchImpl });
    const me = await call("GET", "/v1/me");
    if (me && typeof me.tenant === "string" && me.tenant !== tenant) {
      throw new AgentRuntimeProvisionError(`AGENT_RUNTIME_API_TOKEN is tenant ${me.tenant}'s, not ${tenant}'s`);
    }
    // The upsert answers with the listing of its MCP server; the app is not
    // up yet, so that listing fails softly and the runtime lists it again later.
    const definition = await call("POST", "/v1/definitions", threadDefinition(chiridionUrl), {
      "Idempotency-Key": THREAD_DEFINITION_KEY,
    });
    if (typeof definition?.id !== "string") throw new AgentRuntimeProvisionError("The runtime returned no definition id");

    const webhookUrl = `${chiridionUrl}/agent-runtime/events`;
    const endpoints = await call("GET", "/v1/webhooks");
    const existing = (Array.isArray(endpoints) ? endpoints : []).find((endpoint) => endpoint?.url === webhookUrl);
    let webhook;
    if (!existing) {
      const created = await call("POST", "/v1/webhooks", {
        url: webhookUrl,
        events: RUNTIME_WEBHOOK_EVENTS,
        description: "camelAI self-host: chat threads (runs, inputs, usage)",
      });
      webhook = { id: created.id, secret: created.secret };
      log.log?.(`[selfhost:agent-runtime] Registered the events webhook ${created.id}`);
    } else {
      const missing = RUNTIME_WEBHOOK_EVENTS.filter((event) => !existing.events?.includes(event));
      if (missing.length > 0) {
        await call("PATCH", `/v1/webhooks/${encodeURIComponent(existing.id)}`, {
          events: [...new Set([...(existing.events ?? []), ...RUNTIME_WEBHOOK_EVENTS])],
        });
      }
      if (previous?.webhookId === existing.id && typeof previous.webhookSecret === "string" && previous.webhookSecret) {
        webhook = { id: existing.id, secret: previous.webhookSecret };
      } else {
        // Its secret is not on this volume (restored elsewhere, or lost): take a new one.
        const rotated = await call("POST", `/v1/webhooks/${encodeURIComponent(existing.id)}/secret`, {});
        webhook = { id: existing.id, secret: rotated.secret };
        log.log?.(`[selfhost:agent-runtime] Rotated the events webhook ${existing.id}'s signing secret`);
      }
    }
    if (typeof webhook.secret !== "string" || !webhook.secret.startsWith("whsec_")) {
      throw new AgentRuntimeProvisionError("The runtime returned no webhook signing secret");
    }
    const state = {
      runtimeUrl: url,
      tenant,
      definitionId: definition.id,
      definitionRevision: definition.revision ?? null,
      webhookId: webhook.id,
      webhookUrl,
      webhookSecret: webhook.secret,
      provisionedAt: new Date().toISOString(),
    };
    await writeAgentRuntimeState(stateDir, state);
    log.log?.(`[selfhost:agent-runtime] Tenant ${tenant}: definition ${definition.id} (revision ${definition.revision ?? "?"}), events at ${webhookUrl}`);
    return { definitionId: state.definitionId, webhookSecret: state.webhookSecret, fresh: true };
  } catch (error) {
    if (previous?.definitionId && previous?.webhookSecret && previous.tenant === tenant) {
      log.error?.(`[selfhost:agent-runtime] Could not provision the runtime (${error.message}); using the last provisioned definition ${previous.definitionId}`);
      return { definitionId: previous.definitionId, webhookSecret: previous.webhookSecret, fresh: false };
    }
    throw error;
  }
}
