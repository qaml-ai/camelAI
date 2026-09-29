// The eval relay: how a local agent runtime (Docker) reaches chiridion's tools
// while chiridion runs inside the vitest workers pool, which listens on no port.
//
// The runtime calls this server (http://host.docker.internal:<port>/mcp/agent)
// like any MCP server. Each request waits here until the eval test that owns it
// takes it: the test's worker long-polls /__eval_tunnel/next, answers it with
// chiridion's own /mcp/agent handler and posts the response back to
// /__eval_tunnel/respond/<id>. Requests are routed by the org in the runtime's
// identity token (every eval makes its own org), so concurrent evals (the
// matrix) share one relay; the worker verifies the token itself.
//
//   node scripts/lib/eval-runtime-relay.mjs --port 18791 [--host 127.0.0.1]
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

export const TUNNEL_PREFIX = "/__eval_tunnel";
/** The key of requests that name no org (the runtime listing tools with no agent); any eval takes them. */
export const ANY_KEY = "*";
/** What the relay's health route answers, so a check cannot mistake another server on the port for it. */
export const RELAY_NAME = "chiridion-eval-relay";
/** Bumped when the relay changes, so `up` replaces a running older one. */
export const RELAY_VERSION = 2;
const MAX_BODY_BYTES = 32 * 1024 * 1024;

/**
 * The org a runtime identity token is for (its `ctx.org` claim: the context
 * chiridion gave the agent), without verifying it; ANY_KEY when it names none.
 */
export function relayKeyFromAuthorization(header) {
  const match = /^Bearer\s+([^.\s]+)\.([^.\s]+)\.([^.\s]+)$/i.exec(header ?? "");
  if (!match) return ANY_KEY;
  try {
    const claims = JSON.parse(Buffer.from(match[2], "base64url").toString("utf8"));
    const org = claims?.ctx?.org;
    return typeof org === "string" && org.trim() ? org.trim() : ANY_KEY;
  } catch {
    return ANY_KEY;
  }
}

async function readBody(req, limit = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function send(res, status, body, headers = {}) {
  const payload = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    ...(typeof body === "string" || Buffer.isBuffer(body) ? {} : { "Content-Type": "application/json" }),
    ...headers,
  });
  res.end(payload);
}

/**
 * The relay's state, apart from HTTP: requests waiting per key, and pollers
 * waiting per key. Exported for tests.
 */
export function createRelayQueue({ now = () => Date.now() } = {}) {
  /** key -> requests not yet taken */
  const pending = new Map();
  /** key -> pollers waiting (resolve functions) */
  const waiting = new Map();
  /** id -> { resolve } for requests taken and not yet answered */
  const inFlight = new Map();
  /** key -> last time a poller asked, so a request for an org nobody serves fails fast */
  const lastPoll = new Map();

  const list = (map, key) => {
    let entries = map.get(key);
    if (!entries) {
      entries = [];
      map.set(key, entries);
    }
    return entries;
  };

  function hand(key, request) {
    const pollers = waiting.get(key);
    const poller = pollers?.shift();
    if (!poller) return false;
    poller(request);
    return true;
  }

  return {
    /** Queue a request for `key`; resolves with the worker's response. */
    submit(key, request) {
      return new Promise((resolve) => {
        const entry = { ...request, id: request.id ?? randomUUID(), key };
        inFlight.set(entry.id, { resolve, key });
        if (hand(key, entry)) return;
        if (key === ANY_KEY) {
          for (const pollerKey of waiting.keys()) if (hand(pollerKey, entry)) return;
        }
        list(pending, key).push(entry);
      });
    },
    /**
     * Take the next request for `key` (or one for no org); null after `waitMs`,
     * or at once when `signal` aborts (the poller went away: nothing is handed
     * to it after).
     */
    next(key, waitMs, { signal } = {}) {
      lastPoll.set(key, now());
      const own = pending.get(key)?.shift() ?? pending.get(ANY_KEY)?.shift();
      if (own) return Promise.resolve(own);
      if (signal?.aborted) return Promise.resolve(null);
      return new Promise((resolve) => {
        const pollers = list(waiting, key);
        const done = (request) => {
          clearTimeout(timer);
          const index = pollers.indexOf(poller);
          if (index >= 0) pollers.splice(index, 1);
          resolve(request);
        };
        const poller = (request) => done(request);
        const timer = setTimeout(() => done(null), waitMs);
        signal?.addEventListener("abort", () => done(null), { once: true });
        pollers.push(poller);
      });
    },
    /** Put back a request whose poller went away before it got it. */
    requeue(request) {
      if (!inFlight.has(request.id)) return;
      if (hand(request.key, request)) return;
      list(pending, request.key).unshift(request);
    },
    /** The worker's answer to request `id`; false when nothing waits on it. */
    respond(id, response) {
      const entry = inFlight.get(id);
      if (!entry) return false;
      inFlight.delete(id);
      entry.resolve(response);
      return true;
    },
    /** Fail request `id` (it timed out here). */
    abandon(id) {
      const entry = inFlight.get(id);
      if (!entry) return;
      inFlight.delete(id);
      const queue = pending.get(entry.key);
      const index = queue?.findIndex((request) => request.id === id) ?? -1;
      if (queue && index >= 0) queue.splice(index, 1);
    },
    /** When a poller for `key` (for ANY_KEY: any poller) last asked (0: never). */
    lastPollAt(key) {
      if (key === ANY_KEY) return Math.max(0, ...lastPoll.values());
      return lastPoll.get(key) ?? 0;
    },
    stats() {
      return {
        pending: [...pending.values()].reduce((sum, queue) => sum + queue.length, 0),
        pollers: [...waiting.values()].reduce((sum, pollers) => sum + pollers.length, 0),
        inFlight: inFlight.size,
      };
    },
  };
}

export function createRelayServer({
  requestTimeoutMs = 25 * 60_000,
  pollWaitMs = 20_000,
  noPollerMs = 30_000,
} = {}) {
  const queue = createRelayQueue();
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://relay");
      if (url.pathname === `${TUNNEL_PREFIX}/health`) return send(res, 200, { ok: true, relay: RELAY_NAME, version: RELAY_VERSION, pid: process.pid, ...queue.stats() });
      if (url.pathname === `${TUNNEL_PREFIX}/next` && req.method === "GET") {
        const key = url.searchParams.get("key") || ANY_KEY;
        const wait = Math.min(Number(url.searchParams.get("waitMs")) || pollWaitMs, 60_000);
        // An eval that finished (or a poll it aborted) must not be handed a
        // request: it would never answer, and the runtime's call would hang.
        const gone = new AbortController();
        res.on("close", () => gone.abort());
        const request = await queue.next(key, wait, { signal: gone.signal });
        if (request && (gone.signal.aborted || res.destroyed)) {
          queue.requeue(request);
          return;
        }
        return request ? send(res, 200, request) : send(res, 204, "");
      }
      const respond = /^\/__eval_tunnel\/respond\/([^/]+)$/.exec(url.pathname);
      if (respond && req.method === "POST") {
        const body = JSON.parse((await readBody(req)).toString("utf8"));
        return queue.respond(decodeURIComponent(respond[1]), body)
          ? send(res, 200, { ok: true })
          : send(res, 404, { error: "Nothing waits on that request" });
      }
      if (url.pathname.startsWith(TUNNEL_PREFIX)) return send(res, 404, { error: "Unknown relay route" });

      // A request from the runtime: hand it to the eval that owns its org.
      const key = relayKeyFromAuthorization(req.headers.authorization);
      if (Date.now() - queue.lastPollAt(key) > noPollerMs + pollWaitMs) {
        // Give a starting eval a moment; an org nobody polls for is a finished
        // eval. A request for no org while no eval runs (the runtime checking
        // the definition's server as it is saved) is refused at once.
        if (key !== ANY_KEY) await new Promise((resolve) => setTimeout(resolve, Math.min(noPollerMs, 5_000)));
        if (Date.now() - queue.lastPollAt(key) > noPollerMs + pollWaitMs) {
          return send(res, 503, { error: "No eval is serving this org's tools" });
        }
      }
      const body = await readBody(req);
      const headers = Object.fromEntries(
        Object.entries(req.headers).flatMap(([name, value]) =>
          value === undefined ? [] : [[name, Array.isArray(value) ? value.join(", ") : value]]),
      );
      const id = randomUUID();
      const timer = setTimeout(() => {
        queue.abandon(id);
        if (!res.headersSent) send(res, 504, { error: "The eval did not answer in time" });
      }, requestTimeoutMs);
      const response = await queue.submit(key, {
        id,
        method: req.method ?? "GET",
        // As the runtime addressed it: the worker checks the token's audience against this URL.
        url: `http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`,
        headers,
        body: body.length > 0 ? body.toString("base64") : null,
      });
      clearTimeout(timer);
      if (res.headersSent) return;
      send(res, response.status ?? 502, response.body ? Buffer.from(response.body, "base64") : "", response.headers ?? {});
    } catch (error) {
      if (!res.headersSent) send(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  return { server, queue };
}

function parseArgs(argv) {
  const options = { port: 18791, host: "127.0.0.1" };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--port") options.port = Number(argv[++index]);
    else if (argv[index] === "--host") options.host = argv[++index];
  }
  return options;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { port, host } = parseArgs(process.argv.slice(2));
  const { server } = createRelayServer();
  server.listen(port, host, () => {
    console.log(`[eval-relay] listening on http://${host}:${port}`);
  });
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
